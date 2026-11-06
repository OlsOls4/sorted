// "Claim pack": a deterministic Letter Before Claim for an overdue business invoice.
// No AI call, nothing sent: the trader prints it (or saves as PDF) and sends it themselves.
//
// Structure follows the Pre-Action Protocol for Debt Claims (Civil Procedure Rules). The
// protocol strictly applies where the debtor is an individual (including a sole trader);
// for a company debtor it is good practice and courts expect similar conduct.

import { addDays, balance, daysOverdue, gbp, isOpen, todayISO, ukDate } from "./format";
import { statutoryInterest } from "./ledger";
import { LATE_PAYMENT_REFERENCE_RATE_AS_OF } from "./rates";
import type { Invoice, Settings } from "./types";

export const CLAIM_MIN_DAYS_OVERDUE = 30;
export const BUSINESS_REPLY_DAYS = 14;
export const INDIVIDUAL_REPLY_DAYS = 30;
export const LETTER_FOOTER = "Template only, not legal advice. Check gov.uk/make-money-claim before issuing a claim.";

export const letterPath = (id: string) => `/app/letter/${encodeURIComponent(id)}`;

export function finalNoticeSent(inv: Invoice): boolean {
  return inv.reminders.some((r) => r.stage === "final");
}

export interface ClaimStatus {
  ready: boolean;
  reason: string;
}

/**
 * Ready when the customer is a business, the invoice is open and at least 30 days overdue,
 * and a final notice has gone out. In demo mode the final-notice requirement is relaxed.
 */
export function claimStatus(inv: Invoice, today = todayISO(), opts: { demo?: boolean } = {}): ClaimStatus {
  const od = daysOverdue(inv, today);
  if (!isOpen(inv) || balance(inv) <= 0) return { ready: false, reason: `${inv.number} has nothing left to pay.` };
  if (inv.customerType !== "business")
    return {
      ready: false,
      reason: `${inv.customerName} is a private customer. Before a claim against an individual, the Pre-Action Protocol for Debt Claims requires a letter allowing 30 days to reply, with the Reply Form and Information Sheet enclosed, so Sorted only prepares letters for business customers.`,
    };
  if (od < CLAIM_MIN_DAYS_OVERDUE) return { ready: false, reason: `${inv.number} is ${Math.max(0, od)} days overdue. A Letter Before Claim is prepared from ${CLAIM_MIN_DAYS_OVERDUE} days overdue.` };
  if (!finalNoticeSent(inv) && !opts.demo) return { ready: false, reason: `No final notice has been sent for ${inv.number} yet. Send the final notice first.` };
  return { ready: true, reason: "Letter Before Claim ready." };
}

export interface LetterBeforeClaim {
  invoiceId: string;
  reference: string;
  date: string; // YYYY-MM-DD
  from: { name: string; business: string; email: string };
  to: { name: string; email: string };
  subject: string;
  invoice: { number: string; issueDate: string; dueDate: string; job: string; total: number; amountPaid: number; daysOverdue: number };
  breakdown: { label: string; amount: number }[];
  total: number;
  dailyInterest: number;
  ratePercent: number;
  payBy: string; // YYYY-MM-DD
  replyDays: number;
  payLink?: string;
  paragraphs: { heading?: string; text: string }[];
  individualNote: string;
  footer: string;
}

