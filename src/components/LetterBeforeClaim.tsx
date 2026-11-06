"use client";

// Print-friendly Letter Before Claim. Built in the browser from the ledger this
// browser holds (demo ledger, or the last live PayPal snapshot). Nothing is sent:
// the trader prints it or saves it as a PDF and sends it themselves.
import Link from "next/link";
import { useEffect, useState } from "react";
import { buildLetterBeforeClaim, claimStatus, type LetterBeforeClaim } from "@/lib/claim";
import { storage } from "@/lib/client";
import { gbp, ukDate } from "@/lib/format";

export function LetterBeforeClaimPage({ id }: { id: string }) {
  const [state, setState] = useState<{ letter?: LetterBeforeClaim; note?: string; missing?: boolean } | null>(null);

  useEffect(() => {
    const settings = storage.loadSettings();
    const mode = storage.loadPreferredMode() ?? "demo";
    const pool = mode === "live" ? [...storage.loadLiveSnapshot(), ...storage.loadDemoLedger(settings.hourlyRate)] : [...storage.loadDemoLedger(settings.hourlyRate), ...storage.loadLiveSnapshot()];
    const inv = pool.find((i) => i.id === id || i.number === id);
    const t = setTimeout(() => {
      if (!inv) return setState({ missing: true });
      const st = claimStatus(inv, undefined, { demo: inv.source === "mock" });
      setState({ letter: buildLetterBeforeClaim(inv, settings), note: st.ready ? undefined : st.reason });
    }, 0);
    return () => clearTimeout(t);
  }, [id]);

  if (!state) return <div className="p-8 text-sm text-muted">Preparing the letter…</div>;
  if (state.missing || !state.letter)
    return (
      <div className="mx-auto max-w-xl p-8 text-sm">
        <p>That invoice isn&apos;t in the ledger on this device.</p>
        <Link className="mt-3 inline-block font-semibold text-brand underline" href="/app">
          Back to Sorted
        </Link>
      </div>
    );
  const l = state.letter;

  return (
    <div className="min-h-screen bg-[#f5f7fa] px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/app" className="text-sm font-semibold text-brand hover:underline">
          ← Back to Sorted
        </Link>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Nothing has been sent. Print or save as PDF, then send it yourself.</span>
          <button type="button" className="btn-primary" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </div>
      </div>
      {state.note && <p className="mx-auto mb-3 max-w-[210mm] rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn print:hidden">{state.note}</p>}

      <article className="mx-auto max-w-[210mm] bg-white p-10 font-serif text-[13.5px] leading-relaxed text-black shadow-sm ring-1 ring-line print:max-w-none print:p-0 print:shadow-none print:ring-0">
        <p className="mb-6 rounded border border-dashed border-gray-400 px-3 py-1.5 text-center font-sans text-[11px] text-gray-600">
          TEMPLATE: check every detail before sending. {l.footer}
        </p>
        <header className="mb-6 flex justify-between gap-6">
          <div>
            <div className="font-bold">{l.from.business}</div>
            <div>{l.from.name}</div>
            <div>{l.from.email}</div>
          </div>
          <div className="text-right">
            <div>{ukDate(l.date)}</div>
            <div>Ref: {l.reference}</div>
          </div>
        </header>
        <div className="mb-6">
          <div className="font-bold">{l.to.name}</div>
          {l.to.email && <div>{l.to.email}</div>}
        </div>
        <h1 className="mb-1 text-base font-bold tracking-wide">LETTER BEFORE CLAIM</h1>
        <p className="mb-4 font-bold">{l.subject}</p>
        <p className="mb-3">Dear Sir or Madam,</p>
        {l.paragraphs.slice(0, 2).map((p, i) => (
          <Para key={i} {...p} />
        ))}
        <table className="my-4 w-full border-collapse text-[13px]">
          <tbody>
            {l.breakdown.map((b) => (
              <tr key={b.label} className="border-b border-gray-300">
                <td className="py-1.5 pr-4">{b.label}</td>
                <td className="py-1.5 text-right tabular-nums">{gbp(b.amount)}</td>
              </tr>
            ))}
            <tr>
              <td className="py-2 font-bold">Total due at {ukDate(l.date)}</td>
              <td className="py-2 text-right font-bold tabular-nums">{gbp(l.total)}</td>
            </tr>
          </tbody>
        </table>
        {l.paragraphs.slice(2).map((p, i) => (
          <Para key={i} {...p} />
        ))}
        <p className="mt-6">Yours faithfully,</p>
        <p className="mt-8">
          {l.from.name}
          <br />
          {l.from.business}
        </p>
        <footer className="mt-10 border-t border-gray-300 pt-3 font-sans text-[11px] text-gray-600">
          <p>{l.individualNote}</p>
          <p className="mt-1 font-semibold">{l.footer}</p>
        </footer>
      </article>
    </div>
  );
}

function Para({ heading, text }: { heading?: string; text: string }) {
  return (
    <div className="mb-3">
      {heading && <h2 className="font-bold">{heading}</h2>}
      <p>{text}</p>
    </div>
  );
}
