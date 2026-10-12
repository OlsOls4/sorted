"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { gbp } from "@/lib/format";
import { totals } from "@/lib/ledger";
import type { EngineInfo, Invoice, InvoiceDraft, PendingAction, ReminderStage } from "@/lib/types";
import { AskSorted } from "./AskSorted";
import { InvoiceEditor } from "./InvoiceEditor";
import { JobNotes } from "./JobNotes";
import { LedgerGrid } from "./LedgerGrid";
import { Logo } from "./Logo";
import { OverduePanel } from "./OverduePanel";
import { PayPalConnect } from "./PayPalConnect";
import { ReminderModal } from "./ReminderModal";
import { SettingsModal } from "./SettingsModal";
import { EngineBadge, Modal, Spinner } from "./ui";
import { useSorted } from "./useSorted";

export function Dashboard() {
  const c = useSorted();
  const [editing, setEditing] = useState<{ draft: InvoiceDraft; engine?: EngineInfo; aiError?: string } | null>(null);
  const [reminding, setReminding] = useState<{ inv: Invoice; preset?: { stage: ReminderStage; subject: string; body: string } } | null>(null);
  const [confirmPaid, setConfirmPaid] = useState<Invoice | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [paying, setPaying] = useState(false);

  const kpi = useMemo(() => totals(c.invoices), [c.invoices]);
  const onRemind = useCallback((inv: Invoice) => setReminding({ inv }), []);
  const onMarkPaid = useCallback((inv: Invoice) => setConfirmPaid(inv), []);
  const { toast } = c;
  const onError = useCallback((m: string) => toast("err", m), [toast]);
  const onDraft = useCallback((draft: InvoiceDraft, engine: EngineInfo, aiError?: string) => setEditing({ draft, engine, aiError }), []);

  const onConfirmAction = useCallback(
    async (a: PendingAction): Promise<boolean> => {
      if (a.type === "create_invoice") {
        setEditing({ draft: a.draft });
        return true;
      }
      const inv = c.invoices.find((i) => i.id === a.invoiceId);
      if (!inv) {
        toast("err", "That invoice is no longer in your ledger.");
        return false;
      }
      if (a.type === "send_reminder") {
        setReminding({ inv, preset: { stage: a.stage, subject: a.subject, body: a.body } });
        return true;
      }
      try {
        await c.markPaid(inv);
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
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" aria-label="Sorted home">
              <Logo className="text-xl" />
            </Link>
            {c.mode === "demo" ? (
              <span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-bold tracking-wide text-warn uppercase ring-1 ring-warn/20" title="Mock PayPal backend with seeded data. Nothing is sent.">
                Demo mode
              </span>
            ) : (
              <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-bold tracking-wide text-pp-2 uppercase ring-1 ring-sky-600/20">
                PayPal {c.status?.paypalEnv ?? "live"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">
              <EngineBadge engine={c.status?.engine} />
            </span>
            {c.status?.liveAvailable ? (
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => c.setMode(c.mode === "demo" ? "live" : "demo")}>
                {c.mode === "demo" ? "Go live" : "Use demo"}
              </button>
            ) : null}
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setShowConnect(true)} title="Use live PayPal sandbox invoicing">
              <span className="text-pp">◉</span>
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
            <button className="btn-ghost px-2.5 py-1.5" onClick={() => setShowSettings(true)} aria-label="Settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
          </div>
        </div>
        {c.mode === "demo" && (
          <div className="border-t border-warn/20 bg-warn-soft/60 px-4 py-1.5 text-center text-xs text-warn">
            You&apos;re exploring with sample data for <strong>{c.settings.businessName}</strong>. Invoices and reminders go to a mock PayPal — nothing is emailed.{" "}
            <button className="font-semibold underline" onClick={() => setShowConnect(true)}>
              Connect your PayPal sandbox
            </button>{" "}
            to go live.
          </div>
        )}
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 pt-5">
        {!c.ready ? (
          <div className="flex h-64 items-center justify-center text-muted">
            <Spinner className="mr-2 text-brand" /> Loading your ledger…
          </div>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key figures">
              <Kpi label="Owed to you" value={gbp(kpi.outstanding)} />
              <Kpi label="Overdue" value={gbp(kpi.overdue)} sub={`${kpi.overdueCount} invoice${kpi.overdueCount === 1 ? "" : "s"}`} tone={kpi.overdue > 0 ? "bad" : "ok"} />
              <Kpi label="Paid this month" value={gbp(kpi.paidThisMonth)} tone="ok" />
              <Kpi label="Avg. time to pay" value={kpi.avgDaysToPay !== undefined ? `${kpi.avgDaysToPay} days` : "—"} />
            </section>

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="space-y-5 lg:col-span-2">
                <JobNotes mode={c.mode} settings={c.settings} onDraft={onDraft} onError={onError} />
                <LedgerGrid invoices={c.invoices} onRemind={onRemind} onMarkPaid={onMarkPaid} />
              </div>
              <div className="space-y-5">
                <OverduePanel invoices={c.invoices} onChase={onRemind} />
                <AskSorted mode={c.mode} settings={c.settings} invoices={c.invoices} onConfirm={onConfirmAction} />
              </div>
            </div>
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
            await c.createInvoice(d);
            setEditing(null);
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
          onSend={c.sendReminder}
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
      {showSettings && <SettingsModal settings={c.settings} onSave={c.setSettings} onClose={() => setShowSettings(false)} />}

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

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "bad" }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</div>
      <div className={`mt-1 text-xl font-extrabold tabular-nums sm:text-2xl ${tone === "bad" ? "text-bad" : tone === "ok" ? "text-brand" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}