export function buildLetterBeforeClaim(inv: Invoice, settings: Settings, today = todayISO()): LetterBeforeClaim {
  const si = statutoryInterest(inv, settings.bankRate, today);
  const owed = balance(inv);
  const payBy = addDays(today, BUSINESS_REPLY_DAYS);
  const breakdown = [
    { label: `Unpaid balance of invoice ${inv.number}`, amount: si.principal },
    { label: `Statutory interest at ${si.ratePercent}% a year from ${ukDate(addDays(inv.dueDate, 1))} to ${ukDate(today)} (${si.daysOverdue} days)`, amount: si.interestToDate },
    { label: "Fixed compensation for recovery costs", amount: si.fixedCompensation },
  ];
  const howToPay = inv.payerViewUrl
    ? `Please pay by card or PayPal using the secure PayPal invoice link: ${inv.payerViewUrl}. The link takes payment of the invoice balance (${gbp(owed)}); please pay the interest and compensation (${gbp(si.interestToDate + si.fixedCompensation)}) by the same method or contact me for bank details.`
    : `Please pay using the PayPal link in the original invoice email, or contact me for bank details.`;
  const paragraphs: LetterBeforeClaim["paragraphs"] = [
    {
      text: `I write about invoice ${inv.number}, issued on ${ukDate(inv.issueDate)} for ${inv.jobSummary}. Payment was due on ${ukDate(inv.dueDate)}. The invoice remains unpaid and is now ${si.daysOverdue} days overdue, despite previous reminders.`,
    },
    {
      heading: "Amount claimed",
      text: `The total now due is ${gbp(si.totalClaim)}, made up as set out below. As this is a debt between businesses, statutory interest and fixed compensation are claimed under the Late Payment of Commercial Debts (Interest) Act 1998. Interest is calculated at 8% a year over the Bank of England reference rate (${ukDate(LATE_PAYMENT_REFERENCE_RATE_AS_OF)}), and continues to accrue at ${gbp(si.dailyInterest)} a day until payment.`,
    },
    {
      heading: "What I am asking you to do",
      text: `Please pay ${gbp(si.totalClaim)}, plus any further interest, within ${BUSINESS_REPLY_DAYS} days of the date of this letter, that is by ${ukDate(payBy)}. ${howToPay}`,
    },
    {
      heading: "If you dispute the debt or cannot pay",
      text: `If you dispute any part of this amount, please tell me in writing by ${ukDate(payBy)}, giving your reasons and any documents you rely on. If you cannot pay in full, please contact me to discuss a payment plan. I am willing to consider mediation or another form of alternative dispute resolution.`,
    },
    {
      heading: "Next steps",
      text: `If I do not receive payment or a reply by ${ukDate(payBy)}, I may start court proceedings to recover the debt, interest and compensation without further notice, which may increase the amount you have to pay, including court fees. I would prefer to resolve this without going to court.`,
    },
    { heading: "Enclosed", text: `A copy of invoice ${inv.number}.` },
    { text: `Please reply to ${settings.traderEmail}, quoting reference ${inv.number}.` },
  ];
  return {
    invoiceId: inv.id,
    reference: inv.number,
    date: today,
    from: { name: settings.traderName, business: settings.businessName, email: settings.traderEmail },
    to: { name: inv.customerName, email: inv.customerEmail },
    subject: `Letter Before Claim: unpaid invoice ${inv.number}, ${gbp(si.totalClaim)}`,
    invoice: { number: inv.number, issueDate: inv.issueDate, dueDate: inv.dueDate, job: inv.jobSummary, total: inv.total, amountPaid: inv.amountPaid, daysOverdue: si.daysOverdue },
    breakdown,
    total: si.totalClaim,
    dailyInterest: si.dailyInterest,
    ratePercent: si.ratePercent,
    payBy,
    replyDays: BUSINESS_REPLY_DAYS,
    payLink: inv.payerViewUrl,
    paragraphs,
    individualNote: `This template is for business customers (${BUSINESS_REPLY_DAYS} days to pay). If the debtor is an individual, including a sole trader, the Pre-Action Protocol for Debt Claims applies: allow ${INDIVIDUAL_REPLY_DAYS} days and enclose the Reply Form and Information Sheet.`,
    footer: LETTER_FOOTER,
  };
}

/** Plain-text version (used by tests and for copying into an email). */
export function letterText(l: LetterBeforeClaim): string {
  return [
    `${l.from.name}, ${l.from.business}, ${l.from.email}`,
    ukDate(l.date),
    `To: ${l.to.name}${l.to.email ? ` (${l.to.email})` : ""}`,
    `LETTER BEFORE CLAIM`,
    l.subject,
    "Dear Sir or Madam,",
    ...l.paragraphs.map((p) => (p.heading ? `${p.heading}\n${p.text}` : p.text)),
    ...l.breakdown.map((b) => `${b.label}: ${gbp(b.amount)}`),
    `Total due: ${gbp(l.total)}`,
    `Yours faithfully,\n${l.from.name}\n${l.from.business}`,
    l.individualNote,
    l.footer,
  ].join("\n\n");
}
