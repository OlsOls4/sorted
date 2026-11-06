"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_RULES, describeRules, mergeLog, sanitizeRules, type AutopilotLogEntry, type AutopilotRules } from "@/lib/autopilot";
import { api, storage, type AutopilotState } from "@/lib/client";
import { isoTimestamp, ukDate } from "@/lib/format";
import type { Invoice, Mode, Settings } from "@/lib/types";
import { Modal, Spinner } from "./ui";

/** How often Autopilot checks while the app is open (no server cron). */
export const AUTOPILOT_INTERVAL_MS = 3 * 60_000;

interface RunResponse {
  at: string;
  results: (AutopilotLogEntry & { invoice?: Invoice })[];
}

export function useAutopilot({
  mode,
  ready,
  invoices,
  settings,
  upsert,
  toast,
}: {
  mode: Mode;
  ready: boolean;
  invoices: Invoice[];
  settings: Settings;
  upsert: (inv: Invoice) => void;
  toast: (kind: "ok" | "err" | "info", text: string) => void;
}) {
  const [state, setState] = useState<AutopilotState>({ rules: DEFAULT_RULES });
  const [log, setLog] = useState<AutopilotLogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => {
      setState(storage.loadAutopilot());
      setLog(storage.loadAutopilotLog());
    });
  }, []);

  const invoicesRef = useRef(invoices);
  useEffect(() => {
    invoicesRef.current = invoices;
  }, [invoices]);
  const busy = useRef(false);

  // Clock for the mandate's expiry, ticked outside render (the server re-checks expiry on every run).
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(Date.now());
    requestAnimationFrame(tick);
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
  const m = state.mandate;
  const active = state.rules.enabled && !!m && m.mode === mode && Date.parse(m.expiresAt) > clock;

  const addLog = useCallback((items: AutopilotLogEntry[]) => {
    setLog((prev) => {
      const next = mergeLog(prev, items);
      storage.saveAutopilotLog(next);
      return next;
    });
  }, []);

  const save = useCallback((s: AutopilotState) => {
    storage.saveAutopilot(s);
    setState(s);
  }, []);

  const run = useCallback(
    async (manual = false) => {
      if (busy.current) return;
      const cur = storage.loadAutopilot();
      const mand = cur.mandate;
      if (!cur.rules.enabled || !mand || mand.mode !== mode || Date.parse(mand.expiresAt) <= Date.now()) {
        if (manual) toast("info", "Autopilot is off. Set your limits and sign the mandate first.");
        return;
      }
      busy.current = true;
      setRunning(true);
      try {
        const res = await api<RunResponse>("/api/autopilot/run", mode, { mandate: mand.token, ledger: invoicesRef.current, settings });
        for (const r of res.results) if (r.invoice) upsert(r.invoice);
        addLog(res.results.map((r) => ({ at: r.at, action: r.action, invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, customerName: r.customerName, stage: r.stage, reason: r.reason, via: r.via })));
        setLastRun(res.at);
        const sent = res.results.filter((r) => r.action === "send").length;
        const held = res.results.filter((r) => r.action === "hold").length;
        if (manual || sent) {
          const quiet = res.results.length === 1 && !res.results[0].invoiceId;
          toast(
            sent ? "ok" : "info",
            quiet
              ? res.results[0].reason
              : `Autopilot sent ${sent} reminder${sent === 1 ? "" : "s"}${held ? `, and held ${held} for your OK` : ""}.`,
          );
        }
      } catch (e) {
        if (manual) toast("err", (e as Error).message);
      } finally {
        busy.current = false;
        setRunning(false);
      }
    },
    [mode, settings, upsert, toast, addLog],
  );

  /** The owner's click: sign these limits into a 30-day mandate, then run straight away. */
  const sign = useCallback(
    async (rules: AutopilotRules) => {
      const r = sanitizeRules({ ...rules, enabled: true });
      const res = await api<{ token: string; expiresAt: string; rules: AutopilotRules; mode: Mode }>("/api/autopilot/mandate", mode, { rules: r });
      save({ rules: res.rules, mandate: { token: res.token, expiresAt: res.expiresAt, mode: res.mode } });
      addLog([{ at: isoTimestamp(), action: "note", reason: `Mandate signed until ${ukDate(res.expiresAt)}: ${describeRules(res.rules)}.` }]);
      toast("ok", "Autopilot is on, within the limits you signed.");
      setTimeout(() => void run(false), 0);
    },
    [mode, save, addLog, toast, run],
  );

  const turnOff = useCallback(() => {
    save({ rules: { ...state.rules, enabled: false } });
    addLog([{ at: isoTimestamp(), action: "note", reason: "Autopilot switched off. Mandate withdrawn." }]);
    toast("info", "Autopilot is off. Nothing goes out without your OK.");
  }, [state.rules, save, addLog, toast]);

  // Check every few minutes while the app is open and visible.
  useEffect(() => {
    if (!ready || !active) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void run(false);
    }, AUTOPILOT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ready, active, run]);

  return { rules: state.rules, mandate: state.mandate, active, log, running, lastRun, run, sign, turnOff };
}

export type AutopilotApi = ReturnType<typeof useAutopilot>;

const ACTION_STYLE: Record<AutopilotLogEntry["action"], { label: string; cls: string }> = {
  send: { label: "Sent", cls: "bg-brand-soft text-brand" },
  hold: { label: "Needs your OK", cls: "bg-warn-soft text-warn" },
  skip: { label: "Skipped", cls: "bg-paper text-muted" },
  note: { label: "Mandate", cls: "bg-sky-50 text-pp-2" },
};

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

