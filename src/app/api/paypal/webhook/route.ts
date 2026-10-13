import { paypalConfigFromEnv } from "@/lib/paypal/client";
import { HANDLED_EVENTS, recordEvent, toPaymentEvent, verifyWebhook } from "@/lib/paypal/webhook";

export const dynamic = "force-dynamic";

/**
 * PayPal webhook receiver for the server's own sandbox app.
 * Every event is verified with PayPal (POST /v1/notifications/verify-webhook-signature,
 * webhook id from PAYPAL_WEBHOOK_ID) before it is trusted. INVOICING.INVOICE.PAID and
 * INVOICING.INVOICE.CANCELLED become ledger events the dashboard picks up
 * ("Dave Bennett paid £182, 9 days late"), which flips the row and stops chasing.
 */
export async function POST(req: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
  const cfg = paypalConfigFromEnv();
  if (!webhookId || !cfg) {
    return Response.json({ error: "Webhook not configured (needs PAYPAL_WEBHOOK_ID and server PayPal credentials)." }, { status: 503 });
  }
  const raw = await req.text();
  if (raw.length > 256_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  let event: { id?: string; event_type?: string; create_time?: string; resource?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let verdict;
  try {
    verdict = await verifyWebhook(cfg, req.headers, event, webhookId);
  } catch (e) {
    // PayPal unreachable: ask PayPal to retry later.
    return Response.json({ error: `Couldn't verify with PayPal: ${(e as Error).message}` }, { status: 502 });
  }
  if (!verdict.ok) return Response.json({ error: `Signature verification failed (${verdict.reason})` }, { status: 400 });
  if (!HANDLED_EVENTS.includes(event.event_type as (typeof HANDLED_EVENTS)[number])) {
    return Response.json({ ok: true, ignored: event.event_type ?? "unknown" });
  }
  const pe = toPaymentEvent(event, cfg);
  const stored = pe ? recordEvent(pe, event.id) : null;
  return Response.json({ ok: true, handled: event.event_type, message: pe?.message ?? null, duplicate: !!pe && !stored });
}

export async function GET() {
  return Response.json({
    endpoint: "PayPal webhook receiver",
    configured: !!(process.env.PAYPAL_WEBHOOK_ID && paypalConfigFromEnv()),
    events: HANDLED_EVENTS,
  });
}
