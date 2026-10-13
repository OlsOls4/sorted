"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { balance, daysOverdue, gbp, payLaterEligible, ukDate } from "@/lib/format";
import { suggestStage } from "@/lib/ledger";
import type { EngineInfo, Invoice, Mode, ReminderDraft, ReminderStage, Settings } from "@/lib/types";
import { EngineBadge, Modal, PayPalMark, Spinner, StageBadge } from "./ui";

const s_label = (s: ReminderStage) => (s === "nudge" ? "friendly nudge" : s === "firm" ? "firm reminder" : "final notice");

export function ReminderModal({
  invoice,
  settings,
  mode,
  preset,
  onClose,
  onSend,
}: {
  invoice: Invoice;
  settings: Settings;
  mode: Mode;
  preset?: { stage: ReminderStage; subject: string; body: string };
  onClose: () => void;
  onSend: (inv: Invoice, subject: string, body: string, stage: ReminderStage) => Promise<unknown>;
}) {
  const [stage, setStage] = useState<ReminderStage>(preset?.stage ?? suggestStage(invoice));
  const [subject, setSubject] = useState(preset?.subject ?? "");
  const [body, setBody] = useState(preset?.body ?? "");
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [legal, setLegal] = useState<ReminderDraft["statutoryInterest"]>();
  const [loading, setLoading] = useState(!preset);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetches a draft; only sets state after the network call resolves.
  const fetchDraft = useCallback(
    async (s: ReminderStage) => {
      try {
        const res = await api<{ draft: ReminderDraft; engine: EngineInfo }>("/api/reminders/draft", mode, { invoice, settings, stage: s });
        setSubject(res.draft.subject);
        setBody(res.draft.body);
        setLegal(res.draft.statutoryInterest);
        setEngine(res.engine);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [invoice, settings, mode],
  );

  const load = (s: ReminderStage) => {
    setLoading(true);
    setError(null);
    void fetchDraft(s);
  };

  useEffect(() => {
    if (preset) return;
    const t = setTimeout(() => void fetchDraft(stage), 0);
    return () => clearTimeout(t);
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const od = daysOverdue(invoice);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await onSend(invoice, subject, body, stage);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`${daysOverdue(invoice) > 0 ? "Chase" : "Remind"} ${invoice.customerName}`} wide>
      <div className="mb-4 grid grid-cols-3 gap-2 text-center text-sm">
        <div className="rounded-xl bg-paper p-2">
          <div className="text-xs text-muted">Owed</div>
          <div className="font-bold">{gbp(balance(invoice))}</div>
        </div>
        <div className="rounded-xl bg-paper p-2">
          <div className="text-xs text-muted">{od > 0 ? "Overdue" : "Due"}</div>
          <div className={`font-bold ${od > 0 ? "text-bad" : ""}`}>{od > 0 ? `${od} days` : ukDate(invoice.dueDate)}</div>
        </div>
        <div className="rounded-xl bg-paper p-2">
          <div className="text-xs text-muted">Reminders sent</div>
          <div className="font-bold">{invoice.reminders.length}</div>
        </div>
      </div>

      <span className="label">Tone</span>
      <div className="mb-4 flex rounded-xl border border-line p-0.5 text-sm">
        {(["nudge", "firm", "final"] as ReminderStage[]).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={stage === s}
            disabled={loading}
            className={`flex-1 rounded-lg px-2 py-1.5 font-medium transition ${stage === s ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
            onClick={() => {
              if (s === stage && !error) return;
              setStage(s);
              load(s);
            }}
          >
            {s === "nudge" ? "Friendly nudge" : s === "firm" ? "Firm" : "Final notice"}
          </button>
        ))}
      </div>

      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <StageBadge stage={stage} />
        {engine && (
          <>
            written by <EngineBadge engine={engine} />
          </>
        )}
        {loading && (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="text-brand" /> Writing the {s_label(stage)}…
          </span>
        )}
      </div>

      <label className="label" htmlFor="rs">Subject</label>
      <input id="rs" className="input mb-3 disabled:bg-paper" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={loading} placeholder={loading ? "Drafting…" : ""} />
      <label className="label" htmlFor="rb">Message</label>
      <textarea id="rb" className="input min-h-[260px] font-[inherit] leading-relaxed disabled:bg-paper disabled:text-muted" value={body} onChange={(e) => setBody(e.target.value)} disabled={loading} placeholder={loading ? "Drafting your reminder…" : ""} />

      {!loading && body && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          {invoice.payerViewUrl && body.includes(invoice.payerViewUrl) && (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 font-semibold text-pp-2 ring-1 ring-sky-600/20">✓ PayPal pay link included</span>
          )}
          {payLaterEligible(invoice) && /pay in 3/i.test(body) && (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 font-semibold text-pp-2 ring-1 ring-sky-600/20">Pay in 3 mentioned (eligible customers)</span>
          )}
          {stage === "final" && legal?.applies && /waive/i.test(body) && (
            <span className="rounded-full bg-violet-50 px-2 py-0.5 font-semibold text-violet-800 ring-1 ring-violet-600/20">Pay today: interest waived</span>
          )}
          {invoice.payerViewUrl && (
            <a className="rounded-full px-2 py-0.5 font-semibold text-pp-2 underline" href={invoice.payerViewUrl} target="_blank" rel="noreferrer">
              Preview what your customer sees ↗
            </a>
          )}
        </div>
      )}

      {legal && stage === "final" && (
        <div className={`mt-3 rounded-xl px-3 py-2 text-xs ${legal.applies ? "bg-violet-50 text-violet-800" : "bg-paper text-muted"}`}>
          <strong>{legal.applies ? "Late Payment Act applies: " : "Note: "}</strong>
          {legal.explanation}
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">
          <span>{error}</span>
          {!subject && !sending && (
            <button type="button" className="shrink-0 text-xs font-semibold underline" onClick={() => load(stage)}>
              Try again
            </button>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-ghost" onClick={onClose}>Not now</button>
        <button type="button" className="btn-paypal" onClick={send} disabled={sending || loading || !subject.trim() || !body.trim()}>
          {sending ? <Spinner /> : <PayPalMark />}
          {sending ? "Sending…" : `Send reminder via PayPal${mode === "demo" ? " (demo)" : ""}`}
        </button>
      </div>
      <p className="mt-2 text-right text-[11px] text-muted">
        Nothing is sent until you press send. {mode === "live" ? "Uses PayPal's invoice reminder (POST /v2/invoicing/invoices/{id}/remind) via the PayPal Agent Toolkit." : "Demo mode: logged locally, no email goes out."}
      </p>
    </Modal>
  );
}
