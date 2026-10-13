"use client";

// Sorted's custom AG Studio widgets:
//   sorted-scoreboard   who still owes what, as a friendly league table (click a row to cross-filter)
//   sorted-heat         days-overdue heat tile, calm to hot (click a cell to cross-filter)
//   sorted-ledger-sync  reads the invoice ids that survive every page filter and cross filter and
//                       hands them to the host, so the AG Grid ledger under Studio follows along.
// All three read through widgetApi.getData, so Studio's data engine applies the filters for us.

import { useEffect, useRef, useState } from "react";
import type { AgAggregationFunction, AgDefaultRegistry, AgWidgetData, AgWidgetDataFormat, AgWidgetField, AgWidgetParams } from "ag-studio";
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import { AGING_BUCKETS } from "@/lib/studio/rows";
import { SORTED } from "./theme";

export type SortedWidgetType = "sorted-scoreboard" | "sorted-heat" | "sorted-ledger-sync";
type FieldRef = { id: string; aggregation?: AgAggregationFunction };
export type SortedWidgetState = AgWidgetData<Record<string, FieldRef[]>, AgWidgetDataFormat<Record<string, unknown>>>;
export interface SortedRegistry extends AgRegistry {
  widgets: readonly (AgDefaultRegistry["widgets"][number] | AgWidgetDefinition<SortedWidgetType, SortedWidgetState>)[];
}

/** Host callbacks, passed through Studio's `context` property. */
export interface SortedStudioContext {
  onLedgerIds: (ids: string[] | null) => void;
}

type Params = AgWidgetParams<SortedWidgetState, unknown, SortedStudioContext>;
type Row = Record<string, unknown>;

// Result rows are keyed by an alias of the field; match it whichever way the engine spells it.
function pick(row: Row, field: AgWidgetField | undefined): unknown {
  if (!field) return undefined;
  const f = field as unknown as { id: string; aggregation?: string; key?: string; alias?: string };
  for (const k of [f.key, f.alias, f.id, f.aggregation ? `${f.aggregation}(${f.id})` : undefined]) if (k && k in row) return row[k];
  const hit = Object.keys(row).find((k) => k.endsWith(f.id) || k.includes(f.id));
  return hit ? row[hit] : undefined;
}

const gbp0 = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(n);

