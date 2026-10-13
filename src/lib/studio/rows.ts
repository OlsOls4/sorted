// Flattens Sorted's ledger into the tables the AG Studio "Money owed" dashboard reads.
// Pure and shared by client and server (and the unit tests).

import { balance, daysOverdue, daysToPay, displayStatus, isOpen, isPaid, round2, todayISO } from "../format";
import type { Invoice } from "../types";

export interface StudioInvoiceRow {
  id: string;
  number: string;
  customer: string;
  customerKey: string;
  customerType: string;
  job: string;
  area: string;
  city: string;
  status: string; // friendly: Paid, Overdue, Due soon, Sent, Cancelled...
  issueDate: string;
  issueMonth: string; // YYYY-MM
  dueDate: string;
  paidDate: string | null;
  total: number;
  paid: number;
  owed: number;
  overdueAmount: number;
  daysOverdue: number;
  agingBucket: string;
  isOpen: boolean;
  isOverdue: boolean;
  reminders: number;
  daysToPay: number | null;
}

export interface StudioPaymentRow {
  id: string;
  invoiceId: string;
  date: string;
  month: string; // YYYY-MM
  amount: number;
}

/** Ordered from calm to hot; the heat tile and the bucket filter use this order. */
export const AGING_BUCKETS = ["Not due yet", "1–14 days", "15–30 days", "31–60 days", "60+ days"] as const;

export function agingBucket(days: number): string {
  if (days <= 0) return AGING_BUCKETS[0];
  if (days <= 14) return AGING_BUCKETS[1];
  if (days <= 30) return AGING_BUCKETS[2];
  if (days <= 60) return AGING_BUCKETS[3];
  return AGING_BUCKETS[4];
}

// Neighbourhoods we can read straight off a customer name or job address.
const KNOWN_AREAS: [RegExp, string, string][] = [
  [/clifton/i, "Clifton", "Bristol"],
  [/redland|chandos/i, "Redland", "Bristol"],
  [/bedminster/i, "Bedminster", "Bristol"],
  [/southville/i, "Southville", "Bristol"],
  [/harbourside|cumberland r(?:oa)?d|spike island/i, "Harbourside", "Bristol"],
  [/easton/i, "Easton", "Bristol"],
  [/bishopston|gloucester r(?:oa)?d/i, "Bishopston", "Bristol"],
  [/totterdown/i, "Totterdown", "Bristol"],
  [/keynsham/i, "Keynsham", "Keynsham"],
  [/\bbath\b/i, "Bath", "Bath"],
];

// Demo-only: the seeded sample invoices carry no address, so each sample customer is given a
// stable area so the "Bristol" filters have something to bite on. Live PayPal invoices with no
// recognisable address stay "Unknown".
const SAMPLE_AREAS: [string, string][] = [
  ["Easton", "Bristol"],
  ["Bishopston", "Bristol"],
  ["Totterdown", "Bristol"],
  ["Keynsham", "Keynsham"],
  ["Henleaze", "Bristol"],
  ["Bath", "Bath"],
  ["Fishponds", "Bristol"],
  ["Knowle", "Bristol"],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function areaFor(inv: Pick<Invoice, "customerName" | "customerEmail" | "jobSummary" | "source">): { area: string; city: string } {
  const text = `${inv.customerName} ${inv.jobSummary}`;
  for (const [re, area, city] of KNOWN_AREAS) if (re.test(text)) return { area, city };
  if (inv.source === "mock") {
    const [area, city] = SAMPLE_AREAS[hash((inv.customerEmail || inv.customerName).toLowerCase()) % SAMPLE_AREAS.length];
    return { area, city };
  }
  return { area: "Unknown", city: "Unknown" };
}

export function toStudioRows(ledger: Invoice[], today = todayISO()): { invoices: StudioInvoiceRow[]; payments: StudioPaymentRow[] } {
  const invoices: StudioInvoiceRow[] = [];
  const payments: StudioPaymentRow[] = [];
  for (const inv of ledger) {
    if (inv.status === "DRAFT") continue;
    const owed = isOpen(inv) ? round2(balance(inv)) : 0;
    const od = owed > 0 ? Math.max(0, daysOverdue(inv, today)) : 0;
    const { area, city } = areaFor(inv);
    const paidTotal = isPaid(inv) ? inv.total : inv.amountPaid;
    invoices.push({
      id: inv.id,
      number: inv.number,
      customer: inv.customerName,
      customerKey: (inv.customerEmail || inv.customerName).toLowerCase(),
      customerType: inv.customerType === "business" ? "Business" : "Private",
      job: inv.jobSummary,
      area,
      city,
      status: displayStatus(inv, today),
      issueDate: inv.issueDate,
      issueMonth: inv.issueDate.slice(0, 7),
      dueDate: inv.dueDate,
      paidDate: inv.paidDate ?? null,
      total: round2(inv.total),
      paid: round2(paidTotal),
      owed,
      overdueAmount: od > 0 ? owed : 0,
      daysOverdue: od,
      agingBucket: owed > 0 ? agingBucket(od) : "Settled",
      isOpen: owed > 0,
      isOverdue: owed > 0 && od > 0,
      reminders: inv.reminders.length,
      daysToPay: daysToPay(inv) ?? null,
    });
    if (paidTotal > 0 && inv.status !== "CANCELLED") {
      const date = inv.paidDate ?? inv.issueDate;
      payments.push({ id: `pay_${inv.id}`, invoiceId: inv.id, date, month: date.slice(0, 7), amount: round2(paidTotal) });
    }
  }
  // One name per customer (the most descriptive), so "Mrs Patel" and "Mrs Priya Patel" score together.
  const names = new Map<string, string>();
  for (const r of invoices) if ((names.get(r.customerKey)?.length ?? 0) < r.customer.length) names.set(r.customerKey, r.customer);
  for (const r of invoices) r.customer = names.get(r.customerKey) ?? r.customer;
  return { invoices, payments };
}

/** The words Ask Sorted can filter on, read from the ledger itself. */
export interface StudioVocab {
  cities: string[];
  areas: string[];
  customers: string[];
}

export function vocabFor(rows: StudioInvoiceRow[]): StudioVocab {
  const uniq = (xs: string[]) => [...new Set(xs.filter((x) => x && x !== "Unknown"))].sort();
  return { cities: uniq(rows.map((r) => r.city)), areas: uniq(rows.map((r) => r.area)), customers: uniq(rows.map((r) => r.customer)) };
}
