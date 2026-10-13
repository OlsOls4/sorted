// Unit tests for the rules-engine job-notes parser and the AI provider chain.
// Usage: npm test   (compiles the TS modules with tsc to .test-build/, no extra deps)
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".test-build");
if (existsSync(out)) rmSync(out, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--outDir", out, "--module", "commonjs", "--moduleResolution", "node", "--target", "es2022",
    "--strict", "--skipLibCheck", "--esModuleInterop", "--rootDir", path.join(root, "src"),
    path.join(root, "src/lib/parser.ts"),
    path.join(root, "src/lib/ai/provider.ts"),
    path.join(root, "src/lib/markdown.ts"),
  ],
  { stdio: "inherit" },
);
// provider.ts imports "server-only", which throws outside React Server Components.
const require = createRequire(path.join(out, "x.js"));
require.cache[require.resolve("server-only")] = { id: "server-only", exports: {}, loaded: true };
const { parseJobNotes } = require(path.join(out, "lib/parser.js"));
const P = require(path.join(out, "lib/ai/provider.js"));
const MD = require(path.join(out, "lib/markdown.js"));

let failures = 0;
let passes = 0;
const check = (cond, msg) => {
  if (cond) passes++;
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};

const S = {
  businessName: "Dave Harris Plumbing & Heating", traderName: "Dave Harris", traderEmail: "d@x.example",
  hourlyRate: 45, vatRegistered: false, vatRate: 20, paymentTermsDays: 14, calloutFee: 0, bankRate: 3.75,
};
const TODAY = "2026-10-13";
const sum = (d) => d.items.reduce((t, i) => t + i.quantity * i.unitAmount, 0);
const has = (d, kind, qty, amt) => d.items.some((i) => i.kind === kind && Math.abs(i.quantity - qty) < 1e-9 && Math.abs(i.unitAmount - amt) < 1e-9);

