// Ask Sorted as a custom agent in the AG Studio Agent Framework.
//
// It is a "custom runner" (the agent owns its loop): one request to /api/studio/intent turns the
// user's words into a validated intent (rules first, the free LLM chain only when the rules can't
// place it), then the agent calls its own Studio tool, apply_sorted_view, which filters the page or
// builds a new widget through the Studio API. Every step is emitted as AG-UI events, so the run shows
// up in Studio's AI panel (edit mode) and in the Ask bar above the dashboard. At most one LLM call
// per question, none for the common phrasings, none at all in demo mode without a key.

import { createAiHarness, createAiToolContext, type AgAiAgentRunner, type AgAiEvent, type AgAiHarness, type AgAiTool, type AgFilterState, type AgReportState, type AgStudioApi } from "ag-studio";
import { chartTitle, type StudioIntent } from "@/lib/studio/intent";
import type { StudioVocab } from "@/lib/studio/rows";
import type { EngineInfo } from "@/lib/types";
import { ASK_PREFIX, PAGE_ID } from "./report";

export const AGENT_ID = "ask-sorted";
const TOOL = "apply_sorted_view";

/** Page filters Ask Sorted owns; anything else on the page is left alone. */
const OWNED = ["invoices.isOverdue", "invoices.isOpen", "invoices.city", "invoices.area", "invoices.customer", "invoices.issueMonth"];

type Page = NonNullable<AgReportState["pages"]>[number];
type WidgetMap = NonNullable<Page["widgets"]>;

const cond = (id: string, operator: "isIn" | "isTrue", value?: string[], filterWidgetId?: string): AgFilterState =>
  ({ field: { id }, model: operator === "isTrue" ? { operator } : { operator, value }, ...(filterWidgetId && { filterWidgetId }) }) as AgFilterState;

function filtersFor(intent: StudioIntent, forChart: boolean): AgFilterState[] {
  const f = intent.filters;
  const out: AgFilterState[] = [];
  const cashIn = forChart && intent.chart?.measure === "cashIn";
  if (f.overdue) out.push(cond("invoices.isOverdue", "isTrue"));
  else if (f.open && !cashIn) out.push(cond("invoices.isOpen", "isTrue"));
  // The city filter drives the "Where" buttons, so the widget shows what Ask Sorted picked.
  if (f.city) out.push(cond("invoices.city", "isIn", [f.city], forChart ? undefined : "city"));
  if (f.area) out.push(cond("invoices.area", "isIn", [f.area]));
  if (f.customer) out.push(cond("invoices.customer", "isIn", [f.customer]));
  if (f.month) out.push(cashIn ? cond("payments.month", "isIn", [f.month]) : cond("invoices.issueMonth", "isIn", [f.month]));
  return out;
}

function chartWidget(intent: StudioIntent) {
  const c = intent.chart!;
  const value = { cashIn: "payments.amount", billed: "invoices.total", owed: "invoices.owed" }[c.measure];
  const money = c.measure === "cashIn";
  const category =
    c.by === "customer"
      ? "invoices.customer"
      : c.by === "area"
        ? "invoices.area"
        : c.by === "month"
          ? money ? "calendar::month" : "invoices.issueMonth"
          : c.by === "week"
            ? money ? "calendar::week" : "invoices.issueDate"
            : money ? "payments.date" : "invoices.issueDate";
  const type = c.type === "line" ? "line-chart" : c.type === "bar" ? "bar-chart-grouped" : c.type === "pie" ? "donut-chart" : "column-chart-grouped";
  return {
    type,
    dataMapping: { categoryKey: [{ id: category }], valueKey: [{ id: value, aggregation: "sum" }] },
    format: { title: { enabled: true, text: chartTitle(intent) }, subtitle: { enabled: true, text: "Built by Ask Sorted" } },
  };
}

/** Applies an intent to the Studio report. Returns a one-line summary for the tool result. */
export function applyIntent(api: AgStudioApi, intent: StudioIntent): string {
  const state = api.getState() as AgReportState;
  const pages = state.pages.map((page) => {
    if (page.id !== (state.selectedPageId ?? PAGE_ID)) return page;
    const keep = (page.filter?.page ?? []).filter((f) => !OWNED.includes(f.field.id as string));
    const widgets: WidgetMap = { ...(page.widgets ?? {}) };
    const layout = { ...(page.widgetLayout ?? {}) };
    const widgetFilters = { ...(page.filter?.widget ?? {}) };
    if (intent.kind === "reset") {
      for (const id of Object.keys(widgets)) if (id.startsWith(ASK_PREFIX)) {
        delete widgets[id];
        delete layout[id];
        delete widgetFilters[id];
      }
      return { ...page, widgets, widgetLayout: layout, filter: { ...page.filter, page: keep, widget: widgetFilters }, crossFilter: { values: {} } };
    }
    if (intent.kind === "filter") {
      return { ...page, filter: { ...page.filter, page: [...keep, ...filtersFor(intent, false)] }, crossFilter: { values: {} } };
    }
    if (intent.kind === "chart") {
      // New charts go straight under the KPI row, pushing the rest down, so they're seen at once.
      const id = `${ASK_PREFIX}${Date.now().toString(36)}`;
      const top = 6;
      const h = 16;
      for (const [wid, l] of Object.entries(layout)) if (l && l.yTrack >= top) layout[wid] = { ...l, yTrack: l.yTrack + h };
      layout[id] = { xTrack: 0, yTrack: top, xSpan: 24, ySpan: h };
      widgets[id] = chartWidget(intent) as unknown as WidgetMap[string];
      const wf = filtersFor(intent, true);
      if (wf.length) widgetFilters[id] = wf;
      return { ...page, widgets, widgetLayout: layout, filter: { ...page.filter, widget: widgetFilters } };
    }
    return page;
  });
  if (intent.kind !== "unknown") api.setState({ ...state, pages } as AgReportState);
  return intent.kind === "unknown" ? "Nothing to change." : intent.reply.replace(/\*\*/g, "");
}

