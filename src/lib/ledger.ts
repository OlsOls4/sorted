// Pure ledger analytics used by the dashboard, the rules engine and the AI tools.

import { balance, daysBetween, daysOverdue, daysToPay, isOpen, isPaid, round2, todayISO } from "./format";
import type { Invoice, ReminderStage } from "./types";

export interface CustomerSummary {
  key: string; // email
  name: string;
  email: string;
  invoices: number;
  billed: number;
  paid: number;
  outstanding: number;
  overdue: number;
  maxDaysOverdue: number;
  avgDaysToPay?: number; // for paid invoices
  avgDaysLate?: number; // paid-late + still-overdue, averaged
}

export function customerSummaries(ledger: Invoice[], today = todayISO()): CustomerSummary[] {
  const map = new Map<string, CustomerSummary & { _ttp: number[]; _late: number[] }>();
  for (const inv of ledger) {
    if (inv.status === "CANCELLED" || inv.status === "DRAFT") continue;
    const key = (inv.customerEmail || inv.customerName).toLowerCase();
    const cur =
      map.get(key) ??
      { key, name: inv.customerName, email: inv.customerEmail, invoices: 0, billed: 0, paid: 0, outstanding: 0, overdue: 0, maxDaysOverdue: 0, _ttp: [], _late: [] };
    // keep the most descriptive name
    if (inv.customerName.length > cur.name.length) cur.name = inv.customerName;
    cur.invoices++;
    cur.billed += inv.total;
    cur.paid += isPaid(inv) ? inv.total : inv.amountPaid;
    const bal = balance(inv);
    cur.outstanding += bal;
    const od = daysOverdue(inv, today);
    if (bal > 0 && od > 0) {
      cur.overdue += bal;
      cur.maxDaysOverdue = Math.max(cur.maxDaysOverdue, od);
      cur._late.push(od);
    }
    const ttp = daysToPay(inv);
    if (ttp !== undefined) {
      cur._ttp.push(ttp);
      if (inv.paidDate) cur._late.push(Math.max(0, daysBetween(inv.dueDate, inv.paidDate)));
    }
    map.set(key, cur);
  }
  return [...map.values()].map(({ _ttp, _late, ...c }) => ({
    ...c,
    billed: round2(c.billed),
    paid: round2(c.paid),
    outstanding: round2(c.outstanding),
    overdue: round2(c.overdue),
    avgDaysToPay: _ttp.length ? Math.round(_ttp.reduce((a, b) => a + b, 0) / _ttp.length) : undefined,
    avgDaysLate: _late.length ? Math.round(_late.reduce((a, b) => a + b, 0) / _late.length) : undefined,
  }));
}

export function overdueInvoices(ledger: Invoice[], today = todayISO()): Invoice[] {
  return ledger
    .filter((i) => isOpen(i) && balance(i) > 0 && daysOverdue(i, today) > 0)
    .sort((a, b) => daysOverdue(b, today) - daysOverdue(a, today));
}

export function totals(ledger: Invoice[], today = todayISO()) {
  let outstanding = 0, overdue = 0, paidThisMonth = 0, billedThisMonth = 0;
  const month = today.slice(0, 7);
  const ttp: number[] = [];
  for (const inv of ledger) {
    const bal = balance(inv);
    outstanding += bal;
    if (bal > 0 && daysOverdue(inv, today) > 0) overdue += bal;
    if (isPaid(inv) && inv.paidDate?.startsWith(month)) paidThisMonth += inv.total;
    if (inv.status !== "CANCELLED" && inv.status !== "DRAFT" && inv.issueDate.startsWith(month)) billedThisMonth += inv.total;
    const d = daysToPay(inv);
    if (d !== undefined) ttp.push(d);
  }
  return {
    outstanding: round2(outstanding),
    overdue: round2(overdue),
    overdueCount: overdueInvoices(ledger, today).length,
    paidThisMonth: round2(paidThisMonth),
    billedThisMonth: round2(billedThisMonth),
    avgDaysToPay: ttp.length ? Math.round(ttp.reduce((a, b) => a + b, 0) / ttp.length) : undefined,
  };
}

/** Earnings (cash received) between two dates inclusive, by paid date. */
export function earnedBetween(ledger: Invoice[], from: string, to: string) {
  const paid = ledger.filter((i) => isPaid(i) && i.paidDate && i.paidDate >= from && i.paidDate <= to);
  const billed = ledger.filter((i) => i.status !== "CANCELLED" && i.status !== "DRAFT" && i.issueDate >= from && i.issueDate <= to);
  return {
    received: round2(paid.reduce((s, i) => s + i.total, 0)),
    receivedCount: paid.length,
    billed: round2(billed.reduce((s, i) => s + i.total, 0)),
    billedCount: billed.length,
  };
}

/** Which reminder tone to use next, based on lateness and reminders already sent. */
export function suggestStage(inv: Invoice, today = todayISO()): ReminderStage {
  const od = daysOverdue(inv, today);
  const sent = inv.reminders.length;
  if (sent >= 2 || od >= 30) return "final";
  if (sent >= 1 || od >= 14) return "firm";
  return "nudge";
}

export const STAGE_LABEL: Record<ReminderStage, string> = {
  nudge: "Friendly nudge",
  firm: "Firm reminder",
  final: "Final notice",
};

/**
 * Late Payment of Commercial Debts (Interest) Act 1998: B2B only.
 * Statutory interest = 8% + Bank of England reference rate, simple, daily.
 * Fixed compensation: £40 (< £1,000), £70 (£1,000–£9,999.99), £100 (£10,000+).
 */
export function statutoryInterest(inv: Invoice, bankRate: number, today = todayISO()) {
  const od = Math.max(0, daysOverdue(inv, today));
  const debt = balance(inv);
  const ratePercent = round2(8 + bankRate);
  const interestToDate = round2(((debt * ratePercent) / 100 / 365) * od);
  const fixedCompensation = debt >= 10000 ? 100 : debt >= 1000 ? 70 : 40;
  const applies = inv.customerType === "business" && od > 0;
  return {
    applies,
    ratePercent,
    interestToDate,
    fixedCompensation,
    explanation: applies
      ? `Under the Late Payment of Commercial Debts (Interest) Act 1998 you can claim interest at ${ratePercent}% a year (8% + ${bankRate}% Bank of England base rate) — about £${interestToDate.toFixed(2)} so far — plus £${fixedCompensation} fixed compensation.`
      : "The Late Payment Act only covers business-to-business debts, so it isn't mentioned for a private customer.",
  };
}