// [notes, expectations(d), settings?]
const CASES = [
  ["fixed leaking stopcock for mrs okafor at 12 cotham hill, 2.5 hrs plus new valve 18 quid, call out 45, she pays in 14 days, vat on top, email ngozi.okafor@example.com", (d) => {
    check(d.customerName === "Mrs Okafor", `name=${d.customerName}`);
    check(d.customerEmail === "ngozi.okafor@example.com", "email");
    check(has(d, "labour", 2.5, 45), "2.5h x £45 labour");
    check(has(d, "parts", 1, 18), "£18 valve part");
    check(/valve/i.test(d.items.find((i) => i.kind === "parts")?.description ?? ""), "part described as valve");
    check(has(d, "callout", 1, 45), "£45 call-out");
    check(d.items.length === 3, `3 items (got ${d.items.length})`);
    check(d.vatEnabled === true, "vat on top");
    check(d.dueDate === "2026-10-27", `due 14 days (${d.dueDate})`);
    check(/stopcock/i.test(d.jobSummary) && /12 Cotham Hill/.test(d.jobSummary), `summary=${d.jobSummary}`);
  }],
  ["fixed leaking stopcock for mrs okafor at 12 cotham hill, 2.5 hrs plus new valve 18 quid, call out 45", (d) => {
    check(d.customerName === "Mrs Okafor", `no-email name=${d.customerName}`);
    check(d.vatEnabled === false, "vat off by default");
  }],
  ["fitted 2 radiators for Mrs Patel, 4 hrs, parts £86, she's at patel.r@example.com", (d) => {
    check(d.customerName === "Mrs Patel", "Mrs Patel");
    check(has(d, "labour", 4, 45) && has(d, "parts", 1, 86) && d.items.length === 2, "4h + £86 parts");
    check(/radiators/i.test(d.jobSummary), `summary=${d.jobSummary}`);
  }],
  ["Boiler service for Harbourside Lettings Ltd, flat 3, 1.5 hours @ £60/hr, materials £22.50 from screwfix, + VAT, net 30, accounts@harbourside-lettings.co.uk", (d) => {
    check(d.customerName === "Harbourside Lettings Ltd", `biz name=${d.customerName}`);
    check(d.customerType === "business", "business");
    check(has(d, "labour", 1.5, 60), "1.5h @ £60");
    check(has(d, "parts", 1, 22.5), "£22.50 materials");
    check(d.vatEnabled, "+ VAT");
    check(d.dueDate === "2026-11-12", `net 30 (${d.dueDate})`);
  }],
  ["2 days rewiring kitchen at 220 a day for mr john davies, cable and sockets 140 pounds, plus vat", (d) => {
    check(d.customerName === "Mr John Davies", `name=${d.customerName}`);
    check(has(d, "labour", 2, 220), "2 days x £220");
    check(d.items.some((i) => i.unitAmount === 140), "£140 materials");
    check(d.vatEnabled, "plus vat");
  }],
  ["new bathroom suite for Ms Clarke, fixed price £2.4k, no vat, pays on the day", (d) => {
    check(d.customerName === "Ms Clarke", "Ms Clarke");
    check(d.items.length === 1 && d.items[0].unitAmount === 2400, `£2.4k fixed (${JSON.stringify(d.items.map((i) => i.unitAmount))})`);
    check(!d.vatEnabled, "no vat");
    check(d.dueDate === TODAY, "due on the day");
  }],
  ["Mr Hughes - unblocked drain, callout charge £60, 1 hr, 50 an hour", (d) => {
    check(d.customerName === "Mr Hughes", "Mr Hughes");
    check(has(d, "labour", 1, 50), "1h @ £50 (rate)");
    check(has(d, "callout", 1, 60), "£60 call-out");
    check(d.items.length === 2, "2 items");
  }],
  ["replaced 3 radiator valves £12 x3 for mrs o'brien, 2 hours, call-out fee 35", (d) => {
    check(d.customerName === "Mrs O'Brien", `name=${d.customerName}`);
    check(has(d, "parts", 3, 12), "3 x £12 valves");
    check(has(d, "labour", 2, 45), "2h default rate");
    check(has(d, "callout", 1, 35), "£35 call-out");
  }],
  ["gutter clearing for Dr Ahmed at 7 Buxton Walk BS7 0LG, half a day, skip hire £180, due in 7 days", (d) => {
    check(d.customerName === "Dr Ahmed", `name=${d.customerName}`);
    check(has(d, "labour", 4, 45), "half day = 4h");
    check(d.items.some((i) => i.kind === "other" && i.unitAmount === 180), "£180 skip");
    check(/7 Buxton Walk/.test(d.jobSummary), `address in summary (${d.jobSummary})`);
    check(d.dueDate === "2026-10-20", "7 days");
  }],
  ["tap washer for sarah jones sarah.jones@gmail.com 30 mins, parts 4.50", (d) => {
    check(d.customerName === "Sarah Jones", `name from email/label=${d.customerName}`);
    check(has(d, "labour", 0.5, 45), "30 mins");
    check(has(d, "parts", 1, 4.5), "parts 4.50 bare");
  }],
  ["Power flush, 6hrs x2 (me and my lad), rate £40, chemicals £35, Tom Patel tom.patel@example.com, terms 21 days", (d) => {
    check(has(d, "labour", 12, 40), `12h @ £40 (${JSON.stringify(d.items)})`);
    check(d.items.some((i) => i.unitAmount === 35), "£35 chemicals");
    check(d.dueDate === "2026-11-03", "21 days");
    check(d.customerEmail === "tom.patel@example.com", "email");
  }],
  ["customer: bristol community cafe, fitted water heater, 3 hrs, £95 heater, vat 20%, payment within 10 days", (d) => {
    check(/Cafe/i.test(d.customerName) && d.customerType === "business", `cafe biz=${d.customerName}`);
    check(has(d, "labour", 3, 45) && d.items.some((i) => i.unitAmount === 95), "3h + £95");
    check(d.vatEnabled, "vat 20%");
    check(d.dueDate === "2026-10-23", "10 days");
  }],
  ["day rate 250 x3 for Mrs Begum loft boarding, timber 320 quid", (d) => {
    check(has(d, "labour", 3, 250), `3 days x £250 (${JSON.stringify(d.items.map((i) => [i.quantity, i.unitAmount]))})`);
    check(d.items.some((i) => i.unitAmount === 320), "£320 timber");
    check(d.customerName === "Mrs Begum", "Mrs Begum");
  }],
  ["Mr & Mrs Smith, 14 high st, replaced consumer unit, 5 hours, CU and breakers £210, callout", (d) => {
    check(d.customerName === "Mr & Mrs Smith", `name=${d.customerName}`);
    check(has(d, "labour", 5, 45), "5h");
    check(d.items.some((i) => i.unitAmount === 210), "£210 parts");
    check(!d.items.some((i) => i.unitAmount === 14), "house number not money");
    check(d.warnings.some((w) => /Call-out/.test(w)), "call-out w/o amount warns");
  }],
  ["Mr & Mrs Smith, callout", (d) => check(has(d, "callout", 1, 60), "callout uses settings fee"), { ...S, calloutFee: 60 }],
  ["leak under sink for Mrs Green, an hour and a half, washers 3 quid", (d) => {
    check(has(d, "labour", 1.5, 45), "an hour and a half");
    check(has(d, "parts", 1, 3), "£3 washers");
  }],
  ["shower fit for Mr Khan, 4h at £55, parts: mixer £140 and tray £90, inc vat", (d) => {
    check(has(d, "labour", 4, 55), "4h at £55");
    check(d.items.some((i) => i.unitAmount === 140) && d.items.some((i) => i.unitAmount === 90), "both parts");
    check(d.vatEnabled && d.warnings.some((w) => /includes VAT/.test(w)), "inc vat warns");
  }],
];

