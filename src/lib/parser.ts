// Deterministic job-notes parser. Used as the no-AI fallback and as a
// sanity layer over AI output (e.g. to recover an email the model missed).
//
// Works clause by clause on the way tradespeople actually write notes:
// "fixed leaking stopcock for mrs okafor at 12 cotham hill, 2.5 hrs plus new
// valve 18 quid, call out 45, she pays in 14 days, vat on top, email ...".
// Money can be "£45", "45 quid", "45 pounds", "1.2k"; bare numbers count as
// money only next to a keyword ("call out 45", "parts 30", "rate 50").

import { addDays, round2, todayISO, uid } from "./format";
import type { CustomerType, InvoiceDraft, LineItem, Settings } from "./types";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const N = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;
// £45 / £1.2k / £45 quid | 45 quid / 45 pounds / 45gbp / 1.2k
const MONEY_RE = new RegExp(
  String.raw`£\s?(${N})(?:\s?(k)\b)?(?:\s?(?:quid|pounds?|gbp))?|\b(${N})(?:(k)\b|\s?(?:quid|pounds?|gbp|squid)\b)`,
  "gi",
);
// A bare number that isn't a measurement, duration, quantity or percentage.
const BARE_RE = new RegExp(
  String.raw`(?<![\d.,£x])(${N})(?![\d.,]|\s?(?:k\b|quid|pounds?|gbp|%|mm\b|cm\b|m\b|metres?|meters?|ft\b|feet|foot|inch|in\b|l\b|litres?|liters?|kw|v\b|volts?|amps?\b|bar\b|hrs?\b|hours?|h\b|days?\b|mins?\b|minutes?|weeks?|x\b|st\b|nd\b|rd\b|th\b))`,
  "gi",
);
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  half: 0.5, couple: 2, "a couple of": 2,
};
const NUMW = String.raw`\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|an?|half|couple(?: of)?`;
const BUSINESS_HINT =
  /\b(ltd|limited|llp|plc|& sons|and sons|lettings|properties|property|estates|builders|construction|developments|services|group|holdings|cafe|café|restaurant|pub|hotel|school|surgery|agency|management|housing|associates|co\.)\b/i;
const BUSINESS_SUFFIX = String.raw`ltd|limited|llp|plc|lettings|properties|estates|builders|construction|developments|services|cafe|café|restaurant|surgery|school|hotel|pub|group|holdings|management|housing|associates|agency|(?:&|and) sons`;
const FREEMAIL = /@(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|aol|btinternet|sky|virginmedia|talktalk|example)\./i;
const STREET = String.raw`road|rd|street|st|hill|lane|ln|avenue|ave|close|way|drive|crescent|terrace|place|court|gardens|grove|park|walk|row|square|sq|mews|view|parade|vale|rise|green|yard|wharf|quay`;
const ADDRESS_RE = new RegExp(
  String.raw`\b(?:(?:flat|unit|apt)\s+\d+[a-z]?,?\s+)?\d{1,4}[a-z]?,?\s+(?:[a-z'’]+\s+){1,3}?(?:${STREET})\b\.?(?:,?\s+[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b)?`,
  "i",
);
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/i;
const NAME_STOP = new Set([
  "at", "in", "on", "of", "she", "he", "they", "it", "for", "to", "from", "pays", "paid", "pay", "email", "plus", "and", "x",
  "vat", "call", "callout", "the", "a", "an", "re", "is", "was", "has", "had", "with", "inc", "ltd", "fixed", "fitted", "replaced",
  "repaired", "new", "her", "his", "their", "tap", "boiler", "job", "parts", "materials", "labour", "hrs", "hours",
]);

const CALLOUT_KW = /\bcall[- ]?outs?\b|\bcallouts?\b|\battendance\b|\bvisit (?:fee|charge)\b/i;
const PARTS_KW = /\bparts?\b|\bmaterials?\b|\bsupplies\b|\bkit\b|\bconsumables\b|\bmerchant\b|\bscrewfix\b|\btoolstation\b|\bwickes\b|\bb&q\b|\btravis\b|\bplumbase\b|\bcityplumb\b/i;
const FIXED_KW = /\bfixed(?: price| fee)?\b(?=\s*(?:£|\d|of|:|was|is)|$)|\bquote[ds]?\b|\bagreed\b|\bprice\b|\bjob total\b|\btotal\b|\ball in\b/i;
const WASTE_KW = /\bskip\b|\btip\b|\bdisposal\b|\bwaste\b|\bremoval\b/i;
const RATE_KW = /\brate\b|\bper (?:hr|hour|h)\b|\/\s?(?:hr|hour|h)\b|\b(?:an|a|p\/?)\s?(?:hr|hour)\b|\bph\b|@/i;
const CHARGE_KW = /\bcharge\b|\bfee\b|\bcost\b|\beach\b|\bea\b|\bextra\b/i;

