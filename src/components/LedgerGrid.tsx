"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AllCommunityModule,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type GridSizeChangedEvent,
  type ICellRendererParams,
  type IRowNode,
  type RowClassParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { balance, daysOverdue, daysToPay, displayStatus, gbp, isOpen, round2, todayISO, ukDate, type DisplayStatus } from "@/lib/format";
import { STAGE_LABEL, suggestStage } from "@/lib/ledger";
import type { Invoice } from "@/lib/types";
import { PayPalMark, StageBadge, StatusBadge } from "./ui";

// Modules are registered on this grid only (the `modules` prop), never globally: a global
// ModuleRegistry.registerModules call leaks into AG Studio's own grids on the same page.
const LEDGER_MODULES = [AllCommunityModule];

const sortedTheme = themeQuartz.withParams({
  accentColor: "#0a7f5a",
  backgroundColor: "#ffffff",
  foregroundColor: "#0b1f33",
  headerBackgroundColor: "#f6f8fa",
  headerTextColor: "#5b6b7c",
  headerFontWeight: 600,
  borderColor: "#e3e8ee",
  rowHoverColor: "#f0faf6",
  selectedRowBackgroundColor: "#e5f6ef",
  fontFamily: "inherit",
  fontSize: 13,
  cellHorizontalPaddingScale: 0.8,
  rowHeight: 52,
  headerHeight: 40,
  wrapperBorderRadius: 16,
  oddRowBackgroundColor: "#fcfdfd",
});

type Row = Invoice & {
  _display: DisplayStatus;
  _overdue: number;
  _balance: number;
  _ttp?: number;
  _pinned?: boolean;
};

type Filter = "all" | "outstanding" | "overdue" | "paid";

interface Props {
  invoices: Invoice[];
  onRemind: (inv: Invoice) => void;
  onMarkPaid: (inv: Invoice) => void;
  /** Opens the invoice details (pay link preview, QR code). */
  onOpen?: (inv: Invoice) => void;
  loading?: boolean;
}

const FILTER_LABEL: Record<Filter, string> = { all: "All", outstanding: "Outstanding", overdue: "Overdue", paid: "Paid" };

// Minimum widths (px). Columns flex above these, and the lowest-priority ones are hidden when the
// grid is too narrow to show them all, so nothing is clipped or ellipsised at 1280–1920px.
const ACTIONS_W = 156;
const MIN_W: Record<string, number> = {
  customerName: 220,
  number: 100,
  _display: 120,
  total: 108,
  _balance: 128,
  _overdue: 152,
  issueDate: 112,
  dueDate: 112,
  paidDate: 112,
  reminders: 128,
  actions: ACTIONS_W,
};
// Hidden first → last as the grid narrows.
const HIDE_ORDER = ["paidDate", "issueDate", "reminders", "number", "dueDate", "total", "_display"];
const NARROW_PX = 760;

function fitColumns(api: GridApi<Row>, width: number) {
  if (!width) return;
  const narrow = width < NARROW_PX;
  const ids = Object.keys(MIN_W);
  const visible = new Set(ids);
  // Leave room for a vertical scrollbar on platforms that draw one.
  const room = width - 18;
  const need = () => [...visible].reduce((s, id) => s + MIN_W[id], 0);
  for (const id of HIDE_ORDER) {
    if (need() <= room) break;
    visible.delete(id);
  }
  api.setColumnsVisible(ids.filter((i) => visible.has(i)), true);
  api.setColumnsVisible(ids.filter((i) => !visible.has(i)), false);
  // On phones pinned columns would eat the whole viewport, so everything scrolls together.
  api.setColumnsPinned(["customerName"], narrow ? null : "left");
  api.setColumnsPinned(["actions"], narrow ? null : "right");
}

// Text colours meet WCAG AA on white; the bar uses the same hue.
const severity = (od: number) => (od >= 30 ? "#b42318" : od >= 14 ? "#c2410c" : "#b45309");

// ---------- cell renderers ----------

function CustomerCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  if (!r) return null;
  if (r._pinned)
    return (
      <span className="flex h-full flex-col justify-center leading-tight">
        <span className="font-bold">{r.customerName}</span>
        {r.jobSummary && <span className="text-[11px] font-normal text-muted">{r.jobSummary}</span>}
      </span>
    );
  const initials = r.customerName
    .replace(/^(Mrs|Mr|Ms|Miss|Dr)\.?\s+/i, "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="flex h-full items-center gap-2.5 leading-tight">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          r.customerType === "business" ? "bg-ink text-white" : "bg-brand-soft text-brand"
        }`}
        title={r.customerType === "business" ? "Business customer" : "Private customer"}
      >
        {initials}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-semibold">{r.customerName}</span>
        <span className="block truncate text-[11px] text-muted">{r.jobSummary}</span>
      </span>
    </div>
  );
}

function StatusCell(p: ICellRendererParams<Row>) {
  if (!p.data || p.data._pinned) return null;
  return (
    <div className="flex h-full items-center">
      <StatusBadge status={p.data._display} />
    </div>
  );
}

function OverdueCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  if (!r || r._pinned) return null;
  if (r._display === "Paid") {
    return <span className="text-xs text-muted">{r._ttp !== undefined ? `paid in ${r._ttp}d` : "paid"}</span>;
  }
  if (!isOpen(r)) return <span className="text-xs text-muted">—</span>;
  if (r._overdue <= 0) return <span className="text-xs text-muted">due in {-r._overdue}d</span>;
  const pct = Math.min(100, (r._overdue / 60) * 100);
  const color = severity(r._overdue);
  return (
    <div className="flex h-full flex-col justify-center gap-1">
      <span className="text-xs font-bold" style={{ color }}>
        {r._overdue} day{r._overdue === 1 ? "" : "s"}
      </span>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
    </div>
  );
}

function RemindersCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  if (!r || r._pinned) return null;
  if (!r.reminders.length) return <span className="text-xs text-muted">{r._overdue > 0 && isOpen(r) ? "none yet" : "—"}</span>;
  const last = r.reminders[r.reminders.length - 1];
  return (
    <div className="flex h-full items-center gap-1.5 leading-tight" title={r.reminders.map((x) => `${ukDate(x.sentAt.slice(0, 10))}: ${x.subject}`).join("\n")}>
      <StageBadge stage={last.stage} />
      <span className="text-[11px] text-muted">×{r.reminders.length}</span>
    </div>
  );
}

function ActionsCell(p: ICellRendererParams<Row> & { onRemind: Props["onRemind"]; onMarkPaid: Props["onMarkPaid"]; onOpen?: Props["onOpen"] }) {
  const r = p.data;
  if (!r || r._pinned) return null;
  const open = isOpen(r) && r._balance > 0;
  // Demo rows point at a mock PayPal, so only real invoices get the PayPal link.
  const link = r.source === "mock" ? undefined : (r.merchantViewUrl ?? r.payerViewUrl);
  return (
    <div className="flex h-full items-center gap-1">
      {open && (
        <button
          type="button"
          className={`rounded-lg px-2 py-1 text-xs font-semibold ${r._overdue > 0 ? "bg-bad text-white hover:opacity-90" : "border border-line hover:bg-paper"}`}
          onClick={() => p.onRemind(r)}
          title={`Draft a ${STAGE_LABEL[suggestStage(r)].toLowerCase()} for ${r.customerName}`}
          aria-label={`${r._overdue > 0 ? "Chase" : "Remind"} ${r.customerName} about ${r.number}`}
        >
          {r._overdue > 0 ? "Chase" : "Remind"}
        </button>
      )}
      {open && (
        <button
          type="button"
          className="rounded-lg border border-line px-2 py-1 text-xs font-semibold hover:bg-paper"
          onClick={() => p.onMarkPaid(r)}
          title="Record a cash or bank transfer payment"
          aria-label={`Mark ${r.number} as paid`}
        >
          Paid
        </button>
      )}
      {p.onOpen ? (
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-pp-2 hover:bg-sky-50"
          onClick={() => p.onOpen!(r)}
          title="Pay link, QR code and what your customer sees"
          aria-label={`Open ${r.number}: pay link and QR code`}
        >
          <PayPalMark />
        </button>
      ) : link && (
        <a
          className="flex h-7 w-7 items-center justify-center rounded-lg text-pp-2 hover:bg-sky-50"
          href={link}
          target="_blank"
          rel="noreferrer"
          title="Open in PayPal"
          aria-label={`Open ${r.number} in PayPal`}
        >
          <PayPalMark />
        </a>
      )}
      {!open && !link && !p.onOpen && <span className="text-xs text-muted">—</span>}
    </div>
  );
}

function NoRowsOverlay(p: { emptyRef: { current: boolean } }) {
  return (
    <div className="px-4 py-3 text-center text-sm text-muted">
      {p.emptyRef.current ? (
        <>
          <div className="font-semibold text-ink">No invoices yet</div>
          Describe a finished job above and Sorted will draft your first one.
        </>
      ) : (
        "No invoices match. Try another filter or clear the search."
      )}
    </div>
  );
}

// ---------- grid ----------

export function LedgerGrid({ invoices, onRemind, onMarkPaid, onOpen, loading = false }: Props) {
  const apiRef = useRef<GridApi<Row> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef(invoices.length === 0);
  useEffect(() => {
    emptyRef.current = invoices.length === 0;
  }, [invoices.length]);
  const [quick, setQuick] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const filterRef = useRef<Filter>("all");
  const [pinned, setPinned] = useState<Partial<Row>[]>([]);
  const today = todayISO();

  const rows: Row[] = useMemo(
    () =>
      invoices.map((i) => ({
        ...i,
        _display: displayStatus(i, today),
        _overdue: daysOverdue(i, today),
        _balance: balance(i),
        _ttp: daysToPay(i),
      })),
    [invoices, today],
  );

  const counts = useMemo(() => {
    const c = { all: rows.length, outstanding: 0, overdue: 0, paid: 0 };
    for (const r of rows) {
      if (r._balance > 0) c.outstanding++;
      if (r._display === "Overdue") c.overdue++;
      if (r._display === "Paid") c.paid++;
    }
    return c;
  }, [rows]);

  const recomputePinned = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    let n = 0, cancelled = 0, total = 0, bal = 0, paid = 0;
    api.forEachNodeAfterFilter((node: IRowNode<Row>) => {
      const d = node.data;
      if (!d) return;
      if (d.status === "CANCELLED") {
        cancelled++;
        return;
      }
      n++;
      total += d.total;
      bal += d._balance;
      paid += d._display === "Paid" ? d.total : d.amountPaid;
    });
    const next: Partial<Row> = {
      _pinned: true,
        id: "__totals",
        number: "",
        customerName: "Totals",
        jobSummary: `${n} invoice${n === 1 ? "" : "s"}${cancelled ? ` · ${cancelled} cancelled not counted` : ""}`,
        total: round2(total),
        _balance: round2(bal),
      amountPaid: round2(paid),
    };
    // Only publish a new totals row when it actually changed. A new pinnedBottomRowData array makes
    // the grid fire modelUpdated again, which calls this again: without the check that is an endless
    // render loop that pins the main thread (and starves anything else on the page, e.g. AG Studio).
    setPinned((prev) =>
      prev.length === 1 && (Object.keys(next) as (keyof Row)[]).every((k) => prev[0][k] === next[k]) ? prev : [next],
    );
  }, []);

  // AG Grid only re-renders a cell when its value changes, and the Totals row's Customer value is
  // always "Totals". Force the pinned row to redraw whenever its summary changes (filter, search, data).
  useEffect(() => {
    const refresh = () => {
      const api = apiRef.current;
      if (!api || api.isDestroyed()) return;
      const nodes: IRowNode<Row>[] = [];
      for (let i = 0; i < api.getPinnedBottomRowCount(); i++) {
        const n = api.getPinnedBottomRow(i);
        if (n) nodes.push(n);
      }
      if (nodes.length) api.refreshCells({ rowNodes: nodes, force: true });
    };
    refresh();
    // The grid may apply the new pinnedBottomRowData after this effect; refresh again next frame.
    const raf = requestAnimationFrame(refresh);
    return () => cancelAnimationFrame(raf);
  }, [pinned]);

  const money = (p: ValueFormatterParams<Row, number>) => (p.value == null ? "" : gbp(p.value));
  const dateFmt = (p: ValueFormatterParams<Row, string>) => (p.value ? ukDate(p.value) : "");
  const dateComparator = (filter: Date, cell: string) => {
    if (!cell) return -1;
    const f = `${filter.getFullYear()}-${String(filter.getMonth() + 1).padStart(2, "0")}-${String(filter.getDate()).padStart(2, "0")}`;
    return cell === f ? 0 : cell < f ? -1 : 1;
  };

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      {
        headerName: "Customer",
        field: "customerName",
        cellRenderer: CustomerCell,
        minWidth: MIN_W.customerName,
        flex: 2.4,
        filter: "agTextColumnFilter",
        getQuickFilterText: (p) => `${p.data?.customerName} ${p.data?.customerEmail} ${p.data?.jobSummary} ${p.data?.number}`,
        pinned: "left",
        lockPinned: true,
      },
      { headerName: "Invoice", field: "number", minWidth: MIN_W.number, flex: 1, filter: "agTextColumnFilter", cellClass: "font-mono text-xs" },
      {
        headerName: "Status",
        field: "_display",
        cellRenderer: StatusCell,
        minWidth: MIN_W._display,
        flex: 1.1,
        filter: "agTextColumnFilter",
        comparator: (a: string, b: string) => {
          const order = ["Overdue", "Due soon", "Part paid", "Sent", "Draft", "Paid", "Refunded", "Cancelled"];
          return order.indexOf(a) - order.indexOf(b);
        },
      },
      {
        headerName: "Total",
        field: "total",
        valueFormatter: money,
        type: "rightAligned",
        minWidth: MIN_W.total,
        flex: 1,
        filter: "agNumberColumnFilter",
        cellClass: "font-semibold tabular-nums",
      },
      {
        headerName: "Outstanding",
        field: "_balance",
        valueFormatter: (p) => (p.value ? gbp(p.value) : p.data?._pinned ? gbp(0) : "—"),
        type: "rightAligned",
        minWidth: MIN_W._balance,
        flex: 1.1,
        filter: "agNumberColumnFilter",
        cellClassRules: { "text-bad font-bold": (p) => !!p.data && !p.data._pinned && p.data._overdue > 0 && (p.value ?? 0) > 0 },
        cellClass: "tabular-nums",
      },
      {
        headerName: "Days overdue",
        field: "_overdue",
        cellRenderer: OverdueCell,
        minWidth: MIN_W._overdue,
        flex: 1.1,
        filter: "agNumberColumnFilter",
        sort: "desc",
        sortIndex: 0,
      },
      { headerName: "Issued", field: "issueDate", valueFormatter: dateFmt, minWidth: MIN_W.issueDate, flex: 1, filter: "agDateColumnFilter", filterParams: { comparator: dateComparator } },
      { headerName: "Due", field: "dueDate", valueFormatter: dateFmt, minWidth: MIN_W.dueDate, flex: 1, filter: "agDateColumnFilter", filterParams: { comparator: dateComparator } },
      { headerName: "Paid", field: "paidDate", valueFormatter: dateFmt, minWidth: MIN_W.paidDate, flex: 1, filter: "agDateColumnFilter", filterParams: { comparator: dateComparator } },
      {
        headerName: "Reminders",
        colId: "reminders",
        valueGetter: (p) => p.data?.reminders?.length ?? 0,
        cellRenderer: RemindersCell,
        minWidth: MIN_W.reminders,
        flex: 1.1,
        filter: "agNumberColumnFilter",
      },
      {
        headerName: "",
        colId: "actions",
        cellRenderer: ActionsCell,
        cellRendererParams: { onRemind, onMarkPaid, onOpen },
        width: ACTIONS_W,
        minWidth: ACTIONS_W,
        sortable: false,
        filter: false,
        resizable: false,
        suppressHeaderFilterButton: true,
        pinned: "right",
        lockPinned: true,
      },
    ],
    [onRemind, onMarkPaid, onOpen],
  );

  const defaultColDef = useMemo<ColDef<Row>>(() => ({ sortable: true, resizable: true, floatingFilter: false, suppressHeaderMenuButton: true }), []);

  const onGridReady = useCallback(
    (e: GridReadyEvent<Row>) => {
      apiRef.current = e.api;
      recomputePinned();
      fitColumns(e.api, boxRef.current?.clientWidth ?? window.innerWidth);
    },
    [recomputePinned],
  );

  const onGridSizeChanged = useCallback((e: GridSizeChangedEvent<Row>) => fitColumns(e.api, e.clientWidth), []);
  const quickTrimmed = quick.trim();

  useEffect(() => {
    filterRef.current = filter;
    apiRef.current?.onFilterChanged();
  }, [filter]);

  const getRowClass = useCallback((p: RowClassParams<Row>) => {
    if (!p.data || p.data._pinned) return undefined;
    if (p.data._display === "Overdue") return p.data._overdue >= 30 ? "row-final" : "row-overdue";
    return undefined;
  }, []);

  return (
    <section className="card overflow-hidden" aria-labelledby="ledger">
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="ledger" className="text-base font-bold">
            Ledger
          </h2>
          <p className="text-xs text-muted">Every invoice in one place. Sort, filter, chase.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex max-w-full overflow-x-auto rounded-xl border border-line p-0.5 text-xs font-semibold" role="group" aria-label="Filter by status">
            {(["all", "outstanding", "overdue", "paid"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`shrink-0 rounded-lg px-2.5 py-1.5 whitespace-nowrap transition ${filter === f ? (f === "overdue" ? "bg-bad text-white" : "bg-ink text-white") : "text-muted hover:text-ink"}`}
                title={f === "all" ? "Every invoice, including cancelled ones (cancelled invoices are left out of the totals)" : undefined}
              >
                {FILTER_LABEL[f]} <span className="tabular-nums opacity-70">{counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-56">
            <svg className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="text"
              name="ledger-search"
              autoComplete="off"
              spellCheck={false}
              className="input py-1.5 pr-8 pl-8"
              placeholder="Search customers, jobs…"
              value={quick}
              onChange={(e) => setQuick(e.target.value.replace(/^\s+/, ""))}
              onBlur={() => setQuick((q) => q.trim())}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuick("");
              }}
              aria-label="Search ledger"
            />
            {quick && (
              <button
                type="button"
                className="absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-paper hover:text-ink"
                onClick={() => setQuick("")}
                aria-label="Clear search"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            )}
          </div>
          <button
            className="btn-ghost px-3 py-1.5 text-xs"
            onClick={() =>
              apiRef.current?.exportDataAsCsv({
                fileName: `sorted-ledger-${today}.csv`,
                columnKeys: ["customerName", "number", "_display", "total", "_balance", "_overdue", "issueDate", "dueDate", "paidDate"],
              })
            }
          >
            Export CSV
          </button>
        </div>
      </div>
      <div ref={boxRef} className="h-[460px] w-full sm:h-[520px]">
        <AgGridReact<Row>
          modules={LEDGER_MODULES}
          theme={sortedTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(p) => p.data.id}
          quickFilterText={quickTrimmed}
          isExternalFilterPresent={() => filterRef.current !== "all"}
          doesExternalFilterPass={(node) => {
            const d = node.data;
            if (!d) return true;
            switch (filterRef.current) {
              case "outstanding":
                return d._balance > 0;
              case "overdue":
                return d._display === "Overdue";
              case "paid":
                return d._display === "Paid";
              default:
                return true;
            }
          }}
          pinnedBottomRowData={pinned}
          onGridReady={onGridReady}
          onGridSizeChanged={onGridSizeChanged}
          loading={loading}
          onModelUpdated={recomputePinned}
          getRowClass={getRowClass}
          animateRows
          suppressCellFocus
          noRowsOverlayComponent={NoRowsOverlay}
          noRowsOverlayComponentParams={{ emptyRef }}
        />
      </div>
    </section>
  );
}
