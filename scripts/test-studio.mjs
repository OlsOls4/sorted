// Unit tests for the AG Studio dashboard's pure modules: ledger -> Studio rows, and Ask Sorted's
// rules intent parser / LLM-output sanitiser. Usage: npm test (runs after test-unit.mjs).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".test-build-studio");
if (existsSync(out)) rmSync(out, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--outDir", out, "--module", "commonjs", "--moduleResolution", "node", "--target", "es2022",
    "--strict", "--skipLibCheck", "--esModuleInterop", "--rootDir", path.join(root, "src"),
    path.join(root, "src/lib/studio/rows.ts"),
    path.join(root, "src/lib/studio/intent.ts"),
    path.join(root, "src/lib/seed.ts"),
  ],
  { stdio: "inherit" },
);
const require = createRequire(path.join(out, "x.js"));
const R = require(path.join(out, "lib/studio/rows.js"));
const I = require(path.join(out, "lib/studio/intent.js"));
const { seedInvoices } = require(path.join(out, "lib/seed.js"));

let failures = 0;
let passes = 0;
const check = (cond, msg) => {
  if (cond) passes++;
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};

const today = "2026-10-13";
const ledger = seedInvoices(45, today);
const rows = R.toStudioRows(ledger, today);
const vocab = R.vocabFor(rows.invoices);

console.log("Studio rows");
check(rows.invoices.length === ledger.length, "one row per non-draft invoice");
check(rows.payments.every((p) => p.amount > 0 && /^\d{4}-\d\d$/.test(p.month)), "payments have amount and month");
check(rows.payments.length === ledger.filter((i) => i.status === "PAID").length, "one payment per paid invoice");
const owed = rows.invoices.reduce((s, r) => s + r.owed, 0);
const expected = ledger.filter((i) => ["SENT", "UNPAID", "PARTIALLY_PAID"].includes(i.status)).reduce((s, i) => s + i.total - i.amountPaid, 0);
check(Math.abs(owed - expected) < 0.01, `owed sums to open balances (${owed} vs ${expected})`);
check(rows.invoices.every((r) => r.isOverdue === (r.daysOverdue > 0 && r.owed > 0)), "isOverdue matches days overdue");
check(rows.invoices.filter((r) => r.owed > 0).every((r) => R.AGING_BUCKETS.includes(r.agingBucket)), "open invoices land in an aging bucket");
check(rows.invoices.filter((r) => r.owed === 0).every((r) => r.agingBucket === "Settled"), "settled invoices are not in the heat tile");
check(new Set(rows.invoices.filter((r) => r.customerKey === "patel.r@example.com").map((r) => r.customer)).size === 1, "one display name per customer");
check(rows.invoices.find((r) => /Clifton/.test(r.customer))?.area === "Clifton", "area read from the customer name");
check(rows.invoices.find((r) => /Chandos/.test(r.job))?.area === "Redland", "area read from the job address");
check(vocab.cities.includes("Bristol"), "Bristol is in the vocabulary");
check(R.areaFor({ customerName: "A N Other", customerEmail: "x@y.z", jobSummary: "Tap", source: "paypal" }).area === "Unknown", "live invoices without an address stay Unknown");

console.log("Ask Sorted rules");
const ri = (p) => I.rulesIntent(p, vocab, today);
let t = ri("show overdue Bristol jobs");
check(t.kind === "filter" && t.filters.overdue && t.filters.city === "Bristol", `overdue Bristol: ${JSON.stringify(t)}`);
check(I.rulesConfident(t), "overdue Bristol needs no LLM");
t = ri("chart October earnings");
check(t.kind === "chart" && t.chart.measure === "cashIn" && t.filters.month === "2026-10" && t.chart.by === "day", `October earnings: ${JSON.stringify(t)}`);
check(I.rulesConfident(t), "chart needs no LLM");
t = ri("chart november earnings");
check(t.filters.month === "2025-11", `a later month means last year: ${t.filters.month}`);
t = ri("Chart what's still owed by customer");
check(t.kind === "chart" && t.chart.measure === "owed" && t.chart.by === "customer", `owed by customer: ${JSON.stringify(t)}`);
t = ri("line chart of billed by month");
check(t.chart.type === "line" && t.chart.measure === "billed" && t.chart.by === "month", `billed line: ${JSON.stringify(t)}`);
t = ri("what does Harbourside owe?");
check(t.kind === "filter" && (t.filters.customer === "Harbourside Lettings Ltd" || t.filters.area === "Harbourside"), `Harbourside: ${JSON.stringify(t)}`);
t = ri("only the unpaid ones in Clifton");
check(t.filters.open && t.filters.area === "Clifton", `unpaid Clifton: ${JSON.stringify(t)}`);
t = ri("reset");
check(t.kind === "reset", "reset");
t = ri("clear all filters");
check(t.kind === "reset", "clear all filters");
t = ri("how's my week looking?");
check(t.kind === "unknown" && !I.rulesConfident(t), "vague question goes to the LLM (or help text)");
check(ri("I may be late").filters.month === undefined, "'may' as a verb isn't a month");
check(I.parseMonth("earnings last month", today) === "2026-09", "last month");
check(I.parseMonth("2026-03 takings", today) === "2026-03", "ISO month");

console.log("LLM output sanitiser");
let s = I.sanitizeIntent({ kind: "filter", filters: { overdue: true, city: "bristol", customer: "Nobody Ltd", month: "Oct" } }, vocab);
check(s && s.filters.city === "Bristol" && !s.filters.customer && !s.filters.month, `snaps to vocab, drops unknowns: ${JSON.stringify(s)}`);
s = I.sanitizeIntent({ kind: "chart", chart: { measure: "revenue", by: "planet", type: "3d" }, filters: { month: "2026-10" } }, vocab);
check(s && s.chart.measure === "cashIn" && s.chart.by === "day" && s.chart.type === "column", `chart defaults: ${JSON.stringify(s)}`);
check(I.sanitizeIntent({ kind: "delete everything" }, vocab) === null, "rejects unknown kinds");
check(I.sanitizeIntent("nope", vocab) === null, "rejects non-objects");
check(I.intentSystemPrompt(vocab, today).length < 1500, "LLM prompt stays small");

console.log(`\n${passes} passed, ${failures} failed`);
rmSync(out, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
