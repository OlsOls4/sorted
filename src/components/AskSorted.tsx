"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { gbp } from "@/lib/format";
import type { PaymentEvent } from "@/lib/events";
import type { ChatMessage, ChatResponse, Invoice, Mode, PendingAction, Settings, ToolTraceEntry } from "@/lib/types";
import { EngineBadge, RichText, Spinner } from "./ui";

const SUGGESTIONS = ["Who owes me what?", "How much did I earn last month?", "Who's my latest payer?", "What's overdue?", "Chase my worst payer"];

type UIMsg = ChatMessage & { meta?: Pick<ChatResponse, "engine" | "toolTrace" | "pendingAction">; actionState?: "done" | "dismissed" };

const VIA_LABEL: Record<NonNullable<ToolTraceEntry["via"]>, string> = {
  "paypal-agent-toolkit": "PayPal Agent Toolkit",
  "paypal-rest": "PayPal API",
  "mock-paypal": "mock PayPal",
  ledger: "ledger",
};

export function AskSorted({
  mode,
  settings,
  invoices,
  onConfirm,
  events = [],
}: {
  mode: Mode;
  settings: Settings;
  invoices: Invoice[];
  onConfirm: (a: PendingAction) => Promise<boolean>;
  events?: PaymentEvent[];
}) {
  const [msgs, setMsgs] = useState<UIMsg[]>([
    {
      role: "assistant",
      content: "Hi, I'm the Sorted assistant. Ask me anything about who owes you, what you've earned, or tell me to chase someone. I'll always check with you before anything goes out.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Payment events (verified PayPal webhook, live sync, or the demo payer page) are reported in the chat.
  const shownEvents = useRef(0);
  useEffect(() => {
    if (events.length <= shownEvents.current) return;
    const fresh = events.slice(shownEvents.current);
    shownEvents.current = events.length;
    const src = (e: PaymentEvent) => (e.source === "paypal-webhook" ? "verified PayPal webhook" : e.source === "paypal-sync" ? "PayPal sync" : "mock PayPal");
    // Deferred so React doesn't flag a synchronous setState inside the effect.
    setTimeout(
      () =>
        setMsgs((m) => [
          ...m,
          ...fresh.map((e) => ({
            role: "assistant" as const,
            content: `${e.kind === "paid" ? "💷 **Payment in.**" : "**Invoice cancelled.**"} ${e.message} (via ${src(e)})`,
          })),
        ]),
      0,
    );
  }, [events]);

  // Scroll the conversation itself (not the page) so the newest message stays in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && msgs.length > 1) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const next: UIMsg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const res = await api<ChatResponse>("/api/chat", mode, {
        messages: next.slice(1).map(({ role, content }) => ({ role, content })),
        ledger: invoices,
        settings,
      });
      setMsgs((m) => [...m, { role: "assistant", content: res.reply, meta: { engine: res.engine, toolTrace: res.toolTrace, pendingAction: res.pendingAction } }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: `Sorry — ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(i: number, a: PendingAction) {
    const ok = await onConfirm(a);
    if (ok) setMsgs((m) => m.map((x, j) => (j === i ? { ...x, actionState: "done" } : x)));
  }

  return (
    <section className="card flex h-[560px] flex-col overflow-hidden lg:absolute lg:inset-0 lg:h-auto" aria-labelledby="ask">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 id="ask" className="text-base font-bold">
            Ask Sorted
          </h2>
          <p className="text-xs text-muted">Plain-English questions. Actions need your OK.</p>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            <div className={m.role === "user" ? "max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-sm text-white" : "max-w-[95%]"}>
              {m.role === "user" ? (
                m.content
              ) : (
                <div className="rounded-2xl rounded-bl-md bg-paper px-3.5 py-2.5 text-ink-2">
                  <RichText text={m.content} />
                  {m.meta && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line/70 pt-2">
                      <EngineBadge engine={m.meta.engine} />
                      {m.meta.toolTrace.map((t, k) => (
                        <span
                          key={k}
                          className="rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-muted ring-1 ring-line"
                          title={`${t.summary}${t.via ? ` · via ${VIA_LABEL[t.via]}` : ""}\nargs: ${JSON.stringify(t.args)}`}
                        >
                          ⚡ {t.tool}
                          {t.via && t.via !== "ledger" ? ` · ${VIA_LABEL[t.via]}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.meta?.pendingAction && <ActionCard a={m.meta.pendingAction} state={m.actionState} onConfirm={() => confirm(i, m.meta!.pendingAction!)} onDismiss={() => setMsgs((x) => x.map((y, j) => (j === i ? { ...y, actionState: "dismissed" } : y)))} />}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="text-brand" /> Sorted is checking your ledger…
          </div>
        )}
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Suggested questions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="rounded-full border border-line px-2.5 py-1 text-xs whitespace-nowrap text-ink-2 transition hover:border-brand hover:text-brand disabled:opacity-50"
              onClick={() => ask(s)}
              disabled={busy}
            >
              {s}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Who owes me what?" aria-label="Ask Sorted" />
          <button className="btn-primary px-3" disabled={busy || !input.trim()} aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </form>
      </div>
    </section>
  );
}

function ActionCard({ a, state, onConfirm, onDismiss }: { a: PendingAction; state?: "done" | "dismissed"; onConfirm: () => void; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const title =
    a.type === "send_reminder" ? `Send reminder to ${a.customerName}` : a.type === "create_invoice" ? `Invoice ${a.draft.customerName || "new customer"}` : `Mark ${a.invoiceNumber} as paid (${gbp(a.amount)})`;
  return (
    <div className="mt-3 rounded-xl border border-brand/30 bg-white p-3">
      <div className="mb-1 text-xs font-bold tracking-wide text-brand uppercase">Needs your OK</div>
      <div className="text-sm font-semibold">{title}</div>
      {a.type === "send_reminder" && (
        <details className="mt-1 text-xs text-muted">
          <summary className="cursor-pointer">Preview: {a.subject}</summary>
          <pre className="mt-1 font-sans whitespace-pre-wrap">{a.body}</pre>
        </details>
      )}
      {state === "done" ? (
        <div className="mt-2 text-xs font-semibold text-brand">{a.type === "mark_paid" ? "✓ Marked as paid" : "✓ Opened for your review"}</div>
      ) : state === "dismissed" ? (
        <div className="mt-2 text-xs text-muted">Cancelled</div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            className="btn-primary px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : null}
            {a.type === "send_reminder" ? "Review & send" : a.type === "create_invoice" ? "Review invoice" : "Confirm paid"}
          </button>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onDismiss}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
