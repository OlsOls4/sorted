// Provider-agnostic LLM interface with tool calling. Server-only.
// Free-tier friendly chain, tried in order: Groq -> NVIDIA NIM -> OpenRouter ->
// Gemini -> OpenAI (or any OPENAI_BASE_URL) -> Anthropic. Groq, NVIDIA,
// OpenRouter and OpenAI share one OpenAI-compatible adapter. A provider that
// returns 429/5xx/times out is skipped (and remembered for a few minutes) and
// the next one is tried. If no key is configured, getLLM() returns null and
// callers use the deterministic rules engine.

import "server-only";
import type { EngineInfo } from "../types";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (object)
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LLMMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools?: ToolSpec[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface LLM {
  info: EngineInfo;
  /** Providers sharing a group (e.g. two Groq models) are skipped together on non-429 errors. */
  group?: string;
  chat(req: LLMRequest): Promise<LLMResponse>;
}

export class LLMError extends Error {
  status: number; // HTTP status, 0 = network/timeout
  retryAfterSec?: number;
  provider?: string;
  constructor(message: string, status: number, retryAfterSec?: number) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const timeoutMs = () => Number(process.env.SORTED_AI_TIMEOUT_MS || 12_000);

function parseRetryAfter(res: Response, data: Record<string, unknown>, text: string): number | undefined {
  const h = res.headers.get("retry-after");
  if (h && Number.isFinite(Number(h))) return Number(h);
  // Gemini: details[].retryDelay "23s"; OpenAI-style messages: "try again in 1m30s" / "retry in 23.5s"
  const m = text.match(/retry(?:Delay)?"?\s*[:=]?\s*"?(?:in\s*)?(\d+(?:\.\d+)?)s/i) || text.match(/try again in\s*(?:(\d+)m)?\s*(\d+(?:\.\d+)?)s/i);
  if (m) return m.length > 2 ? Number(m[1] || 0) * 60 + Number(m[2]) : Number(m[1]);
  void data;
  return undefined;
}

async function postJSON(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: "no-store",
      });
    } catch (e) {
      const aborted = (e as Error).name === "AbortError" || ctrl.signal.aborted;
      throw new LLMError(aborted ? `timed out after ${timeoutMs()}ms` : `network error: ${(e as Error).message}`, 0);
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = data.error as { message?: string } | string | undefined;
      const msg = (typeof err === "string" ? err : err?.message) ?? text.slice(0, 300);
      throw new LLMError(`HTTP ${res.status}: ${String(msg).slice(0, 300)}`, res.status, parseRetryAfter(res, data, text));
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

// ---------------- OpenAI-compatible (OpenAI, Groq, NVIDIA NIM, OpenRouter, any OPENAI_BASE_URL) ----------------
export interface OpenAICompatConfig {
  id: string; // provider id, e.g. "groq"
  name: string; // display name, e.g. "Groq"
  baseUrl: string;
  apiKey: string;
  model: string;
  /** json_object response_format is sent only where the endpoint is known to accept it. */
  jsonMode?: boolean;
  extraHeaders?: Record<string, string>;
  /** Extra body fields (e.g. reasoning effort for reasoning models). */
  extraBody?: Record<string, unknown>;
}

export function openAICompatible(cfg: OpenAICompatConfig): LLM {
  const base = cfg.baseUrl.replace(/\/$/, "");
  return {
    info: { id: cfg.id, label: `${cfg.name} ${cfg.model}`, ai: true },
    group: cfg.id,
    async chat(req) {
      const messages: unknown[] = [{ role: "system", content: req.system }];
      for (const m of req.messages) {
        if (m.role === "tool") messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
        else if (m.role === "assistant" && m.toolCalls?.length)
          messages.push({
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
          });
        else messages.push({ role: m.role, content: m.content });
      }
      const data = await postJSON(
        `${base}/chat/completions`,
        { Authorization: `Bearer ${cfg.apiKey}`, ...(cfg.extraHeaders ?? {}) },
        {
          model: cfg.model,
          messages,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 1200,
          ...(req.tools?.length
            ? { tools: req.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
            : {}),
          ...(req.json && cfg.jsonMode && !req.tools?.length ? { response_format: { type: "json_object" } } : {}),
          ...(cfg.extraBody ?? {}),
        },
      );
      const choice = (data.choices as { message?: Record<string, unknown> }[])?.[0];
      if (!choice) throw new LLMError("no choices in response", 502);
      const msg = (choice.message ?? {}) as {
        content?: string | null;
        tool_calls?: { id?: string; function: { name: string; arguments: string | Record<string, unknown> } }[];
      };
      return {
        text: (msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
        toolCalls: (msg.tool_calls ?? []).map((c, i) => ({
          id: c.id || `call_${Date.now()}_${i}`,
          name: c.function.name,
          args: typeof c.function.arguments === "string" ? safeParse(c.function.arguments) : (c.function.arguments ?? {}),
        })),
      };
    },
  };
}

const env = (k: string) => process.env[k]?.trim() || "";

// Groq free limits are per model per org, and Olly's other bot uses gpt-oss-120b
// on the same org, so Sorted defaults to gpt-oss-20b and falls back to a second
// Groq model on 429 before moving to the next provider.
function groqModel(model: string): LLM {
  return openAICompatible({
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: env("GROQ_API_KEY"),
    model,
    jsonMode: true,
    // gpt-oss is a reasoning model; low effort keeps latency and token use down.
    extraBody: /gpt-oss/i.test(model) ? { reasoning_effort: "low" } : undefined,
  });
}

function groqProviders(): LLM[] {
  if (!env("GROQ_API_KEY")) return [];
  const primary = env("GROQ_MODEL") || "openai/gpt-oss-20b";
  const fallback = env("GROQ_FALLBACK_MODEL") || "qwen/qwen3.8-27b";
  const models = fallback && fallback !== "none" && fallback !== primary ? [primary, fallback] : [primary];
  return models.map(groqModel);
}

function nvidia(): LLM | null {
  const key = env("NVIDIA_API_KEY");
  if (!key) return null;
  return openAICompatible({
    id: "nvidia",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: key,
    model: env("NVIDIA_MODEL") || "nvidia/nemotron-3-super-120b-a12b",
  });
}

function openRouter(): LLM | null {
  const key = env("OPENROUTER_API_KEY");
  if (!key) return null;
  return openAICompatible({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: key,
    model: env("OPENROUTER_MODEL") || "nvidia/nemotron-3-super-120b-a12b:free",
    extraHeaders: { "HTTP-Referer": "https://sorted-paypal.vercel.app", "X-Title": "Sorted" },
    extraBody: { reasoning: { effort: "low", exclude: true } },
  });
}

function openAI(): LLM | null {
  const key = env("OPENAI_API_KEY");
  if (!key) return null;
  const baseUrl = env("OPENAI_BASE_URL") || "https://api.openai.com/v1";
  return openAICompatible({
    id: "openai",
    name: /api\.openai\.com/.test(baseUrl) ? "OpenAI" : "OpenAI-compatible",
    baseUrl,
    apiKey: key,
    model: env("OPENAI_MODEL") || "gpt-4o-mini",
    jsonMode: /api\.openai\.com/.test(baseUrl),
  });
}

// ---------------- Anthropic ----------------
function anthropic(): LLM | null {
  const key = env("ANTHROPIC_API_KEY");
  if (!key) return null;
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
  return {
    info: { id: "anthropic", label: `Anthropic ${model}`, ai: true },
    async chat(req) {
      const messages: { role: "user" | "assistant"; content: unknown }[] = [];
      for (const m of req.messages) {
        if (m.role === "tool") {
          const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
          const last = messages[messages.length - 1];
          if (last?.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
          else messages.push({ role: "user", content: [block] });
        } else if (m.role === "assistant" && m.toolCalls?.length) {
          messages.push({
            role: "assistant",
            content: [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
            ],
          });
        } else messages.push({ role: m.role, content: m.content });
      }
      const data = await postJSON(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        {
          model,
          system: req.system + (req.json ? "\nRespond with a single JSON object only." : ""),
          messages,
          max_tokens: req.maxTokens ?? 1200,
          temperature: req.temperature ?? 0.2,
          ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
        },
      );
      const content = (data.content as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]) ?? [];
      return {
        text: content.filter((b) => b.type === "text").map((b) => b.text).join(""),
        toolCalls: content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} })),
      };
    },
  };
}

