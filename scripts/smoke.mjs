// Smoke test against a running Sorted server (demo mode).
// Usage: node scripts/smoke.mjs [baseUrl]   (default http://localhost:3000)
const B = process.argv[2] || "http://localhost:3000";
const H = { "content-type": "application/json", "x-sorted-mode": "demo" };
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

// Write routes need a server-signed approval (what the UI's confirm button mints).
function approvalFor(path) {
  if (path === "/api/invoices") return ["create_invoice", "new"];
  const m = path.match(/^\/api\/invoices\/([^/]+)\/(remind|mark-paid|cancel)$/);
  if (!m) return null;
  return [{ remind: "send_reminder", "mark-paid": "mark_paid", cancel: "cancel_invoice" }[m[2]], decodeURIComponent(m[1])];
}
const post = async (path, body) => {
  const appr = !("approval" in body) ? approvalFor(path) : null;
  if (appr) {
    const a = await fetch(B + "/api/approvals", { method: "POST", headers: H, body: JSON.stringify({ action: appr[0], invoiceId: appr[1] }) });
    body = { ...body, approval: (await a.json()).token };
  }
  const r = await fetch(B + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

const status = await (await fetch(B + "/api/status")).json();
ok(status.engine, `status: engine=${status.engine?.label}, liveAvailable=${status.liveAvailable}`);

const parsed = await post("/api/parse", { notes: "fitted 2 radiators for Mrs Patel, 4 hrs, parts £86, she's at patel.r@example.com" });
const d = parsed.json.draft;
ok(d?.customerName === "Mrs Patel" && d.customerEmail === "patel.r@example.com", "parse: customer + email");
ok(d?.items?.some((i) => i.unit === "HOURS" && i.quantity === 4 && i.unitAmount === 45), "parse: 4 hrs labour at £45");
ok(d?.items?.some((i) => i.kind === "parts" && i.unitAmount === 86), "parse: parts £86");
ok(d?.vatEnabled === false, "parse: VAT off by default");

const okafor = await post("/api/parse", {
  notes: "fixed leaking stopcock for mrs okafor at 12 cotham hill, 2.5 hrs plus new valve 18 quid, call out 45, she pays in 14 days, vat on top, email ngozi.okafor@example.com",
});
const od = okafor.json.draft;
ok(
  od && /okafor/i.test(od.customerName) && od.items.some((i) => i.unitAmount === 18) && od.items.some((i) => i.kind === "callout" && i.unitAmount === 45) &&
    od.items.some((i) => i.kind === "labour" && i.quantity === 2.5 && i.unitAmount === 45) && od.vatEnabled === true,
  `parse okafor note (${okafor.json.engine?.label}${okafor.json.cached ? ", cached" : ""}): ${od?.items?.map((i) => `${i.kind} ${i.quantity}×£${i.unitAmount}`).join(", ")}, VAT ${od?.vatEnabled}`,
);
ok(!(status.engine?.ai === false && okafor.json.engine?.ai === false && /no AI key/.test(okafor.json.engine?.label) && status.aiProviders?.length), "engine label says 'no AI key' only when no key is configured");

const list = await (await fetch(B + "/api/invoices", { headers: H })).json();
ok(list.invoices?.length >= 15, `ledger: ${list.invoices?.length} seeded invoices (${list.via})`);

const created = await post("/api/invoices", { draft: d, ledger: list.invoices });
ok(created.json.invoice?.status === "SENT" && created.json.invoice.total === 266, `create+send: ${created.json.invoice?.number} £${created.json.invoice?.total}`);

const bad = await post("/api/invoices", { draft: { customerName: "", customerEmail: "x", items: [], dueDate: "x" } });
ok(bad.status === 422, "create: validation rejects bad draft");
const noOk = await post("/api/invoices", { draft: d, ledger: list.invoices, approval: undefined });
const forged = await post("/api/invoices", { draft: d, ledger: list.invoices, approval: "eyJhIjoiY3JlYXRlX2ludm9pY2UifQ.forged" });
ok(noOk.status === 403 && forged.status === 403 && noOk.json.code === "APPROVAL_REQUIRED", "approval: writes without a valid server-signed approval are refused (403)");

const overdueBiz = list.invoices.find((i) => i.customerType === "business" && i.status === "SENT" && i.reminders.length >= 2);
const rem = await post("/api/reminders/draft", { invoice: overdueBiz, stage: "final" });
ok(/Late Payment of Commercial Debts/.test(rem.json.draft?.body), "reminder: final notice cites Late Payment Act for business");
const consumer = list.invoices.find((i) => i.customerType === "consumer" && i.status === "SENT");
const rem2 = await post("/api/reminders/draft", { invoice: consumer, stage: "final" });
ok(!/Late Payment of Commercial Debts/.test(rem2.json.draft?.body), "reminder: consumer final notice does NOT cite the Act");

ok(rem.json.draft?.body?.includes(overdueBiz.payerViewUrl) && /waive/i.test(rem.json.draft?.body ?? ""), "reminder: B2B final notice has the PayPal pay link and the pay-today interest waiver");
ok(rem2.json.draft?.body?.includes(consumer.payerViewUrl) && (consumer.total - consumer.amountPaid < 20 || /pay in 3/i.test(rem2.json.draft?.body ?? "")), "reminder: private customer gets the pay link and a hedged Pay in 3 mention");
const qrRes = await post(`/api/invoices/${encodeURIComponent(consumer.id)}/qr`, { invoice: { id: consumer.id } });
ok(/^data:image\/png;base64,/.test(qrRes.json.dataUrl ?? ""), "QR code for an invoice's pay link");
const payPage = await fetch(`${B}/pay/${encodeURIComponent(consumer.id)}`);
ok(payPage.status === 200, "customer view: mock payer page renders");
const sent = await post(`/api/invoices/${encodeURIComponent(overdueBiz.id)}/remind`, { invoice: overdueBiz, subject: rem.json.draft.subject, body: rem.json.draft.body });
ok(sent.json.invoice?.reminders?.length === overdueBiz.reminders.length + 1, "remind: logged on invoice");

const paid = await post(`/api/invoices/${encodeURIComponent(consumer.id)}/mark-paid`, { invoice: consumer });
ok(paid.json.invoice?.status === "MARKED_AS_PAID", "mark paid");

for (const [q, expect] of [
  ["who owes me what?", /owed|owe|outstanding/i],
  ["how much did I earn in October?", /received|earn|paid|£/i],
  ["who's the latest payer?", /latest payers|late|overdue|slow/i],
]) {
  const r = await post("/api/chat", { messages: [{ role: "user", content: q }], ledger: list.invoices });
  ok(expect.test(r.json.reply ?? ""), `chat "${q}" → ${r.json.engine?.id}, tools=${r.json.toolTrace?.map((t) => t.tool).join(",")}`);
}
const act = await post("/api/chat", { messages: [{ role: "user", content: "chase Harbourside" }], ledger: list.invoices });
ok(act.json.pendingAction?.type === "send_reminder" && !!act.json.pendingAction?.approvalToken, "chat: 'chase Harbourside' returns a reminder awaiting confirmation with a signed approval (nothing sent)");
const viaCard = act.json.pendingAction
  ? await post(`/api/invoices/${encodeURIComponent(act.json.pendingAction.invoiceId)}/remind`, {
      invoice: list.invoices.find((i) => i.id === act.json.pendingAction.invoiceId),
      subject: act.json.pendingAction.subject,
      body: act.json.pendingAction.body,
      approval: act.json.pendingAction.approvalToken,
    })
  : { status: 0 };
ok(viaCard.status === 200, "approval: the card's token lets the confirmed reminder through");
const qr = await post("/api/chat", { messages: [{ role: "user", content: "QR code for Harbourside's invoice" }], ledger: list.invoices });
ok(/^data:image\/png;base64,/.test(qr.json.qr?.dataUrl ?? ""), `chat: QR code via generate_invoice_qr_code (${qr.json.toolTrace?.map((t) => t.tool).join(",")})`);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
