import { draftReminder } from "@/lib/ai/remind";
import { readJSON, sanitizeSettings } from "@/lib/api";
import type { Invoice, ReminderStage } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Draft (never send) a reminder email with escalating tone. */
export async function POST(req: Request) {
  const body = await readJSON(req);
  const invoice = body.invoice as Invoice | undefined;
  if (!invoice || typeof invoice.id !== "string") return Response.json({ error: "Missing invoice." }, { status: 400 });
  invoice.reminders = Array.isArray(invoice.reminders) ? invoice.reminders : [];
  const stage = ["nudge", "firm", "final"].includes(String(body.stage)) ? (body.stage as ReminderStage) : undefined;
  const result = await draftReminder(invoice, sanitizeSettings(body.settings), stage);
  return Response.json(result);
}
