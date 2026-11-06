// Payment events ("Dave Bennett paid £182, 9 days late") shared by the webhook
// handler (server), the live-sync diff and the demo payer page (browser).

import { daysBetween, gbp, todayISO } from "./format";
import type { Invoice } from "./types";

export type PaymentEventKind = "paid" | "part_paid" | "cancelled";

export interface PaymentEvent {
  seq?: number;
  kind: PaymentEventKind;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  amount: number;
  dueDate?: string;
  paidDate?: string;
  daysLate?: number; // >0 late, 0 on time, <0 early
  /** part_paid: total paid so far and what is left. */
  amountPaid?: number;
  remaining?: number;
  source: "paypal-webhook" | "paypal-sync" | "demo";
  at: string; // ISO
  message: string;
}

const money = (n: number) => (Number.isInteger(n) ? gbp(n, { pence: false }) : gbp(n));

export function lateness(dueDate: string | undefined, paidDate: string | undefined): number | undefined {
  if (!dueDate || !paidDate) return undefined;
  return daysBetween(dueDate, paidDate);
}

export function eventMessage(e: Pick<PaymentEvent, "kind" | "customerName" | "amount" | "invoiceNumber" | "daysLate" | "amountPaid" | "remaining">): string {
  if (e.kind === "part_paid") return `${e.customerName} made a part payment on ${e.invoiceNumber}: ${gbp(e.amountPaid ?? 0)} paid so far, ${gbp(e.remaining ?? 0)} left.`;
  if (e.kind === "cancelled") return `${e.invoiceNumber} for ${e.customerName} was cancelled. Chasing stopped.`;
  const d = e.daysLate;
  const when = d === undefined ? "" : d > 0 ? `, ${d} day${d === 1 ? "" : "s"} late` : d === 0 ? ", on the due date" : `, ${-d} day${d === -1 ? "" : "s"} early`;
  return `${e.customerName} paid ${money(e.amount)}${when} (${e.invoiceNumber}).${d !== undefined && d > 0 ? " Chasing stopped." : ""}`;
}

export function eventFromInvoice(inv: Invoice, kind: PaymentEventKind, source: PaymentEvent["source"]): PaymentEvent {
  if (kind === "part_paid") {
    const remaining = Math.max(0, Math.round((inv.total - inv.amountPaid) * 100) / 100);
    const base = { kind, invoiceId: inv.id, invoiceNumber: inv.number, customerName: inv.customerName, amount: inv.total, dueDate: inv.dueDate, amountPaid: inv.amountPaid, remaining };
    return { ...base, source, at: new Date().toISOString(), message: eventMessage(base) };
  }
  const paidDate = kind === "paid" ? (inv.paidDate ?? todayISO()) : undefined;
  const daysLate = kind === "paid" ? lateness(inv.dueDate, paidDate) : undefined;
  const base = { kind, invoiceId: inv.id, invoiceNumber: inv.number, customerName: inv.customerName, amount: inv.total, dueDate: inv.dueDate, paidDate, daysLate };
  return { ...base, source, at: new Date().toISOString(), message: eventMessage(base) };
}

const PAIDISH = new Set(["PAID", "MARKED_AS_PAID"]);

/** Compare two snapshots of the ledger and report invoices that became paid, part paid (more paid) or cancelled. */
export function diffLedger(before: Invoice[], after: Invoice[], source: PaymentEvent["source"] = "paypal-sync"): PaymentEvent[] {
  const prev = new Map(before.map((i) => [i.id, i]));
  const out: PaymentEvent[] = [];
  for (const inv of after) {
    const old = prev.get(inv.id);
    const was = old?.status;
    if (!old || !was) continue;
    if (inv.status === "PARTIALLY_PAID" && !PAIDISH.has(was) && inv.amountPaid > old.amountPaid) {
      out.push(eventFromInvoice(inv, "part_paid", source));
      continue;
    }
    if (was === inv.status) continue;
    if (PAIDISH.has(inv.status) && !PAIDISH.has(was)) out.push(eventFromInvoice(inv, "paid", source));
    else if (inv.status === "CANCELLED" && was !== "CANCELLED") out.push(eventFromInvoice(inv, "cancelled", source));
  }
  return out;
}
