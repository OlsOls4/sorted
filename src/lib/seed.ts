// Seeded demo ledger: a Bristol plumbing & heating sole trader's last ~4 months.
// Dates are relative to "today" so overdue/aging always looks realistic.

import { addDays, computeTotals, todayISO } from "./format";
import type { CustomerType, Invoice, InvoiceStatus, LineItem, ReminderLog } from "./types";

interface SeedRow {
  name: string;
  email: string;
  type: CustomerType;
  job: string;
  hours: number;
  parts: number;
  issuedDaysAgo: number;
  terms: number;
  paidAfter?: number; // days after issue it was paid; undefined = unpaid
  vat?: boolean;
  reminders?: { daysAfterDue: number; stage: ReminderLog["stage"] }[];
  status?: InvoiceStatus;
}

const ROWS: SeedRow[] = [
  { name: "Mrs Priya Patel", email: "patel.r@example.com", type: "consumer", job: "Fitted 2 radiators, balanced system", hours: 4, parts: 86, issuedDaysAgo: 3, terms: 14 },
  { name: "Harbourside Lettings Ltd", email: "accounts@harbourside-lettings.example", type: "business", job: "Combi boiler swap, Flat 3 Cumberland Rd", hours: 9, parts: 1240, issuedDaysAgo: 58, terms: 30, reminders: [{ daysAfterDue: 3, stage: "nudge" }, { daysAfterDue: 17, stage: "firm" }] },
  { name: "Mr Gareth Evans", email: "gareth.evans@example.com", type: "consumer", job: "Unblocked kitchen waste, replaced trap", hours: 1.5, parts: 18.4, issuedDaysAgo: 33, terms: 14, reminders: [{ daysAfterDue: 4, stage: "nudge" }] },
  { name: "Clifton Village Café", email: "hello@cliftonvillagecafe.example", type: "business", job: "Installed hot water urn supply & isolation valve", hours: 3, parts: 64, issuedDaysAgo: 41, terms: 14, paidAfter: 12 },
  { name: "Mrs Joan Whitaker", email: "joan.whitaker@example.com", type: "consumer", job: "Annual boiler service + CO alarm", hours: 1, parts: 22, issuedDaysAgo: 52, terms: 14, paidAfter: 2 },
  { name: "Redland Property Management", email: "maintenance@redlandpm.example", type: "business", job: "Emergency leak repair, 14 Chandos Rd", hours: 2.5, parts: 37.5, issuedDaysAgo: 71, terms: 30, reminders: [{ daysAfterDue: 7, stage: "nudge" }, { daysAfterDue: 21, stage: "firm" }, { daysAfterDue: 35, stage: "final" }] },
  { name: "Mr Tom Briggs", email: "tom@briggs.example", type: "consumer", job: "Bathroom refit — first fix plumbing", hours: 14, parts: 412.8, issuedDaysAgo: 95, terms: 14, paidAfter: 26 },
  { name: "Ms Aisha Mensah", email: "aisha.mensah@example.com", type: "consumer", job: "Replaced kitchen mixer tap", hours: 1, parts: 89.99, issuedDaysAgo: 19, terms: 14, reminders: [] },
  { name: "Bedminster Builders Ltd", email: "payables@bedminsterbuilders.example", type: "business", job: "Subcontract: underfloor heating manifold, plot 7", hours: 16, parts: 685, issuedDaysAgo: 24, terms: 30, vat: false },
  { name: "Mr Daniel O'Connor", email: "dan.oconnor@example.com", type: "consumer", job: "Power flush, 8 radiators", hours: 6, parts: 45, issuedDaysAgo: 64, terms: 14, paidAfter: 9 },
  { name: "Mrs Helen Carter", email: "helen.carter@example.com", type: "consumer", job: "Outside tap fitted", hours: 1.5, parts: 34.2, issuedDaysAgo: 46, terms: 14, paidAfter: 35 },
  { name: "Southville Dental Surgery", email: "practice@southvilledental.example", type: "business", job: "Replaced thermostatic mixing valves x3", hours: 4, parts: 255, issuedDaysAgo: 37, terms: 30, paidAfter: 29 },
  { name: "Mr Ravi Sharma", email: "ravi.sharma@example.com", type: "consumer", job: "Radiator valves replaced (6)", hours: 3, parts: 72, issuedDaysAgo: 12, terms: 14 },
  { name: "Mrs Patel", email: "patel.r@example.com", type: "consumer", job: "Fixed dripping shower valve", hours: 1, parts: 15, issuedDaysAgo: 80, terms: 14, paidAfter: 6 },
  { name: "Harbourside Lettings Ltd", email: "accounts@harbourside-lettings.example", type: "business", job: "Gas safety certificates x4 flats", hours: 4, parts: 0, issuedDaysAgo: 110, terms: 30, paidAfter: 44 },
  { name: "Ms Chloe Davies", email: "chloe.davies@example.com", type: "consumer", job: "Toilet cistern replaced", hours: 2, parts: 118, issuedDaysAgo: 27, terms: 14, paidAfter: 4 },
  { name: "The Hope & Anchor", email: "landlord@hopeandanchor.example", type: "business", job: "Cellar drain jetting & trap replacement", hours: 3.5, parts: 48, issuedDaysAgo: 29, terms: 14, reminders: [{ daysAfterDue: 5, stage: "nudge" }] },
  { name: "Mr Kwame Asante", email: "k.asante@example.com", type: "consumer", job: "Boiler pressure fault, replaced PRV", hours: 2, parts: 46.5, issuedDaysAgo: 8, terms: 14, paidAfter: 1 },
  { name: "Mrs Sandra Lloyd", email: "sandra.lloyd@example.com", type: "consumer", job: "Kitchen sink & dishwasher plumbed in", hours: 3, parts: 58, issuedDaysAgo: 6, terms: 14 },
  { name: "Redland Property Management", email: "maintenance@redlandpm.example", type: "business", job: "Void property drain-down & winterise", hours: 2, parts: 0, issuedDaysAgo: 120, terms: 30, paidAfter: 52 },
  { name: "Mr Owen Price", email: "owen.price@example.com", type: "consumer", job: "Replaced immersion heater element", hours: 1.5, parts: 39, issuedDaysAgo: 15, terms: 14, status: "CANCELLED" },
];