function money(raw: string, k?: string): number {
  const n = parseFloat(raw.replace(/,/g, ""));
  return round2(k ? n * 1000 : n);
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s(&/-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    .replace(/\bMc([a-z])/g, (_m, c: string) => `Mc${c.toUpperCase()}`)
    .replace(/\bO['’]([a-z])/g, (_m, c: string) => `O'${c.toUpperCase()}`)
    .replace(/\b(Ltd|Llp|Plc)\b/g, (m) => (m === "Ltd" ? "Ltd" : m.toUpperCase()))
    .replace(/\b(And|Of|The)\b(?!$)/g, (m, _a, off: number) => (off === 0 ? m : m.toLowerCase()));
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0].replace(/\d+/g, "");
  const parts = local.split(/[._-]+/).filter((p) => p.length > 1);
  if (parts.length === 0) return "";
  return titleCase(parts.join(" "));
}

export function detectCustomerType(name: string, email: string): CustomerType {
  if (BUSINESS_HINT.test(name)) return "business";
  if (email && !FREEMAIL.test(email) && /@[a-z0-9-]+\.(co\.uk|com|uk|org\.uk|net)$/i.test(email)) {
    // A custom domain usually means a business customer, but not always.
    return "business";
  }
  return "consumer";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns the customer's display name and the exact text it was found as. */
function extractCustomer(text: string, email: string): { name: string; raw: string } {
  // 1) Titled names, any case: "mrs okafor", "Mr & Mrs J Smith", "dr. ahmed khan"
  const titleRe =
    /\b((?:mrs|mr|ms|miss|mx|dr|prof)\.?(?:\s+(?:&|and)\s+(?:mrs|mr|ms|miss)\.?)?)\s+([a-z][a-z'’-]*)(?:\s+([a-z][a-z'’-]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(text))) {
    const [, title, w1, w2] = m;
    if (NAME_STOP.has(w1.toLowerCase())) continue;
    let raw = `${title} ${w1}`;
    if (w2 && !NAME_STOP.has(w2.toLowerCase())) {
      const w2Start = m.index + m[0].length - w2.length;
      const after = text.slice(w2Start + w2.length);
      const capitalised = /^[A-Z]/.test(w2) && /^[A-Z]/.test(w1);
      const endsName = /^(?:\s*$|\s*[,;.:)(-]|\s+(?:at|in|on|of|from|'s|’s|re)\b|['’]s\b)/i.test(after);
      if (capitalised || endsName || w1.length === 1) raw = `${title} ${w1} ${w2}`;
    }
    const name = titleCase(raw.replace(/\s+/g, " ")).replace(/\b(Mrs|Mr|Ms|Miss|Mx|Dr|Prof)\.(?=\s)/g, "$1");
    return { name, raw };
  }
  // 2) Business names, any case: "for harbourside lettings ltd", "client: Bristol Cafe Co"
  const biz = text.match(
    new RegExp(
      String.raw`\b(?:for|customer|client|at|to)\s*[:\-]?\s*((?:the\s+)?(?:[a-z0-9&'’.-]+\s+){0,4}?(?:${BUSINESS_SUFFIX})(?:\s+(?:ltd|limited|llp|plc))?)\b`,
      "i",
    ),
  );
  if (biz && !/^(?:the\s+)?(?:ltd|limited)$/i.test(biz[1])) {
    const raw = biz[1].trim();
    return { name: /[A-Z]/.test(raw) && raw !== raw.toUpperCase() ? raw : titleCase(raw), raw };
  }
  // 3) Explicit label: "customer: john smith", "name - Jo Bloggs"
  const label = text.match(/\b(?:customer|client|name)\s*[:\-]\s*([a-z][a-z'’-]*(?:\s+[a-z][a-z'’-]*){0,2})/i);
  if (label) {
    const words = label[1].split(/\s+/).filter((w, i) => i === 0 || !NAME_STOP.has(w.toLowerCase()));
    const cut: string[] = [];
    for (const w of words) {
      if (NAME_STOP.has(w.toLowerCase())) break;
      cut.push(w);
    }
    if (cut.length) return { name: titleCase(cut.join(" ")), raw: cut.join(" ") };
  }
  // 4) Capitalised name after "for": "for John Smith"
  const cap = text.match(/\bfor\s+([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)?)(?=[\s,.;]|$)/);
  if (cap && !NAME_STOP.has(cap[1].split(" ")[0].toLowerCase())) return { name: cap[1].replace(/['’]s$/, ""), raw: cap[1] };
  return { name: email ? nameFromEmail(email) : "", raw: "" };
}

function parseNumberWord(s: string): number {
  const t = s.toLowerCase().trim();
  if (t in NUM_WORDS) return NUM_WORDS[t];
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}

interface Money {
  amount: number;
  index: number;
  end: number;
  bare: boolean;
}

function findMoney(clause: string, allowBare: boolean): Money[] {
  const out: Money[] = [];
  const re = new RegExp(MONEY_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause))) {
    out.push({ amount: money(m[1] ?? m[3], m[2] ?? m[4]), index: m.index, end: m.index + m[0].length, bare: false });
  }
  if (allowBare) {
    const br = new RegExp(BARE_RE.source, "gi");
    while ((m = br.exec(clause))) {
      const idx = m.index;
      if (out.some((o) => idx >= o.index && idx < o.end)) continue;
      out.push({ amount: money(m[1]), index: idx, end: idx + m[0].length, bare: true });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

const cleanDesc = (s: string) =>
  s
    .replace(/[£@]/g, " ")
    .replace(/\b(?:quid|pounds?|gbp|each|ea|also|for the|for|on|cost|costs|was|were|is|at|of|charge|fee|extra|me|i|paid|bought|got|used|price|x)\b/gi, " ")
    .replace(/[,;:.\-–—]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^(?:(?:and|plus|&|replaced|fitted|installed|supplied|new|swapped|changed)\s+)+(?=\S)/i, (m) => (/new/i.test(m) ? "new " : ""))
    .replace(/\s+(?:and|plus|&)$/i, "")
    .trim();

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** True when the notes say anything about VAT ("no vat", "+ VAT", "inc vat"...). */
export function mentionsVat(notes: string): boolean {
  return /\bvat\b|\bzero[- ]rated\b|\bno\s+tax\b/i.test(notes);
}

/** The money amounts the rules engine read from the notes (unit prices), for cross-checking an AI draft. */
export function noteAmounts(d: InvoiceDraft): number[] {
  return [...new Set(d.items.filter((li) => li.unitAmount > 0).map((li) => round2(li.unitAmount)))];
}

export interface ParseResult {
  draft: InvoiceDraft;
  confidence: number; // 0..1
}

export function parseJobNotes(notes: string, settings: Settings, today = todayISO()): ParseResult {
  const original = notes.replace(/\s+/g, " ").trim();
  const warnings: string[] = [];
  const items: LineItem[] = [];

  const email = (original.match(EMAIL_RE)?.[0] ?? "").toLowerCase();
  let text = original
    .replace(new RegExp(String.raw`\b(?:e-?mail(?: is| address)?|email:?)?\s*${EMAIL_RE.source}`, "gi"), " § ")
    // normalise fractions and spoken numbers
    .replace(/(\d)\s?½/g, "$1.5")
    .replace(/½/g, "0.5")
    .replace(/\b(\d+)\s+and\s+a\s+half\b/gi, (_m, n: string) => String(Number(n) + 0.5))
    .replace(/\b(?:an|one)\s+(?:hour|hr)\s+and\s+a\s+half\b/gi, "1.5 hrs")
    .replace(/\b(?:a\s+)?couple\s+of\s+(?=hours?|hrs?|days?)/gi, "2 ")
    .replace(/(\d)\s?(?:quid|pound)s?\s?(\d{2})\b/gi, "$1.$2 quid") // "12 quid 50" -> 12.50
    .replace(/\b(\d{1,3})((?:,\d{3})+)(?!\d|,\d)/g, (_m, a: string, b: string) => a + b.replace(/,/g, "")); // "£1,350" -> "£1350" before clauses split on commas

  // --- Customer + address (found on the whole text, then blanked out)
  const cust = extractCustomer(text, email);
  const customerName = cust.name;
  const nameRaw = cust.raw || (customerName && new RegExp(String.raw`\b${escapeRe(customerName)}\b`, "i").test(text) ? customerName : "");
  if (nameRaw) text = text.replace(new RegExp(escapeRe(nameRaw) + String.raw`(?:['’]s)?`, "i"), " § ");
  let addrM = text.match(ADDRESS_RE);
  // "@ 45 per sq m" is a unit price, not "45 Per Square".
  if (addrM && addrM.index !== undefined && (/\bper\b/i.test(addrM[0]) || /(?:@|\bx)\s*(?:£\s?)?$/i.test(text.slice(0, addrM.index)))) addrM = null;
  let address = "";
  if (addrM) {
    address = titleCase(addrM[0].replace(/[,.]$/, "")).replace(POSTCODE_RE, (p) => p.toUpperCase());
    text = text.replace(addrM[0], " § ");
  } else {
    const pc = text.match(POSTCODE_RE);
    if (pc) text = text.replace(pc[0], " § ");
  }

  // --- VAT (whole text), then blank the phrase out
  let vatEnabled = settings.vatRegistered;
  const VAT_OFF = /\bno\s+vat\b|\bwithout\s+vat\b|\bnot\s+vat\s*reg(?:istered|'d)?\b|\bvat[- ]?free\b|\bzero[- ]rated\b|\bno\s+tax\b/gi;
  const VAT_ON =
    /(?:\+|\bplus|\badd(?:ing)?|\bex(?:c|cl|cluding)?\.?|\binc(?:l|luding)?\.?)\s*vat\b|\bvat\s*(?:on top|extra|to be added|added|applies|applicable|@\s*\d+\s*%?|at\s*\d+\s*%|\d+\s*%)|\bon top\s*(?:for|of)?\s*vat\b|\bvat\s*(?:reg(?:istered)?)?\s*(?:yes|y)\b|\bcharge\s+vat\b/gi;
  const vatInc = /\binc(?:l|luding)?\.?\s*vat\b/i.test(text);
  if (VAT_ON.test(text)) vatEnabled = true;
  if (VAT_OFF.test(text)) vatEnabled = false;
  if (vatInc && vatEnabled) warnings.push("Notes say the price includes VAT; amounts here are treated as ex-VAT, so check the totals.");
  text = text.replace(VAT_OFF, " § ").replace(VAT_ON, " § ").replace(/\bvat\b/gi, " ");

  // --- Payment terms, then blank out
  let termDays = settings.paymentTermsDays;
  let dueToday = false;
  const termRes: [RegExp, (m: RegExpMatchArray) => number][] = [
    [/\bnet\s?-?(\d{1,3})\b/i, (m) => +m[1]],
    [/\b(?:due|pay(?:s|ing|ment)?|paid|settle[sd]?|terms?)\s*(?:is|are|of)?\s*(?:in|within)\s*(\d{1,3})\s*days?\b/i, (m) => +m[1]],
    [/\b(?:due|pay(?:s|ing|ment)?|paid|settle[sd]?)\s*(?:in|within)\s*(\d+|a|one|two|three|four)\s*weeks?\b/i, (m) => parseNumberWord(m[1]) * 7],
    [/\b(\d{1,3})\s*days?\s*(?:to pay|terms|credit|payment terms)\b/i, (m) => +m[1]],
    [/\b(?:payment\s*)?terms\s*[:\-]?\s*(\d{1,3})\s*days?\b/i, (m) => +m[1]],
    [/\bwithin\s*(\d{1,3})\s*days?\b/i, (m) => +m[1]],
  ];
  for (const [re, f] of termRes) {
    const m = text.match(re);
    if (m) {
      const d = f(m);
      if (Number.isFinite(d) && d >= 0 && d < 366) termDays = d;
      text = text.replace(m[0], " § ");
      break;
    }
  }
  const dueNow = /\bdue on receipt\b|\bon receipt\b|\bpay(?:s|ing|ment)? on the day\b|\bcash on the day\b|\bpaid on completion\b|\bdue (?:now|today|immediately)\b/i;
  if (dueNow.test(text)) {
    dueToday = true;
    text = text.replace(dueNow, " § ");
  }

  // --- Clauses
  const mergeAnd = (c: string): string[] => {
    // split "mixer £140 and tray £90" but keep "cable and sockets 140" / "CU and breakers £210" together
    const out: string[] = [];
    let buf = "";
    for (const p of c.split(/\s+and\s+/i)) {
      buf = buf ? `${buf} and ${p}` : p;
      if (/[\d£]/.test(buf)) {
        out.push(buf);
        buf = "";
      }
    }
    if (buf) {
      if (out.length) out[out.length - 1] += ` and ${buf}`;
      else out.push(buf);
    }
    return out;
  };
  const rawClauses = text
    .replace(/\s*\b(?:for|to|at|in|on|from|with)\s+(?=§)/gi, " ")
    .split(/[\n;,]|\.(?=\s|$)|\s(?:plus|\+|and also|also|then|&)\s|\s-\s/i)
    .flatMap(mergeAnd)
    .map((c) => c.replace(/§/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);

  // Job summary: first clause with real words, cut before numbers/time chatter.
  let jobSummary = "Work carried out";
  for (const c of rawClauses) {
    if (CALLOUT_KW.test(c) && !/[a-z]{4,}\s+[a-z]{4,}/i.test(c.replace(CALLOUT_KW, ""))) continue;
    let first = c
      .replace(new RegExp(String.raw`\b(?:day\s*rate|(?:hourly\s+)?rate)\s*(?:of|is|:|@|at)?\s*(?:£\s?)?${N}(?:\s?x\s?\d+)?`, "gi"), " ")
      .replace(new RegExp(String.raw`(?:\b(?:at|@)\s*)?(?:£\s?)?${N}\s*(?:quid|pounds?)?\s*(?:/|per|an|a|p/?)\s*(?:hr|hour|h|day)\b`, "gi"), " ")
      .replace(new RegExp(String.raw`^\s*(?:${NUMW})\s*(?:-|\s)?(?:hrs?|hours?|h|days?|mins?)\b`, "i"), " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/^(?:customer|client|name)\s*[:\-]?\s*/i, "")
      .replace(/^(?:for|to|at|in|on|re|job|work)\s*[:\-]?\s+/i, "");
    const cut = first.search(
      new RegExp(
        String.raw`\s(?:${NUMW})\s*(?:-|\s)?(?:hrs?|hours?|h|days?|mins?)\b|\s£|\s@|\scall[- ]?out|\s(?:fixed price|quoted?|parts|materials)\b`,
        "i",
      ),
    );
    if (cut > 2) first = first.slice(0, cut);
    first = first.replace(/\s+(?:for|to|at|in|on|with|from)$/i, "").replace(/^(?:she|he|they)\b.*$/i, "").trim();
    const letters = (first.match(/[a-z]/gi) ?? []).length;
    if (letters >= 4 && !/^\d/.test(first) && !/^(?:email|e-mail|tel|phone|mob)\b/i.test(first)) {
      jobSummary = sentence(first.length > 80 ? `${first.slice(0, 77)}…` : first);
      break;
    }
  }
  const summaryWithAddress = address ? `${jobSummary} at ${address}` : jobSummary;

  // --- Walk clauses
  let rate = settings.hourlyRate;
  let rateFound = false;
  let hours = 0;
  let labourQty = 1;
  let days = 0;
  let dayRate = 0;
  let calloutMentionedNoAmount = false;
  const labourAmounts: LineItem[] = [];

  for (const clause0 of rawClauses) {
    let clause = ` ${clause0} `;

    // "6 boards @ 14.50", "3 flats at 120 each", "3 rooms @ 40 a room", "4 certs at 65 each",
    // "posts 4 x 15", "tiles 8 x 4.50", "6 x £8": one line, quantity N at the unit price.
    const qtyPrice: RegExp[] = [
      new RegExp(String.raw`\b(\d{1,4}(?:\.\d{1,2})?)\s*(?:x\s*)?((?:[a-z][a-z'’.]*\s+){0,2}[a-z][a-z'’.]*)\s*(?:@|\bat\b)\s*(?:£\s?)?(${N})\s*(?:quid|pounds?)?(?:\s*(?:each|ea|per\s+[a-z]+|an?\s+[a-z]+|/\s?[a-z]+))?`, "i"),
      new RegExp(String.raw`\b((?:[a-z][a-z'’.]*\s+){0,2}[a-z][a-z'’.]*)\s+(\d{1,4})\s?x\s?(?:£\s?)?(${N})\b(?!\s*(?:mm|cm|m\b|ft|hrs?|hours?|days?))`, "i"),
      new RegExp(String.raw`(?:^|\s)(\d{1,4})\s?x\s?£\s?(${N})\s*((?:[a-z][a-z'’.]*\s*){0,3})`, "i"),
    ];
    const TIME_UNIT = /^(?:hrs?|hours?|h|days?|mins?|minutes?|weeks?|of us|men|lads|blokes|people)$/i;
    for (let guard = 0; guard < 4; guard++) {
      let hit: { qty: number; thing: string; unit: number; text: string } | null = null;
      const m0 = clause.match(qtyPrice[0]);
      if (m0 && !TIME_UNIT.test(m0[2].trim()) && !/(?:\/|per|an?|p\/?)\s*(?:hr|hour|h|day)\b/i.test(m0[0].slice(m0[0].search(/(?:@|\bat\b)/i)))) {
        hit = { qty: Number(m0[1]), thing: m0[2], unit: money(m0[3]), text: m0[0] };
      }
      const m1 = !hit ? clause.match(qtyPrice[1]) : null;
      if (m1 && !TIME_UNIT.test(m1[1].trim().split(/\s+/).pop() ?? "") && !/\brate$/i.test(m1[1].trim())) hit = { qty: Number(m1[2]), thing: m1[1], unit: money(m1[3]), text: m1[0] };
      const m2 = !hit ? clause.match(qtyPrice[2]) : null;
      if (m2) hit = { qty: Number(m2[1]), thing: m2[3] || "", unit: money(m2[2]), text: m2[0] };
      if (!hit || !(hit.qty > 0) || !(hit.unit > 0)) break;
      const thing = cleanDesc(hit.thing.replace(/\b(?:each|ea|per|a|an)\b/gi, " "));
      const kind: LineItem["kind"] = /\b(?:hrs?|hours?)\b/i.test(thing) ? "labour" : PARTS_KW.test(thing) || !thing ? "parts" : "other";
      items.push({
        id: uid("li_"),
        kind,
        description: sentence(thing || "Items").slice(0, 120),
        quantity: hit.qty,
        unitAmount: hit.unit,
        unit: "QUANTITY",
      });
      clause = clause.replace(hit.text, " ");
    }

    // quantity: x2, 2x, 2 x, "two of"
    let qty = 1;
    const qtyM = clause.match(/\bx\s?(\d{1,3})\b|\b(\d{1,3})\s?x\b(?!\s?\d)|\b(\d{1,3})\s?x\s(?=[a-z])/i);
    if (qtyM) {
      qty = Number(qtyM[1] ?? qtyM[2] ?? qtyM[3]);
      clause = clause.replace(qtyM[0], " ");
    }

    // hourly rate: "£50/hr", "50 an hour", "@ 45ph", "rate 50", "hourly rate of £52"
    const rateM =
      clause.match(new RegExp(String.raw`(?:£\s?)?(${N})\s*(?:quid|pounds?)?\s*(?:/|per|an|a|p/?)\s*(?:hr|hour|h)\b|(?:£\s?)?(${N})\s?ph\b`, "i")) ||
      clause.match(new RegExp(String.raw`(?<!day\s?)\b(?:hourly\s+)?rate\s*(?:of|is|:|@|at)?\s*(?:£\s?)?(${N})`, "i"));
    if (rateM) {
      rate = money(rateM[1] ?? rateM[2]);
      rateFound = true;
      clause = clause.replace(rateM[0], " ");
    }

    // day rate: "£220/day", "220 a day", "day rate 220"
    const dayRateM =
      clause.match(new RegExp(String.raw`(?:£\s?)?(${N})\s*(?:quid|pounds?)?\s*(?:/|per|a|p/?)\s*day\b`, "i")) ||
      clause.match(new RegExp(String.raw`\bday\s*rate\s*(?:of|is|:|@|at)?\s*(?:£\s?)?(${N})`, "i"));
    if (dayRateM) {
      dayRate = money(dayRateM[1]);
      clause = clause.replace(dayRateM[0], " ");
    }

    // hours / minutes / days
    let clauseHours = 0;
    const hrRe = new RegExp(String.raw`\b(${NUMW})\s*(?:-|\s)?(?:hrs?|hours?|h)\b(?!\w)`, "gi");
    let hm: RegExpExecArray | null;
    while ((hm = hrRe.exec(clause))) {
      const v = parseNumberWord(hm[1]);
      if (Number.isFinite(v)) clauseHours += v;
    }
    clause = clause.replace(hrRe, " ");
    if (/\bhalf (?:an |a )?hour\b/i.test(clause)) {
      clauseHours += 0.5;
      clause = clause.replace(/\bhalf (?:an |a )?hour\b/i, " ");
    }
    const minM = clause.match(/\b(\d{1,3})\s*(?:mins?|minutes?)\b/i);
    if (minM) {
      clauseHours += Number(minM[1]) / 60;
      clause = clause.replace(minM[0], " ");
    }
    let clauseDays = 0;
    const halfDay = /\bhalf[- ]a?[- ]?day\b/i;
    const fullDay = /\b(?:full|whole)[- ]day\b|\ba\s+day['’]?s\s+work\b/i;
    const dayM = clause.match(new RegExp(String.raw`\b(${NUMW})\s*(?:-|\s)?days?\b`, "i"));
    if (halfDay.test(clause)) {
      clauseDays += 0.5;
      clause = clause.replace(halfDay, " ");
    } else if (fullDay.test(clause)) {
      clauseDays += 1;
      clause = clause.replace(fullDay, " ");
    } else if (dayM) {
      const v = parseNumberWord(dayM[1]);
      if (Number.isFinite(v)) clauseDays += v;
      clause = clause.replace(dayM[0], " ");
    }
    if (/\bday\s*rate\b/i.test(clause0) && !clauseDays && qty > 1) {
      clauseDays = qty; // "day rate 220 x3"
      qty = 1;
    }

    const isCallout = CALLOUT_KW.test(clause);
    const isParts = PARTS_KW.test(clause);
    const isFixed = FIXED_KW.test(clause) && !isParts;
    const isWaste = WASTE_KW.test(clause);
    // "chemicals 35", "EICR cert 60", "petrol 8": a bare number straight after an item name is money.
    const trailing = clause.match(new RegExp(String.raw`(?:^|\s)([a-z][a-z&'’.\- ]*[a-z])\s+(${N})\s*$`, "i"));
    const itemPriced =
      !!trailing &&
      !/\b(?:flat|unit|no|number|room|house|plot|bay|floor|stage|phase|zone|week|day|job|apt|apartment|block|level|door|year|years|age|aged|ref|invoice)$/i.test(trailing[1].trim()) &&
      /[a-z]{3,}/i.test(trailing[1]);
    const keyworded = isCallout || isParts || isFixed || isWaste || CHARGE_KW.test(clause) || RATE_KW.test(clause) || itemPriced;
    // House numbers are already gone with the address; drop any street-style "12 high st" left.
    clause = clause.replace(new RegExp(String.raw`\b\d{1,4}[a-z]?\s+(?:[a-z'’]+\s+){1,3}(?:${STREET})\b`, "gi"), " ");
    const amounts = findMoney(clause, keyworded);

    // Labour bits found in this clause
    if (clauseHours > 0) {
      if (amounts.length >= 1 && /@|\bat\b/.test(clause) && !isParts && !isCallout) {
        // "4 hrs @ 50" → rate
        rate = amounts[0].amount;
        rateFound = true;
        amounts.shift();
      } else if (amounts.length === 1 && !isParts && !isCallout && !isWaste && !RATE_KW.test(clause) && !isFixed) {
        // "3 hrs labour £150" → a labour total, not a rate
        labourAmounts.push({
          id: uid("li_"),
          kind: "labour",
          description: `Labour (${clauseHours} hr${clauseHours === 1 ? "" : "s"})`,
          quantity: 1,
          unitAmount: amounts[0].amount,
          unit: "AMOUNT",
        });
        continue;
      }
      hours += clauseHours * qty;
      if (qty > 1) labourQty = qty;
      qty = 1;
    }
    if (clauseDays > 0) {
      if (!dayRate && amounts.length === 1 && !isParts && !isCallout && !isWaste) {
        dayRate = amounts.shift()!.amount; // "2 days @ £220"
      }
      days += clauseDays * qty;
      qty = 1;
    }

    if (isCallout) {
      const a = amounts.shift();
      if (a) items.push({ id: uid("li_"), kind: "callout", description: "Call-out charge", quantity: 1, unitAmount: a.amount, unit: "AMOUNT" });
      else calloutMentionedNoAmount = true;
    }

    for (const a of amounts) {
      const rest = cleanDesc(
        (clause.slice(0, a.index) + " " + clause.slice(a.end))
          .replace(new RegExp(MONEY_RE.source, "gi"), " ")
          .replace(new RegExp(BARE_RE.source, "gi"), " "),
      );
      if (isFixed) {
        items.push({ id: uid("li_"), kind: "other", description: summaryWithAddress.slice(0, 120), quantity: 1, unitAmount: a.amount, unit: "AMOUNT" });
      } else if (isWaste) {
        items.push({ id: uid("li_"), kind: "other", description: sentence(rest) || "Waste disposal", quantity: qty, unitAmount: a.amount, unit: qty > 1 ? "QUANTITY" : "AMOUNT" });
      } else if (isParts) {
        const what = rest
          .replace(/\b(?:parts?|materials?|and|&|supplies|from)\b/gi, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
        const shop = rest.match(/\b(screwfix|toolstation|wickes|b&q|travis(?: perkins)?|plumbase|cityplumb)\b/i)?.[1];
        const detail = shop && what.toLowerCase() === shop.toLowerCase() ? `(${titleCase(shop)})` : what ? `— ${what}` : "";
        items.push({
          id: uid("li_"),
          kind: "parts",
          description: detail ? `Parts & materials ${detail}` : "Parts & materials",
          quantity: qty,
          unitAmount: a.amount,
          unit: qty > 1 ? "QUANTITY" : "AMOUNT",
        });
      } else if (rest && /[a-z]{3,}/i.test(rest)) {
        // "new valve 18 quid", "2 x radiator valves £12"
        items.push({ id: uid("li_"), kind: "parts", description: sentence(rest).slice(0, 120), quantity: qty, unitAmount: a.amount, unit: qty > 1 ? "QUANTITY" : "AMOUNT" });
      } else {
        items.push({ id: uid("li_"), kind: "other", description: "Additional charge", quantity: qty, unitAmount: a.amount, unit: qty > 1 ? "QUANTITY" : "AMOUNT" });
        warnings.push(`Wasn't sure what £${a.amount.toFixed(2)} was for — check the description.`);
      }
    }
  }

  // --- Labour lines first
  const labour: LineItem[] = [];
  const labourDesc = jobSummary === "Work carried out" || /^labour/i.test(jobSummary) ? "Labour" : `Labour — ${jobSummary}`;
  if (dayRate > 0) {
    const d = days || 1;
    if (!days) warnings.push("Day rate found but not how many days — set to 1.");
    labour.push({ id: uid("li_"), kind: "labour", description: `${labourDesc} (${d} day${d === 1 ? "" : "s"})`, quantity: d, unitAmount: dayRate, unit: "QUANTITY" });
  } else if (days > 0 && hours === 0) {
    hours = days * 8;
  }
  if (hours > 0) {
    labour.push({
      id: uid("li_"),
      kind: "labour",
      description: labourQty > 1 ? `${labourDesc} (${labourQty} people)` : labourDesc,
      quantity: round2(hours),
      unitAmount: rate,
      unit: "HOURS",
    });
  }
  items.unshift(...labour, ...labourAmounts);
  void rateFound;

  if (calloutMentionedNoAmount && !items.some((i) => i.kind === "callout")) {
    if (settings.calloutFee > 0) {
      items.push({ id: uid("li_"), kind: "callout", description: "Call-out charge", quantity: 1, unitAmount: settings.calloutFee, unit: "AMOUNT" });
    } else {
      warnings.push("Call-out mentioned but no amount — add it if you charge one.");
    }
  }

  const dueDate = dueToday ? today : addDays(today, termDays);
  if (dueToday) termDays = 0;

  if (!customerName) warnings.push("Couldn't spot the customer's name.");
  if (!email) warnings.push("No email address found — PayPal needs one to send the invoice.");
  if (items.length === 0) warnings.push("No hours or amounts found — add line items before sending.");

  const confidence =
    (customerName ? 0.3 : 0) + (email ? 0.3 : 0) + (items.length ? 0.3 : 0) + (warnings.length === 0 ? 0.1 : 0);

  return {
    confidence,
    draft: {
      customerName,
      customerEmail: email,
      customerType: detectCustomerType(customerName, email),
      jobSummary: summaryWithAddress.slice(0, 90),
      items,
      vatEnabled,
      vatRate: settings.vatRate,
      currency: "GBP",
      issueDate: today,
      dueDate,
      note: `Thanks for choosing ${settings.businessName}. ${termDays === 0 ? "Payment due on receipt." : `Payment due within ${termDays} days.`}`,
      warnings,
    },
  };
}
