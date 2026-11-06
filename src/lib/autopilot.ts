// Autopilot: chasing that runs on its own, inside limits the owner signs.
//
// planAutopilot() is pure and shared by the browser (preview) and the server
// (/api/autopilot/run re-plans from the signed mandate before anything is sent).
// It never escalates past the owner's tone cap, and a final notice always waits
// for a manual OK.

import { balance, daysOverdue, isOpen, todayISO } from "./format";
import { STAGE_LABEL, stageRank, suggestStage } from "./ledger";
import type { Invoice, ReminderStage } from "./types";

export type AutoTone = "nudge" | "firm";

export interface AutopilotRules {
  enabled: boolean;
  /** Chase invoices at least this many days overdue. */
  minDaysOverdue: number;
  /** Strongest tone Autopilot may send by itself. Final notice is never automatic. */
  maxTone: AutoTone;
  /** At most one reminder per invoice per this many days. */
  cooldownDays: number;
  /** No sends at weekends, before 8am or from 6pm (UK time). */
  quietHours: boolean;
  /** Customer names or emails Autopilot leaves alone. */
  excludeCustomers: string[];
}

export const DEFAULT_RULES: AutopilotRules = {
  enabled: false,
  minDaysOverdue: 7,
  maxTone: "nudge",
  cooldownDays: 7,
  quietHours: true,
  excludeCustomers: [],
};

/** Most reminders a single run will send (keeps a run small and reviewable). */
export const MAX_SENDS_PER_RUN = 5;
export const MANDATE_DAYS = 30;

const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function sanitizeRules(v: unknown): AutopilotRules {
  const r = (v && typeof v === "object" ? v : {}) as Partial<AutopilotRules>;
  return {
    enabled: r.enabled === true,
    minDaysOverdue: clampInt(r.minDaysOverdue, 1, 365, DEFAULT_RULES.minDaysOverdue),
    // Anything other than "firm" (including "final") is clamped to a nudge.
    maxTone: r.maxTone === "firm" ? "firm" : "nudge",
    cooldownDays: clampInt(r.cooldownDays, 1, 90, DEFAULT_RULES.cooldownDays),
    quietHours: r.quietHours !== false,
    excludeCustomers: (Array.isArray(r.excludeCustomers) ? r.excludeCustomers : [])
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 50),
  };
}

/** Weekday (0 = Sunday) and hour in Europe/London. */
export function ukClock(now: Date): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd), hour };
}

export function inQuietHours(now: Date): boolean {
  const { weekday, hour } = ukClock(now);
  return weekday === 0 || weekday === 6 || hour < 8 || hour >= 18;
}

export function isExcluded(inv: Invoice, rules: AutopilotRules): boolean {
  const name = inv.customerName.toLowerCase();
  const email = inv.customerEmail.toLowerCase();
  return rules.excludeCustomers.some((x) => {
    const q = x.toLowerCase();
    return q.length > 1 && (name.includes(q) || email === q);
  });
}

