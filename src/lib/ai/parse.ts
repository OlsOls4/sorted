import "server-only";
import { addDays, round2, todayISO, uid } from "../format";
import { detectCustomerType, parseJobNotes } from "../parser";
import type { EngineInfo, InvoiceDraft, LineItem, Settings } from "../types";
import { RULES_ENGINE, extractJSON, getLLM } from "./provider";

const SYSTEM = `You turn a UK tradesperson's messy job notes into a structured invoice draft.
Return ONLY a JSON object with keys:
customerName (string, keep titles like "Mrs"), customerEmail (string or ""), customerType ("consumer"|"business"),
jobSummary (short British-English description of the work, sentence case, max 60 chars),
items (array of {kind: "labour"|"parts"|"callout"|"other", description, quantity (number), unitAmount (number, GBP ex VAT), unit: "HOURS"|"QUANTITY"|"AMOUNT"}),
vatMentioned (true if the notes say +VAT / plus VAT, else false), dueInDays (number or null), warnings (array of short strings for anything ambiguous).
Rules: labour is hours x the hourly rate given unless notes state a different rate or a day rate; parts/materials are a single AMOUNT line unless itemised; never invent an email; never invent prices that aren't in the notes (except labour at the default rate); amounts are pounds.`;

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

export async function parseNotes(
  notes: string,
  settings: Settings,
): Promise<{ draft: InvoiceDraft; engine: EngineInfo; aiError?: string }> {
  const today = todayISO();
  const heuristic = parseJobNotes(notes, settings, today).draft;
  const llm = getLLM();
  if (!llm) return { draft: heuristic, engine: RULES_ENGINE };
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
        description: String(li.description ?? "Work").slice(0, 200),
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
    const draft: InvoiceDraft = {
      ...heuristic,
      customerName: name,
      customerEmail: email,
      customerType: ai.customerType === "business" || ai.customerType === "consumer" ? ai.customerType : detectCustomerType(name, email),
      jobSummary: (ai.jobSummary ?? heuristic.jobSummary).slice(0, 90),
      items: items.length ? items : heuristic.items,
      vatEnabled: settings.vatRegistered || !!ai.vatMentioned,
      dueDate: addDays(today, term),
      note: `Thanks for choosing ${settings.businessName}. Payment due within ${term} days.`,
      warnings: [...new Set(warnings)].slice(0, 5),
    };
    return { draft, engine: llm.info };
  } catch (e) {
    return { draft: heuristic, engine: RULES_ENGINE, aiError: (e as Error).message };
  }
}