/** Fetches the widget's rows whenever Studio refreshes it (new params on each refresh). */
function useWidgetRows(p: Params, fields: (AgWidgetField | undefined)[], highlight: boolean) {
  const [state, setState] = useState<{ rows: Row[]; selected: Row[] | null; error?: string } | null>(null);
  const reqId = useRef(0);
  const ready = fields.every(Boolean);
  useEffect(() => {
    if (!ready) {
      p.widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    const id = ++reqId.current;
    p.widgetApi.setDisplayState("loading", { prominent: state === null });
    p.widgetApi
      .getData({ fields: fields as AgWidgetField[] }, { crossFilter: highlight ? "highlight" : "filter" })
      .then((res) => {
        if (id !== reqId.current) return;
        const rows = (res.results?.rows ?? []) as Row[];
        const sel = highlight && res.crossFilter ? ((res.crossFilter.rows ?? []) as Row[]) : null;
        setState({ rows, selected: sel });
        p.widgetApi.setDisplayState(rows.length ? "displayed" : "noData");
      })
      .catch((e: unknown) => {
        if (id !== reqId.current || (e as Error)?.name === "AbortError") return;
        setState({ rows: [], selected: null, error: String((e as Error)?.message ?? e) });
        p.widgetApi.setDisplayState("noData");
      });
    // Studio hands the component new params on every refresh (filters, cross filters, mapping).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);
  return state;
}

function selectedValues(p: Params): Set<unknown> {
  const sel = p.widgetApi.getCrossFilterSelections() ?? [];
  const out = new Set<unknown>();
  for (const s of sel) if (s.type === "value") s.values.forEach((v) => out.add(v));
  return out;
}

// ---------------------------------------------------------------- Scoreboard

const MEDAL = ["#d4a017", "#9aa5b1", "#b8733a"];

export function Scoreboard(p: Params) {
  const cat = p.dataMapping.category?.[0];
  const val = p.dataMapping.value?.[0];
  const late = p.dataMapping.late?.[0];
  const data = useWidgetRows(p, [cat, val, ...(late ? [late] : [])], true);
  if (!data || !cat || !val) return null;
  const sel = selectedValues(p);
  const rows = data.rows
    .map((r) => ({ name: String(pick(r, cat) ?? "—"), raw: pick(r, cat), owed: Number(pick(r, val) ?? 0), late: late ? Number(pick(r, late) ?? 0) : 0 }))
    .filter((r) => r.owed > 0.004)
    .sort((a, b) => b.owed - a.owed);
  const max = rows[0]?.owed || 1;
  const total = rows.reduce((s, r) => s + r.owed, 0);
  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ fontFamily: SORTED.font }}>
      <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
        <div className="text-[13px] text-muted">
          {rows.length} {rows.length === 1 ? "customer" : "customers"} still settling up · <strong className="text-ink tabular-nums">{gbp0(total)}</strong> to come in
        </div>
        {sel.size > 0 && (
          <button className="text-xs font-semibold text-brand underline" onClick={() => p.widgetApi.resetCrossFilter()}>
            Show everyone
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="grid flex-1 place-items-center text-center text-sm text-muted">
          <div>
            <div className="text-3xl" aria-hidden="true">🎉</div>
            Everyone&apos;s paid up. Clean sheet!
          </div>
        </div>
      ) : (
        <ol className="flex-1 space-y-1.5 overflow-y-auto pr-1" aria-label="Who still owes what">
          {rows.map((r, i) => {
            const on = sel.size === 0 || sel.has(r.raw);
            const tone = r.late > 30 ? SORTED.bad : r.late > 0 ? SORTED.warn : SORTED.brand;
            return (
              <li key={r.name}>
                <button
                  type="button"
                  onClick={() => p.widgetApi.toggleCrossFilter({ type: "value", field: cat, value: r.raw, group: 0 })}
                  aria-pressed={sel.has(r.raw)}
                  className="group flex w-full items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition hover:border-brand/40 hover:bg-[#f0faf6]"
                  style={{ opacity: on ? 1 : 0.4, borderColor: sel.has(r.raw) ? SORTED.brand : SORTED.line, background: sel.has(r.raw) ? SORTED.brandSoft : undefined }}
                  title={`Filter the dashboard and ledger to ${r.name}`}
                >
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-extrabold tabular-nums"
                    style={i < 3 ? { background: MEDAL[i], color: "#fff" } : { background: SORTED.paper, color: SORTED.muted }}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-semibold text-ink">{r.name}</span>
                      <span className="shrink-0 text-[13px] font-extrabold text-ink tabular-nums">{gbp0(r.owed)}</span>
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper">
                        <span className="block h-full rounded-full" style={{ width: `${Math.max(4, (r.owed / max) * 100)}%`, background: tone }} />
                      </span>
                      <span className="w-[74px] shrink-0 text-right text-[11px] font-semibold" style={{ color: tone }}>
                        {r.late > 0 ? `${r.late} day${r.late === 1 ? "" : "s"} late` : "not due yet"}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Heat tile

const HEAT: Record<string, { bg: string; fg: string }> = {
  [AGING_BUCKETS[0]]: { bg: SORTED.brandSoft, fg: SORTED.brand },
  [AGING_BUCKETS[1]]: { bg: SORTED.warnSoft, fg: SORTED.warn },
  [AGING_BUCKETS[2]]: { bg: "#fde2c4", fg: "#9a3412" },
  [AGING_BUCKETS[3]]: { bg: SORTED.badSoft, fg: SORTED.bad },
  [AGING_BUCKETS[4]]: { bg: SORTED.bad, fg: "#ffffff" },
};

export function OverdueHeat(p: Params) {
  const cat = p.dataMapping.bucket?.[0];
  const val = p.dataMapping.value?.[0];
  const count = p.dataMapping.count?.[0];
  const data = useWidgetRows(p, [cat, val, ...(count ? [count] : [])], true);
  if (!data || !cat || !val) return null;
  const sel = selectedValues(p);
  const by = new Map(data.rows.map((r) => [String(pick(r, cat)), r]));
  return (
    <div className="grid h-full grid-cols-5 gap-2" style={{ fontFamily: SORTED.font }} role="group" aria-label="Money owed by how late it is">
      {AGING_BUCKETS.map((b) => {
        const r = by.get(b);
        const owed = r ? Number(pick(r, val) ?? 0) : 0;
        const n = r && count ? Number(pick(r, count) ?? 0) : undefined;
        const on = sel.size === 0 || sel.has(b);
        const c = HEAT[b];
        return (
          <button
            key={b}
            type="button"
            disabled={!r}
            onClick={() => p.widgetApi.toggleCrossFilter({ type: "value", field: cat, value: b, group: 0 })}
            aria-pressed={sel.has(b)}
            className="flex min-w-0 flex-col justify-between rounded-xl p-2.5 text-left transition hover:brightness-95 disabled:cursor-default"
            style={{ background: r ? c.bg : SORTED.paper, color: r ? c.fg : SORTED.muted, opacity: on ? 1 : 0.35, outline: sel.has(b) ? `2px solid ${SORTED.ink}` : undefined }}
            title={r ? `Filter to invoices ${b === AGING_BUCKETS[0] ? "not yet due" : `${b} overdue`}` : undefined}
          >
            <span className="text-[11px] font-bold tracking-wide uppercase">{b === AGING_BUCKETS[0] ? b : `${b} late`}</span>
            <span>
              <span className="block text-lg leading-tight font-extrabold tabular-nums">{gbp0(owed)}</span>
              {n !== undefined && <span className="text-[11px] font-semibold opacity-80">{n === 0 ? "nothing" : `${n} job${n === 1 ? "" : "s"}`}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Ledger sync

export function LedgerSync(p: Params) {
  const key = p.dataMapping.key?.[0];
  const val = p.dataMapping.value?.[0];
  const data = useWidgetRows(p, [key, ...(val ? [val] : [])], false);
  const ids = data ? data.rows.map((r) => String(pick(r, key))) : null;
  const sig = ids ? ids.join("|") : "";
  useEffect(() => {
    if (ids) p.context?.onLedgerIds(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useEffect(() => () => p.context?.onLedgerIds(null), [p.context]);
  if (!data || !key) return null;
  const owed = val ? data.rows.reduce((s, r) => s + Number(pick(r, val) ?? 0), 0) : undefined;
  return (
    <div className="flex h-full items-center gap-2 px-1 text-[13px] text-ink-2" style={{ fontFamily: SORTED.font }}>
      <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-soft text-brand" aria-hidden="true">
        ↓
      </span>
      <span>
        Ledger below: <strong className="tabular-nums">{data.rows.length}</strong> job{data.rows.length === 1 ? "" : "s"} match
        {owed !== undefined && (
          <>
            {" "}
            · <strong className="tabular-nums">{gbp0(owed)}</strong> still owed
          </>
        )}
        . Click the scoreboard, heat tile or chart to narrow it.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- Registration

const ICON = {
  scoreboard:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  heat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="18" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>',
  sync: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2M20 4v5h-5M4 20v-5h5"/></svg>',
};

const category = () => ({ type: "field" as const, supportedRoles: ["category" as const], requires: { cardinality: "many" as const }, required: true });
const perCategory = (key: string, required = true) => ({
  type: "field" as const,
  supportedRoles: ["numeric" as const],
  requires: { per: `dataMapping.${key}` as const, cardinality: "one" as const },
  required,
});

export function sortedWidgets() {
  return (defaults: { menu: { label: string; widgetIds: readonly string[] }[] }) =>
    createWidgets<SortedRegistry>({
      additionalTypes: [
        {
          id: "sorted-scoreboard",
          label: "Owed scoreboard",
          icon: ICON.scoreboard,
          dataMapping: {
            category: { ...category(), aiDescription: "Who the money is owed by, usually the customer." },
            value: { ...perCategory("category"), aiDescription: "Amount still owed." },
            late: { ...perCategory("category", false), aiDescription: "Days overdue (use max)." },
          },
          form: (params) =>
            params.createDefaults({
              dataMappingItems: [
                { key: "category", label: "Who" },
                { key: "value", label: "Owed" },
                { key: "late", label: "Days late" },
              ],
              supportsCrossHighlight: true,
            }),
          comp: Scoreboard,
          featureConfig: { crossFilter: { supportsHighlight: true } },
          defaultSize: { width: 420, height: 420 },
          minSize: { width: 260, height: 200 },
          ai: { description: "Friendly league table of who still owes what, biggest first. Clicking a row cross-filters the page." },
        },
        {
          id: "sorted-heat",
          label: "Days-overdue heat",
          icon: ICON.heat,
          dataMapping: {
            bucket: { ...category(), aiDescription: "Lateness bucket (How late)." },
            value: { ...perCategory("bucket"), aiDescription: "Amount owed in the bucket." },
            count: { ...perCategory("bucket", false), aiDescription: "Number of invoices in the bucket (countd of Invoice ID)." },
          },
          form: (params) =>
            params.createDefaults({
              dataMappingItems: [
                { key: "bucket", label: "How late" },
                { key: "value", label: "Owed" },
                { key: "count", label: "Jobs" },
              ],
              supportsCrossHighlight: true,
            }),
          comp: OverdueHeat,
          featureConfig: { crossFilter: { supportsHighlight: true } },
          defaultSize: { width: 600, height: 160 },
          minSize: { width: 360, height: 120 },
          ai: { description: "Heat tile of money owed by how many days overdue, calm green to hot red. Clicking a cell cross-filters." },
        },
        {
          id: "sorted-ledger-sync",
          label: "Ledger link",
          icon: ICON.sync,
          dataMapping: {
            key: { ...category(), aiDescription: "Invoice ID." },
            value: { ...perCategory("key", false), aiDescription: "Amount owed." },
          },
          form: (params) =>
            params.createDefaults({
              dataMappingItems: [
                { key: "key", label: "Invoice ID" },
                { key: "value", label: "Owed" },
              ],
            }),
          comp: LedgerSync,
          defaultSize: { width: 800, height: 60 },
          minSize: { width: 200, height: 40 },
          ai: { description: "Keeps the AG Grid ledger below the dashboard in step with the page's filters." },
        },
      ],
      menu: [{ label: "Sorted", widgetIds: ["sorted-scoreboard", "sorted-heat", "sorted-ledger-sync"] }, ...(defaults.menu as never[])],
    });
}
