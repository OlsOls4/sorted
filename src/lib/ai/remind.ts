import "server-only";
import { addDays, balance, daysOverdue, gbp, todayISO, ukDate } from "../format";
import { STAGE_LABEL } from "../ledger";
import { payLine, templateReminder, waiverLine } from "../reminders";
import { payLaterEligible } from "../format";
import type { EngineInfo, Invoice, ReminderDraft, ReminderStage, Settings } from "../types";
import { RULES_ENGINE, extractJSON, fallbackEngine, friendlyAIError, getLLM } from "./provider";

const SYSTEM = `You write payment reminder emails for a UK sole trader (tradesperson) to send to a customer about an unpaid PayPal invoice.
British English, plain and human, no corporate fluff, no emojis. Keep it short (under 170 words).
Tone by stage: "nudge" = warm and friendly, assume it slipped their mind; "firm" = polite but clear, ask for payment within 7 days, invite them to raise any issue;
"final" = formal final notice with a firm deadline, still courteous, offer a payment plan.
Always include the pay link exactly as given. If payLaterOffer is true, add one hedged sentence that eligible customers can choose PayPal Pay in 3 at checkout (interest-free, subject to status); never promise it. If waiverOffer is given (business, final notice), include it word for word.
Only mention the Late Payment of Commercial Debts (Interest) Act 1998 if the facts say it applies (business customer) — then state the interest rate and fixed compensation exactly as given. For private customers at "final", you may mention the small claims court (Money Claim Online) instead. Never invent amounts, dates or links.
Return ONLY JSON: {"subject": string, "body": string}. Sign off with the trader's name and business.`;

export async function draftReminder(
  inv: Invoice,
  settings: Settings,
  stage?: ReminderStage,
): Promise<{ draft: ReminderDraft; engine: EngineInfo; aiError?: string }> {
  const today = todayISO();
  const base = templateReminder(inv, settings, stage, today);
  const llm = getLLM();
  if (!llm) return { draft: base, engine: RULES_ENGINE };
  try {
    const si = base.statutoryInterest!;
    const facts = {
      stage: base.stage,
      stageLabel: STAGE_LABEL[base.stage],
      trader: settings.traderName,
      business: settings.businessName,
      customerName: inv.customerName,
      customerType: inv.customerType,
      invoiceNumber: inv.number,
      job: inv.jobSummary,
      amountOwed: gbp(balance(inv)),
      issued: ukDate(inv.issueDate),
      due: ukDate(inv.dueDate),
      daysOverdue: daysOverdue(inv, today),
      remindersAlreadySent: inv.reminders.length,
      payLink: inv.payerViewUrl ?? null,
      payLaterOffer: payLaterEligible(inv),
      waiverOffer: base.stage === "final" && si.applies ? waiverLine(si) : null,
      finalDeadline: ukDate(addDays(today, 7)),
      lateInterest: si.applies
        ? { applies: true, ratePercent: si.ratePercent, interestSoFar: gbp(si.interestToDate), fixedCompensation: gbp(si.fixedCompensation) }
        : { applies: false },
    };
    const res = await llm.chat({
      system: SYSTEM,
      json: true,
      messages: [{ role: "user", content: `Facts:\n${JSON.stringify(facts, null, 2)}` }],
      maxTokens: 700,
      temperature: 0.5,
    });
    const out = extractJSON<{ subject?: string; body?: string }>(res.text);
    if (!out?.subject || !out?.body) throw new Error("model returned no usable JSON");
    // Guard rail: if the model mentions the Act for a consumer, fall back to the template.
    if (!si.applies && /Late Payment of Commercial Debts/i.test(out.body)) throw new Error("model cited Late Payment Act for a consumer");
    // Guard rails: the pay link (and the B2B waiver offer) must survive the rewrite.
    let body = out.body;
    if (inv.payerViewUrl && !body.includes(inv.payerViewUrl)) body = insertBeforeSignOff(body, payLine(inv));
    if (payLaterEligible(inv) && !/pay in 3/i.test(body)) body = insertBeforeSignOff(body, "If it helps to spread the cost, eligible customers can choose PayPal Pay in 3 at checkout (interest-free instalments, subject to status).");
    if (base.stage === "final" && si.applies && !/waive/i.test(body)) body = insertBeforeSignOff(body, waiverLine(si));
    return { draft: { ...base, subject: out.subject.slice(0, 200), body }, engine: res.engine };
  } catch (e) {
    return { draft: base, engine: fallbackEngine(), aiError: friendlyAIError(e) };
  }
}

function insertBeforeSignOff(body: string, line: string): string {
  const m = body.match(/\n\s*(Kind regards|Best regards|Regards|Many thanks|Thanks|Cheers|Best wishes|Yours sincerely|Yours faithfully)[,\s]/i);
  if (!m || m.index === undefined) return `${body.trimEnd()}\n\n${line}`;
  return `${body.slice(0, m.index).trimEnd()}\n\n${line}\n${body.slice(m.index)}`;
}
