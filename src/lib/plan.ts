// Payment plans: split what's still owed on an invoice into 2–4 instalments.
// Pure and dependency-free (shared by the client, the server and the PayPal mapping).
// PayPal side: the invoice is updated to allow partial payments with
// minimum_amount_due = the instalment amount, so the customer can pay each one
// from the same PayPal link.

export type PlanCadence = "weekly" | "monthly";

export interface Instalment {
  n: number; // 1-based
  dueDate: string; // YYYY-MM-DD
  amount: number; // GBP, 2dp
}

export interface PaymentPlan {
  count: number;
  cadence: PlanCadence;
  startDate: string; // first instalment due date
  planTotal: number; // the balance the plan covers
  alreadyPaid: number; // amountPaid on the invoice when the plan was agreed
  minimumAmountDue: number; // what PayPal accepts as the smallest payment
  instalments: Instalment[];
}

export const PLAN_COUNTS = [2, 3, 4] as const;

const p2 = (n: number) => String(n).padStart(2, "0");
const isISO = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function addDaysISO(iso: string, days: number): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days, 12));
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** Same day-of-month `months` later, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsISO(iso: string, months: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + months;
  const day = Number(iso.slice(8, 10));
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${p2(tm + 1)}-${p2(Math.min(day, last))}`;
}

/**
 * Splits `total` into `n` instalments, pence-exact: every instalment is the same
 * whole-pence amount except the last, which absorbs the rounding (so it is never
 * less than the others). The first instalment is due on `start`.
 */
export function planInstalments(total: number, n: number, cadence: PlanCadence, start: string): Instalment[] {
  if (!Number.isInteger(n) || n < 2 || n > 4) throw new Error("A payment plan has 2, 3 or 4 instalments.");
  if (cadence !== "weekly" && cadence !== "monthly") throw new Error("Instalments are weekly or monthly.");
  if (!isISO(start)) throw new Error("Start date must be YYYY-MM-DD.");
  const pence = Math.round(total * 100);
  if (!Number.isFinite(pence) || pence < n) throw new Error("There isn't enough left to pay to split into instalments.");
  const base = Math.floor(pence / n);
  const out: Instalment[] = [];
  for (let i = 0; i < n; i++) {
    const p = i === n - 1 ? pence - base * (n - 1) : base;
    out.push({ n: i + 1, dueDate: cadence === "weekly" ? addDaysISO(start, 7 * i) : addMonthsISO(start, i), amount: p / 100 });
  }
  return out;
}

/** Builds the full plan for an invoice's outstanding balance. */
export function buildPlan(balanceOwed: number, alreadyPaid: number, n: number, cadence: PlanCadence, start: string): PaymentPlan {
  const instalments = planInstalments(balanceOwed, n, cadence, start);
  return {
    count: n,
    cadence,
    startDate: start,
    planTotal: Math.round(balanceOwed * 100) / 100,
    alreadyPaid: Math.round(alreadyPaid * 100) / 100,
    minimumAmountDue: instalments[0].amount,
    instalments,
  };
}

/** Where a plan stands: paid against the plan so far, what should have been paid by today, and the next instalment. */
export function planProgress(plan: PaymentPlan, amountPaid: number, today: string) {
  const toPence = (x: number) => Math.round(x * 100);
  const paidOnPlan = Math.max(0, toPence(amountPaid) - toPence(plan.alreadyPaid));
  let dueByToday = 0;
  let cumulative = 0;
  let next: Instalment | undefined;
  let instalmentsPaid = 0;
  for (const i of plan.instalments) {
    cumulative += toPence(i.amount);
    if (i.dueDate <= today) dueByToday = cumulative;
    if (paidOnPlan >= cumulative) instalmentsPaid++;
    else if (!next) next = i;
  }
  return {
    paidOnPlan: paidOnPlan / 100,
    remaining: Math.max(0, toPence(plan.planTotal) - paidOnPlan) / 100,
    dueByToday: dueByToday / 100,
    onTrack: paidOnPlan >= dueByToday,
    instalmentsPaid,
    next,
  };
}

// ---- Compact tag kept in the PayPal invoice memo, so a live sync can rebuild the plan ----

const TAG = /\s*\[Sorted plan: ([234]) (weekly|monthly) from (\d{4}-\d{2}-\d{2}) on ([0-9]+(?:\.[0-9]{1,2})?) after ([0-9]+(?:\.[0-9]{1,2})?)\]/;

export function planTag(plan: PaymentPlan): string {
  return `[Sorted plan: ${plan.count} ${plan.cadence} from ${plan.startDate} on ${plan.planTotal.toFixed(2)} after ${plan.alreadyPaid.toFixed(2)}]`;
}

export function withPlanTag(memo: string | undefined, plan: PaymentPlan, max = 500): string {
  const base = stripPlanTag(memo ?? "");
  const tag = planTag(plan);
  return `${base.slice(0, Math.max(0, max - tag.length - 1))}${base ? " " : ""}${tag}`.slice(0, max);
}

export function stripPlanTag(memo: string): string {
  return memo.replace(TAG, "").trim();
}

export function planFromMemo(memo: string | undefined): PaymentPlan | undefined {
  const m = memo?.match(TAG);
  if (!m) return undefined;
  try {
    return buildPlan(Number(m[4]), Number(m[5]), Number(m[1]), m[2] as PlanCadence, m[3]);
  } catch {
    return undefined;
  }
}

export const CADENCE_LABEL: Record<PlanCadence, string> = { weekly: "weekly", monthly: "monthly" };

const NUM_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, "2": 2, "3": 3, "4": 4 };

/** "3-month plan", "4 weekly instalments", "payment plan" -> count and cadence (defaults: 3 monthly). Undefined when no plan is asked for. */
export function planRequested(q: string): { count: number; cadence: PlanCadence } | undefined {
  const t = q.toLowerCase();
  if (!/\b(payment plan|instal?ments?|(?:month|week)(?:ly)?[- ]?plan|plan over|spread (?:it|the (?:cost|payments?|bill)|payments?)|split (?:it|the (?:bill|invoice|cost)) into)\b/.test(t)) return undefined;
  const m = t.match(/\b(two|three|four|[234])[- ]?(?:x\s*)?(?:(month|week)s?|(?:monthly|weekly)?\s*(?:instal?ments?|payments?|parts?))\b/);
  const count = m ? NUM_WORDS[m[1]] : 3;
  const cadence: PlanCadence = /\bweek(?:ly|s)?\b/.test(t) ? "weekly" : "monthly";
  return { count, cadence };
}
