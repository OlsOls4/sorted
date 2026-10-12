import { runAgent, type AgentContext } from "@/lib/ai/agent";
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
      preTrace.push({ tool: "agent_toolkit_fallback", args: {}, summary: (e as Error).message.slice(0, 160) });
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
  const ctx: AgentContext = { ledger, settings, mode, ledgerVia };
  const res = await runAgent(messages, ctx);
  res.toolTrace = [...preTrace, ...res.toolTrace];
  return Response.json({ mode, ...res });
}