export interface AutopilotItem {
  action: "send" | "hold" | "skip";
  invoiceId?: string;
  invoiceNumber?: string;
  customerName?: string;
  stage?: ReminderStage;
  daysOverdue?: number;
  reason: string;
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const tone = (s: ReminderStage) => STAGE_LABEL[s].toLowerCase();

/**
 * What Autopilot would do right now. Returns one item per overdue, open invoice
 * (send, hold for the owner's OK, or skip with the reason), or a single skip
 * when Autopilot is off or it is quiet hours. Paid, cancelled and not-yet-due
 * invoices never appear.
 */
export function planAutopilot(ledger: Invoice[], rulesIn: AutopilotRules, now: Date = new Date()): AutopilotItem[] {
  const rules = sanitizeRules(rulesIn);
  if (!rules.enabled) return [{ action: "skip", reason: "Autopilot is off." }];
  if (rules.quietHours && inQuietHours(now)) {
    return [{ action: "skip", reason: "Quiet hours (weekends, and before 8am or after 6pm UK). Nothing sent; Autopilot carries on in working hours." }];
  }
  const today = todayISO(now);
  const due = ledger
    .filter((i) => isOpen(i) && balance(i) > 0 && daysOverdue(i, today) > 0)
    .sort((a, b) => daysOverdue(b, today) - daysOverdue(a, today));
  const out: AutopilotItem[] = [];
  let sends = 0;
  for (const inv of due) {
    const od = daysOverdue(inv, today);
    const base = { invoiceId: inv.id, invoiceNumber: inv.number, customerName: inv.customerName, daysOverdue: od };
    if (isExcluded(inv, rules)) {
      out.push({ ...base, action: "skip", reason: `Skipped ${inv.customerName}: on your list of customers Autopilot leaves alone.` });
      continue;
    }
    if (od < rules.minDaysOverdue) {
      out.push({ ...base, action: "skip", reason: `Skipped ${inv.customerName}: ${days(od)} late, and your mandate starts at ${days(rules.minDaysOverdue)}.` });
      continue;
    }
    const last = inv.reminders.reduce((t, r) => Math.max(t, Date.parse(r.sentAt) || 0), 0);
    if (last) {
      const since = Math.floor((now.getTime() - last) / 86_400_000);
      if (since < rules.cooldownDays) {
        out.push({
          ...base,
          action: "skip",
          reason: `Skipped ${inv.customerName}: last reminder ${since === 0 ? "today" : `${days(since)} ago`}; your mandate allows one every ${days(rules.cooldownDays)}.`,
        });
        continue;
      }
    }
    const stage = suggestStage(inv, today);
    if (stage === "final") {
      out.push({ ...base, stage, action: "hold", reason: `Held: a final notice to ${inv.customerName} (${days(od)} late) needs your OK.` });
      continue;
    }
    if (stageRank(stage) > stageRank(rules.maxTone)) {
      out.push({
        ...base,
        stage,
        action: "hold",
        reason: `Held: ${inv.customerName} (${days(od)} late) is due a ${tone(stage)}; your mandate allows ${rules.maxTone === "nudge" ? "friendly nudges" : "firm reminders"} only, so it needs your OK.`,
      });
      continue;
    }
    if (sends >= MAX_SENDS_PER_RUN) {
      out.push({ ...base, stage, action: "skip", reason: `Queued ${inv.customerName} for the next run (at most ${MAX_SENDS_PER_RUN} reminders per run).` });
      continue;
    }
    sends++;
    out.push({ ...base, stage, action: "send", reason: `Sent ${tone(stage)} to ${inv.customerName}, ${days(od)} late, within your mandate.` });
  }
  return out;
}

/** One line summary of the rules, for the mandate and Ask Sorted. */
export function describeRules(r: AutopilotRules): string {
  const parts = [
    `chase invoices ${days(r.minDaysOverdue)}+ overdue`,
    `up to a ${r.maxTone === "nudge" ? "friendly nudge" : "firm reminder"} on its own (final notices always need your OK)`,
    `at most one reminder per invoice every ${days(r.cooldownDays)}`,
  ];
  if (r.quietHours) parts.push("no sends at weekends or outside 8am to 6pm UK");
  if (r.excludeCustomers.length) parts.push(`leave alone: ${r.excludeCustomers.join(", ")}`);
  return parts.join("; ");
}

export interface AutopilotLogEntry {
  at: string; // ISO
  action: AutopilotItem["action"] | "note";
  invoiceId?: string;
  invoiceNumber?: string;
  customerName?: string;
  stage?: ReminderStage;
  reason: string;
  via?: string;
}

/** Append run results to the activity log, skipping repeats of an unchanged held/skipped reason. */
export function mergeLog(log: AutopilotLogEntry[], items: AutopilotLogEntry[], max = 100): AutopilotLogEntry[] {
  const next = [...log];
  for (const it of items) {
    if (it.action !== "send") {
      const prev = [...next].reverse().find((e) => (e.invoiceId ?? "") === (it.invoiceId ?? ""));
      if (prev && prev.reason === it.reason) continue;
    }
    next.push(it);
  }
  return next.slice(-max);
}
