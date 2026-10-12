// Deterministic job-notes parser. Used as the no-AI fallback and as a
// sanity layer over AI output (e.g. to recover an email the model missed).

import { addDays, round2, todayISO, uid } from "./format";
import type { CustomerType, InvoiceDraft, LineItem, Settings } from "./types";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MONEY = String.raw`£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s?(k))?`;
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  half: 0.5, couple: 2,
};
const BUSINESS_HINT =
  /\b(ltd|limited|llp|plc|& sons|and sons|lettings|properties|property|estates|builders|construction|developments|services|group|holdings|cafe|café|restaurant|pub|hotel|school|surgery|agency|management|housing|associates|co\.)\b/i;
const FREEMAIL = /@(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|aol|btinternet|sky|virginmedia|talktalk|example)\./i;

function money(raw: string, k?: string): number {
  const n = parseFloat(raw.replace(/,/g, ""));
  return round2(k ? n * 1000 : n);
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bMc([a-z])/g, (_m, c: string) => `Mc${c.toUpperCase()}`)
    .replace(/\bO'([a-z])/g, (_m, c: string) => `O'${c.toUpperCase()}`)
    .replace(/\b(Ltd|Llp|Plc)\b/g, (m) => (m === "Ltd" ? "Ltd" : m.toUpperCase()));
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

function extractCustomer(text: string, email: string): string {
  const patterns: RegExp[] = [
    /\b(?:customer|client|for|to|at)\s*[:\-]?\s*((?:Mrs|Mr|Ms|Miss|Dr|Prof)\.?\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/,
    /\b((?:Mrs|Mr|Ms|Miss|Dr|Prof)\.?\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/,
    /\b(?:customer|client)\s*[:\-]\s*([A-Z][\w&'.-]*(?:\s+[A-Z&][\w&'.-]*){0,4})/i,
    /\bfor\s+([A-Z][\w&'.-]*(?:\s+(?:[A-Z&][\w&'.-]*|and|of))*\s+(?:Ltd|Limited|LLP|plc|Lettings|Properties|Estates|Builders|Services|Cafe|Café))\b/,
    /\bfor\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)(?=[\s,.;]|$)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      let name = m[1].trim().replace(/[,.;]+$/, "");
      name = name.replace(/\s+(?:she|he|they|it|at|in|on)$/i, "");
      // strip possessive ("Mrs Patel's")
      name = name.replace(/'s$/i, "");
      if (name.length > 1) return name;
    }
  }
  return email ? nameFromEmail(email) : "";
}

function parseNumberWord(s: string): number {
  const t = s.toLowerCase().trim();
  if (t in NUM_WORDS) return NUM_WORDS[t];
  const n = parseFloat(t.replace(/½/, ".5"));
  return Number.isFinite(n) ? n : NaN;
}

function extractJobSummary(text: string, customer = ""): string {
  // First clause, cut before customer/money/time chatter.
  let src = text.replace(EMAIL_RE, "");
  if (customer) src = src.split(customer).join(" ").replace(/\s+['’]s\b/g, "").replace(/^\s*(?:for|to|at)?\s*[,:-]?\s*(?:for\b)?/i, "");
  let first = src.split(/[\n;]|,(?![^()]*\))|\.\s/)[0];
  const cut = first.search(
    /\s(?:for|to|at)\s+(?:Mrs|Mr|Ms|Miss|Dr|Prof|[A-Z])|\s(?:\d+(?:\.\d+)?|½|half|one|two|three|four|a|an)\s*(?:-|\s)?(?:hrs?|hours?|h|days?)\b|\shalf an? (?:hour|day)|\s£|\s@|\sdue\b|\sfixed price|\squoted|\s\+?\s?vat\b|\scall[- ]?out/i,
  );
  if (cut > 3) first = first.slice(0, cut);
  first = first.replace(/\s{2,}/g, " ").trim();
  first = first.replace(/^(?:for|to|at|-|,|:)\s+/i, "").replace(/\s+(?:for|to|at)$/i, "").trim();
  if (first.length < 3 || /^\d/.test(first)) return "Work carried out";
  const s = first.charAt(0).toUpperCase() + first.slice(1);
  return s.length > 90 ? `${s.slice(0, 87)}…` : s;
}

export interface ParseResult {
  draft: InvoiceDraft;
  confidence: number; // 0..1
}

export function parseJobNotes(notes: string, settings: Settings, today = todayISO()): ParseResult {
  const text = notes.replace(/\s+/g, " ").trim();
  const warnings: string[] = [];
  const items: LineItem[] = [];

  const email = (text.match(EMAIL_RE)?.[0] ?? "").toLowerCase();
  const customerName = extractCustomer(text, email) || "";
  const jobSummary = extractJobSummary(text, customerName);

  // --- Hourly rate override: "@ £50/hr", "£50 an hour", "rate £50"
  let rate = settings.hourlyRate;
  const rateM =
    text.match(new RegExp(`${MONEY}\\s*(?:/|per|an|a)\\s*(?:hr|hour|h)\\b`, "i")) ||
    text.match(new RegExp(`rate\\s*(?:of|:)?\\s*${MONEY}`, "i"));
  if (rateM) rate = money(rateM[1], rateM[2]);

  // --- Day rate: "2 days @ £220/day"
  const dayRateM = text.match(
    new RegExp(`(\\d+(?:\\.\\d+)?|a|one|two|three|four|five|half)\\s*(?:days?)\\s*(?:@|at|x)?\\s*${MONEY}\\s*(?:/|per|a)\\s*day`, "i"),
  );

  // --- Hours: "4 hrs", "2.5 hours", "4h", "half a day", "full day"
  let hours = 0;
  const hoursM = text.match(/(\d+(?:\.\d+)?|½|one|two|three|four|five|six|seven|eight|nine|ten|a|an|half)\s*(?:-|\s)?(?:hrs?|hours?|h)\b(?!\w)/i);
  if (hoursM) hours = parseNumberWord(hoursM[1]);
  if (/\bhalf (?:an |a )?hour\b/i.test(text)) hours = 0.5;
  if (!hoursM && !dayRateM) {
    if (/\bhalf[- ]a?[- ]?day\b/i.test(text)) hours = 4;
    else if (/\b(?:full|whole|a|one)[- ]day\b/i.test(text)) hours = 8;
    else {
      const daysM = text.match(/(\d+(?:\.\d+)?|two|three|four|five)\s+days?\b/i);
      if (daysM) hours = parseNumberWord(daysM[1]) * 8;
    }
  }

  if (dayRateM) {
    const days = parseNumberWord(dayRateM[1]);
    items.push({
      id: uid("li_"),
      kind: "labour",
      description: `Labour — ${days} day${days === 1 ? "" : "s"}`,
      quantity: days,
      unitAmount: money(dayRateM[2], dayRateM[3]),
      unit: "QUANTITY",
    });
  } else if (hours > 0) {
    items.push({
      id: uid("li_"),
      kind: "labour",
      description: jobSummary === "Work carried out" || /^labour/i.test(jobSummary) ? "Labour" : `Labour — ${jobSummary}`,
      quantity: hours,
      unitAmount: rate,
      unit: "HOURS",
    });
  }

  // --- Money mentions: parts/materials/callout/fixed price
  const moneyRe = new RegExp(MONEY, "gi");
  let m: RegExpExecArray | null;
  const used = new Set<number>();
  if (rateM?.index !== undefined) used.add(text.indexOf(rateM[0]) + rateM[0].indexOf("£"));
  if (dayRateM?.index !== undefined) used.add(text.indexOf(dayRateM[0]) + dayRateM[0].indexOf("£"));
  while ((m = moneyRe.exec(text))) {
    if (used.has(m.index)) continue;
    const amount = money(m[1], m[2]);
    const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const near = `${before.slice(-25)} | ${after.slice(0, 25)}`;
    if (/(\/|per|an|a)\s*(hr|hour|day)/.test(after.slice(0, 10))) continue;
    if (/call[- ]?out|callout|attendance/.test(near)) {
      items.push({ id: uid("li_"), kind: "callout", description: "Call-out charge", quantity: 1, unitAmount: amount, unit: "AMOUNT" });
    } else if (/part|material|supplies|kit|merchant|screwfix|toolstation|wickes|b&q|travis/.test(near)) {
      const what = after.match(/^\s*(?:for|on)\s+([a-z0-9 '\-]+?)(?=[,.;]|$| and )/i)?.[1];
      items.push({
        id: uid("li_"),
        kind: "parts",
        description: what ? `Parts & materials — ${what.trim()}` : "Parts & materials",
        quantity: 1,
        unitAmount: amount,
        unit: "AMOUNT",
      });
    } else if (/fixed|quote|quoted|agreed|price|job total|total/.test(near)) {
      items.push({ id: uid("li_"), kind: "other", description: jobSummary, quantity: 1, unitAmount: amount, unit: "AMOUNT" });
    } else if (/skip|tip|disposal|waste/.test(near)) {
      items.push({ id: uid("li_"), kind: "other", description: "Waste disposal", quantity: 1, unitAmount: amount, unit: "AMOUNT" });
    } else {
      const what = after.match(/^\s*(?:for|on)\s+([a-z0-9 '\-]+?)(?=[,.;]|$| and )/i)?.[1];
      items.push({
        id: uid("li_"),
        kind: what ? "parts" : "other",
        description: what ? `Materials — ${what.trim()}` : "Additional charge",
        quantity: 1,
        unitAmount: amount,
        unit: "AMOUNT",
      });
      if (!what) warnings.push(`Wasn't sure what ${"£" + amount.toFixed(2)} was for — check the description.`);
    }
  }

  if (settings.calloutFee > 0 && !items.some((i) => i.kind === "callout") && /call[- ]?out/i.test(text)) {
    items.push({ id: uid("li_"), kind: "callout", description: "Call-out charge", quantity: 1, unitAmount: settings.calloutFee, unit: "AMOUNT" });
  }

  // --- VAT
  let vatEnabled = settings.vatRegistered;
  if (/(?:\+|\bplus|\badd|\binc\.?|\bincluding)\s*vat\b/i.test(text)) vatEnabled = true;
  if (/\bno vat\b/i.test(text)) vatEnabled = false;

  // --- Due date
  let termDays = settings.paymentTermsDays;
  const dueM = text.match(/\b(?:due in|net|within|payment in)\s*(\d{1,3})\s*(?:days?)?/i);
  if (dueM) termDays = parseInt(dueM[1], 10);
  const dueDate = /\bdue on receipt|pay(?:ment)? on the day\b/i.test(text) ? today : addDays(today, termDays);

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
      jobSummary,
      items,
      vatEnabled,
      vatRate: settings.vatRate,
      currency: "GBP",
      issueDate: today,
      dueDate,
      note: `Thanks for choosing ${settings.businessName}. Payment due within ${termDays} days.`,
      warnings,
    },
  };
}