function LogList({ log, limit }: { log: AutopilotLogEntry[]; limit: number }) {
  const items = [...log].reverse().slice(0, limit);
  if (!items.length) return <p className="rounded-xl bg-paper px-3 py-4 text-center text-sm text-muted">No activity yet.</p>;
  return (
    <ul className="space-y-1.5" aria-label="Autopilot activity">
      {items.map((e, i) => {
        const st = ACTION_STYLE[e.action];
        return (
          <li key={`${e.at}-${i}`} className="flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-sm">
            <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase ${st.cls}`}>{st.label}</span>
            <span className="min-w-0 flex-1">
              {e.reason}
              <span className="block text-[11px] text-muted">
                {when(e.at)}
                {e.invoiceNumber ? ` · ${e.invoiceNumber}` : ""}
                {e.via ? ` · via ${e.via === "paypal-agent-toolkit" ? "PayPal Agent Toolkit" : e.via === "mock-paypal" ? "mock PayPal" : "PayPal"}` : ""}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function AutopilotActivity({ ap, onOpen, onReview }: { ap: AutopilotApi; onOpen: () => void; onReview: (invoiceId: string) => void }) {
  const lastHold = [...ap.log].reverse().find((e) => e.action === "hold" && e.invoiceId);
  return (
    <section className="card p-4 sm:p-5" aria-labelledby="autopilot-activity">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="autopilot-activity" className="text-base font-bold">
            Autopilot activity
          </h2>
          <p className="text-xs text-muted">
            {ap.active
              ? `On: ${describeRules(ap.rules)}. Checks every few minutes while Sorted is open.`
              : "Off. Set your limits and sign a mandate to let Sorted chase on its own."}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onOpen}>
            Rules
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => (ap.active ? void ap.run(true) : onOpen())} disabled={ap.running}>
            {ap.running ? <Spinner /> : null} {ap.active ? "Autopilot run" : "Turn on"}
          </button>
        </div>
      </div>
      <LogList log={ap.log} limit={6} />
      {lastHold?.invoiceId && (
        <button type="button" className="mt-2 text-xs font-semibold text-brand underline" onClick={() => onReview(lastHold.invoiceId!)}>
          Review the held reminder for {lastHold.customerName}
        </button>
      )}
    </section>
  );
}

export function AutopilotModal({ ap, mode, onClose }: { ap: AutopilotApi; mode: Mode; onClose: () => void }) {
  const [r, setR] = useState<AutopilotRules>(ap.rules);
  const [excl, setExcl] = useState(ap.rules.excludeCustomers.join(", "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof AutopilotRules>(k: K, v: AutopilotRules[K]) => setR((p) => ({ ...p, [k]: v }));
  const rules = sanitizeRules({ ...r, enabled: true, excludeCustomers: excl.split(",") });
  return (
    <Modal open onClose={onClose} title="Autopilot" wide>
      <p className="mb-4 text-sm text-muted">
        Let Sorted chase late payers on its own, within limits you sign. Final notices always wait for your OK, and everything Autopilot does is listed below.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="ap-days">Chase invoices overdue by at least (days)</label>
          <input id="ap-days" type="number" min={1} max={365} className="input" value={r.minDaysOverdue} onChange={(e) => set("minDaysOverdue", Number(e.target.value) || 1)} />
        </div>
        <div>
          <label className="label" htmlFor="ap-cool">At most one reminder per invoice every (days)</label>
          <input id="ap-cool" type="number" min={1} max={90} className="input" value={r.cooldownDays} onChange={(e) => set("cooldownDays", Number(e.target.value) || 1)} />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Strongest tone Autopilot may send on its own</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Strongest tone">
            {(["nudge", "firm"] as const).map((t) => (
              <label key={t} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${r.maxTone === t ? "border-brand bg-brand-soft" : "border-line"}`}>
                <input type="radio" name="ap-tone" className="accent-[#0a7f5a]" checked={r.maxTone === t} onChange={() => set("maxTone", t)} />
                {t === "nudge" ? "Friendly nudge" : "Firm reminder"}
              </label>
            ))}
            <span className="flex items-center rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted">Final notice: always needs your OK</span>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="h-4 w-4 accent-[#0a7f5a]" checked={r.quietHours} onChange={(e) => set("quietHours", e.target.checked)} />
          Quiet hours: no sends at weekends, or before 8am or after 6pm (UK time)
        </label>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="ap-excl">Leave these customers alone (names or emails, comma separated)</label>
          <input id="ap-excl" className="input" placeholder="e.g. Mrs Patel, Redland Property" value={excl} onChange={(e) => setExcl(e.target.value)} />
        </div>
      </div>
      <div className="mt-4 rounded-xl bg-paper px-3 py-2 text-xs text-muted">
        <strong className="text-ink-2">Your mandate:</strong> {describeRules(rules)}. Signed by Sorted&apos;s server for 30 days in {mode} mode
        {mode === "live" ? "; on the shared PayPal sandbox it only sends to @example.com test addresses" : "; demo sends go to mock PayPal"}. Reminder text uses Sorted&apos;s standard templates.
        {ap.active && ap.mandate ? ` Current mandate runs until ${ukDate(ap.mandate.expiresAt)}.` : ""}
      </div>
      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        {ap.active ? (
          <button type="button" className="btn-ghost" onClick={() => { ap.turnOff(); onClose(); }}>
            Turn off
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await ap.sign(rules);
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : null} {ap.active ? "Sign updated mandate" : "Sign mandate and turn on"}
          </button>
        </div>
      </div>
      <h3 className="mt-6 mb-2 text-sm font-bold">Autopilot activity</h3>
      <LogList log={ap.log} limit={20} />
    </Modal>
  );
}