export type IntentFetcher = (prompt: string, signal?: AbortSignal) => Promise<{ intent: StudioIntent; engine: EngineInfo; aiError?: string }>;

export function intentFetcher(vocab: () => StudioVocab, today: () => string): IntentFetcher {
  return async (prompt, signal) => {
    const res = await fetch("/api/studio/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, vocab: vocab(), today: today() }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.intent) throw new Error(data.error || `Ask Sorted failed (HTTP ${res.status})`);
    return data;
  };
}

function lastUserText(messages: { role: string; content?: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((c: { text?: string }) => c?.text ?? "").join(" ");
  }
  return "";
}

/** Ask Sorted's own Studio tool: applies an intent JSON to the dashboard. */
function applyTool(api: AgStudioApi): AgAiTool {
  return api.defineAiTool({
    name: TOOL,
    description: "Apply a Sorted dashboard intent (filters or a new chart) to the current page.",
    params: (s) => s.object({ intent: s.string({ description: "StudioIntent as JSON" }) }),
    execute: (args: { intent: string }, ctx) => {
      try {
        return ctx.success(applyIntent(api, JSON.parse(args.intent) as StudioIntent));
      } catch (e) {
        return ctx.error((e as Error).message);
      }
    },
  });
}

export function askSortedAgent(api: AgStudioApi, fetchIntent: IntentFetcher): AgAiAgentRunner {
  const tool = applyTool(api);
  return {
    id: AGENT_ID,
    name: "Ask Sorted",
    description: "Filters the Money owed dashboard or adds a chart from a plain-English request.",
    schema: (s) => s.undefined(),
    tools: () => [tool],
    run: async function* (input, ctx): AsyncGenerator<AgAiEvent> {
      const { threadId, runId } = input;
      yield { type: "RUN_STARTED", threadId, runId };
      const prompt = lastUserText(input.messages as { role: string; content?: unknown }[]).trim();
      const msgId = `msg-${runId}`;
      const say = function* (text: string): Generator<AgAiEvent> {
        yield { type: "TEXT_MESSAGE_START", messageId: msgId, role: "assistant" };
        yield { type: "TEXT_MESSAGE_CONTENT", messageId: msgId, delta: text };
        yield { type: "TEXT_MESSAGE_END", messageId: msgId };
      };
      try {
        const { intent, engine, aiError } = await fetchIntent(prompt, ctx.signal);
        if (intent.kind !== "unknown") {
          const callId = `call-${runId}`;
          const args = { intent: JSON.stringify(intent) };
          yield { type: "TOOL_CALL_START", toolCallId: callId, toolCallName: TOOL };
          yield { type: "TOOL_CALL_ARGS", toolCallId: callId, delta: args.intent };
          yield { type: "TOOL_CALL_END", toolCallId: callId };
          const live = ctx.tools().find((t) => t.name === TOOL) ?? tool;
          const result = await live.execute!(
            { toolCallId: callId, name: TOOL, args },
            createAiToolContext({ signal: ctx.signal ?? new AbortController().signal, run: { threadId, runId } }),
          );
          yield {
            type: "TOOL_CALL_RESULT",
            messageId: `res-${runId}`,
            toolCallId: callId,
            content: result.success ? result.response : result.issues.map((i) => i.message).join("; "),
          };
        }
        const via = engine.ai ? ` (understood by ${engine.label})` : "";
        yield* say(`${intent.reply}${via}${aiError ? ` (${aiError.replace(/\s*\[.*\]$/, "")})` : ""}`);
        yield { type: "RUN_FINISHED", threadId, runId, result: intent };
      } catch (e) {
        yield { type: "RUN_ERROR", message: (e as Error).message };
      }
    },
  };
}

export const PROMPT_STARTERS = [
  { label: "Overdue Bristol jobs", prompt: "Show overdue Bristol jobs" },
  { label: "October earnings", prompt: "Chart October earnings" },
  { label: "Who owes most?", prompt: "Chart what's still owed by customer" },
  { label: "Reset", prompt: "Reset" },
];

export function buildHarness(api: AgStudioApi, fetchIntent: IntentFetcher): AgAiHarness {
  return createAiHarness(api, () => ({
    agents: [askSortedAgent(api, fetchIntent)],
    primary: AGENT_ID,
    promptStarters: PROMPT_STARTERS,
  }));
}
