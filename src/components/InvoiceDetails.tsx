"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { claimStatus, letterPath } from "@/lib/claim";
import { statutoryInterest } from "@/lib/ledger";
import { balance, daysOverdue, displayStatus, gbp, isOpen, payLaterEligible, todayISO, ukDate } from "@/lib/format";
import { PLAN_COUNTS, planInstalments, planProgress } from "@/lib/plan";
import { DEFAULT_SETTINGS, type Invoice, type Mode, type PlanCadence, type Settings } from "@/lib/types";
import { Modal, PayPalMark, Spinner, StatusBadge } from "./ui";

/**
 * One invoice: what the customer sees (PayPal payer page / mock payer page in
 * demo), a scan-to-pay QR code from PayPal, and the actions that apply.
 */
export function InvoiceDetails({
  invoice,
  mode,
  settings = DEFAULT_SETTINGS,
  onClose,
  onRemind,
  onMarkPaid,
  onCancel,
  onOfferPlan,
}: {
  invoice: Invoice;
  mode: Mode;
  settings?: Settings;
  onClose: () => void;
  onRemind?: (inv: Invoice) => void;
  onMarkPaid?: (inv: Invoice) => void;
  onCancel?: (inv: Invoice) => Promise<unknown>;
  onOfferPlan?: (inv: Invoice, count: number, cadence: PlanCadence) => Promise<unknown>;
}) {
  const [qr, setQr] = useState<{ dataUrl: string; via: string } | null>(null);
  const [qrErr, setQrErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planCount, setPlanCount] = useState(3);
  const [planCadence, setPlanCadence] = useState<PlanCadence>("monthly");
  const [planBusy, setPlanBusy] = useState(false);
  const open = isOpen(invoice) && balance(invoice) > 0;
  const status = displayStatus(invoice);
  const od = daysOverdue(invoice);
  const link = invoice.payerViewUrl;
  const si = statutoryInterest(invoice, settings.bankRate);
  const showSI = open && si.applies;
  const claim = claimStatus(invoice, undefined, { demo: mode === "demo" });
  const today = todayISO();
  const progress = invoice.plan ? planProgress(invoice.plan, invoice.amountPaid, today) : null;
  let preview: ReturnType<typeof planInstalments> = [];
  try {
    preview = open ? planInstalments(balance(invoice), planCount, planCadence, today) : [];
  } catch {
    preview = [];
  }

  useEffect(() => {
    if (!open) return;
    let gone = false;
    api<{ dataUrl: string; via: string }>(`/api/invoices/${encodeURIComponent(invoice.id)}/qr`, mode, { invoice: { id: invoice.id } })
      .then((r) => !gone && setQr(r))
      .catch((e) => !gone && setQrErr((e as Error).message));
    return () => {
      gone = true;
    };
  }, [invoice.id, mode, open]);

  return (
    <Modal open onClose={onClose} title={`${invoice.number} · ${invoice.customerName}`} wide>
      <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={status} />
            <span className="text-muted">
              Issued {ukDate(invoice.issueDate)} · {invoice.paidDate ? `paid ${ukDate(invoice.paidDate)}` : od > 0 ? `${od} days overdue` : `due ${ukDate(invoice.dueDate)}`}
            </span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {invoice.items.map((li) => (
                <tr key={li.id} className="border-b border-line/70">
                  <td className="py-1.5 pr-2">{li.description}</td>
                  <td className="py-1.5 text-right text-muted tabular-nums">
                    {li.quantity} × {gbp(li.unitAmount)}
                  </td>
                </tr>
              ))}
              {invoice.vatEnabled && (
                <tr>
                  <td className="py-1 text-muted">VAT {invoice.vatRate}%</td>
                  <td className="py-1 text-right text-muted tabular-nums">{gbp(invoice.vat)}</td>
                </tr>
              )}
              <tr>
                <td className="py-1.5 font-bold">{open ? "Owed" : "Total"}</td>
                <td className="py-1.5 text-right font-bold tabular-nums">{gbp(open ? balance(invoice) : invoice.total)}</td>
              </tr>
            </tbody>
          </table>
          {showSI && (
            <div className="rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn">
              <p className="font-semibold">
                Statutory interest so far {gbp(si.interestToDate)} · rising {gbp(si.dailyInterest)} a day
              </p>
              <p className="mt-0.5">
                Plus {gbp(si.fixedCompensation)} fixed compensation. Late Payment of Commercial Debts (Interest) Act 1998: {si.ratePercent}% a year from the due date on{" "}
                {gbp(si.principal)}. Total you could claim today: <strong>{gbp(si.totalClaim)}</strong>.
              </p>
              {claim.ready && (
                <a className="mt-2 inline-block font-semibold text-ink underline" href={letterPath(invoice.id)} target="_blank" rel="noreferrer">
                  Prepare Letter Before Claim →
                </a>
              )}
            </div>
          )}
          {invoice.amountPaid > 0 && open && (
            <p className="text-xs text-muted tabular-nums">
              {gbp(invoice.amountPaid)} paid so far · <strong className="text-ink">{gbp(balance(invoice))}</strong> remaining
            </p>
          )}
          {invoice.plan && progress && open && (
            <div className="rounded-xl bg-violet-50 px-3 py-2 text-xs text-violet-800 ring-1 ring-violet-600/15">
              <div className="font-semibold">
                Payment plan: {invoice.plan.count} {invoice.plan.cadence} payments · {progress.instalmentsPaid} of {invoice.plan.count} paid
                {progress.onTrack ? "" : " · an instalment is late"}
              </div>
              <ol className="mt-1 space-y-0.5">
                {invoice.plan.instalments.map((i) => (
                  <li key={i.n} className="flex justify-between tabular-nums">
                    <span>
                      {i.n <= progress.instalmentsPaid ? "Paid" : progress.next?.n === i.n ? "Next" : "Due"} {ukDate(i.dueDate)}
                    </span>
                    <span>{gbp(i.amount)}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-1 text-[11px] text-violet-700/80">PayPal accepts part payments of {gbp(invoice.plan.minimumAmountDue)} or more on this invoice.</div>
            </div>
          )}
          {open && payLaterEligible(invoice) && (
            <p className="rounded-xl bg-sky-50 px-3 py-2 text-xs text-pp">
              Private customer, {gbp(balance(invoice))}: reminders mention that eligible customers can choose <strong>PayPal Pay in 3</strong> at checkout (subject to
              status; PayPal decides eligibility).
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {link && (
              <a className="btn-paypal" href={link} target="_blank" rel="noreferrer">
                <PayPalMark /> Preview what your customer sees
              </a>
            )}
            {link && (
              <button
                type="button"
                className="btn-ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    /* clipboard blocked */
                  }
                }}
              >
                {copied ? "✓ Copied" : "Copy pay link"}
              </button>
            )}
            {invoice.source === "paypal" && invoice.merchantViewUrl && (
              <a className="btn-ghost" href={invoice.merchantViewUrl} target="_blank" rel="noreferrer">
                Open in PayPal ↗
              </a>
            )}
          </div>
          <p className="text-[11px] text-muted">
            {mode === "live"
              ? "Live: this opens the real PayPal sandbox invoice page your customer gets (pay with a sandbox personal account)."
              : "Demo: this opens Sorted's mock PayPal payer page. Paying there flips this invoice to Paid, like PayPal's INVOICING.INVOICE.PAID webhook does in live mode."}
          </p>
        </div>

        {open && (
          <figure className="flex flex-col items-center justify-start rounded-2xl bg-white p-3 ring-1 ring-line sm:w-[200px]">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.dataUrl} alt={`QR code to pay ${invoice.number}`} width={176} height={176} />
            ) : qrErr ? (
              <div className="flex h-[176px] items-center px-2 text-center text-xs text-bad">{qrErr}</div>
            ) : (
              <div className="flex h-[176px] w-[176px] items-center justify-center">
                <Spinner className="text-brand" />
              </div>
            )}
            <figcaption className="mt-1 text-center text-[11px] text-muted">
              Scan to pay
              <br />
              {qr?.via === "paypal-agent-toolkit" ? "QR by PayPal (Agent Toolkit)" : "Opens the mock payer page"}
            </figcaption>
          </figure>
        )}
      </div>

      {planOpen && open && onOfferPlan && !confirmCancel ? (
        <div className="mt-5 rounded-xl bg-violet-50 p-3 text-sm text-ink ring-1 ring-violet-600/15">
          <div className="font-semibold">Offer a payment plan for {gbp(balance(invoice))}</div>
          <p className="mt-0.5 text-xs text-muted">
            {mode === "live"
              ? "PayPal will accept part payments of the instalment amount on this invoice. Nothing is emailed yet: you review the offer next."
              : "Demo: the invoice accepts part payments of the instalment amount in mock PayPal. You review the offer email next."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <div className="inline-flex rounded-lg bg-white p-0.5 ring-1 ring-line" role="group" aria-label="Number of instalments">
              {PLAN_COUNTS.map((n) => (
                <button key={n} type="button" aria-pressed={planCount === n} className={`rounded-md px-2.5 py-1 font-medium ${planCount === n ? "bg-ink text-white" : "text-muted"}`} onClick={() => setPlanCount(n)}>
                  {n} payments
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-lg bg-white p-0.5 ring-1 ring-line" role="group" aria-label="How often">
              {(["weekly", "monthly"] as const).map((c) => (
                <button key={c} type="button" aria-pressed={planCadence === c} className={`rounded-md px-2.5 py-1 font-medium capitalize ${planCadence === c ? "bg-ink text-white" : "text-muted"}`} onClick={() => setPlanCadence(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <ol className="mt-2 space-y-0.5 text-xs tabular-nums">
            {preview.map((i) => (
              <li key={i.n} className="flex justify-between">
                <span>
                  {i.n}. {i.n === 1 ? "Today" : ukDate(i.dueDate)}
                </span>
                <span className="font-semibold">{gbp(i.amount)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setPlanOpen(false)} disabled={planBusy}>
              Not now
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={planBusy || !preview.length}
              onClick={async () => {
                setPlanBusy(true);
                try {
                  await onOfferPlan(invoice, planCount, planCadence);
                } catch {
                  setPlanBusy(false);
                }
              }}
            >
              {planBusy && <Spinner />} Set up plan and draft offer
            </button>
          </div>
        </div>
      ) : confirmCancel ? (
        <div className="mt-5 rounded-xl bg-bad-soft p-3 text-sm text-bad">
          Cancel {invoice.number}? {mode === "live" ? "PayPal marks it cancelled and the customer can no longer pay it." : "Demo: it's marked cancelled in your sample ledger."} Chasing stops.
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setConfirmCancel(false)} disabled={cancelling}>
              Keep it
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                try {
                  await onCancel?.(invoice);
                  onClose();
                } catch {
                  setCancelling(false);
                }
              }}
            >
              {cancelling && <Spinner />} Cancel invoice
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-between">
          <div>
            {open && onCancel && (
              <button type="button" className="btn-ghost text-bad" onClick={() => setConfirmCancel(true)}>
                Cancel invoice…
              </button>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {open && onOfferPlan && od > 0 && !invoice.plan && (
              <button type="button" className="btn-ghost" onClick={() => setPlanOpen(true)}>
                Offer a payment plan
              </button>
            )}
            {open && onMarkPaid && (
              <button type="button" className="btn-ghost" onClick={() => onMarkPaid(invoice)}>
                Mark paid
              </button>
            )}
            {open && onRemind && (
              <button type="button" className="btn-primary" onClick={() => onRemind(invoice)}>
                {od > 0 ? "Chase" : "Remind"} {invoice.customerName.split(" ")[0]}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
