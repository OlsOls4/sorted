"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, storage, type PayPalCreds } from "@/lib/client";
import type { EngineInfo, Invoice, InvoiceDraft, Mode, ReminderStage, Settings } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { diffLedger, type PaymentEvent } from "@/lib/events";

export interface Status {
  liveAvailable: boolean;
  serverCredentials: boolean;
  credSource: "browser" | "server" | null;
  paypalEnv: "sandbox" | "live" | null;
  engine: EngineInfo;
  agentToolkit: string;
  liveByDefault?: boolean;
  sharedSandbox?: boolean;
}

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

export function useSorted() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setModeState] = useState<Mode>("demo");
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  // Payment events (webhook, live-sync diff, demo payer page) that Ask Sorted reports.
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const invoicesRef = useRef<Invoice[]>([]);
  useEffect(() => {
    invoicesRef.current = invoices;
  }, [invoices]);
  const seenEvents = useRef(new Set<string>());

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 8000 : 4500);
  }, []);

  /** Flip the affected rows and tell the user ("Dave Bennett paid £182, 9 days late"). */
  const reportEvents = useCallback(
    (evs: PaymentEvent[]) => {
      const fresh = evs.filter((e) => {
        const k = `${e.invoiceId}:${e.kind}`;
        if (seenEvents.current.has(k)) return false;
        seenEvents.current.add(k);
        return true;
      });
      if (!fresh.length) return;
      setInvoices((prev) =>
        prev.map((inv) => {
          const e = fresh.find((x) => x.invoiceId === inv.id);
          if (!e) return inv;
          return e.kind === "paid"
            ? { ...inv, status: inv.status === "MARKED_AS_PAID" ? inv.status : "PAID", amountPaid: inv.total, paidDate: e.paidDate ?? inv.paidDate }
            : { ...inv, status: "CANCELLED" };
        }),
      );
      setEvents((x) => [...x, ...fresh].slice(-30));
      for (const e of fresh) toast(e.kind === "paid" ? "ok" : "info", e.message);
    },
    [toast],
  );

  const loadLedger = useCallback(
    async (m: Mode, s: Settings, opts: { quiet?: boolean } = {}) => {
      if (m === "demo") {
        setInvoices(storage.loadDemoLedger(s.hourlyRate));
        return;
      }
      if (!opts.quiet) setSyncing(true);
      try {
        const res = await api<{ invoices: Invoice[] }>("/api/invoices", "live");
        const rem = storage.loadLiveReminders();
        const next = res.invoices.map((i) => ({ ...i, reminders: rem[i.id] ?? i.reminders }));
        // Anything that turned Paid/Cancelled in PayPal since the last sync (even if a webhook was missed).
        const before = invoicesRef.current.filter((i) => i.source === "paypal");
        const changes = before.length ? diffLedger(before, next) : [];
        setInvoices(next);
        if (changes.length) reportEvents(changes);
      } catch (e) {
        if (!opts.quiet) toast("err", `Couldn't sync with PayPal: ${(e as Error).message}`);
      } finally {
        if (!opts.quiet) setSyncing(false);
      }
    },
    [toast, reportEvents],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = storage.loadSettings();
      let st: Status | null = null;
      try {
        st = await api<Status>("/api/status", "demo");
      } catch {
        st = null;
      }
      if (cancelled) return;
      const preferred = storage.loadPreferredMode();
      const m: Mode = st?.liveAvailable && preferred !== "demo" ? "live" : "demo";
      setSettingsState(s);
      setStatus(st);
      setModeState(m);
      await loadLedger(m, s);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadLedger]);

  const setMode = useCallback(
    async (m: Mode) => {
      if (m === "live" && !status?.liveAvailable) {
        toast("info", "Connect a PayPal sandbox app first (Client ID + Secret). Staying in demo mode.");
        return;
      }
      storage.savePreferredMode(m);
      setModeState(m);
      await loadLedger(m, settings);
    },
    [status, settings, loadLedger, toast],
  );

  const setSettings = useCallback((s: Settings) => {
    storage.saveSettings(s);
    setSettingsState(s);
  }, []);

  const upsert = useCallback(
    (inv: Invoice) => {
      setInvoices((prev) => {
        const exists = prev.some((p) => p.id === inv.id);
        const next = exists ? prev.map((p) => (p.id === inv.id ? inv : p)) : [inv, ...prev];
        if (mode === "demo") storage.saveDemoLedger(next);
        else {
          const rem = storage.loadLiveReminders();
          rem[inv.id] = inv.reminders;
          storage.saveLiveReminders(rem);
        }
        return next;
      });
    },
    [mode],
  );

  const createInvoice = useCallback(
    async (draft: InvoiceDraft) => {
      const res = await api<{ invoice: Invoice; via: string }>("/api/invoices", mode, { draft, settings, ledger: invoices });
      upsert(res.invoice);
      toast("ok", `Invoice ${res.invoice.number} sent to ${res.invoice.customerEmail} via ${mode === "demo" ? "mock PayPal" : "PayPal"}.`);
      return res.invoice;
    },
    [mode, settings, invoices, upsert, toast],
  );

  const sendReminder = useCallback(
    async (inv: Invoice, subject: string, body: string, stage?: ReminderStage) => {
      const res = await api<{ invoice: Invoice; via: string }>(`/api/invoices/${encodeURIComponent(inv.id)}/remind`, mode, {
        invoice: inv,
        subject,
        body,
        stage,
      });
      upsert(res.invoice);
      toast("ok", `Reminder sent to ${inv.customerName} via ${res.via === "paypal-agent-toolkit" ? "PayPal Agent Toolkit" : res.via === "mock-paypal" ? "mock PayPal" : "PayPal"}.`);
      return res.invoice;
    },
    [mode, upsert, toast],
  );

  const markPaid = useCallback(
    async (inv: Invoice) => {
      const res = await api<{ invoice: Invoice }>(`/api/invoices/${encodeURIComponent(inv.id)}/mark-paid`, mode, { invoice: inv });
      upsert(res.invoice);
      toast("ok", `${inv.number} marked as paid.`);
      return res.invoice;
    },
    [mode, upsert, toast],
  );

  /** Verify pasted sandbox creds, store them in this browser, and switch to live. */
  const connectPayPal = useCallback(
    async (creds: PayPalCreds) => {
      const res = await api<{ ok: boolean; invoiceCount: number }>("/api/paypal/verify", "live", {}, "POST", creds);
      storage.savePayPalCreds(creds);
      const st = await api<Status>("/api/status", "live");
      setStatus(st);
      storage.savePreferredMode("live");
      setModeState("live");
      await loadLedger("live", settings);
      toast("ok", `Connected to PayPal sandbox (${res.invoiceCount} existing invoice${res.invoiceCount === 1 ? "" : "s"}).`);
    },
    [loadLedger, settings, toast],
  );

  const disconnectPayPal = useCallback(async () => {
    storage.clearPayPalCreds();
    let st: Status | null = null;
    try {
      st = await api<Status>("/api/status", "demo");
    } catch {
      st = null;
    }
    setStatus(st);
    const m: Mode = st?.liveAvailable ? mode : "demo";
    setModeState(m);
    await loadLedger(m, settings);
    toast("info", st?.liveAvailable ? "Removed your sandbox keys — using the server's PayPal connection." : "Disconnected. Back to demo mode.");
  }, [loadLedger, mode, settings, toast]);

  const resetDemo = useCallback(() => {
    setInvoices(storage.resetDemoLedger(settings.hourlyRate));
    toast("info", "Demo data reset.");
  }, [settings.hourlyRate, toast]);

  const refresh = useCallback(() => loadLedger(mode, settings), [loadLedger, mode, settings]);

  // Live mode: pick up verified webhook events quickly, and re-sync the ledger every
  // minute while the tab is visible so a payment made on PayPal shows up on its own.
  const eventSeq = useRef(0);
  useEffect(() => {
    if (mode !== "live" || !ready) return;
    let n = 0;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      n++;
      if (status?.sharedSandbox) {
        try {
          const r = await api<{ events: PaymentEvent[]; seq: number }>(`/api/paypal/events?since=${eventSeq.current}`, "live");
          eventSeq.current = r.seq;
          if (r.events.length) reportEvents(r.events);
        } catch {
          /* best effort */
        }
      }
      if (n % 3 === 0) await loadLedger("live", settings, { quiet: true });
    };
    const id = setInterval(() => void tick(), 20_000);
    return () => clearInterval(id);
  }, [mode, ready, status?.sharedSandbox, settings, loadLedger, reportEvents]);

  return {
    ready,
    status,
    mode,
    setMode,
    settings,
    setSettings,
    invoices,
    syncing,
    refresh,
    createInvoice,
    sendReminder,
    markPaid,
    resetDemo,
    connectPayPal,
    disconnectPayPal,
    hasBrowserCreds: status?.credSource === "browser",
    toasts,
    toast,
    events,
    reportEvents,
  };
}

export type SortedApi = ReturnType<typeof useSorted>;
export { ApiError };