// ---------------- Google Gemini ----------------
function gemini(): LLM | null {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY)?.trim();
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  return {
    info: { id: "gemini", label: `Google ${model}`, ai: true },
    async chat(req) {
      const contents: unknown[] = [];
      for (const m of req.messages) {
        if (m.role === "tool") {
          const part = { functionResponse: { name: m.name, response: { result: safeParse(m.content, m.content) } } };
          const last = contents[contents.length - 1] as { role: string; parts: unknown[] } | undefined;
          if (last?.role === "user" && last.parts.every((p) => (p as Record<string, unknown>).functionResponse)) last.parts.push(part);
          else contents.push({ role: "user", parts: [part] });
        } else if (m.role === "assistant") {
          contents.push({
            role: "model",
            parts: [
              ...(m.content ? [{ text: m.content }] : []),
              ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args } })),
            ],
          });
        } else contents.push({ role: "user", parts: [{ text: m.content }] });
      }
      const data = await postJSON(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": key },
        {
          systemInstruction: { parts: [{ text: req.system }] },
          contents,
          generationConfig: {
            temperature: req.temperature ?? 0.2,
            maxOutputTokens: req.maxTokens ?? 1200,
            ...(req.json && !req.tools?.length ? { responseMimeType: "application/json" } : {}),
          },
          ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map(stripForGemini) }] } : {}),
        },
      );
      const parts =
        ((data.candidates as { content?: { parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[])?.[0]?.content
          ?.parts ?? []);
      return {
        text: parts.map((p) => p.text ?? "").join(""),
        toolCalls: parts
          .filter((p) => p.functionCall)
          .map((p, i) => ({ id: `g_${Date.now()}_${i}`, name: p.functionCall!.name, args: p.functionCall!.args ?? {} })),
      };
    },
  };
}

