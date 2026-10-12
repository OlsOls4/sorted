import "server-only";
import { DEFAULT_SETTINGS, type Invoice, type Settings } from "./types";

export function sanitizeSettings(s: unknown): Settings {
  const o = (s && typeof s === "object" ? s : {}) as Partial<Settings>;
  const num = (v: unknown, d: number, min = 0, max = 100000) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : d;
  };
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : d);
  return {
    businessName: str(o.businessName, DEFAULT_SETTINGS.businessName),
    traderName: str(o.traderName, DEFAULT_SETTINGS.traderName),
    traderEmail: str(o.traderEmail, DEFAULT_SETTINGS.traderEmail),
    hourlyRate: num(o.hourlyRate, DEFAULT_SETTINGS.hourlyRate, 0, 10000),
    vatRegistered: typeof o.vatRegistered === "boolean" ? o.vatRegistered : DEFAULT_SETTINGS.vatRegistered,
    vatRate: num(o.vatRate, DEFAULT_SETTINGS.vatRate, 0, 100),
    paymentTermsDays: Math.round(num(o.paymentTermsDays, DEFAULT_SETTINGS.paymentTermsDays, 0, 365)),
    calloutFee: num(o.calloutFee, DEFAULT_SETTINGS.calloutFee, 0, 10000),
    bankRate: num(o.bankRate, DEFAULT_SETTINGS.bankRate, 0, 25),
  };
}

export function asLedger(v: unknown): Invoice[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((i): i is Invoice => !!i && typeof i === "object" && typeof (i as Invoice).id === "string" && typeof (i as Invoice).total === "number")
    .map((i) => ({ ...i, reminders: Array.isArray(i.reminders) ? i.reminders : [], items: Array.isArray(i.items) ? i.items : [] }))
    .slice(0, 2000);
}

export async function readJSON(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
