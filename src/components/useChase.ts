"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, storage, type PayPalCreds } from "@/lib/client";
import type { EngineInfo, Invoice, InvoiceDraft, Mode, Settings } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";

export interface Status {
  liveAvailable: boolean;
  serverCredentials: boolean;
  credSource: "browser" | "server" | null;
  paypalEnv: "sandbox" | "live" | null;
  engine: EngineInfo;
  agentToolkit: string;
}

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

export function useChase() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setModeState] = useState<Mode>("demo");
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 8000 : 4500);
  }, []);

  const loadLedger = useCallback(
    async (m: Mode, s: Settings) => {
      if (m === "demo") {
        setInvoices(storage.loadDemoLedger(s.hourlyRate));
        return;
      }
      setSyncing(true);
      try {
        const res = await api<{ invoices: Invoice[] }>("/api/invoices", "live");
        const rem = storage.loadLiveReminders();
        setInvoices(res.invoices.map((i) => ({ ...i, reminders: rem[i.id] ?? i.reminders })));
      } catch (e) {
        toast("err", `Couldn't sync with PayPal: ${(e as Error).message}`);
      } finally {
        setSyncing(false);
      }
    },
    [toast],
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
    async (inv: Invoice, subject: string, body: string) => {
      const res = await api<{ invoice: Invoice; via: string }>(`/api/invoices/${encodeURIComponent(inv.id)}/remind`, mode, {
        invoice: inv,
        subject,
        body,
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
  };
}

export type ChaseApi = ReturnType<typeof useChase>;
export { ApiError };
