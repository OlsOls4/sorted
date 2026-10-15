// Internal regression harness for the job-notes -> invoice parser (local use only; outputs are git-ignored).
//
// Runs the app's real parse path (src/lib/ai/parse.ts parseNotes, which falls back to
// the rules engine in src/lib/parser.ts) over eval/job-notes.json and scores it.
//
// Usage:
//   node scripts/eval-parser.mjs --engine rules              # SORTED_AI_DISABLED=1, local, no network
//   node scripts/eval-parser.mjs --engine groq               # local parseNotes pinned to Groq openai/gpt-oss-20b (needs GROQ_API_KEY)
//   node scripts/eval-parser.mjs --engine remote             # POST each note to the deployed /api/parse (Groq gpt-oss-20b on Vercel)
//   node scripts/eval-parser.mjs --rescore eval/raw-remote.json   # re-score saved outputs, no calls
// Options: --append (continue a chunked run)  --url https://sorted-paypal.vercel.app  --pause 3000  --max-calls 55  --only n01,n02
//
// Outputs go to eval/raw-<engine>.json and eval/scores-<engine>.json, which are git-ignored and never published.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const engine = opt("engine", "rules");
const rescore = opt("rescore", null);
const url = opt("url", "https://sorted-paypal.vercel.app").replace(/\/$/, "");
const pauseMs = Number(opt("pause", 3000));
const maxCalls = Number(opt("max-calls", 55));
const only = opt("only", null)?.split(",");

const set = JSON.parse(readFileSync(path.join(root, "eval/job-notes.json"), "utf8"));
const cases = set.notes.filter((n) => !only || only.includes(n.id));

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const lineTotal = (li) => round2(Number(li.quantity) * Number(li.unitAmount));
const totals = (d) => {
  const subtotal = round2((d.items ?? []).reduce((s, li) => s + lineTotal(li), 0));
  const vat = d.vatEnabled ? round2((subtotal * (d.vatRate ?? 20)) / 100) : 0;
  return { subtotal, vat, total: round2(subtotal + vat) };
};
const normName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const eq = (a, b) => Math.abs(a - b) < 0.005;

function score(c, draft) {
  const exp = c.expected;
  const items = draft?.items ?? [];
  const t = draft ? totals(draft) : { subtotal: 0, vat: 0, total: 0 };
  // Line-total matching (multiset): how many expected line amounts appear in the output.
  const pool = items.map(lineTotal);
  let matched = 0;
  for (const e of exp.items) {
    const i = pool.findIndex((p) => eq(p, e.lineTotal));
    if (i >= 0) {
      matched++;
      pool.splice(i, 1);
    }
  }
  const r = {
    customer: exp.customerNames.map(normName).includes(normName(draft?.customerName)),
    customerType: draft?.customerType === exp.customerType,
    lineCount: items.length === exp.items.length,
    amounts: matched === exp.items.length && items.length === exp.items.length,
    linesMatched: matched,
    linesExpected: exp.items.length,
    vat: !!draft?.vatEnabled === exp.vatEnabled,
    subtotal: eq(t.subtotal, exp.subtotal),
    total: eq(t.total, exp.total),
    got: { customerName: draft?.customerName ?? null, items: items.map((li) => ({ kind: li.kind, description: li.description, quantity: li.quantity, unitAmount: li.unitAmount })), vatEnabled: !!draft?.vatEnabled, ...t },
  };
  return r;
}

