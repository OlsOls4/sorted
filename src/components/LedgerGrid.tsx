"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type IRowNode,
  type RowClassParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { balance, daysOverdue, daysToPay, displayStatus, gbp, isOpen, round2, todayISO, ukDate, type DisplayStatus } from "@/lib/format";
import { suggestStage } from "@/lib/ledger";
import type { Invoice } from "@/lib/types";
import { StageBadge, StatusBadge } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

const chaseTheme = themeQuartz.withParams({
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
}

// ---------- cell renderers ----------

function CustomerCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  if (!r) return null;
  if (r._pinned) return <span className="font-bold">{r.customerName}</span>;
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
  const color = r._overdue >= 30 ? "#b42318" : r._overdue >= 14 ? "#dc6803" : "#f79009";
  return (
    <div className="flex h-full flex-col justify-center gap-1">
      <span className="text-xs font-bold" style={{ color }}>
        {r._overdue} days
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
    <div className="flex h-full items-center gap-1.5" title={r.reminders.map((x) => `${ukDate(x.sentAt.slice(0, 10))}: ${x.subject}`).join("\n")}>
      <StageBadge stage={last.stage} />
      <span className="text-[11px] text-muted">×{r.reminders.length}</span>
    </div>
  );
}

function ActionsCell(p: ICellRendererParams<Row> & { onRemind: Props["onRemind"]; onMarkPaid: Props["onMarkPaid"] }) {
  const r = p.data;
  if (!r || r._pinned) return null;
  const open = isOpen(r) && r._balance > 0;
  const link = r.merchantViewUrl ?? r.payerViewUrl;
  return (
    <div className="flex h-full items-center gap-1">
      {open && (
        <button
          className={`rounded-lg px-2 py-1 text-xs font-semibold ${r._overdue > 0 ? "bg-bad text-white hover:opacity-90" : "border border-line hover:bg-paper"}`}
          onClick={() => p.onRemind(r)}
          title={`Draft a ${suggestStage(r)} reminder`}
        >
          {r._overdue > 0 ? "Chase" : "Remind"}
        </button>
      )}
      {open && (
        <button className="rounded-lg border border-line px-2 py-1 text-xs font-semibold hover:bg-paper" onClick={() => p.onMarkPaid(r)} title="Record a cash / bank transfer payment">
          Paid
        </button>
      )}
      {link && (
        <a
          className="rounded-lg px-1.5 py-1 text-xs font-semibold text-pp-2 hover:underline"
          href={link}
          target="_blank"
          rel="noreferrer"
          title={r.source === "mock" ? "Demo link (mock PayPal)" : "Open in PayPal"}
        >
          PayPal ↗
        </a>
      )}
    </div>
  );
}

// ---------- grid ----------

