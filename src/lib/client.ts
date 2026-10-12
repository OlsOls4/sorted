"use client";
// Browser-side API helpers + localStorage persistence.

import { seedInvoices } from "./seed";
import { DEFAULT_SETTINGS, type Invoice, type Mode, type Settings } from "./types";

const K = {
  ledger: "sorted.demo.ledger.v1",
  settings: "sorted.settings.v1",
  mode: "sorted.mode.v1",
  liveReminders: "sorted.live.reminders.v1",
  paypalCreds: "sorted.paypal.sandbox.v1",
};

export interface PayPalCreds {
  clientId: string;
  clientSecret: string;
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* quota / private mode */
  }
}

export const storage = {
  loadSettings: (): Settings => ({ ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(K.settings, {}) }),
  saveSettings: (s: Settings) => write(K.settings, s),
  loadDemoLedger: (rate: number): Invoice[] => {
    const l = read<Invoice[] | null>(K.ledger, null);
    if (l && Array.isArray(l) && l.length) return l;
    const seeded = seedInvoices(rate);
    write(K.ledger, seeded);
    return seeded;
  },
  saveDemoLedger: (l: Invoice[]) => write(K.ledger, l),
  resetDemoLedger: (rate: number) => {
    const seeded = seedInvoices(rate);
    write(K.ledger, seeded);
    return seeded;
  },
  loadPreferredMode: (): Mode | null => read<Mode | null>(K.mode, null),
  savePreferredMode: (m: Mode) => write(K.mode, m),
  loadLiveReminders: () => read<Record<string, Invoice["reminders"]>>(K.liveReminders, {}),
  saveLiveReminders: (r: Record<string, Invoice["reminders"]>) => write(K.liveReminders, r),
  loadPayPalCreds: (): PayPalCreds | null => {
    const c = read<PayPalCreds | null>(K.paypalCreds, null);
    return c && c.clientId && c.clientSecret ? c : null;
  },
  savePayPalCreds: (c: PayPalCreds) => write(K.paypalCreds, c),
  clearPayPalCreds: () => {
    try {
      window.localStorage.removeItem(K.paypalCreds);
    } catch {
      /* noop */
    }
  },
};

export class ApiError extends Error {
  debugId?: string;
  constructor(msg: string, debugId?: string) {
    super(msg);
    this.debugId = debugId;
  }
}

export async function api<T>(path: string, mode: Mode, body?: unknown, method?: "GET" | "POST", credsOverride?: PayPalCreds | null): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-sorted-mode": mode };
  // Sandbox creds pasted by the user travel per request (HTTPS) and are never stored server-side.
  const creds = credsOverride === undefined ? storage.loadPayPalCreds() : credsOverride;
  if (creds) {
    headers["x-paypal-client-id"] = creds.clientId;
    headers["x-paypal-client-secret"] = creds.clientSecret;
  }
  const res = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; paypalDebugId?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, data.paypalDebugId);
  return data;
}
