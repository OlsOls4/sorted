// Register (or show) the PayPal sandbox webhook that feeds /api/paypal/webhook.
// Usage:
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/register-webhook.mjs [url]
//   NODE_USE_ENV_PROXY=1 PAYPAL_AUTH_VIA_PROXY=1 node scripts/register-webhook.mjs   (Hark dev sandbox)
// Prints the webhook id: set it as PAYPAL_WEBHOOK_ID on the server (Vercel).
const BASE = "https://api-m.sandbox.paypal.com";
const url = process.argv[2] || "https://sorted-paypal.vercel.app/api/paypal/webhook";
const EVENTS = ["INVOICING.INVOICE.PAID", "INVOICING.INVOICE.CANCELLED"];

const headers = { "Content-Type": "application/x-www-form-urlencoded" };
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (id && secret) headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
else if (process.env.PAYPAL_AUTH_VIA_PROXY !== "1") throw new Error("Set PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET (sandbox) or PAYPAL_AUTH_VIA_PROXY=1.");
const tok = (await (await fetch(`${BASE}/v1/oauth2/token`, { method: "POST", headers, body: "grant_type=client_credentials" })).json()).access_token;
if (!tok) throw new Error("PayPal auth failed");
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

const list = await (await fetch(`${BASE}/v1/notifications/webhooks`, { headers: H })).json();
let hook = list.webhooks?.find((w) => w.url === url);
if (hook) {
  const have = new Set(hook.event_types.map((e) => e.name));
  if (!EVENTS.every((e) => have.has(e))) {
    const r = await fetch(`${BASE}/v1/notifications/webhooks/${hook.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify([{ op: "replace", path: "/event_types", value: EVENTS.map((name) => ({ name })) }]),
    });
    hook = await r.json();
  }
  console.log(`Webhook already registered: ${hook.id} → ${url}`);
} else {
  const r = await fetch(`${BASE}/v1/notifications/webhooks`, { method: "POST", headers: H, body: JSON.stringify({ url, event_types: EVENTS.map((name) => ({ name })) }) });
  hook = await r.json();
  if (!r.ok) throw new Error(`Register failed (${r.status}): ${JSON.stringify(hook)}`);
  console.log(`Registered webhook ${hook.id} → ${url}`);
}
console.log(`Events: ${hook.event_types?.map((e) => e.name).join(", ")}`);
console.log(`\nSet on the server:  PAYPAL_WEBHOOK_ID=${hook.id}`);
