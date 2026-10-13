// PayPal Agent Toolkit integration (server-only).
//
// What runs through @paypal/agent-toolkit (its AI-SDK tool objects, executed
// server-side) in live mode:
//   - Ask Sorted's PayPal tools: list_invoices (ledger sync + the model's
//     list_invoices tool), get_invoice, generate_invoice_qr_code.
//   - Confirmed writes: send_invoice_reminder (reminders) and cancel_sent_invoice
//     (cancel). The model can only propose these; the route runs them after
//     verifying a signed approval token (see ../approval.ts).
//   - The invoice details modal's QR code (generate_invoice_qr_code).
// What uses our own REST client (client.ts) instead:
//   - Create + send, because it needs Prefer: return=representation, idempotency
//     keys, duplicate-number retry, orphan-draft clean-up and GBP/UK VAT shaping.
//   - Recording a cash/bank payment (no toolkit tool for it), list hydration
//     (per-invoice GETs for line items/VAT), webhook signature verification.
//   - Fallback for reminders/cancel only when the toolkit couldn't start or
//     authenticate (never to retry a PayPal-side rejection).
// The toolkit's own token cache never expires, so we inject our cached,
// auto-refreshed OAuth token before each call and rebuild it every 30 minutes.

import "server-only";
import type { PayPalConfig } from "./client";
import { PayPalClient, PayPalError, credKey, isSandbox } from "./client";

type ToolLike = { description?: string; execute?: (args: Record<string, unknown>, opts?: unknown) => Promise<unknown> };

// Keyed per credential set (fingerprint, never the raw secret).
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
