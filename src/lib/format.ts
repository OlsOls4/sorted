import type { Invoice, InvoiceDraft, LineItem } from "./types";

export const gbp = (n: number, opts: { pence?: boolean } = {}) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: opts.pence === false ? 0 : 2,
    maximumFractionDigits: opts.pence === false ? 0 : 2,
  }).format(Number.isFinite(n) ? n : 0);

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Today's date in Europe/London as YYYY-MM-DD. */
export function todayISO(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 timestamp built from UTC parts (avoids relying on Date#toISOString). */
export function isoTimestamp(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}Z`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days, 12));
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export function daysBetween(fromISO: string, toISO: string): number {
  const u = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const a = u(fromISO);
  const b = u(toISO);
  return Math.round((b - a) / 86_400_000);
}

export function ukDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function lineTotal(li: LineItem): number {
  return round2(li.quantity * li.unitAmount);
}

export function computeTotals(d: Pick<InvoiceDraft, "items" | "vatEnabled" | "vatRate">) {
  const subtotal = round2(d.items.reduce((s, li) => s + lineTotal(li), 0));
  const vat = d.vatEnabled ? round2((subtotal * d.vatRate) / 100) : 0;
  return { subtotal, vat, total: round2(subtotal + vat) };
}

export const OPEN_STATUSES = new Set(["SENT", "UNPAID", "SCHEDULED", "PAYMENT_PENDING", "PARTIALLY_PAID"]);
export const PAID_STATUSES = new Set(["PAID", "MARKED_AS_PAID"]);

export function isOpen(inv: Invoice) {
  return OPEN_STATUSES.has(inv.status);
}
export function isPaid(inv: Invoice) {
  return PAID_STATUSES.has(inv.status);
}

/** Outstanding balance (0 for paid/cancelled/draft). */
export function balance(inv: Invoice): number {
  if (!isOpen(inv)) return 0;
  return round2(Math.max(0, inv.total - inv.amountPaid));
}

/** Days past due date (only for open invoices). Negative = not yet due. */
export function daysOverdue(inv: Invoice, today = todayISO()): number {
  if (!isOpen(inv)) return 0;
  return daysBetween(inv.dueDate, today);
}

export type DisplayStatus = "Draft" | "Sent" | "Due soon" | "Overdue" | "Paid" | "Part paid" | "Cancelled" | "Refunded";

export function displayStatus(inv: Invoice, today = todayISO()): DisplayStatus {
  if (isPaid(inv)) return "Paid";
  if (inv.status === "DRAFT") return "Draft";
  if (inv.status === "CANCELLED") return "Cancelled";
  if (inv.status.includes("REFUNDED")) return "Refunded";
  const od = daysOverdue(inv, today);
  if (od > 0) return "Overdue";
  if (inv.status === "PARTIALLY_PAID") return "Part paid";
  if (od >= -3) return "Due soon";
  return "Sent";
}

/** Days it took to get paid (issue -> paid), for paid invoices. */
export function daysToPay(inv: Invoice): number | undefined {
  if (!isPaid(inv) || !inv.paidDate) return undefined;
  return daysBetween(inv.issueDate, inv.paidDate);
}

export function uid(prefix = ""): string {
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${r}`;
}

// ---- Pay links ----

/** Public site URL, used for the demo's mock payer page (/pay/<id>) in reminders and QR codes. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://sorted-paypal.vercel.app").replace(/\/$/, "");

/** Demo invoices point at Sorted's mock PayPal payer page; real ones use PayPal's recipient_view_url. */
export function demoPayLink(id: string): string {
  return `${SITE_URL}/pay/${encodeURIComponent(id)}`;
}

/** PayPal Pay in 3 range for UK buyers (PayPal UK: eligible purchases £20 to £3,000, subject to status). */
export const PAY_IN_3 = { min: 20, max: 3000 };

/** True when a private customer's balance is in the Pay in 3 range. Eligibility is still PayPal's call. */
export function payLaterEligible(inv: Pick<Invoice, "customerType" | "total" | "amountPaid">): boolean {
  const due = round2(inv.total - inv.amountPaid);
  return inv.customerType === "consumer" && due >= PAY_IN_3.min && due <= PAY_IN_3.max;
}
