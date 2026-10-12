// PayPal Agent Toolkit integration (server-only).
//
// In live mode the Ask Chase agent's PayPal tools (list_invoices, get_invoice,
// send_invoice_reminder) are executed through @paypal/agent-toolkit's
// AI-SDK tool objects, so the agent drives PayPal through PayPal's own
// agent tool layer. Core invoice creation uses our direct REST client
// (see client.ts) because it needs Prefer: return=representation, idempotency
// keys, retries and GBP/UK-specific payload shaping that we control end-to-end.

import "server-only";
import type { PayPalConfig } from "./client";
import { credKey, isSandbox } from "./client";

type ToolLike = { description?: string; execute?: (args: Record<string, unknown>, opts?: unknown) => Promise<unknown> };

// The toolkit caches its OAuth token without expiry, so rebuild it periodically. Keyed per credential set.
const cache = new Map<string, { tools: Record<string, ToolLike>; at: number }>();
const TOOLKIT_TTL_MS = 30 * 60 * 1000;
let loadError: string | null = null;

export const TOOLKIT_TOOL_NAMES = ["list_invoices", "get_invoice", "send_invoice", "send_invoice_reminder"] as const;
export type ToolkitToolName = (typeof TOOLKIT_TOOL_NAMES)[number];

async function loadTools(cfg: PayPalConfig): Promise<Record<string, ToolLike> | null> {
  const key = credKey(cfg);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TOOLKIT_TTL_MS) return hit.tools;
  try {
    const mod = (await import("@paypal/agent-toolkit/ai-sdk")) as unknown as {
      PayPalAgentToolkit: new (args: {
        clientId: string;
        clientSecret: string;
        configuration: { actions: Record<string, Record<string, boolean>>; context?: Record<string, unknown> };
      }) => { getTools(): Record<string, ToolLike> };
    };
    const toolkit = new mod.PayPalAgentToolkit({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      configuration: {
        actions: { invoices: { list: true, get: true, send: true, sendReminder: true } },
        context: { sandbox: isSandbox(cfg) },
      },
    });
    const tools = toolkit.getTools();
    if (cache.size > 100) cache.clear();
    cache.set(key, { tools, at: Date.now() });
    loadError = null;
    return tools;
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
  const tools = await loadTools(cfg);
  const tool = tools?.[name];
  if (!tool?.execute) throw new Error(`Agent Toolkit tool ${name} unavailable${loadError ? `: ${loadError}` : ""}`);
  const raw = await tool.execute(args, { toolCallId: crypto.randomUUID(), messages: [] });
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
    const err = (parsed as { error?: { message?: string } }).error;
    throw new Error(`PayPal Agent Toolkit ${name} failed: ${err?.message ?? JSON.stringify(err)}`);
  }
  return parsed;
}
