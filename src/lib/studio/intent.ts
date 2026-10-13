// Ask Sorted on the AG Studio dashboard: turns "show overdue Bristol jobs" or "chart October
// earnings" into a small, validated intent that the Studio agent applies as filters or a new
// widget. The rules parser runs first and answers most requests with no AI call at all; only
// requests it can't place go to the LLM chain (one short JSON call), and whatever the LLM says is
// snapped back onto this schema and the ledger's own vocabulary before it is used.
// Pure and shared by client, server and the unit tests.

import type { StudioVocab } from "./rows";

export type IntentKind = "filter" | "chart" | "reset" | "unknown";
export type ChartMeasure = "cashIn" | "billed" | "owed";
export type ChartBy = "day" | "week" | "month" | "customer" | "area";
export type ChartType = "column" | "line" | "bar" | "pie";

export interface IntentFilters {
  overdue?: boolean;
  open?: boolean;
  city?: string;
  area?: string;
  customer?: string;
  month?: string; // YYYY-MM
}

export interface StudioIntent {
  kind: IntentKind;
  filters: IntentFilters;
  chart?: { measure: ChartMeasure; by: ChartBy; type: ChartType };
  reply: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_LABEL = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_LABEL[m - 1] ?? ym} ${y}`;
}

/** A month named in the prompt, as YYYY-MM. A month later than this one means last year's. */
export function parseMonth(text: string, today: string): string | undefined {
  const t = text.toLowerCase();
  const iso = t.match(/\b(20\d\d)-(0[1-9]|1[0-2])\b/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const [ty, tm] = today.split("-").map(Number);
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(ty, tm - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  if (/\bthis month\b/.test(t)) return shift(0);
  if (/\blast month\b|\bprevious month\b/.test(t)) return shift(-1);
  for (let i = 0; i < 12; i++) {
    const full = MONTHS[i];
    const re = new RegExp(`\\b(${full}|${full.slice(0, 3)}${full === "september" ? "t?" : ""})\\b(?:\\s+(20\\d\\d))?`);
    const m = t.match(re);
    // "may" is also a verb: only take it with a year or an earnings/chart word nearby.
    if (m && !(full === "may" && !m[2] && !/\b(in|for|during|of)\s+may\b/.test(t))) {
      const year = m[2] ? Number(m[2]) : i + 1 > tm ? ty - 1 : ty;
      return `${year}-${String(i + 1).padStart(2, "0")}`;
    }
  }
  return undefined;
}

const STOP = new Set(["mr", "mrs", "ms", "miss", "dr", "ltd", "limited", "the", "and", "&", "plc", "co"]);

function findIn(text: string, options: string[]): string | undefined {
  const t = ` ${text.toLowerCase()} `;
  // Whole names first, longest first, then a distinctive word of a customer's name.
  const sorted = [...options].sort((a, b) => b.length - a.length);
  for (const o of sorted) if (t.includes(` ${o.toLowerCase()} `) || t.includes(` ${o.toLowerCase()}'`) || t.includes(` ${o.toLowerCase()}s `)) return o;
  return undefined;
}