function stripForGemini(t: ToolSpec) {
  // Gemini rejects some JSON-Schema keywords (e.g. additionalProperties).
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) if (k !== "additionalProperties" && k !== "$schema") o[k] = clean(val);
      return o;
    }
    return v;
  };
  return { name: t.name, description: t.description, parameters: clean(t.parameters) };
}

function safeParse(s: string, fallback: unknown = {}): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : { value: v };
  } catch {
    return (typeof fallback === "object" ? fallback : { value: fallback }) as Record<string, unknown>;
  }
}

// ---------------- Provider chain with per-provider cooldowns ----------------

export const RULES_ENGINE: EngineInfo = { id: "rules", label: "Sorted rules engine (no AI key)", ai: false };
export const RULES_ENGINE_BUSY: EngineInfo = { id: "rules", label: "Sorted rules engine (AI busy, fallback)", ai: false };

const one = (f: () => LLM | null) => () => {
  const l = f();
  return l ? [l] : [];
};
const FACTORIES: Record<string, () => LLM[]> = {
  groq: groqProviders,
  nvidia: one(nvidia),
  openrouter: one(openRouter),
  gemini: one(gemini),
  openai: one(openAI),
  anthropic: one(anthropic),
};
const ORDER = ["groq", "nvidia", "openrouter", "gemini", "openai", "anthropic"];

/** Configured providers in fallback order. SORTED_AI_PROVIDER pins exactly one. */
export function configuredProviders(): LLM[] {
  if (process.env.SORTED_AI_DISABLED === "1") return [];
  const pin = env("SORTED_AI_PROVIDER").toLowerCase();
  const ids = pin && FACTORIES[pin] ? [pin] : ORDER;
  return ids.flatMap((id) => FACTORIES[id]());
}

// Cooldowns live in module memory (per server instance). Good enough to stop
// hammering a provider whose free quota is exhausted.
type Cooldown = { until: number; reason: string };
const g = globalThis as unknown as { __sortedAICooldowns?: Map<string, Cooldown> };
const cooldowns: Map<string, Cooldown> = (g.__sortedAICooldowns ??= new Map());

export function cooldownMs(err: LLMError): number {
  const s = err.status;
  if (s === 429) {
    const ra = err.retryAfterSec;
    // Short per-minute limits: honour Retry-After (min 30s). Daily quota: park it for 5 min.
    if (ra !== undefined && ra <= 120) return Math.max(30, ra) * 1000;
    return 5 * 60_000;
  }
  if (s === 401 || s === 403 || s === 404) return 10 * 60_000; // bad key / model gone: don't retry every request
  if (s === 400 && /api[ _-]?key/i.test(err.message)) return 10 * 60_000; // Gemini reports bad keys as 400
  if (s === 0 || s >= 500) return 60_000; // timeout / outage
  return 0; // 400 etc: probably request-specific
}

