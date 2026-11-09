"use client";

// /app/dashboard drawn with Sorted's own components: owed / overdue / cash-in KPIs, a city filter,
// the "who still owes what" scoreboard, the days-overdue heat tile and a cash-in-by-month chart,
// all cross-filtering the AG Grid ledger underneath. Same rows as the Studio view (toStudioRows).

import Link from "next/link";
import { useMemo, useState } from "react";
import { gbp, todayISO } from "@/lib/format";
import { AGING_BUCKETS, toStudioRows, type StudioInvoiceRow } from "@/lib/studio/rows";
import type { Invoice } from "@/lib/types";
import { LedgerGrid } from "../LedgerGrid";
import { Logo } from "../Logo";
import { ReminderModal } from "../ReminderModal";
import { Modal, Spinner } from "../ui";
import { useSorted } from "../useSorted";

const C = {
  ink: "#0b1f33",
  muted: "#5b6b7c",
  line: "#e3e8ee",
  paper: "#f6f8fa",
  brand: "#0a7f5a",
  brand2: "#0f9d6f",
  brandSoft: "#e5f6ef",
  warn: "#b45309",
  warnSoft: "#fef3c7",
  bad: "#b42318",
  badSoft: "#fee4e2",
} as const;

const HEAT: Record<string, { bg: string; fg: string }> = {
  [AGING_BUCKETS[0]]: { bg: C.brandSoft, fg: C.brand },
  [AGING_BUCKETS[1]]: { bg: C.warnSoft, fg: C.warn },
  [AGING_BUCKETS[2]]: { bg: "#fde2c4", fg: "#9a3412" },
  [AGING_BUCKETS[3]]: { bg: C.badSoft, fg: C.bad },
  [AGING_BUCKETS[4]]: { bg: C.bad, fg: "#ffffff" },
};
const MEDAL = ["#d4a017", "#9aa5b1", "#b8733a"];
const gbp0 = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(n);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
const monthLabel = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
const monthLong = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bad" | "ok" }) {
  return (
    <div className="card flex min-w-0 flex-col justify-between p-4">
      <div className="text-xs font-bold text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-extrabold tracking-tight tabular-nums" style={{ color: tone === "bad" ? C.bad : tone === "ok" ? C.brand : C.ink }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] font-semibold text-muted">{sub}</div>}
    </div>
  );
}

