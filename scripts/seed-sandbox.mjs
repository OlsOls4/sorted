// Seed (or reset) the PayPal sandbox account behind the live demo with a small,
// realistic ledger for "Dave Harris Plumbing & Heating", dated relative to today.
//
// Usage:
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/seed-sandbox.mjs [--reset] [--dry-run]
//   # inside the Hark dev sandbox (auth injected by the egress proxy):
//   NODE_USE_ENV_PROXY=1 PAYPAL_AUTH_VIA_PROXY=1 node scripts/seed-sandbox.mjs --reset [--fresh]
//
// Idempotent: every seeded invoice carries "[Sorted demo:<key>]" in its memo, and
// an invoice that already exists in the right state is left alone.
// --reset also tidies up after a demo: cancels + deletes other invoices that Sorted
// created (memo starts "Created by Sorted"), and re-creates any seeded invoice whose
// state drifted (e.g. Dave was marked paid on camera). Sandbox only, always.
const BASE = "https://api-m.sandbox.paypal.com";
const args = new Set(process.argv.slice(2));
const RESET = args.has("--reset");
const DRY = args.has("--dry-run");
const FRESH = args.has("--fresh"); // with --reset: also re-create seeded invoices that look fine

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// key, customer, email, business?, items [name, qty, unit, uom], vat, issued (days ago), terms (days), target state
const SEED = [
  { key: "sarah", name: "Sarah Jones", email: "sb-sarah.jones@example.com", biz: false, items: [["Replace kitchen tap", 1, 50, "QUANTITY"], ["Labour", 1, 45, "HOURS"]], vat: false, issued: -24, terms: 14, state: "paid" },
  { key: "harbourside", name: "Harbourside Lettings Ltd", email: "sb-accounts.harbourside@example.com", biz: true, items: [["Boiler service, Flat 3", 1, 85, "QUANTITY"], ["Labour", 3, 45, "HOURS"], ["Pressure relief valve", 1, 35, "QUANTITY"]], vat: true, issued: -42, terms: 14, state: "overdue", reminders: 1 },
  { key: "tom", name: "Tom Patel", email: "sb-tom.patel@example.com", biz: false, items: [["Labour", 4, 45, "HOURS"]], vat: false, issued: 0, terms: 14, state: "open" },
  { key: "dave", name: "Dave Bennett", email: "sb-dave.bennett@example.com", biz: false, items: [["Radiator valves x4", 1, 92, "QUANTITY"], ["Labour", 2, 45, "HOURS"]], vat: false, issued: -23, terms: 14, state: "overdue" },
  { key: "redland", name: "Redland Property Management Ltd", email: "sb-accounts.redland@example.com", biz: true, items: [["Emergency leak call-out", 1, 120, "QUANTITY"], ["Labour", 5, 45, "HOURS"], ["Copper pipe and fittings", 1, 64.5, "QUANTITY"]], vat: true, issued: -61, terms: 30, state: "overdue", reminders: 2 },
];

