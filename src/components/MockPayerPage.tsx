"use client";

// Demo-only stand-in for PayPal's invoice payer page. Reads the sample ledger
// from this browser, and "paying" flips the invoice to Paid and tells the
// dashboard tab (BroadcastChannel), mirroring the live INVOICING.INVOICE.PAID webhook.
import { useEffect, useState } from "react";
import { eventFromInvoice } from "@/lib/events";
import { balance, gbp, isOpen, payLaterEligible, todayISO, ukDate } from "@/lib/format";
import type { Invoice } from "@/lib/types";
import { PayPalMark } from "./ui";

const KEY = "sorted.demo.ledger.v1";

export function MockPayerPage({ id }: { id: string }) {
  const [inv, setInv] = useState<Invoice | null | undefined>(undefined);
  const [paid, setPaid] = useState(false);
  const [from, setFrom] = useState("Dave Harris Plumbing & Heating");

  useEffect(() => {
    let found: Invoice | null = null;
    try {
      found = ((JSON.parse(localStorage.getItem(KEY) ?? "[]") as Invoice[]) || []).find((i) => i.id === id) ?? null;
    } catch {
      found = null;
    }
    let biz = "";
    try {
      biz = (JSON.parse(localStorage.getItem("sorted.settings.v1") ?? "{}") as { businessName?: string }).businessName ?? "";
    } catch {
      /* default */
    }
    const t = setTimeout(() => {
      setInv(found);
      if (biz) setFrom(biz);
    }, 0);
    return () => clearTimeout(t);
  }, [id]);

  function pay(method: "paypal" | "payin3") {
    if (!inv) return;
    const updated: Invoice = { ...inv, status: "PAID", amountPaid: inv.total, paidDate: todayISO() };
    try {
      const all = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Invoice[];
      localStorage.setItem(KEY, JSON.stringify(all.map((i) => (i.id === inv.id ? updated : i))));
    } catch {
      /* ignore */
    }
    const ev = eventFromInvoice(updated, "paid", "demo");
    try {
      const ch = new BroadcastChannel("sorted-pay");
      ch.postMessage(ev);
      ch.close();
    } catch {
      /* old browser */
    }
    setInv(updated);
    setPaid(true);
    void method;
  }

  return (
    <div className="min-h-screen bg-[#f5f7fa] px-4 py-8">
      <div className="mx-auto max-w-md">
        <div className="mb-3 rounded-full bg-warn-soft px-3 py-1 text-center text-[11px] font-semibold text-warn">
          Demo · Sorted&apos;s mock of the PayPal invoice page. No money moves.
        </div>
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 bg-pp px-5 py-3 text-white">
            <PayPalMark className="text-white" /> <span className="font-bold">Invoice</span>
          </div>
          {inv === undefined ? (
            <p className="p-6 text-sm text-muted">Loading…</p>
          ) : inv === null ? (
            <div className="space-y-2 p-6 text-sm text-ink-2">
              <p className="font-semibold text-ink">This demo invoice lives in another browser.</p>
              <p>Sorted&apos;s demo keeps its sample ledger on the device that opened it. On a real invoice this link opens PayPal&apos;s own payment page, where the customer pays by card, PayPal or, if eligible, Pay in 3.</p>
            </div>
          ) : (
            <div className="space-y-4 p-5">
              <div>
                <div className="text-xs text-muted">From</div>
                <div className="font-semibold">{from}</div>
                <div className="mt-2 text-xs text-muted">
                  {inv.number} · issued {ukDate(inv.issueDate)} · due {ukDate(inv.dueDate)}
                </div>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {inv.items.map((li) => (
                    <tr key={li.id} className="border-b border-line/70">
                      <td className="py-1.5">{li.description}</td>
                      <td className="py-1.5 text-right tabular-nums">{gbp(li.quantity * li.unitAmount)}</td>
                    </tr>
                  ))}
                  {inv.vatEnabled && (
                    <tr>
                      <td className="py-1 text-muted">VAT {inv.vatRate}%</td>
                      <td className="py-1 text-right text-muted tabular-nums">{gbp(inv.vat)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{paid || !isOpen(inv) ? "Paid" : "Amount due"}</span>
                <span className="text-2xl font-extrabold tabular-nums">{gbp(paid || !isOpen(inv) ? inv.total : balance(inv))}</span>
              </div>
              {paid || !isOpen(inv) ? (
                <div className="rounded-xl bg-brand-soft p-3 text-center text-sm font-semibold text-brand">
                  ✓ {paid ? "Payment sent. You can close this tab: the trader's Sorted dashboard has been told." : "This invoice is no longer open."}
                </div>
              ) : (
                <div className="space-y-2">
                  <button type="button" className="btn w-full justify-center rounded-full bg-[#ffc439] py-3 font-bold text-[#003087] hover:brightness-95" onClick={() => pay("paypal")}>
                    Pay with PayPal
                  </button>
                  <button type="button" className="btn w-full justify-center rounded-full bg-ink py-3 font-semibold text-white hover:opacity-90" onClick={() => pay("paypal")}>
                    Debit or credit card
                  </button>
                  {payLaterEligible(inv) && (
                    <button type="button" className="btn w-full justify-center rounded-full border border-pp py-2.5 text-sm font-semibold text-pp" onClick={() => pay("payin3")}>
                      Pay in 3 interest-free payments of {gbp(Math.ceil((balance(inv) / 3) * 100) / 100)}
                    </button>
                  )}
                  {payLaterEligible(inv) && <p className="text-center text-[10px] text-muted">Pay in 3 shown as PayPal would for an eligible UK customer (subject to status). Simulated here.</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
