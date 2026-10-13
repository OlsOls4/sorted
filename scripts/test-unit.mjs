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
    path.join(root, "src/lib/ai/parse.ts"),
    path.join(root, "src/lib/markdown.ts"),
    path.join(root, "src/lib/paypal/mapping.ts"),
    path.join(root, "src/lib/paypal/client.ts"),
    path.join(root, "src/lib/paypal/toolkit.ts"),
    path.join(root, "src/lib/paypal/webhook.ts"),
    path.join(root, "src/lib/approval.ts"),
    path.join(root, "src/lib/guard.ts"),
    path.join(root, "src/lib/events.ts"),
    path.join(root, "src/lib/qr.ts"),
    path.join(root, "src/lib/reminders.ts"),
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
  // Bare number straight after an item name is money ("chemicals 35", "EICR cert 60").
  ["power flushed system for the Coopers, 6 hours, chemicals 35, magnaclean filter 120, mark.cooper@btinternet.com", (d) => {
    check(has(d, "labour", 6, 45), "6h labour");
    check(d.items.some((i) => i.unitAmount === 35 && /chemicals/i.test(i.description)), "chemicals 35 is £35");
    check(d.items.some((i) => i.unitAmount === 120 && /filter/i.test(i.description)), "filter 120 is £120");
    check(sum(d) === 425, `total 425 (got ${sum(d)})`);
  }],
  ["Mr & Mrs Lewis, 14 Redland Grove. New consumer unit fitted, CU and breakers £210, 7 hrs labour, EICR cert 60, lewisfamily@gmail.com", (d) => {
    check(d.items.some((i) => i.unitAmount === 60 && /EICR/i.test(i.description)), "EICR cert 60 is £60");
    check(sum(d) === 210 + 7 * 45 + 60, `total ${sum(d)}`);
  }],
  // "6 boards @ 14.50" is one line: quantity 6 at £14.50 (not a £6 part plus £14.50).
  ["decking repair for Kingswood Builders Ltd, 5 hrs, 6 boards @ 14.50, screws 12, plus vat, accounts@kingswoodbuilders.co.uk", (d) => {
    check(d.items.some((i) => i.quantity === 6 && i.unitAmount === 14.5 && /boards/i.test(i.description)), "6 x £14.50 boards");
    check(!d.items.some((i) => i.unitAmount === 6), "no stray £6 line");
    check(has(d, "labour", 5, 45), "5h labour");
    check(d.items.some((i) => i.unitAmount === 12 && /screws/i.test(i.description)), "screws 12");
    check(Math.abs(sum(d) - (225 + 87 + 12)) < 1e-9, `subtotal 324 (got ${sum(d)})`);
    check(d.vatEnabled === true, "plus vat");
  }],
  ["landlord EICR for Avon Properties, 3 flats at 120 each, accounts@avonproperties.co.uk, net 30", (d) => {
    check(d.items.some((i) => i.quantity === 3 && i.unitAmount === 120) && sum(d) === 360, "3 flats at 120 each → 3 x £120");
  }],
  // "£1,350" keeps its thousands separator (clauses split on commas must not make it £1 + £350).
  ["new combi installed Mrs Ogunleye, worcester boiler £1,350, flue kit 95, 2 days at 280/day, ogunleye.f@yahoo.co.uk", (d) => {
    check(d.items.some((i) => i.unitAmount === 1350 && /boiler/i.test(i.description)), "boiler £1,350");
    check(!d.items.some((i) => i.unitAmount === 1 || i.unitAmount === 350), "not split into £1 and £350");
  }],
  ["rewire for Mr Jones, materials £2,450.50, jones@example.com", (d) => {
    check(d.items.some((i) => i.unitAmount === 2450.5), "£2,450.50");
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

// ---------------- PayPal mapping, client, toolkit, approvals, guards, events ----------------
const MAP = require(path.join(out, "lib/paypal/mapping.js"));
const CL = require(path.join(out, "lib/paypal/client.js"));
const APR = require(path.join(out, "lib/approval.js"));
const GD = require(path.join(out, "lib/guard.js"));
const EV = require(path.join(out, "lib/events.js"));
const QR = require(path.join(out, "lib/qr.js"));
const REM = require(path.join(out, "lib/reminders.js"));
const WH = require(path.join(out, "lib/paypal/webhook.js"));

const li = (id, kind, description, quantity, unitAmount, unit = "QUANTITY") => ({ id, kind, description, quantity, unitAmount, unit });
const baseDraft = {
  customerName: "Mrs Ngozi Okafor", customerEmail: "ngozi.okafor@example.com", customerType: "consumer", jobSummary: "Stopcock repair",
  items: [li("a", "labour", "Labour", 2.5, 45, "HOURS"), li("b", "parts", "New valve", 1, 18), li("c", "callout", "Call-out", 1, 45)],
  vatEnabled: true, vatRate: 20, currency: "GBP", issueDate: "2026-10-13", dueDate: "2026-10-27",
};

await step("PayPal mapping: draft → Invoicing v2 payload (VAT per line, private vs business)", async () => {
  const p = MAP.draftToPayPal(baseDraft, S, "INV-1042");
  check(p.detail.invoice_number === "INV-1042" && p.detail.currency_code === "GBP", "number + GBP");
  check(p.detail.payment_term.term_type === "DUE_ON_DATE_SPECIFIED" && p.detail.payment_term.due_date === "2026-10-27", "due date term");
  check(p.items.length === 3 && p.items.every((i) => i.tax?.name === "VAT" && i.tax?.percent === "20"), "VAT 20% on every line");
  check(p.items[0].unit_of_measure === "HOURS" && p.items[0].quantity === "2.5" && p.items[0].unit_amount.value === "45.00", "hours line: qty 2.5 × 45.00");
  check(p.configuration.tax_inclusive === false, "VAT added on top");
  const bi = p.primary_recipients[0].billing_info;
  check(!bi.business_name && bi.name.given_name === "Ngozi" && bi.name.surname === "Okafor" && bi.language === "en-GB", "private: title stripped, given/surname, en-GB");
  check(p.invoicer.business_name === S.businessName, "invoicer business name");
  const noVat = MAP.draftToPayPal({ ...baseDraft, vatEnabled: false }, S);
  check(noVat.items.every((i) => !i.tax) && !noVat.detail.invoice_number, "no VAT: no tax objects; no number lets PayPal assign");
  const biz = MAP.draftToPayPal({ ...baseDraft, customerName: "Harbourside Lettings Ltd", customerType: "business" }, S);
  const bb = biz.primary_recipients[0].billing_info;
  check(bb.business_name === "Harbourside Lettings Ltd" && bb.name.given_name === "Accounts", "business: business_name + Accounts Department");
  const zero = MAP.draftToPayPal({ ...baseDraft, items: [...baseDraft.items, li("d", "other", "", 0, 10)] }, S);
  check(zero.items.length === 3, "zero-quantity lines dropped");
});

await step("PayPal mapping: Invoicing v2 → ledger invoice", async () => {
  const full = {
    id: "INV2-AAAA", status: "SENT",
    detail: { invoice_number: "INV-1004", invoice_date: "2026-09-20", currency_code: "GBP", memo: "Created by Sorted from job notes: [Sorted demo:dave] Radiator valves x4",
      payment_term: { due_date: "2026-10-04" }, metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#X", invoicer_view_url: "https://www.sandbox.paypal.com/invoice/details/INV2-AAAA" } },
    primary_recipients: [{ billing_info: { name: { given_name: "Dave", surname: "Bennett" }, email_address: "sb-dave.bennett@example.com" } }],
    items: [{ name: "Labour", quantity: "2", unit_amount: { currency_code: "GBP", value: "45.00" }, unit_of_measure: "HOURS", tax: { name: "VAT", percent: "20" } }],
    amount: { currency_code: "GBP", value: "108.00", breakdown: { item_total: { currency_code: "GBP", value: "90.00" }, tax_total: { currency_code: "GBP", value: "18.00" } } },
    due_amount: { currency_code: "GBP", value: "108.00" },
  };
  const inv = MAP.payPalToInvoice(full, true);
  check(inv.customerName === "Dave Bennett" && inv.customerType === "consumer", "private customer name/type");
  check(inv.subtotal === 90 && inv.vat === 18 && inv.total === 108 && inv.vatEnabled && inv.vatRate === 20, "subtotal/VAT/total from breakdown");
  check(inv.amountPaid === 0 && inv.items[0].kind === "labour", "unpaid; HOURS → labour");
  check(inv.jobSummary === "Radiator valves x4", `memo prefixes stripped (${inv.jobSummary})`);
  check(inv.payerViewUrl === "https://www.sandbox.paypal.com/invoice/p/#X", "payer view link kept");
  const biz = MAP.payPalToInvoice({ ...full, primary_recipients: [{ billing_info: { business_name: "Redland Property Management Ltd", name: { given_name: "Accounts", surname: "Department" } } }] }, true);
  check(biz.customerName === "Redland Property Management Ltd" && biz.customerType === "business", "business_name wins, business type");
  const summary = MAP.payPalToInvoice({ id: "INV2-B", status: "MARKED_AS_PAID", detail: { currency_code: "GBP", metadata: { create_time: "Tue 2026-10-13 12:26 AM BST" } }, amount: { value: "95.00" } }, true);
  check(summary.subtotal === 95 && summary.vat === 0 && summary.amountPaid === 95, "list summary: total as subtotal, paid status → fully paid");
  check(summary.issueDate === "2026-10-13", "display-string create_time parsed");
  const part = MAP.payPalToInvoice({ ...full, status: "PARTIALLY_PAID", due_amount: { currency_code: "GBP", value: "58.00" } }, true);
  check(part.amountPaid === 50, `paid = total - due (${part.amountPaid})`);
  check(MAP.payPalToInvoice({ ...full, status: "WEIRD" }, true).status === "SENT", "unknown status → SENT");
});

await step("PayPal REST client: errors, token refresh, idempotency", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  let tokenCalls = 0;
  let first = true;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith("/v1/oauth2/token")) {
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: `tok${tokenCalls}`, expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes("/remind")) {
      return new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed", details: [{ issue: "CANNOT_REMIND_INVOICE", description: "Invoice is paid" }] }), { status: 422, headers: { "paypal-debug-id": "dbg1" } });
    }
    if (String(url).includes("/v2/invoicing/invoices/INV2-T")) {
      if (first) {
        first = false;
        return new Response("{}", { status: 401 });
      }
      return new Response(JSON.stringify({ id: "INV2-T", status: "SENT", detail: { currency_code: "GBP" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const c = new CL.PayPalClient({ clientId: "unit-id", clientSecret: "unit-secret", baseUrl: CL.SANDBOX_BASE });
    let err;
    try {
      await c.remind("INV2-PAID", { subject: "s", note: "n" });
    } catch (e) {
      err = e;
    }
    check(err instanceof CL.PayPalError && err.status === 422 && err.debugId === "dbg1", "422 → PayPalError with status + debug id");
    check(CL.hasIssue(err, "CANNOT_REMIND_INVOICE") && /Invoice is paid/.test(err.message), "issue detail kept");
    const remindReq = seen.find((x) => x.url.includes("/remind"));
    check(!!remindReq.init.headers["PayPal-Request-Id"], "POST carries a PayPal-Request-Id (idempotency)");
    check(remindReq.init.headers.Authorization === "Bearer tok1", "bearer token used");
    const inv = await c.getInvoice("INV2-T");
    check(inv.id === "INV2-T" && tokenCalls === 2, `401 → one forced token refresh then success (token calls ${tokenCalls})`);
    check(seen.find((x) => x.url.endsWith("/v1/oauth2/token")).init.headers.Authorization.startsWith("Basic "), "token call uses Basic auth");
    check(CL.paypalConfigFromHeaders(new Request("http://x", { headers: { "x-paypal-client-id": "abc", "x-paypal-client-secret": "has space" } })) === null, "pasted keys with whitespace rejected");
    const pasted = CL.paypalConfigFromHeaders(new Request("http://x", { headers: { "x-paypal-client-id": "abc", "x-paypal-client-secret": "def" } }));
    check(pasted.baseUrl === CL.SANDBOX_BASE, "pasted keys pinned to sandbox");
    check(!CL.credKey(pasted).includes("def"), "cache key never contains the secret");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await step("Agent Toolkit: {ok:false} results become errors, never success", async () => {
  // Stub @paypal/agent-toolkit/ai-sdk so runToolkitTool's dynamic import gets a fake toolkit.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "tk", expires_in: 3600 }), { status: 200 });
  const tkPath = require.resolve("@paypal/agent-toolkit/ai-sdk");
  const results = {
    send_invoice_reminder: JSON.stringify({ ok: false, status: 422, code: "PAYPAL_API_HTTP_ERROR", message: "Invoice is already paid" }),
    get_invoice: JSON.stringify({ id: "INV2-OK", status: "SENT" }),
    list_invoices: JSON.stringify({ error: { message: "boom" } }),
    generate_invoice_qr_code: JSON.stringify("--b\r\nContent-Disposition: form-data; name=\"image\"\r\n\r\niVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQAAAACFI5MzAAAB\r\n--b--"),
  };
  class FakeToolkit {
    constructor() {
      this.client = {};
    }
    getTools() {
      return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { execute: async () => v }]));
    }
  }
  require.cache[tkPath] = { id: tkPath, exports: { PayPalAgentToolkit: FakeToolkit }, loaded: true };
  const TK = require(path.join(out, "lib/paypal/toolkit.js"));
  const cfg = { clientId: "fake", clientSecret: "fake2", baseUrl: CL.SANDBOX_BASE };
  try {
    let err;
    try {
      await TK.runToolkitTool(cfg, "send_invoice_reminder", { invoice_id: "INV2-PAID" });
    } catch (e) {
      err = e;
    }
    check(err instanceof CL.PayPalError && err.status === 422 && /already paid/.test(err.message), "ok:false → PayPalError(422)");
    const okRes = await TK.runToolkitTool(cfg, "get_invoice", { invoice_id: "INV2-OK" });
    check(okRes.id === "INV2-OK", "normal JSON result passes through");
    let err2;
    try {
      await TK.runToolkitTool(cfg, "list_invoices", {});
    } catch (e) {
      err2 = e;
    }
    check(err2 && /boom/.test(err2.message), "{error} result throws");
    const qrOut = await TK.runToolkitTool(cfg, "generate_invoice_qr_code", { invoice_id: "INV2-OK" });
    check(QR.qrFromToolkitOutput(qrOut).startsWith("data:image/png;base64,iVBOR"), "multipart QR body → PNG data URL");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await step("Approval tokens: signed, scoped, short-lived, single use", async () => {
  process.env.SORTED_APPROVAL_SECRET = "unit-test-secret";
  const t = APR.issueApproval("send_reminder", "INV2-1", "live").token;
  check(APR.verifyApproval(t, "send_reminder", "INV2-2", "live").ok === false, "other invoice rejected");
  check(APR.verifyApproval(t, "mark_paid", "INV2-1", "live").ok === false, "other action rejected");
  check(APR.verifyApproval(t, "send_reminder", "INV2-1", "demo").ok === false, "other mode rejected");
  check(APR.verifyApproval(t, "send_reminder", "INV2-1", "live").ok === true, "exact match accepted");
  check(APR.verifyApproval(t, "send_reminder", "INV2-1", "live").ok === false, "replay rejected");
  const [payload] = APR.issueApproval("create_invoice", "new", "live").token.split(".");
  check(APR.verifyApproval(`${payload}.AAAA`, "create_invoice", "new", "live").ok === false, "forged signature rejected");
  const old = APR.issueApproval("mark_paid", "INV2-9", "demo", Date.now() - 11 * 60_000).token;
  const v = APR.verifyApproval(old, "mark_paid", "INV2-9", "demo");
  check(!v.ok && /expired/.test(v.reason), "expired after 10 minutes");
  check(APR.verifyApproval(undefined, "mark_paid", "x", "demo").ok === false, "missing token rejected");
});

await step("Live write guards: test recipients only on the shared sandbox, rate limits", async () => {
  GD._resetGuards();
  check(GD.isSafeRecipient("sb-tom@example.com") && GD.isSafeRecipient("a@personal.example.com") && GD.isSafeRecipient("x@harbourside-lettings.example"), "example.com / .example allowed");
  check(!GD.isSafeRecipient("someone@gmail.com") && !GD.isSafeRecipient("x@example.com.evil.io"), "real domains blocked");
  check(GD.isSafeRecipient("x@acme.co.uk", "acme.co.uk"), "extra allowed domains via env");
  const req = new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9" } });
  const server = { mode: "live", credSource: "server", cfg: {} };
  check(GD.liveWriteGuard(req, server, ["bob@gmail.com"]).status === 422, "server keys: real address → 422");
  check(GD.liveWriteGuard(req, { mode: "demo", credSource: null, cfg: null }, ["bob@gmail.com"]) === null, "demo mode untouched");
  check(GD.liveWriteGuard(req, { mode: "live", credSource: "browser", cfg: {} }, ["bob@gmail.com"]) === null, "own sandbox keys: any address");
  let last;
  for (let i = 0; i < 13; i++) last = GD.liveWriteGuard(req, server, ["a@example.com"]);
  check(last && last.status === 429 && last.headers.get("Retry-After"), "13th live write in 10 min from one IP → 429");
});

await step("Payment events: lateness, messages, ledger diff, webhook mapping", async () => {
  const inv = { id: "INV2-D", number: "INV-1004", customerName: "Dave Bennett", total: 182, dueDate: "2026-10-04", paidDate: "2026-10-13", status: "PAID" };
  const e = EV.eventFromInvoice(inv, "paid", "paypal-webhook");
  check(e.daysLate === 9 && e.message === "Dave Bennett paid £182, 9 days late (INV-1004). Chasing stopped.", e.message);
  check(EV.eventMessage({ kind: "paid", customerName: "Sam", amount: 95.5, invoiceNumber: "INV-1", daysLate: -2 }) === "Sam paid £95.50, 2 days early (INV-1).", "early payment wording");
  const diff = EV.diffLedger([{ ...inv, status: "SENT" }, { ...inv, id: "X", status: "SENT" }], [inv, { ...inv, id: "X", status: "CANCELLED" }]);
  check(diff.length === 2 && diff[0].kind === "paid" && diff[1].kind === "cancelled", "diff finds paid + cancelled");
  check(EV.diffLedger([inv], [inv]).length === 0, "no change, no event");
  const wh = WH.toPaymentEvent({ event_type: "INVOICING.INVOICE.PAID", create_time: "2026-10-13T10:00:00Z", resource: { invoice: {
    id: "INV2-D", status: "PAID", detail: { invoice_number: "INV-1004", currency_code: "GBP", payment_term: { due_date: "2026-10-04" } },
    primary_recipients: [{ billing_info: { name: { given_name: "Dave", surname: "Bennett" } } }], amount: { value: "182.00" },
    payments: { transactions: [{ payment_date: "2026-10-13" }] } } } }, null);
  check(wh && wh.message === "Dave Bennett paid £182, 9 days late (INV-1004). Chasing stopped.", `webhook → ${wh?.message}`);
  check(WH.toPaymentEvent({ event_type: "INVOICING.INVOICE.CREATED", resource: {} }, null) === null, "other event types ignored");
  const r1 = WH.recordEvent(wh, "WH-1");
  check(r1 && WH.recordEvent(wh, "WH-1") === null, "duplicate webhook delivery ignored");
  check(WH.eventsSince(0).events.length >= 1 && WH.eventsSince(r1.seq).events.length === 0, "eventsSince");
});

await step("Reminders: pay link, Pay in 3 (private, £20–£3,000), B2B waiver", async () => {
  const inv = { id: "INV2-D", number: "INV-1004", status: "SENT", customerName: "Dave Bennett", customerEmail: "d@example.com", customerType: "consumer", jobSummary: "Radiator valves",
    items: [], vatEnabled: false, vatRate: 20, currency: "GBP", subtotal: 182, vat: 0, total: 182, amountPaid: 0, issueDate: "2026-09-20", dueDate: "2026-10-04", reminders: [],
    payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#ABC", source: "paypal" };
  const firm = REM.templateReminder(inv, S, "firm", TODAY);
  check(firm.body.includes(inv.payerViewUrl) && /Pay in 3/.test(firm.body) && /subject to status/.test(firm.body), "private: link + hedged Pay in 3");
  check(!/Pay in 3/.test(REM.templateReminder({ ...inv, total: 12 }, S, "firm", TODAY).body), "no Pay in 3 under £20");
  const biz = { ...inv, customerName: "Redland Property Management Ltd", customerType: "business", total: 491.4 };
  const fin = REM.templateReminder(biz, S, "final", TODAY);
  check(/Late Payment of Commercial Debts/.test(fin.body) && /pay the invoice in full today .* waive the statutory interest/.test(fin.body), "B2B final: Act + pay-today waiver");
  check(!/Pay in 3/.test(fin.body), "no Pay in 3 for business");
  check(!/waive/.test(REM.templateReminder(inv, S, "final", TODAY).body), "no waiver for private customers");
});

await step("parse.ts: notes that mention VAT override the AI's/settings' VAT decision", async () => {
  const PARSE = require(path.join(out, "lib/ai/parse.js"));
  setEnv({ GROQ_API_KEY: "gk" });
  const aiReply = (vatMentioned) => () => respond(200, { choices: [{ message: { role: "assistant", content: JSON.stringify({
    customerName: "Mr Price", customerEmail: "", customerType: "consumer", jobSummary: "Replaced tap",
    items: [{ kind: "labour", description: "Labour", quantity: 2, unitAmount: 50, unit: "HOURS" }], vatMentioned, dueInDays: null, warnings: [] }) } }] });
  const REG = { ...S, hourlyRate: 50, vatRegistered: true };
  script = { "api.groq.com": aiReply(false) };
  const a = await PARSE.parseNotes("replaced tap for mr price, 2 hrs, cash job no vat", REG);
  check(a.engine.ai === true, `AI answered (${a.engine.label})`);
  check(a.draft.vatEnabled === false, "VAT-registered trader + 'no vat' in notes → no VAT");
  script = { "api.groq.com": aiReply(false) };
  const b = await PARSE.parseNotes("replaced tap for mr price, 2 hrs", REG);
  check(b.draft.vatEnabled === true, "no VAT mention → registered trader's default (VAT on)");
  script = { "api.groq.com": aiReply(false) };
  const c = await PARSE.parseNotes("replaced tap for mr price, 2 hrs, plus vat", { ...REG, vatRegistered: false });
  check(c.draft.vatEnabled === true, "'plus vat' in notes wins even when the AI says vatMentioned=false");
  setEnv({});
});

console.log(`\n${passes} checks passed, ${failures} failed`);
rmSync(out, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