let tokenCache;
async function token() {
  if (tokenCache) return tokenCache;
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (id && secret) headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  else if (process.env.PAYPAL_AUTH_VIA_PROXY !== "1") throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox), or PAYPAL_AUTH_VIA_PROXY=1 in the dev sandbox.");
  const r = await fetch(`${BASE}/v1/oauth2/token`, { method: "POST", headers, body: "grant_type=client_credentials" });
  const j = await r.json();
  if (!j.access_token) throw new Error(`PayPal auth failed (${r.status}): ${j.error_description ?? j.error}`);
  return (tokenCache = j.access_token);
}
async function pp(method, path, body) {
  if (DRY && method !== "GET") {
    console.log(`  [dry-run] ${method} ${path}`);
    return {};
  }
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...(method === "POST" ? { "PayPal-Request-Id": crypto.randomUUID(), Prefer: "return=representation" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${data.name ?? ""} ${data.message ?? ""} ${JSON.stringify(data.details ?? "")}`);
  return data;
}

function payload(s) {
  const [given, ...rest] = s.name.split(" ");
  return {
    detail: {
      invoice_date: day(s.issued),
      currency_code: "GBP",
      note: "Thank you for your business — Dave Harris Plumbing & Heating",
      memo: `Created by Sorted from job notes: [Sorted demo:${s.key}] ${s.items[0][0]}`,
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: day(s.issued + s.terms) },
    },
    invoicer: { business_name: "Dave Harris Plumbing & Heating", name: { given_name: "Dave", surname: "Harris" } },
    primary_recipients: [
      {
        billing_info: {
          ...(s.biz ? { business_name: s.name, name: { given_name: "Accounts", surname: "Department" } } : { name: { given_name: given, surname: rest.join(" ") } }),
          email_address: s.email,
          language: "en-GB",
        },
      },
    ],
    items: s.items.map(([name, qty, unit, uom]) => ({
      name,
      quantity: String(qty),
      unit_amount: { currency_code: "GBP", value: unit.toFixed(2) },
      unit_of_measure: uom,
      ...(s.vat ? { tax: { name: "VAT", percent: "20" } } : {}),
    })),
    configuration: { partial_payment: { allow_partial_payment: false }, allow_tip: false, tax_inclusive: false },
  };
}

async function listAll() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const d = await pp("GET", `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`);
    out.push(...(d.items ?? []));
    if (!d.total_pages || page >= d.total_pages) break;
  }
  // summaries lack the memo, so fetch each
  return Promise.all(out.map((i) => pp("GET", `/v2/invoicing/invoices/${i.id}`)));
}

async function removeInvoice(inv) {
  const id = inv.id;
  if (inv.status === "PAID") {
    console.log(`  ! ${inv.detail.invoice_number} was paid through PayPal; leaving it (refund it in the sandbox dashboard to remove).`);
    return false;
  }
  for (const t of inv.payments?.transactions ?? []) {
    if (t.payment_id?.startsWith("EXTR")) await pp("DELETE", `/v2/invoicing/invoices/${id}/payments/${t.payment_id}`).catch(() => {});
  }
  if (!["DRAFT", "CANCELLED"].includes(inv.status)) await pp("POST", `/v2/invoicing/invoices/${id}/cancel`, { send_to_invoicer: false, send_to_recipient: false }).catch((e) => console.log(`  cancel: ${e.message}`));
  await pp("DELETE", `/v2/invoicing/invoices/${id}`);
  return true;
}

const want = (s) => (s.state === "paid" ? ["MARKED_AS_PAID", "PAID"] : ["SENT", "UNPAID"]);

const all = await listAll();
console.log(`Sandbox has ${all.length} invoice(s).`);
const byKey = new Map();
for (const inv of all) {
  const k = inv.detail?.memo?.match(/\[Sorted demo:([a-z]+)\]/)?.[1];
  if (k) byKey.set(k, inv);
}

if (RESET) {
  for (const inv of all) {
    const k = inv.detail?.memo?.match(/\[Sorted demo:([a-z]+)\]/)?.[1];
    const isSorted = /^Created by Sorted/.test(inv.detail?.memo ?? "") || /\[Sorted demo\]/.test(inv.detail?.memo ?? "");
    const s = SEED.find((x) => x.key === k);
    if (s && want(s).includes(inv.status) && !FRESH) continue;
    if (!isSorted && !s) continue;
    console.log(`- removing ${inv.detail.invoice_number} (${inv.status}) ${inv.detail.memo?.slice(0, 60)}`);
    if (await removeInvoice(inv)) byKey.delete(k);
  }
}

for (const s of SEED) {
  if (byKey.has(s.key)) {
    console.log(`= ${s.key}: ${byKey.get(s.key).detail.invoice_number} ${byKey.get(s.key).status}`);
    continue;
  }
  const created = await pp("POST", "/v2/invoicing/invoices", payload(s));
  const id = created.id ?? created.href?.split("/").pop();
  if (DRY) continue;
  await pp("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: true });
  for (let i = 0; i < (s.reminders ?? 0); i++) {
    await pp("POST", `/v2/invoicing/invoices/${id}/remind`, { subject: "Payment reminder", note: "A quick reminder that this invoice is overdue.", send_to_invoicer: false });
  }
  if (s.state === "paid") {
    const full = await pp("GET", `/v2/invoicing/invoices/${id}`);
    await pp("POST", `/v2/invoicing/invoices/${id}/payments`, { method: "BANK_TRANSFER", payment_date: day(s.issued + 9), amount: full.amount, note: "Recorded via Sorted" });
  }
  const fresh = await pp("GET", `/v2/invoicing/invoices/${id}`);
  console.log(`+ ${s.key}: ${fresh.detail.invoice_number} ${fresh.status} £${fresh.amount?.value} due ${fresh.detail.payment_term?.due_date}`);
}
console.log("Done.");
