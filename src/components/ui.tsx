"use client";

import { useEffect, useRef } from "react";
import type { DisplayStatus } from "@/lib/format";
import type { EngineInfo, ReminderStage } from "@/lib/types";
import { parseMarkdown, type Inline } from "@/lib/markdown";

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      // Keep Tab focus inside the dialog.
      if (e.key === "Tab" && dialogRef.current) {
        const f = dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus into the dialog: first empty field if any, else the dialog itself.
    const t = setTimeout(() => {
      const el = dialogRef.current;
      if (!el) return;
      const empty = [...el.querySelectorAll<HTMLInputElement>("input:not([type=checkbox]):not([disabled])")].find((i) => !i.value);
      (empty ?? el).focus({ preventScroll: true });
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      opener?.focus?.({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      // Only close when the press started and ended on the backdrop, so selecting text in a field and
      // releasing outside the dialog doesn't throw away an edited draft.
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white shadow-2xl outline-none sm:rounded-3xl ${wide ? "sm:max-w-3xl" : "sm:max-w-xl"}`}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white/95 px-5 py-4 backdrop-blur">
          <h2 className="text-lg font-bold">{title}</h2>
          <button type="button" className="rounded-lg p-1.5 text-muted hover:bg-paper hover:text-ink" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<DisplayStatus, string> = {
  Paid: "bg-brand-soft text-brand ring-brand/20",
  Sent: "bg-sky-50 text-sky-700 ring-sky-600/20",
  "Due soon": "bg-warn-soft text-warn ring-warn/20",
  Overdue: "bg-bad-soft text-bad ring-bad/20",
  "Part paid": "bg-violet-50 text-violet-700 ring-violet-600/20",
  Draft: "bg-slate-100 text-slate-600 ring-slate-500/20",
  Cancelled: "bg-slate-100 text-slate-500 ring-slate-500/20 line-through",
  Refunded: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

export function StatusBadge({ status }: { status: DisplayStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ring-1 ring-inset ${STATUS_STYLE[status]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

const STAGE_STYLE: Record<ReminderStage, string> = {
  nudge: "bg-sky-50 text-sky-700",
  firm: "bg-warn-soft text-warn",
  final: "bg-bad-soft text-bad",
};
const STAGE_TEXT: Record<ReminderStage, string> = { nudge: "Friendly nudge", firm: "Firm reminder", final: "Final notice" };

export function StageBadge({ stage }: { stage: ReminderStage }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${STAGE_STYLE[stage]}`}>{STAGE_TEXT[stage]}</span>;
}

export function EngineBadge({ engine, compact = false }: { engine?: EngineInfo | null; compact?: boolean }) {
  if (!engine) return null;
  return (
    <span
      title={engine.ai ? `Answered by ${engine.label}` : `${engine.label}: deterministic rules answered`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        engine.ai ? "bg-violet-50 text-violet-700" : "bg-slate-100 text-slate-600"
      }`}
    >
      {engine.ai ? "✦" : "⚙"} {compact ? (engine.ai ? engine.label.split(" ")[0] : "Rules") : engine.label}
    </span>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PayPalMark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="14" height="16" viewBox="0 0 24 28" aria-hidden="true">
      <path fill="currentColor" opacity=".7" d="M20.1 6.6c.3-2-.0-3.4-1.1-4.7C17.8.6 15.6 0 12.8 0H4.6c-.6 0-1 .4-1.1 1L.1 22.4c-.1.4.3.8.7.8h5l-.3 2.2c-.1.4.2.7.6.7h4.3c.5 0 .9-.4 1-.9l.0-.2.8-5.2.1-.3c.1-.5.5-.9 1-.9h.6c4.1 0 7.4-1.7 8.3-6.5.4-2 .2-3.7-.8-4.9-.3-.4-.7-.7-1.1-.9z" />
      <path fill="currentColor" d="M20.1 6.6c-.1.4-.1.7-.2 1.1-1.1 5.6-4.8 7.5-9.6 7.5H7.9c-.6 0-1.1.4-1.2 1L5.5 24l-.4 2.2c-.1.4.2.7.6.7h4.3c.5 0 .9-.4 1-.9l.0-.2.8-5.2.1-.3c.1-.5.5-.9 1-.9h.6c4.1 0 7.4-1.7 8.3-6.5.4-2 .2-3.7-.8-4.9-.3-.4-.7-.7-1.4-.7z" />
    </svg>
  );
}

/** Tiny markdown: **bold**, bullet lines, line breaks. Safe: no HTML injection. */
function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, j) =>
        p.kind === "bold" ? (
          <strong key={j} className="font-semibold text-ink">
            {p.text}
          </strong>
        ) : p.kind === "code" ? (
          <code key={j} className="rounded bg-white px-1 font-mono text-[12px] ring-1 ring-line">
            {p.text}
          </code>
        ) : (
          <span key={j}>{p.text}</span>
        ),
      )}
    </>
  );
}

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;
// Money and counts read better right-aligned even when the model forgets the ":" in the separator.
const numeric = (parts: Inline[]) => /^[\s£$€+\-−]*[\d,.]+%?\s*(?:days?|d)?$/i.test(parts.map((p) => p.text).join(""));

/** Renders the small markdown subset from lib/markdown. Text only: raw HTML in a reply stays literal. */
export function RichText({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "gap":
            return <div key={i} className="h-1.5" />;
          case "h":
            return (
              <p key={i} className="pt-1 font-semibold text-ink">
                <Inlines parts={b.inline} />
              </p>
            );
          case "li":
            return (
              <div key={i} className="flex gap-2 pl-1">
                <span className={b.marker ? "min-w-[1.1rem] text-muted tabular-nums" : "text-brand"}>{b.marker ?? "•"}</span>
                <span className="min-w-0">
                  <Inlines parts={b.inline} />
                </span>
              </div>
            );
          case "table": {
            const right = b.align.map((a, k) => a === "right" || (a === "left" && b.rows.length > 0 && b.rows.every((r) => !r[k] || numeric(r[k]) || !r[k].some((p) => p.text.trim()))));
            return (
              <div key={i} className="my-1.5 max-w-full overflow-x-auto rounded-lg bg-white ring-1 ring-line">
                <table className="w-full border-collapse text-[12.5px] leading-snug">
                  <thead>
                    <tr className="bg-paper/60">
                      {b.header.map((h, k) => (
                        <th key={k} scope="col" className={`border-b border-line px-2.5 py-1.5 font-semibold whitespace-nowrap text-ink ${right[k] ? "text-right" : ALIGN[b.align[k]]}`}>
                          <Inlines parts={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri} className="border-b border-line/60 last:border-0">
                        {r.map((c, k) => (
                          <td key={k} className={`px-2.5 py-1.5 align-top ${right[k] ? "text-right tabular-nums whitespace-nowrap" : ALIGN[b.align[k]]}`}>
                            <Inlines parts={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          default:
            return (
              <p key={i}>
                <Inlines parts={b.inline} />
              </p>
            );
        }
      })}
    </div>
  );
}