function findCustomer(text: string, customers: string[]): string | undefined {
  const whole = findIn(text, customers);
  if (whole) return whole;
  const words = new Set(text.toLowerCase().split(/[^a-z'&]+/).filter(Boolean));
  const hits = customers.filter((c) =>
    c
      .toLowerCase()
      .split(/[^a-z'&]+/)
      .some((w) => w.length >= 4 && !STOP.has(w) && (words.has(w) || words.has(`${w}s`) || words.has(`${w}'s`))),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

/** Deterministic parser. Returns kind "unknown" when it can't place the request. */
export function rulesIntent(prompt: string, vocab: StudioVocab, today: string): StudioIntent {
  const t = prompt.toLowerCase().trim();
  const filters: IntentFilters = {};
  if (/\b(reset|clear( all)?( the)? filters?|remove (all )?filters|show (me )?everything|start over|show all)\b/.test(t)) {
    return finish({ kind: "reset", filters: {}, reply: "" });
  }
  if (/\b(overdue|late|past due|behind)\b/.test(t)) filters.overdue = true;
  else if (/\b(unpaid|owed|owing|outstanding|open|still owe)\b/.test(t)) filters.open = true;

  const city = findIn(t, vocab.cities);
  const area = findIn(t, vocab.areas.filter((a) => !vocab.cities.includes(a)));
  if (city) filters.city = city;
  if (area) filters.area = area;
  const customer = findCustomer(t, vocab.customers);
  if (customer) filters.customer = customer;
  const month = parseMonth(t, today);
  if (month) filters.month = month;

  const wantsChart = /\b(chart|graph|plot|visuali[sz]e|trend|breakdown|break down)\b/.test(t);
  if (wantsChart) {
    const measure: ChartMeasure = /\b(owe|owed|owing|outstanding|overdue|debt|unpaid)\b/.test(t)
      ? "owed"
      : /\b(bill|billed|invoiced|issued|sent)\b/.test(t)
        ? "billed"
        : "cashIn";
    const by: ChartBy = /\b(by|per|each) (customer|client)|\bwho\b/.test(t)
      ? "customer"
      : /\b(by|per|each) (area|neighbourhood|neighborhood|city|town|place)\b/.test(t)
        ? "area"
        : /\b(weekly|by week|per week|each week)\b/.test(t)
          ? "week"
          : /\b(daily|by day|per day|each day)\b/.test(t) || month
            ? "day"
            : "month";
    const type: ChartType = /\bline\b|\btrend\b/.test(t) ? "line" : /\bbar\b/.test(t) ? "bar" : /\b(pie|donut|doughnut|share)\b/.test(t) ? "pie" : "column";
    return finish({ kind: "chart", filters, chart: { measure, by, type }, reply: "" });
  }
  return finish({ kind: Object.keys(filters).length > 0 ? "filter" : "unknown", filters, reply: "" });
}

/** True when the rules parser placed the request well enough to skip the LLM. */
export function rulesConfident(intent: StudioIntent): boolean {
  if (intent.kind === "reset" || intent.kind === "chart") return true;
  return intent.kind === "filter" && Object.keys(intent.filters).length > 0;
}

const KINDS: IntentKind[] = ["filter", "chart", "reset", "unknown"];
const MEASURES: ChartMeasure[] = ["cashIn", "billed", "owed"];
const BYS: ChartBy[] = ["day", "week", "month", "customer", "area"];
const TYPES: ChartType[] = ["column", "line", "bar", "pie"];

const snap = (v: unknown, options: string[]) =>
  typeof v === "string" && v.trim() ? options.find((o) => o.toLowerCase() === v.trim().toLowerCase()) : undefined;

/** Validates an LLM's JSON against the schema and the ledger's vocabulary; drops anything unknown. */
export function sanitizeIntent(raw: unknown, vocab: StudioVocab): StudioIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = snap(r.kind, KINDS) as IntentKind | undefined;
  if (!kind) return null;
  const f = (r.filters && typeof r.filters === "object" ? r.filters : {}) as Record<string, unknown>;
  const filters: IntentFilters = {};
  if (f.overdue === true) filters.overdue = true;
  else if (f.open === true) filters.open = true;
  const city = snap(f.city, vocab.cities);
  const area = snap(f.area, vocab.areas);
  const customer = snap(f.customer, vocab.customers);
  if (city) filters.city = city;
  if (area && area !== city) filters.area = area;
  if (customer) filters.customer = customer;
  if (typeof f.month === "string" && /^20\d\d-(0[1-9]|1[0-2])$/.test(f.month)) filters.month = f.month;
  let chart: StudioIntent["chart"];
  if (kind === "chart") {
    const c = (r.chart && typeof r.chart === "object" ? r.chart : {}) as Record<string, unknown>;
    chart = {
      measure: (snap(c.measure, MEASURES) as ChartMeasure) ?? "cashIn",
      by: (snap(c.by, BYS) as ChartBy) ?? (filters.month ? "day" : "month"),
      type: (snap(c.type, TYPES) as ChartType) ?? "column",
    };
  }
  return finish({ kind, filters, chart, reply: "" });
}

const MEASURE_LABEL: Record<ChartMeasure, string> = { cashIn: "Cash in", billed: "Billed", owed: "Still owed" };

export function chartTitle(intent: StudioIntent): string {
  const c = intent.chart!;
  const f = intent.filters;
  const by = c.by === "customer" ? "by customer" : c.by === "area" ? "by area" : c.by === "day" ? "by day" : c.by === "week" ? "by week" : "by month";
  const scope = [f.month && monthLabel(f.month), f.customer, f.area, f.city !== f.area ? f.city : undefined, f.overdue && "overdue"].filter(Boolean).join(", ");
  return `${MEASURE_LABEL[c.measure]} ${by}${scope ? ` · ${scope}` : ""}`;
}

export function describeFilters(f: IntentFilters): string {
  const bits: string[] = [];
  if (f.overdue) bits.push("overdue");
  else if (f.open) bits.push("unpaid");
  const what = `${bits.join(" ")}${bits.length ? " " : ""}jobs`;
  const where = [f.area, f.city && f.city !== f.area ? f.city : undefined].filter(Boolean).join(", ");
  return [what, where && `in ${where}`, f.customer && `for ${f.customer}`, f.month && `from ${monthLabel(f.month)}`].filter(Boolean).join(" ");
}

function finish(i: StudioIntent): StudioIntent {
  let reply: string;
  if (i.kind === "reset") reply = "Cleared Ask Sorted's filters and charts — you're looking at everything again.";
  else if (i.kind === "chart") reply = `Added a chart: **${chartTitle(i)}**. Click a bar to filter the ledger below.`;
  else if (i.kind === "filter") reply = `Showing ${describeFilters(i.filters)}. The scoreboard, heat tile and ledger below all follow.`;
  else
    reply =
      'I can filter or chart your ledger. Try "show overdue Bristol jobs", "who owes the most in Clifton?", "chart October earnings" or "reset".';
  return { ...i, reply };
}

/** Compact instructions for the one LLM call (kept short: free-tier token budgets). */
export function intentSystemPrompt(vocab: StudioVocab, today: string): string {
  return [
    "You turn a UK tradesperson's request about their invoice dashboard into JSON. Reply with one JSON object only.",
    'Schema: {"kind":"filter"|"chart"|"reset"|"unknown","filters":{"overdue"?:true,"open"?:true,"city"?:string,"area"?:string,"customer"?:string,"month"?:"YYYY-MM"},"chart"?:{"measure":"cashIn"|"billed"|"owed","by":"day"|"week"|"month"|"customer"|"area","type":"column"|"line"|"bar"|"pie"}}',
    "earnings/income/takings = cashIn. Use only these values:",
    `cities: ${vocab.cities.join(", ") || "none"}`,
    `areas: ${vocab.areas.join(", ") || "none"}`,
    `customers: ${vocab.customers.slice(0, 40).join(", ") || "none"}`,
    `Today is ${today}; a month later than this one means last year.`,
  ].join("\n");
}
