"use client";

// /app/dashboard: the AG Studio "Money owed" dashboard. Studio on top (scoreboard, heat tile,
// cash-in chart, KPIs, Ask Sorted), Sorted's own AG Grid ledger underneath, cross-filtered by
// whatever is selected in Studio. Works in demo mode on the seeded ledger with no keys at all.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgAiChatSession, AgAiHarness, AgStudioApi, AgStudioMode } from "ag-studio";
import { gbp, todayISO } from "@/lib/format";
import { toStudioRows, vocabFor } from "@/lib/studio/rows";
import { parseInline } from "@/lib/markdown";
import type { Invoice } from "@/lib/types";
import { LedgerGrid } from "../LedgerGrid";
import { Logo } from "../Logo";
import { ReminderModal } from "../ReminderModal";
import { Modal, Spinner } from "../ui";
import { useSorted } from "../useSorted";
import { AGENT_ID, intentFetcher, PROMPT_STARTERS } from "./agent";
import StudioCanvas from "./StudioCanvas";

const noSubscription = () => () => {};
/** Studio and its saved state live in the browser only; render it after hydration. */
function useInBrowser() {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

class Holder<T> {
  constructor(private value: T) {}
  get() {
    return this.value;
  }
  set(v: T) {
    this.value = v;
  }
}

export function MoneyOwedStudio({ licenseKey }: { licenseKey?: string }) {
  const c = useSorted();
  const inBrowser = useInBrowser();
  const today = todayISO();
  const rows = useMemo(() => toStudioRows(c.invoices, today), [c.invoices, today]);
  const vocab = useMemo(() => vocabFor(rows.invoices), [rows]);
  // The agent is created once with Studio, so it reads the current vocabulary from a small holder.
  const [vocabBox] = useState(() => new Holder(vocab));
  useEffect(() => vocabBox.set(vocab), [vocab, vocabBox]);
  const fetchIntent = useMemo(() => intentFetcher(() => vocabBox.get(), todayISO), [vocabBox]);

  const [ledgerIds, setLedgerIds] = useState<string[] | null>(null);
  const [studioMode, setStudioMode] = useState<AgStudioMode>("view");
  const apiRef = useRef<AgStudioApi | null>(null);
  const harnessRef = useRef<AgAiHarness | null>(null);
  const sessionRef = useRef<AgAiChatSession | null>(null);
  const [ready, setReady] = useState(false);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{ q: string; text: string; error?: boolean } | null>(null);

  const [reminding, setReminding] = useState<Invoice | null>(null);
  const [confirmPaid, setConfirmPaid] = useState<Invoice | null>(null);
  const [paying, setPaying] = useState(false);

  const onReady = useCallback((api: AgStudioApi, harness: AgAiHarness | null) => {
    apiRef.current = api;
    harnessRef.current = harness;
    // Dev-only handle for poking Studio from the console (api.getHealth(), api.getState()).
    if (process.env.NODE_ENV !== "production") (window as unknown as { __sortedStudio?: AgStudioApi }).__sortedStudio = api;
    setReady(true);
  }, []);

  // Ask goes through the Studio Agent Framework: a thread on the harness, Ask Sorted as its agent.
  const ask = useCallback(async (text: string) => {
    const q = text.trim();
    const harness = harnessRef.current;
    if (!q || !harness) return;
    setAsking(true);
    setAnswer(null);
    try {
      if (!sessionRef.current) sessionRef.current = await harness.createThread({ agentId: AGENT_ID, title: "Ask Sorted" });
      const session = sessionRef.current;
      const before = session.messages.length;
      await new Promise<void>((resolve) => {
        let started = false;
        const onChange = () => {
          if (session.status === "running") started = true;
          if ((started || session.messages.length > before + 1) && session.status !== "running") {
            session.removeEventListener("changed", onChange);
            resolve();
          }
        };
        session.addEventListener("changed", onChange);
        session.sendMessage(q);
        setTimeout(() => {
          session.removeEventListener("changed", onChange);
          resolve();
        }, 30_000);
      });
      const last = [...session.messages].reverse().find((m) => m.role === "assistant");
      const err = last?.parts.find((p) => p.type === "error");
      const txt = last?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n");
      setAnswer({ q, text: err && "message" in err ? err.message : txt || "Done.", error: !!err });
      setQuestion("");
    } catch (e) {
      setAnswer({ q, text: (e as Error).message, error: true });
    } finally {
      setAsking(false);
    }
  }, []);

  const shown = useMemo(() => {
    if (!ledgerIds) return c.invoices;
    const set = new Set(ledgerIds);
    return c.invoices.filter((i) => set.has(i.id));
  }, [c.invoices, ledgerIds]);
  const filtered = ledgerIds !== null && shown.length !== c.invoices.filter((i) => i.status !== "DRAFT").length;

  return (
    <div className="min-h-screen pb-16">
      <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 2xl:max-w-[1440px]">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" aria-label="Sorted home">
              <Logo className="text-xl" />
            </Link>
            <span className="hidden text-sm font-semibold text-ink-2 sm:inline">Money owed</span>
            {c.mode === "demo" && (
              <span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-bold tracking-wide text-warn uppercase ring-1 ring-warn/20">Demo mode</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={() => setStudioMode((m) => (m === "view" ? "edit" : "view"))}
              disabled={!ready}
              aria-pressed={studioMode === "edit"}
              title="Edit mode opens AG Studio's layout, data and AI panels"
            >
              {studioMode === "view" ? "✎ Customise" : "✓ Done"}
            </button>
            <Link href="/app" className="btn-ghost px-3 py-1.5 text-xs">
              ← Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-4 pt-5 2xl:max-w-[1440px]">
        <section className="card p-3 sm:p-4" aria-label="Ask Sorted">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <label htmlFor="ask-studio" className="sr-only">
              Ask Sorted to filter or chart the dashboard
            </label>
            <input
              id="ask-studio"
              className="input flex-1"
              placeholder='Ask Sorted: "show overdue Bristol jobs" or "chart October earnings"'
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={!ready || asking}
              maxLength={300}
            />
            <button className="btn-primary" disabled={!ready || asking || !question.trim()}>
              {asking && <Spinner />} Ask
            </button>
          </form>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {PROMPT_STARTERS.map((s) => (
              <button key={s.label} type="button" className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/15 disabled:opacity-50" disabled={!ready || asking} onClick={() => void ask(s.prompt)}>
                {s.label}
              </button>
            ))}
          </div>
          {answer && (
            <div className={`mt-3 rounded-xl px-3 py-2 text-sm ${answer.error ? "bg-bad-soft text-bad" : "bg-paper text-ink-2"}`} aria-live="polite">
              <span className="font-semibold text-ink">“{answer.q}”</span> — <span>
                {parseInline(answer.text).map((t, i) => (t.kind === "bold" ? <strong key={i}>{t.text}</strong> : t.kind === "code" ? <code key={i}>{t.text}</code> : <span key={i}>{t.text}</span>))}
              </span>
            </div>
          )}
        </section>

        <section className="card overflow-hidden p-0" aria-label="Money owed dashboard" style={{ height: studioMode === "edit" ? 860 : 640 }}>
          {c.ready && inBrowser ? (
            <StudioCanvas
              rows={rows}
              today={today}
              mode={studioMode}
              licenseKey={licenseKey}
              fetchIntent={fetchIntent}
              onLedgerIds={setLedgerIds}
              onReady={onReady}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted">
              <span className="flex items-center gap-2">
                <Spinner className="text-brand" /> Loading your ledger…
              </span>
            </div>
          )}
        </section>

        {filtered && (
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-1" aria-live="polite">
            <h2 className="text-sm font-semibold text-ink">
              Ledger · <span className="font-normal text-muted">{shown.length} matching the dashboard</span>
            </h2>
            <span className="text-xs text-muted">
              Clear filters in the dashboard (or ask “reset”) to see every job · {gbp(shown.reduce((s, i) => s + Math.max(0, i.total - i.amountPaid), 0))} open in view
            </span>
          </div>
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