export function providerCoolingUntil(id: string, now = Date.now()): number | null {
  const c = cooldowns.get(id);
  if (!c) return null;
  if (c.until <= now) {
    cooldowns.delete(id);
    return null;
  }
  return c.until;
}

export function resetCooldowns() {
  cooldowns.clear();
}

/** Thrown when every configured provider failed or is cooling down. */
export class AIUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIUnavailableError";
  }
}

export interface RoutedResponse extends LLMResponse {
  engine: EngineInfo;
}

export interface LLMRouter {
  providers: LLM[];
  /** The provider that would be tried first right now (null if all are cooling down). */
  info: EngineInfo | null;
  chat(req: LLMRequest): Promise<RoutedResponse>;
}

const TOTAL_BUDGET_MS = () => Number(process.env.SORTED_AI_BUDGET_MS || 25_000);

/**
 * The configured providers as one router: tries each in order, skipping any in
 * cooldown, falling through on 429/5xx/timeout (and other errors). One HTTP call
 * per provider attempt, no internal retries. Returns null when no key is set.
 */
export function getLLM(): LLMRouter | null {
  const providers = configuredProviders();
  if (!providers.length) return null;
  return {
    providers,
    get info() {
      return providers.find((p) => !providerCoolingUntil(p.info.label))?.info ?? null;
    },
    async chat(req) {
      const started = Date.now();
      const errors: string[] = [];
      const deadGroups = new Set<string>();
      for (const p of providers) {
        const key = p.info.label; // per provider + model
        if (p.group && deadGroups.has(p.group)) continue;
        if (providerCoolingUntil(key)) {
          if (p.group && cooldowns.get(key)?.reason !== "rate limited") deadGroups.add(p.group);
          errors.push(`${key}: cooling down (${cooldowns.get(key)?.reason})`);
          continue;
        }
        if (Date.now() - started > TOTAL_BUDGET_MS()) {
          errors.push(`${key}: skipped (time budget spent)`);
          break;
        }
        try {
          const res = await p.chat(req);
          return { ...res, engine: p.info };
        } catch (e) {
          const err = e instanceof LLMError ? e : new LLMError((e as Error).message, 0);
          const ms = cooldownMs(err);
          if (ms > 0) cooldowns.set(key, { until: Date.now() + ms, reason: err.status === 429 ? "rate limited" : err.status ? `HTTP ${err.status}` : "timeout" });
          // Only a 429 (per-model quota) is worth trying a sibling model on the same provider.
          if (err.status !== 429 && p.group) deadGroups.add(p.group);
          errors.push(`${key}: ${err.message.slice(0, 120)}`);
        }
      }
      throw new AIUnavailableError(errors.join(" | "));
    },
  };
}

/** Engine label for a rules-engine answer: "no AI key" only when no key is configured. */
export function fallbackEngine(): EngineInfo {
  return configuredProviders().length ? RULES_ENGINE_BUSY : RULES_ENGINE;
}

/** Short, user-facing reason the AI wasn't used. */
export function friendlyAIError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/rate limited|HTTP 429|quota/i.test(m)) return "AI provider busy (rate limit/quota), used the rules engine";
  if (/timed out|timeout/i.test(m)) return "AI provider timed out, used the rules engine";
  if (/HTTP 5\d\d/.test(m)) return "AI provider error, used the rules engine";
  if (/HTTP 40[134]/.test(m)) return "AI provider rejected the key or model, used the rules engine";
  return "AI answer unusable, used the rules engine";
}

/** Status for /api/status: which providers are configured and which are cooling. */
export function aiStatus() {
  const providers = configuredProviders();
  const now = Date.now();
  return providers.map((p) => {
    const until = providerCoolingUntil(p.info.label, now);
    return { id: p.info.id, label: p.info.label, coolingDownForSec: until ? Math.round((until - now) / 1000) : 0 };
  });
}

/** Extract the first JSON object from model text (handles ```json fences). */
export function extractJSON<T = Record<string, unknown>>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
