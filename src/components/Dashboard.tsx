"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PaymentEvent } from "@/lib/events";
import { gbp } from "@/lib/format";
import { totals } from "@/lib/ledger";
import type { EngineInfo, Invoice, InvoiceDraft, PendingAction, ReminderStage } from "@/lib/types";
import { AskSorted } from "./AskSorted";
import { InvoiceDetails } from "./InvoiceDetails";
import { InvoiceEditor } from "./InvoiceEditor";
import { JobNotes } from "./JobNotes";
import { LedgerGrid } from "./LedgerGrid";
import { Logo } from "./Logo";
import { OverduePanel } from "./OverduePanel";
import { PayPalConnect } from "./PayPalConnect";
import { ReminderModal } from "./ReminderModal";
import { SettingsModal } from "./SettingsModal";
import { Modal, Spinner } from "./ui";
import { useSorted } from "./useSorted";

export function Dashboard() {
  const c = useSorted();
  const [editing, setEditing] = useState<{ draft: InvoiceDraft; engine?: EngineInfo; aiError?: string; approval?: string } | null>(null);
  const [reminding, setReminding] = useState<{ inv: Invoice; preset?: { stage: ReminderStage; subject: string; body: string }; approval?: string } | null>(null);
  const [confirmPaid, setConfirmPaid] = useState<Invoice | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  // The demo notice is a small dismissible pill (remembered for this browser session).
  const [pillHidden, setPillHidden] = useState(false);
  useEffect(() => {
    if (sessionStorage.getItem("sorted.demoPill.hidden") === "1") requestAnimationFrame(() => setPillHidden(true));
  }, []);
  const hidePill = useCallback(() => {
    sessionStorage.setItem("sorted.demoPill.hidden", "1");
    setPillHidden(true);
  }, []);
  const [paying, setPaying] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const viewing = viewingId ? (c.invoices.find((i) => i.id === viewingId) ?? null) : null;
  const onOpen = useCallback((inv: Invoice) => setViewingId(inv.id), []);

  // Demo: the mock PayPal payer page (/pay/<id>, another tab) announces payments here,
  // the same way the INVOICING.INVOICE.PAID webhook does in live mode.
  const { reportEvents } = c;
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("sorted-pay");
    ch.onmessage = (m: MessageEvent<PaymentEvent>) => {
      if (m.data?.invoiceId) reportEvents([m.data]);
    };
    return () => ch.close();
  }, [reportEvents]);

  const kpi = useMemo(() => totals(c.invoices), [c.invoices]);
  const onRemind = useCallback((inv: Invoice) => setReminding({ inv }), []);
  const onMarkPaid = useCallback((inv: Invoice) => setConfirmPaid(inv), []);
  const { toast } = c;
  const onError = useCallback((m: string) => toast("err", m), [toast]);
  const onDraft = useCallback((draft: InvoiceDraft, engine: EngineInfo, aiError?: string) => setEditing({ draft, engine, aiError }), []);

  const onConfirmAction = useCallback(
    async (a: PendingAction): Promise<boolean> => {
      if (a.type === "create_invoice") {
        setEditing({ draft: a.draft, approval: a.approvalToken });
        return true;
      }
      const inv = c.invoices.find((i) => i.id === a.invoiceId);
      if (!inv) {
        toast("err", "That invoice is no longer in your ledger.");
        return false;
      }
      if (a.type === "send_reminder") {
        setReminding({ inv, preset: { stage: a.stage, subject: a.subject, body: a.body }, approval: a.approvalToken });
        return true;
      }
      try {
        await c.markPaid(inv, a.approvalToken);
        return true;
      } catch (e) {
        toast("err", (e as Error).message);
        return false;
      }
    },
    [c, toast],
  );

  return (
    <div className="min-h-screen pb-16">
      <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 2xl:max-w-[1440px]">
          <div className="flex items-center gap-3">
            <Link href="/" aria-label="Sorted home">
              <Logo className="text-xl" />
            </Link>
            {c.mode === "demo" ? (
              pillHidden ? (
                <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-bold tracking-wide text-warn uppercase ring-1 ring-warn/20" title="Sample data · mock PayPal. Nothing is sent.">
                  Demo
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft py-0.5 pr-1 pl-2.5 text-[11px] font-medium text-warn ring-1 ring-warn/20" title="Mock PayPal backend with seeded data. Nothing is emailed.">
                  <span className="hidden sm:inline">Sample data · mock PayPal ·</span>
                  <span className="sm:hidden">Demo ·</span>
                  <button type="button" className="font-semibold underline" onClick={() => setShowConnect(true)}>
                    Connect sandbox
                  </button>
                  <button type="button" className="rounded-full px-1 leading-none hover:bg-warn/10" aria-label="Hide demo notice" onClick={hidePill}>
                    ×
                  </button>
                </span>
              )
            ) : (
              <span
                className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-bold tracking-wide text-pp-2 uppercase ring-1 ring-sky-600/20"
                title={
                  c.status?.sharedSandbox
                    ? "Real PayPal sandbox API on Sorted's shared demo account. Invoices only go to @example.com test addresses."
                    : "Real PayPal sandbox API with the keys you connected."
                }
              >
                Live · PayPal {c.status?.paypalEnv ?? "sandbox"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link href="/app/dashboard" className="btn-ghost px-3 py-1.5 text-xs" title="AG Studio dashboard: who still owes what">
              <span aria-hidden="true">▦</span> Money owed
            </Link>
            {c.status?.liveAvailable ? (
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => c.setMode(c.mode === "demo" ? "live" : "demo")}>
                {c.mode === "demo" ? "Go live" : "Use demo"}
              </button>
            ) : null}
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setShowConnect(true)} title="Use live PayPal sandbox invoicing">
              <span className="text-pp" aria-hidden="true">◉</span>
              <span className="hidden sm:inline">{c.status?.liveAvailable ? "PayPal" : "Connect PayPal sandbox"}</span>
              <span className="sm:hidden">PayPal</span>
            </button>
            {c.mode === "demo" && (
              <button className="btn-ghost hidden px-3 py-1.5 text-xs sm:inline-flex" onClick={c.resetDemo} title="Restore the seeded demo ledger">
                Reset demo
              </button>
            )}
            {c.mode === "live" && (
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => c.refresh()} disabled={c.syncing}>
                {c.syncing ? <Spinner /> : "↻"} Sync
              </button>
            )}
            <button type="button" className="btn-ghost px-2.5 py-1.5" onClick={() => setShowSettings(true)} aria-label="Business settings" title="Business settings">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 pt-5 2xl:max-w-[1440px]">
        {!c.ready ? (
          <LoadingSkeleton />
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key figures">
              <Kpi label="Owed to you" value={gbp(kpi.outstanding)} />
              <Kpi label="Overdue" value={gbp(kpi.overdue)} sub={`${kpi.overdueCount} invoice${kpi.overdueCount === 1 ? "" : "s"}`} tone={kpi.overdue > 0 ? "bad" : "ok"} />
              <Kpi label="Paid this month" value={gbp(kpi.paidThisMonth)} tone="ok" />
              <Kpi label="Avg. time to pay" value={kpi.avgDaysToPay !== undefined ? `${kpi.avgDaysToPay} days` : "—"} />
            </section>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              <div className="min-w-0 space-y-5 lg:col-span-2">
                <JobNotes mode={c.mode} settings={c.settings} onDraft={onDraft} onError={onError} />
                <OverduePanel invoices={c.invoices} onChase={onRemind} />
              </div>
              {/* On desktop the chat fills the column's height without stretching the row. */}
              <div className="relative min-w-0 lg:min-h-[560px]">
                <AskSorted mode={c.mode} settings={c.settings} invoices={c.invoices} onConfirm={onConfirmAction} events={c.events} />
              </div>
            </div>

            <LedgerGrid invoices={c.invoices} onRemind={onRemind} onMarkPaid={onMarkPaid} onOpen={onOpen} loading={c.syncing && c.invoices.length === 0} />
          </>
        )}
      </main>

      {editing && (
        <InvoiceEditor
          draft={editing.draft}
          engine={editing.engine}
          aiError={editing.aiError}
          mode={c.mode}
          onClose={() => setEditing(null)}
          onSend={async (d) => {
            // Approvals are single-use: a retry after an error mints a fresh one.
            const t = editing.approval;
            setEditing((e) => (e ? { ...e, approval: undefined } : e));
            const created = await c.createInvoice(d, t);
            setEditing(null);
            setViewingId(created.id); // show the pay link + QR the customer just got
          }}
        />
      )}
      {viewing && (
        <InvoiceDetails
          invoice={viewing}
          mode={c.mode}
          onClose={() => setViewingId(null)}
          onRemind={(inv) => {
            setViewingId(null);
            setReminding({ inv });
          }}
          onMarkPaid={(inv) => {
            setViewingId(null);
            setConfirmPaid(inv);
          }}
          onCancel={async (inv) => {
            try {
              await c.cancelInvoice(inv);
            } catch (e) {
              toast("err", (e as Error).message);
              throw e;
            }
          }}
        />
      )}
      {reminding && (
        <ReminderModal
          invoice={reminding.inv}
          preset={reminding.preset}
          settings={c.settings}
          mode={c.mode}
          onClose={() => setReminding(null)}
          onSend={(inv, subject, body, stage) => {
            const t = reminding.approval;
            setReminding((r) => (r ? { ...r, approval: undefined } : r));
            return c.sendReminder(inv, subject, body, stage, t);
          }}
        />
      )}
      {confirmPaid && (
        <Modal open onClose={() => setConfirmPaid(null)} title="Mark as paid?">
          <p className="text-sm text-ink-2">
            Record <strong>{gbp(confirmPaid.total - confirmPaid.amountPaid)}</strong> received from <strong>{confirmPaid.customerName}</strong> for {confirmPaid.number} (e.g. cash or bank
            transfer). {c.mode === "live" ? "This records the payment against the invoice in PayPal." : ""}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setConfirmPaid(null)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={paying}
              onClick={async () => {
                setPaying(true);
                try {
                  await c.markPaid(confirmPaid);
                  setConfirmPaid(null);
                } catch (e) {
                  toast("err", (e as Error).message);
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
      {showConnect && (
        <PayPalConnect
          connected={!!c.status?.liveAvailable}
          credSource={c.status?.credSource ?? null}
          onConnect={c.connectPayPal}
          onDisconnect={c.disconnectPayPal}
          onClose={() => setShowConnect(false)}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={c.settings}
          engine={c.status?.engine}
          onSave={(s) => {
            c.setSettings(s);
            toast("ok", "Settings saved.");
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {c.toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ${
              t.kind === "ok" ? "bg-ink text-white" : t.kind === "err" ? "bg-bad text-white" : "bg-white text-ink ring-1 ring-line"
            }`}
          >
            {t.kind === "ok" ? "✓ " : t.kind === "err" ? "⚠ " : ""}
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your ledger">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card h-[92px] animate-pulse p-4">
            <div className="h-3 w-24 rounded bg-paper" />
            <div className="mt-3 h-6 w-28 rounded bg-paper" />
          </div>
        ))}
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <div className="card h-64 animate-pulse lg:col-span-2" />
        <div className="card h-64 animate-pulse" />
      </div>
      <p className="mt-4 flex items-center justify-center gap-2 text-sm text-muted">
        <Spinner className="text-brand" /> Loading your ledger…
      </p>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "bad" }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</div>
      <div className={`mt-1 text-xl font-extrabold tabular-nums sm:text-2xl ${tone === "bad" ? "text-bad" : tone === "ok" ? "text-brand" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}