console.log("Parser cases");
for (const [notes, fn, settings] of CASES) {
  const before = failures;
  const { draft } = parseJobNotes(notes, settings ?? S, TODAY);
  try {
    fn(draft);
  } catch (e) {
    failures++;
    console.log(`  ✗ threw: ${e.message}`);
  }
  const verbose = process.argv.includes("--print");
  console.log(`${failures === before ? "✓" : "✗"} ${notes.slice(0, 90)}${failures === before && !verbose ? "" : `\n    → ${JSON.stringify({ name: draft.customerName, items: draft.items.map((i) => `${i.kind}:${i.quantity}x${i.unitAmount} ${i.description}`), vat: draft.vatEnabled, due: draft.dueDate, summary: draft.jobSummary, total: sum(draft) })}`}`);
}

// ---------------- Provider chain (mocked fetch) ----------------
console.log("\nProvider chain");
const AI_ENV = ["GROQ_API_KEY", "GROQ_MODEL", "GROQ_FALLBACK_MODEL", "NVIDIA_API_KEY", "NVIDIA_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_API_KEY", "SORTED_AI_PROVIDER", "SORTED_AI_DISABLED"];
const setEnv = (vars) => {
  for (const k of AI_ENV) delete process.env[k];
  Object.assign(process.env, vars);
  P.resetCooldowns();
};
const calls = [];
const respond = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
let script = {};
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body, headers: init.headers });
  const host = new URL(url).host;
  const h = script[host];
  if (!h) throw new Error(`unexpected fetch ${url}`);
  return h(body);
};
const okText = (text) => () => respond(200, { choices: [{ message: { role: "assistant", content: text } }] });
const step = async (name, fn) => {
  const before = failures;
  calls.length = 0;
  try {
    await fn();
  } catch (e) {
    failures++;
    console.log(`  ✗ threw: ${e.stack}`);
  }
  console.log(`${failures === before ? "✓" : "✗"} ${name}`);
};

await step("no keys → getLLM() null, rules engine says 'no AI key'", async () => {
  setEnv({});
  check(P.getLLM() === null, "null router");
  check(P.fallbackEngine().label === "Sorted rules engine (no AI key)", "label");
});

await step("Groq adapter: request shape, tool calls parsed, engine names provider+model", async () => {
  setEnv({ GROQ_API_KEY: "gk" });
  script = {
    "api.groq.com": () => respond(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_ledger_summary", arguments: "{\"x\":1}" } }] } }] }),
  };
  const r = await P.getLLM().chat({
    system: "sys",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t0", name: "list_invoices", args: { a: 1 } }] },
      { role: "tool", toolCallId: "t0", name: "list_invoices", content: "{}" },
    ],
    tools: [{ name: "get_ledger_summary", description: "d", parameters: { type: "object", properties: {} } }],
  });
  const c = calls[0];
  check(c.url === "https://api.groq.com/openai/v1/chat/completions", `url ${c.url}`);
  check(c.headers.Authorization === "Bearer gk", "bearer");
  check(c.body.model === "openai/gpt-oss-20b", "default groq model gpt-oss-20b (not the Metaculus bot's 120b)");
  check(c.body.reasoning_effort === "low", "low reasoning effort for gpt-oss");
  check(c.body.messages[0].role === "system" && c.body.messages[2].tool_calls[0].function.arguments === "{\"a\":1}" && c.body.messages[3].tool_call_id === "t0", "message mapping");
  check(c.body.tools[0].type === "function" && c.body.tool_choice === "auto", "tools sent");
  check(r.toolCalls[0].name === "get_ledger_summary" && r.toolCalls[0].args.x === 1, "tool call parsed");
  check(r.engine.label === "Groq openai/gpt-oss-20b" && r.engine.ai, `engine ${r.engine.label}`);
});

