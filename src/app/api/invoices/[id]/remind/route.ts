import { readJSON } from "@/lib/api";
import { errorResponse, getBackend, resolveContext } from "@/lib/backend";
import type { Invoice, ReminderStage } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Send a reminder for an invoice. Called only after the user confirms the draft in the UI. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rc = resolveContext(req);
  const mode = rc.mode;
  const body = await readJSON(req);
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const note = typeof body.body === "string" ? body.body.trim() : "";
  if (!subject || !note) return Response.json({ error: "Reminder subject and message are required." }, { status: 400 });
  const invoice = body.invoice as Invoice | undefined;
  // The tone the user actually sent, so the ledger logs "Final notice" even if it's the first reminder.
  const stage = (["nudge", "firm", "final"] as const).find((s) => s === body.stage) as ReminderStage | undefined;
  if (mode === "demo" && (!invoice || invoice.id !== id)) {
    return Response.json({ error: "Demo mode needs the invoice in the request body." }, { status: 400 });
  }
  try {
    const { data, via } = await getBackend(rc).remind(invoice && invoice.id === id ? invoice : id, subject, note, stage);
    return Response.json({ mode, via, invoice: data });
  } catch (e) {
    return errorResponse(e);
  }
}
