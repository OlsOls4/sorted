// Template reminder emails (deterministic fallback; also the baseline the AI improves on).

import { addDays, balance, daysOverdue, gbp, payLaterEligible, todayISO, ukDate } from "./format";
import { statutoryInterest, suggestStage } from "./ledger";
import type { Invoice, ReminderDraft, ReminderStage, Settings } from "./types";

function greetingName(inv: Invoice): string {
  if (inv.customerType === "business") return "Accounts team";
  const n = inv.customerName.trim();
  // "Mrs Priya Patel" -> "Mrs Patel"; "Tom Briggs" -> "Tom"
  const title = n.match(/^(Mrs|Mr|Ms|Miss|Dr|Prof)\.?\s+/i)?.[1];
  const parts = n.replace(/^(Mrs|Mr|Ms|Miss|Dr|Prof)\.?\s+/i, "").split(/\s+/);
  if (title) return `${title} ${parts[parts.length - 1]}`;
  return parts[0] || "there";
}

/** "Pay here" line with the PayPal pay link, plus a hedged Pay in 3 mention for eligible private customers. */
export function payLine(inv: Invoice): string {
  const link = inv.payerViewUrl
    ? `You can pay securely by card or PayPal here: ${inv.payerViewUrl}`
    : "You can pay via the PayPal link in the original invoice email.";
  return payLaterEligible(inv) ? `${link}\n\nIf it helps to spread the cost, eligible customers can choose PayPal Pay in 3 at checkout (interest-free instalments, subject to status).` : link;
}

/** B2B final notice incentive: settle today and the statutory extras are dropped. */
export function waiverLine(si: { interestToDate: number; fixedCompensation: number }): string {
  return `If you pay the invoice in full today using the link above, I'll waive the statutory interest and the ${gbp(si.fixedCompensation)} compensation.`;
}

export function templateReminder(inv: Invoice, settings: Settings, stage?: ReminderStage, today = todayISO()): ReminderDraft {
  const s = stage ?? suggestStage(inv, today);
  const owed = gbp(balance(inv));
  const od = daysOverdue(inv, today);
  const late = od > 0 ? `${od} day${od === 1 ? "" : "s"} overdue` : `due on ${ukDate(inv.dueDate)}`;
  const pay = payLine(inv);
  const hi = `Hi ${greetingName(inv)},`;
  const sign = `Kind regards,\n${settings.traderName}\n${settings.businessName}`;
  const si = statutoryInterest(inv, settings.bankRate, today);

  let subject: string;
  let body: string;
  if (s === "nudge") {
    subject = `Friendly reminder: invoice ${inv.number} (${owed})`;
    body = `${hi}\n\nHope all's well. Just a quick nudge that invoice ${inv.number} for ${inv.jobSummary.toLowerCase()} (${owed}) is ${late}. It's easy to miss these, so no worries if it slipped through.\n\n${pay}\n\nIf you've already paid, thank you, and please ignore this.\n\n${sign}`;
  } else if (s === "firm") {
    subject = `Payment overdue: invoice ${inv.number} — ${owed}`;
    body = `${hi}\n\nI'm following up on invoice ${inv.number} for ${owed}, issued on ${ukDate(inv.issueDate)} and now ${late}. I haven't yet received payment or heard back about it.\n\nPlease could you settle the balance within the next 7 days. ${pay}\n\nIf there's a problem with the work or the invoice, just reply and let me know so we can sort it out.\n\n${sign}`;
  } else {
    const by = ukDate(addDays(today, 7));
    const legal = si.applies
      ? `As this is a business-to-business debt, if payment is not received by ${by} I will claim statutory interest under the Late Payment of Commercial Debts (Interest) Act 1998 at ${si.ratePercent}% a year (currently ${gbp(si.interestToDate)} and rising daily), plus fixed compensation of ${gbp(si.fixedCompensation)}.\n\n${waiverLine(si)}`
      : `If payment is not received by ${by}, I will have no option but to pursue the debt formally, which may include a claim through the small claims court (Money Claim Online).`;
    subject = `FINAL NOTICE: invoice ${inv.number} — ${owed} now ${od} days overdue`;
    body = `${hi}\n\nDespite previous reminders, invoice ${inv.number} for ${owed} remains unpaid and is now ${late}.\n\nThis is a final notice. Please pay the full balance by ${by}. ${pay}\n\n${legal}\n\nI'd much rather resolve this amicably — if you're having difficulty paying, please get in touch today and we can agree a payment plan.\n\n${sign}`;
  }
  return {
    invoiceId: inv.id,
    stage: s,
    subject,
    body,
    statutoryInterest: si,
  };
}
