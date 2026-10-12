// Provider-agnostic LLM interface with tool calling. Server-only.
// Supported: Google Gemini, OpenAI (or any OpenAI-compatible endpoint, e.g. Groq,
// OpenRouter, Ollama via OPENAI_BASE_URL), Anthropic. If no key is configured,
// getLLM() returns null and callers use the deterministic rules engine.

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
  chat(req: LLMRequest): Promise<LLMResponse>;
}

const TIMEOUT_MS = Number(process.env.SORTED_AI_TIMEOUT_MS || 25_000);

async function postJSON(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const msg = (data.error as { message?: string })?.message ?? text.slice(0, 300);
      throw new Error(`LLM HTTP ${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

// ---------------- OpenAI-compatible ----------------
function openAI(): LLM | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  return {
    info: { id: "openai", label: `OpenAI ${model}`, ai: true },
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
        { Authorization: `Bearer ${key}` },
        {
          model,
          messages,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 1200,
          ...(req.tools?.length
            ? { tools: req.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
            : {}),
          ...(req.json && !req.tools?.length ? { response_format: { type: "json_object" } } : {}),
        },
      );
      const msg = ((data.choices as { message?: Record<string, unknown> }[])?.[0]?.message ?? {}) as {
        content?: string;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
      return {
        text: msg.content ?? "",
        toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: safeParse(c.function.arguments) })),
      };
    },
  };
}

// ---------------- Anthropic ----------------
function anthropic(): LLM | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
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
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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

export const RULES_ENGINE: EngineInfo = { id: "rules", label: "Sorted rules engine (no AI key)", ai: false };

/** Pick the configured provider (SORTED_AI_PROVIDER overrides auto-detect). */
export function getLLM(): LLM | null {
  if (process.env.SORTED_AI_DISABLED === "1") return null;
  const pref = (process.env.SORTED_AI_PROVIDER || "").toLowerCase();
  const order: (() => LLM | null)[] =
    pref === "openai" ? [openAI, gemini, anthropic] : pref === "anthropic" ? [anthropic, gemini, openAI] : [gemini, openAI, anthropic];
  for (const f of order) {
    const llm = f();
    if (llm) return llm;
  }
  return null;
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