export function seedInvoices(rate = 45, today = todayISO()): Invoice[] {
  return ROWS.map((r, i) => {
    const issueDate = addDays(today, -r.issuedDaysAgo);
    const dueDate = addDays(issueDate, r.terms);
    const items: LineItem[] = [
      { id: `seed_${i}_l`, kind: "labour", description: `Labour — ${r.job}`, quantity: r.hours, unitAmount: rate, unit: "HOURS" },
    ];
    if (r.parts > 0) items.push({ id: `seed_${i}_p`, kind: "parts", description: "Parts & materials", quantity: 1, unitAmount: r.parts, unit: "AMOUNT" });
    const t = computeTotals({ items, vatEnabled: !!r.vat, vatRate: 20 });
    const paid = r.paidAfter !== undefined;
    const paidDate = paid ? addDays(issueDate, r.paidAfter!) : undefined;
    const num = String(1001 + (ROWS.length - 1 - i)).padStart(4, "0");
    const id = `INV2-DEMO-${num}-${(i * 7919).toString(36).toUpperCase().padStart(4, "X")}`;
    return {
      id,
      number: `INV-${num}`,
      status: r.status ?? (paid ? "PAID" : "SENT"),
      customerName: r.name,
      customerEmail: r.email,
      customerType: r.type,
      jobSummary: r.job,
      items,
      vatEnabled: !!r.vat,
      vatRate: 20,
      currency: "GBP",
      subtotal: t.subtotal,
      vat: t.vat,
      total: t.total,
      amountPaid: paid ? t.total : 0,
      issueDate,
      dueDate,
      paidDate,
      payerViewUrl: `https://www.sandbox.paypal.com/invoice/p/#${id}`,
      merchantViewUrl: `https://www.sandbox.paypal.com/invoice/details/${id}`,
      reminders: (r.reminders ?? []).map((rm) => ({
        sentAt: `${addDays(dueDate, rm.daysAfterDue)}T09:30:00.000Z`,
        stage: rm.stage,
        subject: rm.stage === "nudge" ? "Friendly reminder" : rm.stage === "firm" ? "Payment now overdue" : "Final notice",
      })),
      source: "mock",
    } satisfies Invoice;
  }).sort((a, b) => b.issueDate.localeCompare(a.issueDate));
}