await step("JSON mode only where supported (Groq yes, NVIDIA no)", async () => {
  setEnv({ GROQ_API_KEY: "g" });
  script = { "api.groq.com": okText("{}") };
  await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }], json: true });
  check(calls[0].body.response_format?.type === "json_object", "groq json_object");
  setEnv({ NVIDIA_API_KEY: "n" });
  calls.length = 0;
  script = { "integrate.api.nvidia.com": okText("{}") };
  await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }], json: true });
  check(calls[0].body.response_format === undefined, "nvidia no response_format");
  check(calls[0].body.model === "nvidia/nemotron-3-super-120b-a12b", "nvidia default model");
});

await step("Fallthrough order Groq(429) → NVIDIA(503) → OpenRouter(ok); 429 remembered", async () => {
  setEnv({ GROQ_API_KEY: "g", NVIDIA_API_KEY: "n", OPENROUTER_API_KEY: "o", GEMINI_API_KEY: "gm" });
  script = {
    "api.groq.com": () => respond(429, { error: { message: "Rate limit reached for tokens per day. Please try again in 23h5m." } }),
    "integrate.api.nvidia.com": () => respond(503, { error: "overloaded" }),
    "openrouter.ai": okText("hello"),
  };
  const r = await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }] });
  check(calls.map((c) => new URL(c.url).host).join(",") === "api.groq.com,api.groq.com,integrate.api.nvidia.com,openrouter.ai", `order ${calls.map((c) => c.url).join(",")}`);
  check(calls[0].body.model === "openai/gpt-oss-20b" && calls[1].body.model === "qwen/qwen3.8-27b", "groq 429 → qwen fallback model before next provider");
  check(r.text === "hello" && r.engine.label === "OpenRouter nvidia/nemotron-3-super-120b-a12b:free", `engine ${r.engine.label}`);
  check(calls[3].headers["X-Title"] === "Sorted", "openrouter attribution headers");
  check(P.providerCoolingUntil("Groq openai/gpt-oss-20b") > Date.now() + 4 * 60_000, "groq 20b cooling ~5 min");
  check(P.providerCoolingUntil("NVIDIA nvidia/nemotron-3-super-120b-a12b") > Date.now(), "nvidia cooling after 503");
  calls.length = 0;
  await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }] });
  check(calls.length === 1 && new URL(calls[0].url).host === "openrouter.ai", "second request skips cooling providers (1 HTTP call)");
});

await step("Short Retry-After honoured; timeout falls through", async () => {
  setEnv({ GROQ_API_KEY: "g", GROQ_FALLBACK_MODEL: "none", OPENROUTER_API_KEY: "o", SORTED_AI_TIMEOUT_MS: "50" });
  script = {
    "api.groq.com": () => respond(429, { error: { message: "slow down" } }, { "retry-after": "40" }),
    "openrouter.ai": () => new Promise(() => {}),
  };
  // the never-resolving fetch must be aborted by the timeout
  globalThis.__origFetch = globalThis.fetch;
  const f = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      f(url, init).then(resolve, reject);
    });
  let err;
  try {
    await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }] });
  } catch (e) {
    err = e;
  }
  globalThis.fetch = f;
  delete process.env.SORTED_AI_TIMEOUT_MS;
  const until = P.providerCoolingUntil("Groq openai/gpt-oss-20b");
  check(until && until - Date.now() <= 40_000 && until - Date.now() > 30_000, "groq cooling ≈ Retry-After 40s");
  check(err?.name === "AIUnavailableError" && /timed out/.test(err.message), `all failed → AIUnavailableError (${err?.message})`);
  check(P.providerCoolingUntil("OpenRouter nvidia/nemotron-3-super-120b-a12b:free") > Date.now(), "timeout cools openrouter");
  check(P.fallbackEngine().label === "Sorted rules engine (AI busy, fallback)", "busy label when keys exist");
  check(/busy|timed out/.test(P.friendlyAIError(err)), `friendly: ${P.friendlyAIError(err)}`);
  calls.length = 0;
  let err2;
  try {
    await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }] });
  } catch (e) {
    err2 = e;
  }
  check(err2 && calls.length === 0, "all cooling → fails instantly with no HTTP call");
  check(P.getLLM().info === null, "router info null while all cooling");
});