function loadLocal() {
  const out = path.join(root, ".eval-build");
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "--outDir", out, "--module", "commonjs", "--moduleResolution", "node", "--target", "es2022",
      "--strict", "--skipLibCheck", "--esModuleInterop", "--rootDir", path.join(root, "src"),
      path.join(root, "src/lib/ai/parse.ts"),
    ],
    { stdio: "inherit" },
  );
  const require = createRequire(path.join(out, "x.js"));
  // parse.ts/provider.ts import "server-only", which throws outside React Server Components.
  require.cache[require.resolve("server-only")] = { id: "server-only", exports: {}, loaded: true };
  return require(path.join(out, "lib/ai/parse.js")).parseNotes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  if (rescore) return JSON.parse(readFileSync(path.resolve(rescore), "utf8"));
  const rawPath = path.join(root, `eval/raw-${engine}.json`);
  // --append continues an earlier (chunked) run: the call budget and results carry over.
  const raw = args.includes("--append") && existsSync(rawPath)
    ? JSON.parse(readFileSync(rawPath, "utf8"))
    : { engine, startedAt: new Date().toISOString(), url: engine === "remote" ? url : null, calls: 0, results: [] };
  const done = () => new Set(raw.results.filter((r) => !r.superseded).map((r) => r.id));
  if (engine === "rules" || engine === "groq") {
    if (engine === "rules") process.env.SORTED_AI_DISABLED = "1";
    else {
      if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY not set; use --engine remote");
      Object.assign(process.env, { SORTED_AI_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-20b", GROQ_FALLBACK_MODEL: "none" });
    }
    const parseNotes = loadLocal();
    for (const c of cases) {
      if (engine === "groq" && raw.calls >= maxCalls) break;
      if (engine === "groq" && raw.calls) await sleep(pauseMs);
      if (engine === "groq") raw.calls++;
      const res = await parseNotes(c.notes, { traderName: "Trader", traderEmail: "t@x.example", bankRate: 3.75, ...c.settings });
      raw.results.push({ id: c.id, engine: res.engine, aiError: res.aiError ?? null, draft: res.draft });
    }
  } else if (engine === "remote") {
    const queue = cases.filter((c) => !done().has(c.id));
    const retried = new Set();
    while (queue.length && raw.calls < maxCalls) {
      const c = queue.shift();
      if (raw.calls) await sleep(pauseMs);
      raw.calls++;
      let body;
      try {
        const res = await fetch(`${url}/api/parse`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: c.notes, settings: c.settings }) });
        body = await res.json();
        if (!res.ok) body = { error: body.error ?? `HTTP ${res.status}` };
      } catch (e) {
        body = { error: String(e) };
      }
      const label = body.engine?.label ?? "error";
      process.stdout.write(`${c.id} ${label}${body.aiError ? ` (${body.aiError.slice(0, 80)})` : ""}\n`);
      // One retry (budget permitting) when the model wasn't the one under test.
      const stillToDo = set.notes.filter((n) => !done().has(n.id) && n.id !== c.id).length;
      if (!/gpt-oss-20b/.test(label) && !retried.has(c.id) && !raw.results.some((r) => r.id === c.id && r.superseded) && raw.calls + stillToDo < maxCalls) {
        retried.add(c.id);
        queue.push(c);
        raw.results.push({ id: c.id, superseded: true, engine: body.engine ?? null, aiError: body.aiError ?? body.error ?? null, draft: body.draft ?? null });
        continue;
      }
      raw.results.push({ id: c.id, engine: body.engine ?? null, aiError: body.aiError ?? body.error ?? null, cached: !!body.cached, draft: body.draft ?? null });
    }
  } else throw new Error(`unknown engine ${engine}`);
  raw.finishedAt = new Date().toISOString();
  writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  return raw;
}

const raw = await run();
const byId = new Map(raw.results.filter((r) => !r.superseded).map((r) => [r.id, r]));
const rows = cases.map((c) => {
  const r = byId.get(c.id);
  return { id: c.id, trade: c.trade, tags: c.tags, engine: r?.engine?.label ?? "missing", ...score(c, r?.draft) };
});
const fields = ["customer", "lineCount", "amounts", "vat", "subtotal", "total", "customerType"];
const summarise = (rs) => {
  const s = { n: rs.length };
  for (const f of fields) s[f] = rs.filter((r) => r[f]).length;
  s.linesMatched = rs.reduce((a, r) => a + r.linesMatched, 0);
  s.linesExpected = rs.reduce((a, r) => a + r.linesExpected, 0);
  s.allCorrect = rs.filter((r) => r.customer && r.amounts && r.vat && r.total).length;
  return s;
};
const summary = summarise(rows);
const engines = {};
for (const r of rows) engines[r.engine] = (engines[r.engine] ?? 0) + 1;
const modelRows = rows.filter((r) => /gpt-oss-20b/.test(r.engine));
const out = { engine: raw.engine, calls: raw.calls ?? 0, engines, summary, modelOnlySummary: modelRows.length && modelRows.length !== rows.length ? summarise(modelRows) : null, rows };
const tag = rescore ? raw.engine : engine;
writeFileSync(path.join(root, `eval/scores-${tag}.json`), JSON.stringify(out, null, 2));

console.log(`\nEngine: ${tag}   calls: ${out.calls}   answered by: ${JSON.stringify(engines)}`);
for (const f of fields) console.log(`  ${f.padEnd(13)} ${summary[f]}/${summary.n}`);
console.log(`  line amounts  ${summary.linesMatched}/${summary.linesExpected} expected lines found`);
console.log(`  all correct   ${summary.allCorrect}/${summary.n} (customer, every line amount, VAT and total)`);
console.log("\nMisses:");
for (const r of rows) {
  const bad = fields.filter((f) => !r[f]);
  if (bad.length) console.log(`  ${r.id} [${bad.join(",")}] name=${JSON.stringify(r.got.customerName)} total=${r.got.total} items=${r.got.items.map((i) => `${i.kind}:${i.quantity}x${i.unitAmount}`).join(" ")} vat=${r.got.vatEnabled}`);
}
