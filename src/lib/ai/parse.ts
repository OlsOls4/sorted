import "server-only";
import { addDays, round2, todayISO, uid } from "../format";
import { detectCustomerType, mentionsVat, noteAmounts, parseJobNotes } from "../parser";
import type { EngineInfo, InvoiceDraft, LineItem, Settings } from "../types";
import { RULES_ENGINE, extractJSON, fallbackEngine, friendlyAIError, getLLM } from "./provider";

const SYSTEM = `You turn a UK tradesperson's messy job notes into a structured invoice draft.
Return ONLY a JSON object with keys:
customerName (string, keep titles like "Mrs"), customerEmail (string or ""), customerType ("consumer"|"business"),
jobSummary (short British-English description of the work, sentence case, max 60 chars),
items (array of {kind: "labour"|"parts"|"callout"|"other", description, quantity (number), unitAmount (number, GBP ex VAT), unit: "HOURS"|"QUANTITY"|"AMOUNT"}),
vatMentioned (true if the notes say +VAT / plus VAT, else false), dueInDays (number or null), warnings (array of short strings for anything ambiguous).
Rules: labour is hours x the hourly rate given unless notes state a different rate or a day rate; parts/materials are a single AMOUNT line unless itemised; never invent an email; never invent prices that aren't in the notes (except labour at the default rate); amounts are pounds ("18 quid" = 18, "1.2k" = 1200).
A number after "call out"/"callout"/"call-out" is a callout line, never the hourly rate. "vat on top", "+ VAT", "plus vat", "ex VAT" all mean vatMentioned true; "no vat" means false. "pays in N days", "net N", "due in N days" set dueInDays.`;

interface AIDraft {
  customerName?: string;
  customerEmail?: string;
  customerType?: string;
  jobSummary?: string;
  items?: Partial<LineItem>[];
  vatMentioned?: boolean;
  dueInDays?: number | null;
  warnings?: string[];
}

