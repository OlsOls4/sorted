"use client";

import { useEffect } from "react";
import type { DisplayStatus } from "@/lib/format";
import type { EngineInfo, ReminderStage } from "@/lib/types";

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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl ${wide ? "sm:max-w-3xl" : "sm:max-w-xl"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white/95 px-5 py-4 backdrop-blur">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className="rounded-lg p-1.5 text-muted hover:bg-paper" onClick={onClose} aria-label="Close">
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
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_STYLE[status]}`}>
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
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STAGE_STYLE[stage]}`}>{STAGE_TEXT[stage]}</span>;
}

export function EngineBadge({ engine, compact = false }: { engine?: EngineInfo | null; compact?: boolean }) {
  if (!engine) return null;
  return (
    <span
      title={engine.ai ? `Answered by ${engine.label}` : "No AI key configured or AI unavailable — deterministic rules engine answered"}
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
export function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1 text-sm leading-relaxed">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1.5" />;
        const isBullet = /^\s*(?:[•\-*]|\d+\.)\s+/.test(line);
        const content = line.replace(/^\s*(?:[•\-*])\s+/, "");
        const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <strong key={j} className="font-semibold text-ink">
              {p.slice(2, -2)}
            </strong>
          ) : (
            <span key={j}>{p}</span>
          ),
        );
        return isBullet ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="text-brand">•</span>
            <span>{parts}</span>
          </div>
        ) : (
          <p key={i}>{parts}</p>
        );
      })}
    </div>
  );
}
