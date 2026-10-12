#!/usr/bin/env node
// Live PayPal SANDBOX end-to-end check of Sorted's own API routes.
// Needs a running server whose env has PayPal creds (or PAYPAL_AUTH_VIA_PROXY=1).
// Usage: node scripts/live-e2e.mjs [baseUrl]   (default http://localhost:3000)
// Creates real sandbox invoices to sb-*@example.com addresses, labelled [E2E].
// It leaves them in the sandbox: cancel/delete them afterwards (see docs/status.md).

const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const H = { "Content-Type": "application/json", "x-sorted-mode": "live" };
let failures = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
};
async function call(path, body, method) {
  const res = await fetch(BASE + path, { method: method ?? (body ? "POST" : "GET"), headers: H, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const iso = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d); // YYYY-MM-DD, UK date
const today = new Date();
const plus = (n) => iso(new Date(today.getTime() + n * 86400000));

const settings = { businessName: "Dave Harris Plumbing & Heating", traderName: "Dave Harris", hourlyRate: 45, vatRegistered: true };

const st = await call("/api/status");
ok(st.data.liveAvailable === true && st.data.credSource === "server", "status: live available via server creds", JSON.stringify({ env: st.data.paypalEnv, src: st.data.credSource }));

const ver = await call("/api/paypal/verify", {});
ok(ver.status === 200 && ver.data.ok, "verify: OAuth + invoice list", `existing=${ver.data.invoiceCount} ${ver.data.error ?? ""}`);

// 1. consumer, VAT, hours + parts
const draft1 = {
  customerName: "Mrs Sarah Jones",
  customerEmail: "sb-sarah.e2e@example.com",
  customerType: "consumer",
  jobSummary: "[E2E] Replace kitchen mixer tap",
  items: [
    { id: "a", kind: "labour", description: "Labour", quantity: 2.5, unitAmount: 45, unit: "HOURS" },
    { id: "b", kind: "parts", description: "Parts: mixer tap", quantity: 1, unitAmount: 62.5, unit: "QUANTITY" },
  ],
  vatEnabled: true,
  vatRate: 20,
  currency: "GBP",
  issueDate: iso(today),
  dueDate: plus(14),
  note: "[E2E test] Thanks for choosing Dave Harris Plumbing.",
};
const c1 = await call("/api/invoices", { draft: draft1, settings });
const i1 = c1.data.invoice;
ok(c1.status === 200 && i1?.id?.startsWith("INV2-"), "create+send consumer invoice", `${c1.status} ${i1?.id ?? c1.data.error}`);
if (i1) {
  ok(i1.status === "SENT", "status SENT", i1.status);
  ok(i1.subtotal === 175 && i1.vat === 35 && i1.total === 210, "amounts 175 + 35 VAT = 210", `${i1.subtotal}/${i1.vat}/${i1.total}`);
  ok(i1.dueDate === draft1.dueDate && i1.issueDate === draft1.issueDate, "dates round-trip", `${i1.issueDate} → ${i1.dueDate}`);
  ok(i1.customerName === "Sarah Jones" && i1.customerType === "consumer", "customer mapped", `${i1.customerName}/${i1.customerType}`);
  ok(i1.items.length === 2 && i1.items[0].unit === "HOURS", "items mapped", JSON.stringify(i1.items.map((x) => [x.description, x.quantity, x.unitAmount, x.unit])));
  ok(!!i1.payerViewUrl && i1.payerViewUrl.includes("sandbox.paypal.com"), "payer link", i1.payerViewUrl);
  ok(i1.jobSummary === draft1.jobSummary, "job summary from memo", i1.jobSummary);
}

// 2. business, no VAT, overdue (past due date) for the late-payer path
const draft2 = {
  customerName: "Acme Lettings Ltd",
  customerEmail: "sb-acme.e2e@example.com",
  customerType: "business",
  jobSummary: "[E2E] Emergency call-out, burst pipe",
  items: [
    { id: "a", kind: "callout", description: "Emergency call-out", quantity: 1, unitAmount: 85, unit: "AMOUNT" },
    { id: "b", kind: "labour", description: "Labour", quantity: 1.5, unitAmount: 45, unit: "HOURS" },
  ],
  vatEnabled: false,
  vatRate: 20,
  currency: "GBP",
  issueDate: plus(-40),
  dueDate: plus(-10),
};
const c2 = await call("/api/invoices", { draft: draft2, settings });
const i2 = c2.data.invoice;
ok(c2.status === 200 && !!i2?.id, "create+send business invoice (past due)", `${c2.status} ${i2?.id ?? c2.data.error}`);
if (i2) {
  ok(i2.total === 152.5 && i2.vat === 0 && !i2.vatEnabled, "no-VAT total 152.50", `${i2.subtotal}/${i2.vat}/${i2.total}`);
  ok(i2.customerName === "Acme Lettings Ltd" && i2.customerType === "business", "business recipient", `${i2.customerName}/${i2.customerType}`);
}

// 3. list (hydrated)
const l = await call("/api/invoices");
const list = l.data.invoices ?? [];
const l1 = list.find((x) => x.id === i1?.id);
ok(l.status === 200 && l.data.via === "paypal-rest" && !!l1, "list includes new invoice", `${list.length} invoices, via ${l.data.via}`);
if (l1) ok(l1.vat === 35 && l1.subtotal === 175 && l1.items.length === 2, "list row hydrated (VAT/items)", `${l1.subtotal}/${l1.vat} items=${l1.items.length}`);

// 4. remind (toolkit first, REST fallback)
if (i2) {
  const r = await call(`/api/invoices/${encodeURIComponent(i2.id)}/remind`, {
    subject: "[E2E] Reminder: invoice overdue",
    body: "Hi, just a reminder this invoice is now overdue. Thanks, Dave",
    invoice: i2,
  });
  ok(r.status === 200 && r.data.invoice?.reminders?.length === 1, "remind", `${r.status} via ${r.data.via} ${r.data.error ?? ""}`);
}

// 5. mark paid (records external payment)
if (i1) {
  const p = await call(`/api/invoices/${encodeURIComponent(i1.id)}/mark-paid`, { invoice: i1 });
  const pi = p.data.invoice;
  ok(p.status === 200 && pi?.status === "MARKED_AS_PAID" && pi.amountPaid === 210, "mark paid", `${p.status} ${pi?.status} paid=${pi?.amountPaid} date=${pi?.paidDate} ${p.data.error ?? ""}`);
}

// 6. Ask Sorted over live data
const ch = await call("/api/chat", { messages: [{ role: "user", content: "Who owes me what?" }], settings, ledger: [] });
const trace = (ch.data.toolTrace ?? []).map((t) => `${t.tool}${t.via ? `[${t.via}]` : ""}`).join(", ");
ok(ch.status === 200 && /Acme/i.test(ch.data.reply ?? ch.data.content ?? JSON.stringify(ch.data)), "Ask Sorted 'who owes me what' sees live Acme invoice", trace);
console.log("      reply:", String(ch.data.reply ?? ch.data.content ?? "").slice(0, 400).replace(/\n/g, " | "));

// 7. validation + error mapping
const bad = await call("/api/invoices", { draft: { ...draft1, customerEmail: "nope" }, settings });
ok(bad.status === 422, "invalid draft rejected before PayPal", String(bad.status));

console.log(`\nCreated: ${[i1?.id, i2?.id].filter(Boolean).join(", ")}`);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