export function LedgerGrid({ invoices, onRemind, onMarkPaid }: Props) {
  const apiRef = useRef<GridApi<Row> | null>(null);
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
    let n = 0, total = 0, bal = 0, paid = 0;
    api.forEachNodeAfterFilter((node: IRowNode<Row>) => {
      const d = node.data;
      if (!d || d.status === "CANCELLED") return;
      n++;
      total += d.total;
      bal += d._balance;
      paid += d._display === "Paid" ? d.total : d.amountPaid;
    });
    setPinned([
      {
        _pinned: true,
        id: "__totals",
        number: `${n} invoice${n === 1 ? "" : "s"}`,
        customerName: "Totals (filtered)",
        total: round2(total),
        _balance: round2(bal),
        amountPaid: round2(paid),
      },
    ]);
  }, []);

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
        minWidth: 220,
        flex: 2,
        filter: "agTextColumnFilter",
        getQuickFilterText: (p) => `${p.data?.customerName} ${p.data?.customerEmail} ${p.data?.jobSummary}`,
        pinned: "left",
        lockPinned: true,
      },
      { headerName: "Invoice", field: "number", width: 110, filter: "agTextColumnFilter", cellClass: "font-mono text-xs" },
      {
        headerName: "Status",
        field: "_display",
        cellRenderer: StatusCell,
        width: 130,
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
        width: 115,
        filter: "agNumberColumnFilter",
        cellClass: "font-semibold tabular-nums",
      },
      {
        headerName: "Outstanding",
        field: "_balance",
        valueFormatter: (p) => (p.value ? gbp(p.value) : p.data?._pinned ? gbp(0) : "—"),
        type: "rightAligned",
        width: 130,
        filter: "agNumberColumnFilter",
        cellClassRules: { "text-bad font-bold": (p) => !!p.data && !p.data._pinned && p.data._overdue > 0 && (p.value ?? 0) > 0 },
        cellClass: "tabular-nums",
      },
      {
        headerName: "Days overdue",
        field: "_overdue",
        cellRenderer: OverdueCell,
        width: 135,
        filter: "agNumberColumnFilter",
        sort: "desc",
        sortIndex: 0,
      },
      { headerName: "Issued", field: "issueDate", valueFormatter: dateFmt, width: 120, filter: "agDateColumnFilter", filterParams: { comparator: dateComparator } },
      { headerName: "Due", field: "dueDate", valueFormatter: dateFmt, width: 120, filter: "agDateColumnFilter", filterParams: { comparator: dateComparator } },
      { headerName: "Paid", field: "paidDate", valueFormatter: dateFmt, width: 120, filter: "agDateColumnFilter", filterParams: { comparator: dateComparator } },
      {
        headerName: "Reminders",
        colId: "reminders",
        valueGetter: (p) => p.data?.reminders?.length ?? 0,
        cellRenderer: RemindersCell,
        width: 150,
        filter: "agNumberColumnFilter",
      },
      {
        headerName: "",
        colId: "actions",
        cellRenderer: ActionsCell,
        cellRendererParams: { onRemind, onMarkPaid },
        width: 200,
        sortable: false,
        filter: false,
        resizable: false,
        pinned: "right",
      },
    ],
    [onRemind, onMarkPaid],
  );

  const defaultColDef = useMemo<ColDef<Row>>(() => ({ sortable: true, resizable: true, floatingFilter: false, suppressHeaderMenuButton: false }), []);

  const onGridReady = useCallback(
    (e: GridReadyEvent<Row>) => {
      apiRef.current = e.api;
      recomputePinned();
      const narrow = window.innerWidth < 768;
      e.api.setColumnsVisible(["issueDate", "paidDate", "reminders", "number"], !narrow);
      if (narrow) e.api.setColumnsPinned(["customerName"], null);
    },
    [recomputePinned],
  );

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
          <p className="text-xs text-muted">Every invoice, synced with PayPal. Sort, filter, chase.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-line p-0.5 text-xs font-semibold">
            {(["all", "outstanding", "overdue", "paid"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-lg px-2.5 py-1.5 capitalize transition ${filter === f ? (f === "overdue" ? "bg-bad text-white" : "bg-ink text-white") : "text-muted hover:text-ink"}`}
              >
                {f} <span className="opacity-70">{counts[f]}</span>
              </button>
            ))}
          </div>
          <input
            className="input w-full py-1.5 sm:w-52"
            placeholder="Search customers, jobs…"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            aria-label="Search ledger"
          />
          <button
            className="btn-ghost px-3 py-1.5 text-xs"
            onClick={() =>
              apiRef.current?.exportDataAsCsv({
                fileName: `chase-ledger-${today}.csv`,
                columnKeys: ["customerName", "number", "_display", "total", "_balance", "_overdue", "issueDate", "dueDate", "paidDate"],
              })
            }
          >
            Export CSV
          </button>
        </div>
      </div>
      <div className="h-[520px] w-full">
        <AgGridReact<Row>
          theme={chaseTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(p) => p.data.id}
          quickFilterText={quick}
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
          onModelUpdated={recomputePinned}
          getRowClass={getRowClass}
          animateRows
          suppressCellFocus
          overlayNoRowsTemplate='<span style="padding:12px;color:#5b6b7c">No invoices match. Try another filter.</span>'
        />
      </div>
    </section>
  );
}