const sentenceCase = (s: string) => {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

/** Models sometimes echo the customer into the summary ("fixed stopcock for mrs okafor"). */
function cleanSummary(ai: string | undefined, customer: string, fallback: string): string {
  let s = (ai ?? "").trim();
  if (customer) {
    const bare = customer.replace(/^(?:mrs|mr|ms|miss|dr|prof)\.?\s+/i, "");
    for (const n of [customer, bare].filter((x) => x.length > 2)) {
      s = s.replace(new RegExp(String.raw`\s*\b(?:for|to|at)?\s*${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:['’]s)?\b`, "ig"), "");
    }
  }
  s = s.replace(/\s+(?:for|to|at|in)$/i, "").trim();
  if (s.length < 4) return fallback;
  // Keep the address the rules parser found (e.g. "at 12 Cotham Hill") if the model dropped it.
  const addr = fallback.match(/\sat\s(\d.*)$/)?.[1];
  if (addr && !s.toLowerCase().includes(addr.toLowerCase())) s = `${s} at ${addr}`;
  return sentenceCase(s);
}

// Identical notes + settings within 10 minutes reuse the last AI parse (saves free-tier calls).
const CACHE_TTL_MS = 10 * 60_000;
const gc = globalThis as unknown as { __sortedParseCache?: Map<string, { at: number; draft: InvoiceDraft; engine: EngineInfo }> };
const parseCache = (gc.__sortedParseCache ??= new Map());
const cacheKey = (notes: string, s: Settings, today: string) =>
  JSON.stringify([notes.trim().replace(/\s+/g, " "), s.hourlyRate, s.vatRegistered, s.vatRate, s.paymentTermsDays, s.calloutFee, s.businessName, today]);

export async function parseNotes(
  notes: string,
  settings: Settings,
): Promise<{ draft: InvoiceDraft; engine: EngineInfo; aiError?: string; cached?: boolean }> {
  const today = todayISO();
  const heuristic = parseJobNotes(notes, settings, today).draft;
  const llm = getLLM();
  if (!llm) return { draft: heuristic, engine: RULES_ENGINE };
  const key = cacheKey(notes, settings, today);
  const hit = parseCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { draft: structuredClone(hit.draft), engine: hit.engine, cached: true };
  try {
    const res = await llm.chat({
      system: SYSTEM,
      json: true,
      messages: [
        {
          role: "user",
          content: `Default hourly rate: £${settings.hourlyRate}. VAT registered: ${settings.vatRegistered ? "yes" : "no"}. Today: ${today}.\nNotes:\n"""${notes.slice(0, 4000)}"""`,
        },
      ],
      maxTokens: 900,
    });
    const ai = extractJSON<AIDraft>(res.text);
    if (!ai || !Array.isArray(ai.items)) throw new Error("model returned no usable JSON");
    const items: LineItem[] = ai.items
      .map((li) => ({
        id: uid("li_"),
        kind: (["labour", "parts", "callout", "other"].includes(String(li.kind)) ? li.kind : "other") as LineItem["kind"],
        description:
          li.kind === "callout" && /^call[- ]?out(?: charge| fee)?$/i.test(String(li.description ?? "").trim())
            ? "Call-out charge"
            : sentenceCase(String(li.description ?? "Work")).slice(0, 200),
        quantity: round2(Number(li.quantity) || 1),
        unitAmount: round2(Number(li.unitAmount) || 0),
        unit: (["HOURS", "QUANTITY", "AMOUNT"].includes(String(li.unit)) ? li.unit : "AMOUNT") as LineItem["unit"],
      }))
      .filter((li) => li.unitAmount > 0 || li.kind === "labour");
    // Guard rails: emails must literally appear in the notes.
    const aiEmail = (ai.customerEmail ?? "").trim().toLowerCase();
    const email = aiEmail && notes.toLowerCase().includes(aiEmail) ? aiEmail : heuristic.customerEmail;
    const name = (ai.customerName ?? "").trim() || heuristic.customerName;
    const term = typeof ai.dueInDays === "number" && ai.dueInDays >= 0 && ai.dueInDays < 366 ? ai.dueInDays : settings.paymentTermsDays;
    const warnings = [...(ai.warnings ?? []).map(String)];
    if (!email) warnings.push("No email address found — PayPal needs one to send the invoice.");
    // Flag any £ amount in the notes that the AI draft doesn't account for (a line's unit price,
    // line total, or the labour rate), e.g. a short "screws 12" the model dropped.
    const finalItems = items.length ? items : heuristic.items;
    const covered = new Set<number>();
    for (const li of finalItems) {
      covered.add(round2(li.unitAmount));
      covered.add(round2(li.unitAmount * li.quantity));
    }
    covered.add(round2(settings.hourlyRate));
    const missing = noteAmounts(heuristic).filter((a) => !covered.has(a));
    if (missing.length) {
      warnings.unshift(`Check the lines: ${missing.map((a) => `£${a.toFixed(2)}`).join(", ")} in your notes ${missing.length === 1 ? "isn't" : "aren't"} on this draft.`);
    }
    const draft: InvoiceDraft = {
      ...heuristic,
      customerName: name,
      customerEmail: email,
      customerType: ai.customerType === "business" || ai.customerType === "consumer" ? ai.customerType : detectCustomerType(name, email),
      jobSummary: cleanSummary(ai.jobSummary, name, heuristic.jobSummary).slice(0, 90),
      items: items.length ? items : heuristic.items,
      // When the notes talk about VAT ("no vat", "+ VAT"), the rules engine's reading wins over the default.
      vatEnabled: mentionsVat(notes) ? heuristic.vatEnabled : settings.vatRegistered || !!ai.vatMentioned,
      dueDate: addDays(today, term),
      note: `Thanks for choosing ${settings.businessName}. Payment due within ${term} days.`,
      warnings: [...new Set(warnings)].slice(0, 5),
    };
    if (parseCache.size > 200) for (const [k, v] of parseCache) if (Date.now() - v.at > CACHE_TTL_MS || parseCache.size > 150) parseCache.delete(k);
    parseCache.set(key, { at: Date.now(), draft: structuredClone(draft), engine: res.engine });
    return { draft, engine: res.engine };
  } catch (e) {
    return { draft: heuristic, engine: fallbackEngine(), aiError: friendlyAIError(e) };
  }
}
