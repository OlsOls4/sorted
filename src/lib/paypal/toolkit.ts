// PayPal Agent Toolkit integration (server-only).
//
// In live mode the Ask Sorted agent's PayPal tools (list_invoices, get_invoice,
// send_invoice_reminder) are executed through @paypal/agent-toolkit's
// AI-SDK tool objects, so the agent drives PayPal through PayPal's own
// agent tool layer. Core invoice creation uses our direct REST client
// (see client.ts) because it needs Prefer: return=representation, idempotency
// keys, retries and GBP/UK-specific payload shaping that we control end-to-end.

import "server-only";
import type { PayPalConfig } from "./client";
import { PayPalClient, PayPalError, credKey, isSandbox } from "./client";

type ToolLike = { description?: string; execute?: (args: Record<string, unknown>, opts?: unknown) => Promise<unknown> };

// The toolkit caches its OAuth token without expiry, so rebuild it periodically. Keyed per credential set.
// Before each run we also hand it the token from our own client (cached + refreshed
// there), so the toolkit never needs to do its own Basic-auth token call. That keeps
// tokens fresh and lets the toolkit work when auth is injected by a dev proxy.
type ToolkitInstance = { getTools(): Record<string, ToolLike>; client?: { _accessToken?: string } };
const cache = new Map<string, { tools: Record<string, ToolLike>; toolkit: ToolkitInstance; at: number }>();
const TOOLKIT_TTL_MS = 30 * 60 * 1000;
let loadError: string | null = null;

export const TOOLKIT_TOOL_NAMES = ["list_invoices", "get_invoice", "send_invoice", "send_invoice_reminder", "generate_invoice_qr_code", "cancel_sent_invoice"] as const;
export type ToolkitToolName = (typeof TOOLKIT_TOOL_NAMES)[number];

async function loadTools(cfg: PayPalConfig): Promise<{ tools: Record<string, ToolLike>; toolkit: ToolkitInstance } | null> {
  const key = credKey(cfg);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TOOLKIT_TTL_MS) return hit;
  try {
    const mod = (await import("@paypal/agent-toolkit/ai-sdk")) as unknown as {
      PayPalAgentToolkit: new (args: {
        clientId: string;
        clientSecret: string;
        configuration: { actions: Record<string, Record<string, boolean>>; context?: Record<string, unknown> };
      }) => ToolkitInstance;
    };
    const toolkit = new mod.PayPalAgentToolkit({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      configuration: {
        actions: { invoices: { list: true, get: true, send: true, sendReminder: true, generateQRC: true, cancel: true } },
        context: { sandbox: isSandbox(cfg) },
      },
    });
    const tools = toolkit.getTools();
    if (cache.size > 100) cache.clear();
    const entry = { tools, toolkit, at: Date.now() };
    cache.set(key, entry);
    loadError = null;
    return entry;
  } catch (e) {
    loadError = (e as Error).message;
    return null;
  }
}

export function toolkitLoadError() {
  return loadError;
}

/** Run a PayPal Agent Toolkit tool. Returns parsed JSON, or throws on toolkit/PayPal error. */
export async function runToolkitTool(cfg: PayPalConfig, name: ToolkitToolName, args: Record<string, unknown>): Promise<unknown> {
  const loaded = await loadTools(cfg);
  const tool = loaded?.tools[name];
  if (!loaded || !tool?.execute) throw new Error(`Agent Toolkit tool ${name} unavailable${loadError ? `: ${loadError}` : ""}`);
  // Share our (cached, auto-refreshed) OAuth token with the toolkit's client.
  if (loaded.toolkit.client && typeof loaded.toolkit.client === "object") {
    loaded.toolkit.client._accessToken = await new PayPalClient(cfg).getAccessToken();
  }
  const raw = await tool.execute(args, { toolCallId: crypto.randomUUID(), messages: [] });
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw; // e.g. a multipart body
    }
  }
  // Toolkit v1.11 reports PayPal HTTP failures as {"ok":false,"status":422,"message":...}
  // instead of throwing; treat that as a failure, never as success.
  const obj = parsed as { ok?: unknown; status?: unknown; message?: unknown; code?: unknown } | null;
  if (obj && typeof obj === "object" && obj.ok === false) {
    const status = typeof obj.status === "number" ? obj.status : 502;
    throw new PayPalError(`PayPal Agent Toolkit ${name} failed (${status}): ${String(obj.message ?? obj.code ?? "error")}`, status, undefined, parsed);
  }
  if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
    const err = (parsed as { error?: { message?: string } }).error;
    throw new Error(`PayPal Agent Toolkit ${name} failed: ${err?.message ?? JSON.stringify(err)}`);
  }
  return parsed;
}
