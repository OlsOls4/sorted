"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { EngineInfo, InvoiceDraft, Mode, Settings } from "@/lib/types";
import { Spinner } from "./ui";

// Short chip labels; clicking one fills the textarea with the full, realistic note.
const EXAMPLES = [
  {
    label: "Stopcock · VAT on top",
    note: "fixed leaking stopcock for mrs okafor at 12 cotham hill, 2.5 hrs plus new valve 18 quid, call out 45, she pays in 14 days, vat on top, email ngozi.okafor@example.com",
  },
  { label: "2 radiators · parts", note: "fitted 2 radiators for Mrs Patel, 4 hrs, parts £86, she's at patel.r@example.com" },
  {
    label: "Business · day rate",
    note: "rewired kitchen for Harbourside Lettings Ltd 2 days @ £220/day, materials £340.50, accounts@harbourside-lettings.example due in 30 days",
  },
];

// Minimal typing for the Web Speech API (not in TS DOM lib everywhere).
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

export function JobNotes({
  mode,
  settings,
  onDraft,
  onError,
}: {
  mode: Mode;
  settings: Settings;
  onDraft: (d: InvoiceDraft, engine: EngineInfo, aiError?: string) => void;
  onError: (msg: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechOK, setSpeechOK] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);
  const baseRef = useRef("");
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-GB";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setNotes((baseRef.current ? baseRef.current + " " : "") + text.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e) => {
      setListening(false);
      if (e.error !== "aborted" && e.error !== "no-speech") onError(`Voice input error: ${e.error}`);
    };
    recRef.current = rec;
    const id = requestAnimationFrame(() => setSpeechOK(true));
    return () => {
      cancelAnimationFrame(id);
      rec.onresult = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    };
  }, [onError]);

  const toggleMic = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (listening) {
      rec.stop();
      setListening(false);
    } else {
      baseRef.current = notes.trim();
      try {
        rec.start();
        setListening(true);
      } catch {
        /* already started */
      }
    }
  }, [listening, notes]);

  const submit = useCallback(async () => {
    if (!notes.trim() || busy) return;
    if (listening) recRef.current?.stop();
    setBusy(true);
    try {
      const res = await api<{ draft: InvoiceDraft; engine: EngineInfo; aiError?: string }>("/api/parse", mode, { notes, settings });
      onDraft(res.draft, res.engine, res.aiError);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [notes, busy, listening, mode, settings, onDraft, onError]);

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="newjob">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 id="newjob" className="text-base font-bold">
            Just finished a job?
          </h2>
          <p className="text-sm text-muted">Type or say what you did, the way you&apos;d jot it down. Sorted writes the invoice.</p>
        </div>
      </div>
      <div className="relative">
        <textarea
          ref={textRef}
          className="input min-h-[112px] resize-y pr-14 text-[15px] leading-relaxed"
          placeholder="e.g. fixed leaking stopcock for mrs okafor, 2.5 hrs, new valve 18 quid, call out 45, vat on top, ngozi.okafor@example.com"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          aria-label="Job notes"
        />
        {speechOK && (
          <button
            type="button"
            onClick={toggleMic}
            className={`absolute top-2.5 right-2.5 flex h-10 w-10 items-center justify-center rounded-full transition ${
              listening ? "mic-live bg-bad text-white" : "bg-paper text-ink hover:bg-line"
            }`}
            aria-label={listening ? "Stop dictation" : "Dictate job notes"}
            title={listening ? "Stop" : "Dictate (en-GB)"}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
        )}
      </div>
      {listening && <p className="mt-1.5 text-xs font-medium text-bad">Listening… speak naturally, tap the mic to stop.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" onClick={submit} disabled={busy || !notes.trim()} title="Ctrl/⌘ + Enter">
          {busy ? <Spinner /> : <span aria-hidden>✦</span>}
          {busy ? "Reading your notes…" : "Draft invoice"}
        </button>
        <span className="text-xs text-muted">or try:</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            type="button"
            className="rounded-full border border-line bg-paper px-3 py-1 text-xs whitespace-nowrap text-ink-2 transition hover:border-brand hover:text-brand"
            onClick={() => {
              setNotes(ex.note);
              textRef.current?.focus();
            }}
            title={ex.note}
            aria-label={`Try example: ${ex.note}`}
          >
            {ex.label}
          </button>
        ))}
      </div>
    </section>
  );
}