await step("Gemini 429 (quota) → falls to OpenAI; SORTED_AI_PROVIDER pins one", async () => {
  setEnv({ GEMINI_API_KEY: "gm", OPENAI_API_KEY: "oa" });
  script = {
    "generativelanguage.googleapis.com": () => respond(429, { error: { code: 429, message: "You exceeded your current quota", details: [{ retryDelay: "86000s" }] } }),
    "api.openai.com": okText("ok"),
  };
  const r = await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }] });
  check(calls[0].url.includes("gemini-3.8-flash"), "gemini default model");
  check(r.engine.id === "openai", "fell through to openai");
  setEnv({ GROQ_API_KEY: "g", NVIDIA_API_KEY: "n", SORTED_AI_PROVIDER: "nvidia" });
  check(P.getLLM().providers.map((p) => p.info.id).join() === "nvidia", "pinned to nvidia");
  setEnv({ GROQ_API_KEY: "g", NVIDIA_API_KEY: "n", OPENROUTER_API_KEY: "o", GEMINI_API_KEY: "gm", OPENAI_API_KEY: "oa", ANTHROPIC_API_KEY: "an" });
  check(P.getLLM().providers.map((p) => p.info.id).join() === "groq,groq,nvidia,openrouter,gemini,openai,anthropic", "full order (2 Groq models)");
  setEnv({ GROQ_API_KEY: "g", GROQ_MODEL: "llama-x" });
  check(P.getLLM().providers.map((p) => p.info.label).join() === "Groq llama-x,Groq qwen/qwen3.8-27b", "GROQ_MODEL override keeps qwen fallback");
  setEnv({ GROQ_API_KEY: "g", SORTED_AI_DISABLED: "1" });
  check(P.getLLM() === null, "SORTED_AI_DISABLED");
});

await step("<think> tags stripped from content", async () => {
  setEnv({ GROQ_API_KEY: "g" });
  script = { "api.groq.com": okText("<think>{scratch}</think>{\"a\":1}") };
  const r = await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }] });
  check(r.text === "{\"a\":1}", `text ${r.text}`);
});

await step("400 (bad request) falls through without cooldown", async () => {
  setEnv({ GROQ_API_KEY: "g", NVIDIA_API_KEY: "n" });
  script = { "api.groq.com": () => respond(400, { error: { message: "bad" } }), "integrate.api.nvidia.com": okText("fine") };
  const r = await P.getLLM().chat({ system: "s", messages: [{ role: "user", content: "x" }] });
  check(r.engine.id === "nvidia" && P.providerCoolingUntil("Groq openai/gpt-oss-20b") === null, "no cooldown on 400");
  check(calls.length === 2 && calls[0].body.model === "openai/gpt-oss-20b", "non-429 error skips the sibling Groq model");
});

await step("chat markdown: tables, bold, lists, no HTML", async () => {
  const txt = (parts) => parts.map((p) => p.text).join("");
  const b = MD.parseMarkdown("Here's who owes you:\n\n| Customer | Owed | Days overdue |\n|---|---:|:--:|\n| **Harbourside Lettings** | £1,645.00 | 28 |\n| Tom \\| Patel | £180 |\n\n- **Total:** £1,825\n2. chase <b>them</b>");
  check(b[0].type === "p" && b[1].type === "gap", "intro paragraph then gap");
  const t = b[2];
  check(t.type === "table" && t.header.length === 3 && t.rows.length === 2, "table 3 cols x 2 rows");
  check(t.align.join() === "left,right,center", `align ${t.align}`);
  check(t.rows[0][0][0].kind === "bold" && t.rows[0][0][0].text === "Harbourside Lettings", "bold cell");
  check(txt(t.rows[1][0]) === "Tom | Patel" && txt(t.rows[1][2]) === "", "escaped pipe, short row padded");
  check(!b.some((x) => x.type === "p" && txt(x.inline).includes("|")), "no raw pipes left");
  const li = b.filter((x) => x.type === "li");
  check(li.length === 2 && li[0].marker === null && li[1].marker === "2.", "bullet + numbered");
  check(li[0].inline[0].kind === "bold" && li[0].inline[0].text === "Total:", "bold in bullet");
  check(txt(li[1].inline) === "chase <b>them</b>" && li[1].inline.every((p) => p.kind === "text"), "html kept as literal text");
  const nt = MD.parseMarkdown("a | b\nnot a table");
  check(nt.length === 2 && nt.every((x) => x.type === "p"), "pipes without separator stay text");
  const nb = MD.parseMarkdown("Customer | Owed\n--- | ---\nSam | £5");
  check(nb[0].type === "table" && nb[0].rows.length === 1, "table without outer pipes");
});

console.log(`\n${passes} checks passed, ${failures} failed`);
rmSync(out, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
