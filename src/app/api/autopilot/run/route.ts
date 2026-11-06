import { asLedger, readJSON, sanitizeSettings } from "@/lib/api";
import { verifyMandate } from "@/lib/approval";
import { planAutopilot, type AutopilotLogEntry } from "@/lib/autopilot";
import { errorResponse, getBackend, resolveContext } from "@/lib/backend";
import { isoTimestamp } from "@/lib/format";
import { liveWriteGuard } from "@/lib/guard";
import { templateReminder } from "@/lib/reminders";
import type { Invoice } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One Autopilot run. The signed mandate is re-verified and the plan is rebuilt
 * here from the limits inside it (live: from PayPal's own invoice list), so the
 * browser can't widen what was signed. Reminders go through the same backend
 * path as a manual send (PayPal Agent Toolkit send_invoice_reminder, REST
 * fallback; mock PayPal in demo) with the deterministic template text: no AI call.
 */
export async function POST(req: Request) {
  const rc = resolveContext(req);
  const body = await readJSON(req);
  const m = verifyMandate(body.mandate, rc.mode);
  if (!m.ok) return Response.json({ error: `Autopilot needs a signed mandate (${m.reason}). Open Autopilot and sign it.`, code: "MANDATE_REQUIRED" }, { status: 403 });
  const settings = sanitizeSettings(body.settings);
  const clientLedger = asLedger(body.ledger);
  const backend = getBackend(rc);
  let ledger: Invoice[];
  try {
    if (rc.mode === "live") {
      // Statuses come from PayPal; reminder history is kept in the browser, as for manual sends.
      const local = new Map(clientLedger.map((i) => [i.id, i.reminders]));
      ledger = (await backend.list()).data.map((i) => ({ ...i, reminders: local.get(i.id) ?? i.reminders }));
    } else ledger = clientLedger;
  } catch (e) {
    return errorResponse(e);
  }

  const now = new Date();
  const plan = planAutopilot(ledger, m.rules, now);
  const results: (AutopilotLogEntry & { invoice?: Invoice })[] = [];
  for (const item of plan) {
    const entry: AutopilotLogEntry = { at: isoTimestamp(now), action: item.action, invoiceId: item.invoiceId, invoiceNumber: item.invoiceNumber, customerName: item.customerName, stage: item.stage, reason: item.reason };
    const inv = item.action === "send" ? ledger.find((i) => i.id === item.invoiceId) : undefined;
    if (!inv || !item.stage) {
      results.push(entry);
      continue;
    }
    const blocked = liveWriteGuard(req, rc, [inv.customerEmail]);
    if (blocked) {
      const why =
        blocked.status === 422
          ? `Held: ${inv.customerName} has a non-test address, and the shared PayPal sandbox only sends to @example.com.`
          : `Queued ${inv.customerName} for the next run (live send limit reached for now).`;
      results.push({ ...entry, action: blocked.status === 422 ? "hold" : "skip", reason: why });
      continue;
    }
    try {
      const draft = templateReminder(inv, settings, item.stage);
      const { data, via } = await backend.remind(inv, draft.subject, draft.body, item.stage);
      results.push({ ...entry, via, invoice: data ?? undefined });
    } catch (e) {
      results.push({ ...entry, action: "skip", reason: `Queued ${inv.customerName} for the next run: PayPal did not take the reminder just now (${(e as Error).message.slice(0, 120)}).` });
    }
  }
  return Response.json({ mode: rc.mode, at: isoTimestamp(now), rules: m.rules, mandateExpiresAt: m.expiresAt, results });
}
