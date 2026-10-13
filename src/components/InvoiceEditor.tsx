"use client";

import { useState } from "react";
import { computeTotals, gbp, lineTotal, uid } from "@/lib/format";
import type { EngineInfo, InvoiceDraft, LineItem, Mode } from "@/lib/types";
import { EngineBadge, Modal, PayPalMark, Spinner } from "./ui";

export function InvoiceEditor({
  draft: initial,
  engine,
  aiError,
  mode,
  onClose,
  onSend,
}: {
  draft: InvoiceDraft;
  engine?: EngineInfo;
  aiError?: string;
  mode: Mode;
  onClose: () => void;
  onSend: (d: InvoiceDraft) => Promise<void>;
}) {
  const [d, setD] = useState<InvoiceDraft>(initial);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = computeTotals(d);

  const set = <K extends keyof InvoiceDraft>(k: K, v: InvoiceDraft[K]) => setD((p) => ({ ...p, [k]: v }));
  const setItem = (id: string, patch: Partial<LineItem>) => setD((p) => ({ ...p, items: p.items.map((li) => (li.id === id ? { ...li, ...patch } : li)) }));
  const removeItem = (id: string) => setD((p) => ({ ...p, items: p.items.filter((li) => li.id !== id) }));
  const addItem = () =>
    setD((p) => ({ ...p, items: [...p.items, { id: uid("li_"), kind: "other", description: "", quantity: 1, unitAmount: 0, unit: "AMOUNT" }] }));

  const emailOK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.customerEmail);
  const dueOK = /^\d{4}-\d{2}-\d{2}$/.test(d.dueDate);
  const blocker = !d.customerName.trim()
    ? "Add the customer's name."
    : !emailOK
      ? "Add a valid email so PayPal can send the invoice."
      : d.items.length === 0
        ? "Add at least one line."
        : d.items.some((li) => !li.description.trim())
          ? "Give every line a description."
          : d.items.some((li) => li.quantity <= 0)
            ? "Every line needs a quantity above zero."
            : t.total <= 0
              ? "The total must be more than £0."
              : !dueOK
                ? "Pick a due date."
                : null;
  const canSend = !blocker;

  async function send() {
    setSending(true);
    setError(null);
    try {
      await onSend(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Check your invoice" wide>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Drafted by</span>
        <EngineBadge engine={engine} />
        {aiError && (
          <span className="text-warn" title={aiError}>
            ({aiError.split(" [")[0]})
          </span>
        )}
      </div>

      {!!d.warnings?.length && (
        <div className="mb-4 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          {d.warnings.map((w, i) => (
            <div key={i}>⚠️ {w}</div>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="cn">Customer</label>
          <input id="cn" className="input" value={d.customerName} onChange={(e) => set("customerName", e.target.value)} placeholder="Mrs Patel" />
        </div>
        <div>
          <label className="label" htmlFor="ce">Email</label>
          <input
            id="ce"
            type="email"
            className={`input ${d.customerEmail && !emailOK ? "border-bad" : ""}`}
            value={d.customerEmail}
            onChange={(e) => set("customerEmail", e.target.value.trim())}
            placeholder="customer@example.com"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="js">Job</label>
          <input id="js" className="input" value={d.jobSummary} onChange={(e) => set("jobSummary", e.target.value)} placeholder="What you did, e.g. Fixed leaking stopcock" />
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="label mb-0">Line items</span>
          <button type="button" className="text-sm font-semibold text-brand hover:underline" onClick={addItem}>
            + Add line
          </button>
        </div>
        <div className="space-y-2">
          {d.items.map((li) => (
            <div key={li.id} className="grid grid-cols-12 items-center gap-2 rounded-xl border border-line p-2">
              <input
                className="input col-span-12 sm:col-span-6"
                value={li.description}
                onChange={(e) => setItem(li.id, { description: e.target.value })}
                placeholder="Description"
                aria-label="Description"
              />
              <div className="col-span-4 sm:col-span-2">
                <input
                  className="input text-right"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={li.unit === "HOURS" ? 0.25 : 1}
                  value={li.quantity}
                  onChange={(e) => setItem(li.id, { quantity: Math.max(0, Number(e.target.value) || 0) })}
                  aria-label={li.unit === "HOURS" ? "Hours" : "Quantity"}
                />
              </div>
              <div className="col-span-4 sm:col-span-2">
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted">£</span>
                  <input
                    className="input pl-6 text-right"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={li.unitAmount}
                    onChange={(e) => setItem(li.id, { unitAmount: Math.max(0, Number(e.target.value) || 0) })}
                    aria-label="Unit price"
                  />
                </div>
              </div>
              <div className="col-span-3 text-right text-sm font-semibold sm:col-span-1">{gbp(lineTotal(li))}</div>
              <button type="button" className="col-span-1 rounded-md py-1 text-muted hover:text-bad" onClick={() => removeItem(li.id)} aria-label={`Remove ${li.description || "line"}`} title="Remove line">
                ✕
              </button>
              <div className="col-span-12 -mt-1 pl-1 text-[11px] text-muted">
                {li.unit === "HOURS" ? `${li.quantity} hrs × ${gbp(li.unitAmount)}/hr` : li.kind === "parts" ? "Parts & materials" : li.kind === "callout" ? "Call-out" : "Fixed amount"}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="due">Due date</label>
          <input id="due" type="date" className="input" value={d.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
        </div>
        <div>
          <span className="label">Customer type</span>
          <div className="flex rounded-xl border border-line p-0.5 text-sm">
            {(["consumer", "business"] as const).map((ct) => (
              <button
                key={ct}
                type="button"
                aria-pressed={d.customerType === ct}
                className={`flex-1 rounded-lg px-2 py-1.5 font-medium ${d.customerType === ct ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
                onClick={() => set("customerType", ct)}
              >
                {ct === "consumer" ? "Private" : "Business"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="label">VAT</span>
          <label className="flex h-[38px] cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[#0a7f5a]" checked={d.vatEnabled} onChange={(e) => set("vatEnabled", e.target.checked)} />
            Add VAT at {d.vatRate}%
          </label>
        </div>
      </div>

      <div className="mt-3">
        <label className="label" htmlFor="note">Note to customer</label>
        <textarea id="note" className="input min-h-[60px]" value={d.note ?? ""} onChange={(e) => set("note", e.target.value)} />
      </div>

      <div className="mt-5 rounded-2xl bg-paper p-4 text-sm">
        <div className="flex justify-between"><span className="text-muted">Subtotal</span><span>{gbp(t.subtotal)}</span></div>
        {d.vatEnabled && <div className="flex justify-between"><span className="text-muted">VAT ({d.vatRate}%)</span><span>{gbp(t.vat)}</span></div>}
        <div className="mt-1 flex justify-between border-t border-line pt-2 text-lg font-extrabold"><span>Total</span><span>{gbp(t.total)}</span></div>
        {!d.vatEnabled && <p className="mt-1 text-xs text-muted">No VAT charged. Tick &ldquo;Add VAT&rdquo; above if you&apos;re VAT registered.</p>}
      </div>

      {error && (
        <div className="mt-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">
          {error}
        </div>
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {blocker && <span className="text-xs text-muted sm:mr-auto">{blocker}</span>}
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-paypal" disabled={!canSend || sending} onClick={send}>
          {sending ? <Spinner /> : <PayPalMark />}
          {sending ? "Sending…" : `Send ${gbp(t.total)} invoice via PayPal${mode === "demo" ? " (demo)" : ""}`}
        </button>
      </div>
      <p className="mt-2 text-right text-[11px] text-muted">
        {mode === "demo"
          ? "Demo mode: a mock PayPal backend simulates create + send. No email goes out."
          : "Creates the invoice with PayPal Invoicing v2 and emails your customer a secure pay link (card or PayPal)."}
      </p>
    </Modal>
  );
}
