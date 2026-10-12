// Smoke test against a running Sorted server (demo mode).
// Usage: node scripts/smoke.mjs [baseUrl]   (default http://localhost:3000)
const B = process.argv[2] || "http://localhost:3000";
const H = { "content-type": "application/json", "x-sorted-mode": "demo" };
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const post = async (path, body) => {
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

const list = await (await fetch(B + "/api/invoices", { headers: H })).json();
ok(list.invoices?.length >= 15, `ledger: ${list.invoices?.length} seeded invoices (${list.via})`);

const created = await post("/api/invoices", { draft: d, ledger: list.invoices });
ok(created.json.invoice?.status === "SENT" && created.json.invoice.total === 266, `create+send: ${created.json.invoice?.number} £${created.json.invoice?.total}`);

const bad = await post("/api/invoices", { draft: { customerName: "", customerEmail: "x", items: [], dueDate: "x" } });
ok(bad.status === 422, "create: validation rejects bad draft");

const overdueBiz = list.invoices.find((i) => i.customerType === "business" && i.status === "SENT" && i.reminders.length >= 2);
const rem = await post("/api/reminders/draft", { invoice: overdueBiz, stage: "final" });
ok(/Late Payment of Commercial Debts/.test(rem.json.draft?.body), "reminder: final notice cites Late Payment Act for business");
const consumer = list.invoices.find((i) => i.customerType === "consumer" && i.status === "SENT");
const rem2 = await post("/api/reminders/draft", { invoice: consumer, stage: "final" });
ok(!/Late Payment of Commercial Debts/.test(rem2.json.draft?.body), "reminder: consumer final notice does NOT cite the Act");

const sent = await post(`/api/invoices/${encodeURIComponent(overdueBiz.id)}/remind`, { invoice: overdueBiz, subject: rem.json.draft.subject, body: rem.json.draft.body });
ok(sent.json.invoice?.reminders?.length === overdueBiz.reminders.length + 1, "remind: logged on invoice");

const paid = await post(`/api/invoices/${encodeURIComponent(consumer.id)}/mark-paid`, { invoice: consumer });
ok(paid.json.invoice?.status === "MARKED_AS_PAID", "mark paid");

for (const [q, expect] of [
  ["who owes me what?", /owed/i],
  ["how much did I earn in October?", /received/i],
  ["who's the latest payer?", /latest payers/i],
  ["what's overdue?", /overdue/i],
]) {
  const r = await post("/api/chat", { messages: [{ role: "user", content: q }], ledger: list.invoices });
  ok(expect.test(r.json.reply ?? ""), `chat "${q}" → ${r.json.engine?.id}, tools=${r.json.toolTrace?.map((t) => t.tool).join(",")}`);
}
const act = await post("/api/chat", { messages: [{ role: "user", content: "chase Harbourside" }], ledger: list.invoices });
ok(act.json.pendingAction?.type === "send_reminder", "chat: 'chase Harbourside' returns a reminder awaiting confirmation (nothing sent)");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
