"use client";

import { balance, daysOverdue, gbp } from "@/lib/format";
import { overdueInvoices, suggestStage } from "@/lib/ledger";
import type { Invoice } from "@/lib/types";
import { StageBadge } from "./ui";

export function OverduePanel({ invoices, onChase }: { invoices: Invoice[]; onChase: (inv: Invoice) => void }) {
  const overdue = overdueInvoices(invoices);
  const total = overdue.reduce((s, i) => s + balance(i), 0);
  return (
    <section className="card p-4 sm:p-5" aria-labelledby="late">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div>
          <h2 id="late" className="text-base font-bold">
            Late payers
          </h2>
          <p className="text-xs text-muted">Most overdue first, with the tone Sorted suggests next.</p>
        </div>
        {overdue.length > 0 && <span className="shrink-0 text-sm font-bold whitespace-nowrap text-bad">{gbp(total)} overdue</span>}
      </div>
      {overdue.length === 0 ? (
        <p className="rounded-xl bg-brand-soft px-3 py-4 text-center text-sm text-brand">Nobody&apos;s late. Lovely.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {overdue.slice(0, 6).map((inv) => {
            const od = daysOverdue(inv);
            const stage = suggestStage(inv);
            return (
              <li key={inv.id} className="flex items-center gap-3 rounded-xl border border-line p-3">
                <div className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl text-white ${od >= 30 ? "bg-bad" : od >= 14 ? "bg-[#c2410c]" : "bg-[#b45309]"}`} aria-label={`${od} days overdue`}>
                  <span className="text-sm leading-none font-extrabold">{od}</span>
                  <span className="text-[9px] leading-none uppercase">{od === 1 ? "day" : "days"}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{inv.customerName}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    <span className="font-semibold text-ink">{gbp(balance(inv))}</span>
                    <span>·</span>
                    <span>{inv.reminders.length ? `${inv.reminders.length} sent` : "not chased"}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StageBadge stage={stage} />
                  <button type="button" className="text-xs font-semibold whitespace-nowrap text-brand hover:underline" onClick={() => onChase(inv)} aria-label={`Draft a reminder for ${inv.customerName}`}>
                    Draft reminder →
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {overdue.length > 6 && <p className="mt-2 text-xs text-muted">+{overdue.length - 6} more in the ledger below. Filter by Overdue to see them all.</p>}
    </section>
  );
}
