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
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="late" className="text-base font-bold">
          Late payers
        </h2>
        {overdue.length > 0 && <span className="text-sm font-bold text-bad">{gbp(total)} overdue</span>}
      </div>
      {overdue.length === 0 ? (
        <p className="rounded-xl bg-brand-soft px-3 py-4 text-center text-sm text-brand">Nobody&apos;s late. Lovely.</p>
      ) : (
        <ul className="space-y-2">
          {overdue.slice(0, 6).map((inv) => {
            const od = daysOverdue(inv);
            const stage = suggestStage(inv);
            return (
              <li key={inv.id} className="flex items-center gap-3 rounded-xl border border-line p-3">
                <div className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl text-white ${od >= 30 ? "bg-bad" : od >= 14 ? "bg-[#dc6803]" : "bg-[#f79009]"}`}>
                  <span className="text-sm leading-none font-extrabold">{od}</span>
                  <span className="text-[9px] leading-none uppercase">days</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{inv.customerName}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    <span className="font-semibold text-ink">{gbp(balance(inv))}</span>
                    <span>·</span>
                    <span>{inv.reminders.length ? `${inv.reminders.length} sent` : "not chased"}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StageBadge stage={stage} />
                  <button className="text-xs font-semibold text-brand hover:underline" onClick={() => onChase(inv)}>
                    Draft reminder →
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