function CashChart({ data }: { data: { month: string; amount: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(100, ...data.map((d) => d.amount));
  // A "nice" step (1, 2 or 5 × 10^n) giving about four gridlines.
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * mag).find((x) => x >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const H = 252;
  if (data.length === 0) return <div className="grid h-[220px] place-items-center text-sm text-muted">No payments in view yet.</div>;
  return (
    <div className="relative" role="img" aria-label={`Cash in by month: ${data.map((d) => `${monthLong(d.month)} ${gbp0(d.amount)}`).join(", ")}`}>
      <div className="flex">
        <div className="relative w-12 shrink-0" style={{ height: H }} aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 -translate-y-1/2 text-[10px] text-muted tabular-nums" style={{ top: H - (t / top) * H }}>
              {t >= 1000 ? `£${+(t / 1000).toFixed(1)}k` : `£${+t.toFixed(0)}`}
            </span>
          ))}
        </div>
        <div className="relative flex-1" style={{ height: H }}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t" style={{ top: H - (t / top) * H, borderColor: t === 0 ? "#c9d2dc" : C.line }} aria-hidden="true" />
          ))}
          <div className="absolute inset-0 flex items-end gap-[6%] px-[3%]">
            {data.map((d, i) => (
              <div
                key={d.month}
                className="relative flex h-full flex-1 items-end justify-center"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {hover === i && (
                  <div className="pointer-events-none absolute z-10 -translate-y-2 rounded-lg bg-ink px-2 py-1 text-[11px] font-semibold whitespace-nowrap text-white shadow" style={{ bottom: `${(d.amount / top) * 100}%` }}>
                    {monthLong(d.month)} · {gbp(d.amount)}
                  </div>
                )}
                <div
                  className="w-full max-w-[44px] rounded-t-md transition-[filter] hover:brightness-110"
                  style={{ height: `${(d.amount / top) * 100}%`, minHeight: d.amount > 0 ? 3 : 0, background: i === data.length - 1 ? C.brand2 : C.brand }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex pl-12" aria-hidden="true">
        <div className="flex flex-1 gap-[6%] px-[3%]">
          {data.map((d) => (
            <span key={d.month} className="flex-1 text-center text-[11px] font-semibold text-muted">
              {monthLabel(d.month)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MoneyOwedBoard() {
  const c = useSorted();
  const today = todayISO();
  const rows = useMemo(() => toStudioRows(c.invoices, today), [c.invoices, today]);

  const [cities, setCities] = useState<Set<string>>(new Set());
  const [customer, setCustomer] = useState<string | null>(null);
  const [bucket, setBucket] = useState<string | null>(null);

  const [reminding, setReminding] = useState<Invoice | null>(null);
  const [confirmPaid, setConfirmPaid] = useState<Invoice | null>(null);
  const [paying, setPaying] = useState(false);

  const allCities = useMemo(() => [...new Set(rows.invoices.map((r) => r.city))].sort((a, b) => (a === "No address" ? 1 : b === "No address" ? -1 : a.localeCompare(b))), [rows]);
  const byCity = useMemo(() => (cities.size ? rows.invoices.filter((r) => cities.has(r.city)) : rows.invoices), [rows, cities]);
  const matches = (r: StudioInvoiceRow, skip?: "customer" | "bucket") =>
    (skip === "customer" || !customer || r.customerKey === customer) && (skip === "bucket" || !bucket || r.agingBucket === bucket);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inView = useMemo(() => byCity.filter((r) => matches(r)), [byCity, customer, bucket]);
  const inViewIds = useMemo(() => new Set(inView.map((r) => r.id)), [inView]);

  const owed = sum(inView.map((r) => r.owed));
  const overdue = sum(inView.map((r) => r.overdueAmount));
  const overdueJobs = inView.filter((r) => r.isOverdue).length;
  const payments = useMemo(() => rows.payments.filter((p) => inViewIds.has(p.invoiceId)), [rows, inViewIds]);
  const cashIn = sum(payments.map((p) => p.amount));

  // Scoreboard: every customer in the city filter (selection highlights rather than hides).
  const board = useMemo(() => {
    const m = new Map<string, { key: string; name: string; owed: number; late: number }>();
    for (const r of byCity) {
      if (!matches(r, "customer") || r.owed <= 0.004) continue;
      const e = m.get(r.customerKey) ?? { key: r.customerKey, name: r.customer, owed: 0, late: 0 };
      e.owed += r.owed;
      e.late = Math.max(e.late, r.daysOverdue);
      m.set(r.customerKey, e);
    }
    return [...m.values()].sort((a, b) => b.owed - a.owed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byCity, bucket]);
  const boardMax = board[0]?.owed || 1;

  const heat = useMemo(() => {
    const m = new Map<string, { owed: number; n: number }>();
    for (const r of byCity) {
      if (!matches(r, "bucket") || r.owed <= 0.004) continue;
      const e = m.get(r.agingBucket) ?? { owed: 0, n: 0 };
      e.owed += r.owed;
      e.n++;
      m.set(r.agingBucket, e);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byCity, customer]);

  const cash = useMemo(() => {
    const all = rows.payments.map((p) => p.month).sort();
    if (!all.length) return [];
    const months = monthsBetween(all[0], today.slice(0, 7)).slice(-8);
    const by = new Map<string, number>();
    for (const p of payments) by.set(p.month, (by.get(p.month) ?? 0) + p.amount);
    return months.map((month) => ({ month, amount: by.get(month) ?? 0 }));
  }, [rows, payments, today]);

  const anySelection = cities.size > 0 || !!customer || !!bucket;
  const shown = useMemo(() => (anySelection ? c.invoices.filter((i) => inViewIds.has(i.id)) : c.invoices), [anySelection, c.invoices, inViewIds]);
  const clear = () => {
    setCities(new Set());
    setCustomer(null);
    setBucket(null);
  };

  return (
    <div className="min-h-screen pb-16">
      <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 2xl:max-w-[1440px]">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" aria-label="Sorted home">
              <Logo className="text-xl" />
            </Link>
            <span className="hidden text-sm font-semibold text-ink-2 sm:inline">Money owed</span>
            {c.ready && c.mode === "demo" && (
              <span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-bold tracking-wide text-warn uppercase ring-1 ring-warn/20">Demo mode</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {anySelection && (
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={clear}>
                Clear filters
              </button>
            )}
            <Link href="/app" className="btn-ghost px-3 py-1.5 text-xs">
              ← Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-4 pt-5 2xl:max-w-[1440px]">
        {!c.ready ? (
          <div className="card grid h-[420px] place-items-center text-sm text-muted">
            <span className="flex items-center gap-2">
              <Spinner className="text-brand" /> Loading your ledger…
            </span>
          </div>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_1.6fr]" aria-label="Headline numbers">
              <Kpi label="Owed to you" value={gbp(owed)} sub={`${inView.filter((r) => r.isOpen).length} open job${inView.filter((r) => r.isOpen).length === 1 ? "" : "s"}`} />
              <Kpi label="Overdue" value={gbp(overdue)} sub={overdueJobs ? `${overdueJobs} job${overdueJobs === 1 ? "" : "s"} past due` : "nothing past due"} tone={overdue > 0 ? "bad" : "ok"} />
              <div className="col-span-2 grid sm:col-span-1">
                <Kpi label="Cash in" value={gbp(cashIn)} sub={`${payments.length} payment${payments.length === 1 ? "" : "s"} received`} tone="ok" />
              </div>
              <div className="card col-span-2 flex flex-col justify-between p-4 sm:col-span-3 lg:col-span-1">
                <div className="text-xs font-bold text-ink-2">Where the work was</div>
                <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Filter by city">
                  {allCities.map((city) => {
                    const on = cities.has(city);
                    return (
                      <button
                        key={city}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setCities((s) => {
                            const n = new Set(s);
                            if (n.has(city)) n.delete(city);
                            else n.add(city);
                            return n;
                          })
                        }
                        className="rounded-full border px-3 py-1 text-xs font-semibold transition"
                        style={on ? { background: C.brand, borderColor: C.brand, color: "#fff" } : { background: "#fff", borderColor: C.line, color: C.ink }}
                      >
                        {city}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-[minmax(0,9fr)_minmax(0,15fr)]">
              <div className="card flex flex-col p-4 lg:h-[540px]" aria-label="Who still owes what">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <h2 className="text-sm font-bold text-ink">Who still owes what</h2>
                  {customer && (
                    <button className="text-xs font-semibold text-brand underline" onClick={() => setCustomer(null)}>
                      Show everyone
                    </button>
                  )}
                </div>
                <div className="mb-3 text-[13px] text-muted">
                  {board.length} {board.length === 1 ? "customer" : "customers"} still settling up · <strong className="text-ink tabular-nums">{gbp0(sum(board.map((b) => b.owed)))}</strong> to come in
                </div>
                {board.length === 0 ? (
                  <div className="grid flex-1 place-items-center py-10 text-center text-sm text-muted">
                    <div>
                      <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-brand-soft text-lg font-bold text-brand" aria-hidden="true">
                        ✓
                      </div>
                      Everyone&apos;s paid up. Clean sheet!
                    </div>
                  </div>
                ) : (
                  <ol className="flex-1 space-y-1.5 overflow-y-auto pr-1">
                    {board.map((r, i) => {
                      const sel = customer === r.key;
                      const on = !customer || sel;
                      const tone = r.late > 30 ? C.bad : r.late > 0 ? C.warn : C.brand;
                      return (
                        <li key={r.key}>
                          <button
                            type="button"
                            onClick={() => setCustomer(sel ? null : r.key)}
                            aria-pressed={sel}
                            className="flex w-full items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition hover:border-brand/40 hover:bg-[#f0faf6]"
                            style={{ opacity: on ? 1 : 0.4, borderColor: sel ? C.brand : C.line, background: sel ? C.brandSoft : undefined }}
                            title={`Show only ${r.name}`}
                          >
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-extrabold tabular-nums" style={i < 3 ? { background: MEDAL[i], color: "#fff" } : { background: C.paper, color: C.muted }}>
                              {i + 1}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-[13px] font-semibold text-ink">{r.name}</span>
                                <span className="shrink-0 text-[13px] font-extrabold text-ink tabular-nums">{gbp0(r.owed)}</span>
                              </span>
                              <span className="mt-1 flex items-center gap-2">
                                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper">
                                  <span className="block h-full rounded-full" style={{ width: `${Math.max(4, (r.owed / boardMax) * 100)}%`, background: tone }} />
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

              <div className="flex min-w-0 flex-col gap-4">
                <div className="card p-4" aria-label="How late is it?">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-bold text-ink">How late is it?</h2>
                    {bucket && (
                      <button className="text-xs font-semibold text-brand underline" onClick={() => setBucket(null)}>
                        All ages
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="group" aria-label="Money owed by how late it is">
                    {AGING_BUCKETS.map((b) => {
                      const r = heat.get(b);
                      const sel = bucket === b;
                      const on = !bucket || sel;
                      const col = HEAT[b];
                      return (
                        <button
                          key={b}
                          type="button"
                          disabled={!r}
                          onClick={() => setBucket(sel ? null : b)}
                          aria-pressed={sel}
                          className="flex min-h-[92px] min-w-0 flex-col justify-between rounded-xl p-2.5 text-left transition hover:brightness-95 disabled:cursor-default"
                          style={{ background: r ? col.bg : C.paper, color: r ? col.fg : C.muted, opacity: on ? 1 : 0.35, outline: sel ? `2px solid ${C.ink}` : undefined }}
                          title={r ? `Show invoices ${b === AGING_BUCKETS[0] ? "not yet due" : `${b} overdue`}` : undefined}
                        >
                          <span className="text-[11px] font-bold tracking-wide uppercase">{b === AGING_BUCKETS[0] ? b : `${b} late`}</span>
                          <span>
                            <span className="block text-lg leading-tight font-extrabold tabular-nums">{gbp0(r?.owed ?? 0)}</span>
                            <span className="text-[11px] font-semibold opacity-80">{!r ? "nothing" : `${r.n} job${r.n === 1 ? "" : "s"}`}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="card flex-1 p-4" aria-label="Cash in by month">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-bold text-ink">Cash in by month</h2>
                    <span className="text-xs text-muted tabular-nums">{gbp0(sum(cash.map((d) => d.amount)))} over {cash.length} months</span>
                  </div>
                  <CashChart data={cash} />
                </div>
              </div>
            </section>

            <div className="flex flex-wrap items-baseline justify-between gap-2 px-1 text-xs text-muted" aria-live="polite">
              {anySelection ? (
                <>
                  <span>
                    <strong className="text-ink tabular-nums">{shown.length}</strong> job{shown.length === 1 ? "" : "s"} below match · <strong className="text-ink tabular-nums">{gbp(owed)}</strong> still owed in view
                  </span>
                  <button className="font-semibold text-brand underline" onClick={clear}>
                    Show every job
                  </button>
                </>
              ) : (
                <span>Click the scoreboard, the heat tile or a city to narrow the ledger below.</span>
              )}
            </div>
          </>
        )}
        <LedgerGrid invoices={shown} onRemind={setReminding} onMarkPaid={setConfirmPaid} loading={!c.ready} />
      </main>

      {reminding && <ReminderModal invoice={reminding} settings={c.settings} mode={c.mode} onClose={() => setReminding(null)} onSend={c.sendReminder} />}
      {confirmPaid && (
        <Modal open onClose={() => setConfirmPaid(null)} title="Mark as paid?">
          <p className="text-sm text-ink-2">
            Record <strong>{gbp(confirmPaid.total - confirmPaid.amountPaid)}</strong> received from <strong>{confirmPaid.customerName}</strong> for {confirmPaid.number}.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setConfirmPaid(null)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={paying}
              onClick={async () => {
                setPaying(true);
                try {
                  await c.markPaid(confirmPaid);
                  setConfirmPaid(null);
                } catch (e) {
                  c.toast("err", (e as Error).message);
                } finally {
                  setPaying(false);
                }
              }}
            >
              {paying && <Spinner />} Mark paid
            </button>
          </div>
        </Modal>
      )}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {c.toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ${t.kind === "err" ? "bg-bad text-white" : "bg-ink text-white"}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
