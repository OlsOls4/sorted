import { runAgent, type AgentContext } from "@/lib/ai/agent";
import { sanitizeRules, type AutopilotLogEntry } from "@/lib/autopilot";
import { asLedger, readJSON, sanitizeSettings } from "@/lib/api";
import { errorResponse, getBackend, resolveContext } from "@/lib/backend";
import { PayPalClient, isSandbox, type PayPalInvoice } from "@/lib/paypal/client";
import { payPalToInvoice } from "@/lib/paypal/mapping";
import { runToolkitTool } from "@/lib/paypal/toolkit";
import { seedInvoices } from "@/lib/seed";
import type { ChatMessage, Invoice, ToolTraceEntry } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const rc = resolveContext(req);
  const mode = rc.mode;
  const body = await readJSON(req);
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m): m is ChatMessage => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return Response.json({ error: "Ask Sorted a question." }, { status: 400 });
  }
  const settings = sanitizeSettings(body.settings);
  let ledger: Invoice[];
  let ledgerVia: ToolTraceEntry["via"];
  const preTrace: ToolTraceEntry[] = [];
  if (mode === "live") {
    const cfg = rc.cfg!;
    try {
      // Live: read the ledger through PayPal's Agent Toolkit list_invoices tool.
      const res = (await runToolkitTool(cfg, "list_invoices", { page: 1, page_size: 100, total_required: true })) as { items?: PayPalInvoice[] };
      // The list summary has no line items / VAT breakdown, so fill in details.
      const full = await new PayPalClient(cfg).hydrate(res.items ?? []);
      ledger = full.map((p) => payPalToInvoice(p, isSandbox(cfg)));
      ledgerVia = "paypal-agent-toolkit";
    } catch (e) {
      console.warn("[sorted] agent toolkit list failed, using REST:", (e as Error).message.slice(0, 160));
      try {
        ledger = (await getBackend(rc).list()).data;
        ledgerVia = "paypal-rest";
      } catch (e2) {
        return errorResponse(new Error(`Couldn't read your invoices from PayPal: ${(e2 as Error).message} (Agent Toolkit: ${(e as Error).message})`), 502);
      }
    }
    // keep reminder history the browser knows about
    const local = new Map(asLedger(body.ledger).map((i) => [i.id, i.reminders]));
    ledger = ledger.map((i) => ({ ...i, reminders: local.get(i.id) ?? i.reminders }));
    preTrace.push({ tool: "list_invoices", args: { page_size: 100 }, summary: `synced ${ledger.length} invoices from PayPal`, via: ledgerVia });
  } else {
    const l = asLedger(body.ledger);
    ledger = l.length ? l : seedInvoices(settings.hourlyRate);
    ledgerVia = "mock-paypal";
  }
  const ctx: AgentContext = { ledger, settings, mode, ledgerVia, cfg: mode === "live" ? rc.cfg : null, autopilot: readAutopilot(body.autopilot) };
  const res = await runAgent(messages, ctx);
  res.toolTrace = [...preTrace, ...res.toolTrace];
  return Response.json({ mode, ...res });
}

/** The browser's Autopilot state, trimmed to plain strings (it's only ever read back to the owner). */
function readAutopilot(v: unknown): AgentContext["autopilot"] {
  if (!v || typeof v !== "object") return undefined;
  const a = v as { active?: unknown; rules?: unknown; log?: unknown };
  const str = (x: unknown, n: number) => (typeof x === "string" ? x.slice(0, n) : undefined);
  const actions = ["send", "hold", "skip", "note"] as const;
  const log: AutopilotLogEntry[] = (Array.isArray(a.log) ? a.log : [])
    .slice(-25)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as AutopilotLogEntry).reason === "string")
    .map((e) => ({
      at: str(e.at, 40) ?? "",
      action: actions.find((x) => x === e.action) ?? "note",
      invoiceNumber: str(e.invoiceNumber, 40),
      customerName: str(e.customerName, 120),
      reason: str(e.reason, 300) ?? "",
    }));
  return { active: a.active === true, rules: sanitizeRules(a.rules), log };
}
