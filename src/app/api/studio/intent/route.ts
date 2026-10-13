// Ask Sorted for the AG Studio dashboard. Rules first (no AI call); only a request the rules
// can't place goes to the free LLM chain in src/lib/ai, as one short JSON call. Results are
// cached per prompt + vocabulary so repeating a question never spends a second call.

import { extractJSON, fallbackEngine, friendlyAIError, getLLM, RULES_ENGINE } from "@/lib/ai/provider";
import { readJSON } from "@/lib/api";
import { todayISO } from "@/lib/format";
import { intentSystemPrompt, rulesConfident, rulesIntent, sanitizeIntent, type StudioIntent } from "@/lib/studio/intent";
import type { StudioVocab } from "@/lib/studio/rows";
import type { EngineInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 80)).slice(0, 80) : []);

type Answer = { intent: StudioIntent; engine: EngineInfo; aiError?: string };
const g = globalThis as unknown as { __sortedIntentCache?: Map<string, Answer> };
const cache: Map<string, Answer> = (g.__sortedIntentCache ??= new Map());

export async function POST(req: Request) {
  const body = await readJSON(req);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 300) : "";
  if (!prompt) return Response.json({ error: "Ask Sorted something about your ledger." }, { status: 400 });
  const v = (body.vocab ?? {}) as Record<string, unknown>;
  const vocab: StudioVocab = { cities: strList(v.cities), areas: strList(v.areas), customers: strList(v.customers) };
  const today = typeof body.today === "string" && /^\d{4}-\d\d-\d\d$/.test(body.today) ? body.today : todayISO();

  const rules = rulesIntent(prompt, vocab, today);
  if (rulesConfident(rules)) return Response.json({ intent: rules, engine: RULES_ENGINE } satisfies Answer);

  const key = JSON.stringify([prompt.toLowerCase(), vocab, today.slice(0, 7)]);
  const hit = cache.get(key);
  if (hit) return Response.json(hit);

  const llm = getLLM();
  if (!llm) return Response.json({ intent: rules, engine: RULES_ENGINE } satisfies Answer);
  try {
    const res = await llm.chat({
      system: intentSystemPrompt(vocab, today),
      messages: [{ role: "user", content: prompt }],
      json: true,
      maxTokens: 300,
      temperature: 0,
    });
    const intent = sanitizeIntent(extractJSON(res.text), vocab);
    const answer: Answer = intent ? { intent, engine: res.engine } : { intent: rules, engine: fallbackEngine(), aiError: "AI answer unusable, used the rules engine" };
    if (cache.size > 200) cache.clear();
    cache.set(key, answer);
    return Response.json(answer);
  } catch (e) {
    return Response.json({ intent: rules, engine: fallbackEngine(), aiError: friendlyAIError(e) } satisfies Answer);
  }
}
