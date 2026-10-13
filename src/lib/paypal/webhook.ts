// PayPal webhooks (server-only): signature verification + invoice payment events.
// Docs: https://developer.paypal.com/api/rest/webhooks/rest/#link-verifywebhooksignature

import "server-only";
import { eventMessage, lateness, type PaymentEvent } from "../events";
import { PayPalClient, isSandbox, type PayPalConfig, type PayPalInvoice } from "./client";
import { payPalToInvoice } from "./mapping";

export const HANDLED_EVENTS = ["INVOICING.INVOICE.PAID", "INVOICING.INVOICE.CANCELLED"] as const;

const HEADER_MAP = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

/** Asks PayPal to verify the event's signature. True only on verification_status SUCCESS. */
export async function verifyWebhook(cfg: PayPalConfig, headers: Headers, event: unknown, webhookId: string): Promise<{ ok: boolean; reason?: string }> {
  const fields: Record<string, string> = {};
  for (const [k, h] of Object.entries(HEADER_MAP)) {
    const v = headers.get(h);
    if (!v) return { ok: false, reason: `missing ${h} header` };
    fields[k] = v;
  }
  // Only accept PayPal-hosted signing certs.
  try {
    const host = new URL(fields.cert_url).hostname;
    if (!/(^|\.)paypal\.com$/.test(host)) return { ok: false, reason: "cert_url is not a paypal.com host" };
  } catch {
    return { ok: false, reason: "bad cert_url" };
  }
  const { data } = await new PayPalClient(cfg).request<{ verification_status?: string }>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    { ...fields, webhook_id: webhookId, webhook_event: event },
    { retries: 1 },
  );
  return data?.verification_status === "SUCCESS" ? { ok: true } : { ok: false, reason: `verification_status=${data?.verification_status ?? "unknown"}` };
}

/** Maps a verified INVOICING.* event to a Sorted payment event (null for types we ignore). */
export function toPaymentEvent(event: { event_type?: string; create_time?: string; resource?: unknown }, cfg: PayPalConfig | null): PaymentEvent | null {
  const type = event.event_type;
  if (type !== "INVOICING.INVOICE.PAID" && type !== "INVOICING.INVOICE.CANCELLED") return null;
  const res = (event.resource ?? {}) as { invoice?: PayPalInvoice } & PayPalInvoice;
  const raw = res.invoice ?? res;
  if (!raw?.id || !raw.detail) return null;
  const inv = payPalToInvoice(raw as PayPalInvoice, cfg ? isSandbox(cfg) : true);
  const kind = type === "INVOICING.INVOICE.PAID" ? "paid" : "cancelled";
  const paidDate = kind === "paid" ? (inv.paidDate ?? event.create_time?.slice(0, 10)) : undefined;
  const daysLate = kind === "paid" ? lateness(inv.dueDate, paidDate) : undefined;
  const base = { kind, invoiceId: inv.id, invoiceNumber: inv.number, customerName: inv.customerName, amount: inv.total, daysLate } as const;
  return { ...base, dueDate: inv.dueDate, paidDate, source: "paypal-webhook", at: event.create_time ?? new Date().toISOString(), message: eventMessage(base) };
}

// Recent events, per server instance (no database). The browser also diffs the
// ledger on every live sync, so a missed webhook still shows up within a minute.
const recent: PaymentEvent[] = [];
const seenIds = new Set<string>();
let seq = 0;

export function recordEvent(e: PaymentEvent, eventId?: string): PaymentEvent | null {
  if (eventId) {
    if (seenIds.has(eventId)) return null; // PayPal retries deliveries
    seenIds.add(eventId);
    if (seenIds.size > 1000) seenIds.clear();
  }
  const withSeq = { ...e, seq: ++seq };
  recent.push(withSeq);
  if (recent.length > 50) recent.shift();
  return withSeq;
}

export function eventsSince(since: number): { events: PaymentEvent[]; seq: number } {
  return { events: recent.filter((e) => (e.seq ?? 0) > since), seq };
}
