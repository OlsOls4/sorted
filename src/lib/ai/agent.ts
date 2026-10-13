// "Ask Sorted": an agent that answers questions over the ledger and proposes
// actions (create invoice, send reminder, mark paid). Actions that send
// money-related comms are never executed here — they come back as a
// PendingAction which the user must confirm in the UI.

import "server-only";
import { addDays, balance, daysOverdue, gbp, isOpen, todayISO, ukDate } from "../format";
import { customerSummaries, earnedBetween, overdueInvoices, STAGE_LABEL, totals } from "../ledger";
import { parseJobNotes } from "../parser";
import { templateReminder } from "../reminders";
import type { ChatMessage, ChatResponse, Invoice, Mode, PendingAction, ReminderStage, Settings, ToolTraceEntry } from "../types";
import { parseNotes } from "./parse";
import { RULES_ENGINE, fallbackEngine, friendlyAIError, getLLM, type LLMMessage, type LLMRouter, type ToolSpec } from "./provider";
import { draftReminder } from "./remind";

export interface AgentContext {
  ledger: Invoice[];
  settings: Settings;
  mode: Mode;
  ledgerVia: ToolTraceEntry["via"];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// ---------------- Tools ----------------

export const TOOLS: ToolSpec[] = [
  {
    name: "get_ledger_summary",
    description: "Totals across the whole ledger: outstanding, overdue, billed and received this month, average days to get paid, plus a per-customer breakdown.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_invoices",
    description: "List invoices (from PayPal in live mode). Filter by status and/or customer name/email substring.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["all", "outstanding", "overdue", "paid"], description: "Which invoices to return" },
        customer: { type: "string", description: "Optional customer name or email to match" },
      },
    },
  },
  {
    name: "get_earnings",
    description: "Money received (by paid date) and amount billed (by issue date) between two dates inclusive. Dates are YYYY-MM-DD.",
    parameters: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "rank_payers",
    description: "Rank customers by how late they pay (average days late, current overdue). Use for 'slowest/latest/worst payer' or 'best payer' questions.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "draft_payment_reminder",
    description:
      "Draft a reminder email for an unpaid invoice with escalating tone (nudge, firm, final). Does NOT send — the user must confirm in the app. Provide invoice_id, or customer to pick their most overdue invoice.",
    parameters: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        customer: { type: "string" },
        stage: { type: "string", enum: ["nudge", "firm", "final"], description: "Omit to let Sorted choose based on lateness" },
      },
    },
  },
  {
    name: "create_invoice_draft",
    description: "Turn job notes into an invoice draft for the user to review and send via PayPal. Does NOT send.",
    parameters: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
  },
  {
    name: "propose_mark_paid",
    description: "Propose marking an invoice as paid (e.g. customer paid cash/bank transfer). Does NOT change anything until the user confirms.",
    parameters: { type: "object", properties: { invoice_id: { type: "string" }, customer: { type: "string" } } },
  },
];

function brief(inv: Invoice, today: string) {
  const od = daysOverdue(inv, today);
  return {
    id: inv.id,
    number: inv.number,
    customer: inv.customerName,
    email: inv.customerEmail,
    job: inv.jobSummary,
    total: inv.total,
    outstanding: balance(inv),
    status: inv.status,
    issued: inv.issueDate,
    due: inv.dueDate,
    paid: inv.paidDate ?? null,
    daysOverdue: isOpen(inv) && od > 0 ? od : 0,
    remindersSent: inv.reminders.length,
  };
}

function matchCustomer(inv: Invoice, q: string) {
  const s = q.toLowerCase().replace(/^(mrs|mr|ms|miss|dr)\.?\s+/, "").trim();
  if (!s) return false;
  return inv.customerName.toLowerCase().includes(s) || inv.customerEmail.toLowerCase().includes(s);
}

function findTarget(ledger: Invoice[], args: { invoice_id?: unknown; customer?: unknown }, today: string): Invoice | undefined {
  const id = typeof args.invoice_id === "string" ? args.invoice_id.trim() : "";
  if (id) {
    const hit = ledger.find((i) => i.id === id || i.number.toLowerCase() === id.toLowerCase());
    if (hit) return hit;
  }
  const cust = typeof args.customer === "string" ? args.customer : "";
  if (cust) {
    const open = ledger.filter((i) => isOpen(i) && balance(i) > 0 && matchCustomer(i, cust));
    return open.sort((a, b) => daysOverdue(b, today) - daysOverdue(a, today))[0];
  }
  return undefined;
}

interface ToolOutcome {
  result: unknown;
  trace: ToolTraceEntry;
  pending?: PendingAction;
}

async function runTool(name: string, args: Record<string, unknown>, ctx: AgentContext, useAI: boolean): Promise<ToolOutcome> {
  const today = todayISO();
  const { ledger, settings } = ctx;
  switch (name) {
    case "get_ledger_summary": {
      const t = totals(ledger, today);
      const customers = customerSummaries(ledger, today).sort((a, b) => b.outstanding - a.outstanding);
      return {
        result: { today, ...t, customers },
        trace: { tool: name, args, summary: `${ledger.length} invoices, ${gbp(t.outstanding)} outstanding`, via: "ledger" },
      };
    }
    case "list_invoices": {
      const status = String(args.status ?? "all");
      let rows = ledger.filter((i) => i.status !== "CANCELLED");
      if (status === "outstanding") rows = rows.filter((i) => balance(i) > 0);
      if (status === "overdue") rows = overdueInvoices(rows, today);
      if (status === "paid") rows = rows.filter((i) => i.status === "PAID" || i.status === "MARKED_AS_PAID");
      if (typeof args.customer === "string" && args.customer) rows = rows.filter((i) => matchCustomer(i, args.customer as string));
      return {
        result: rows.slice(0, 40).map((i) => brief(i, today)),
        trace: { tool: name, args, summary: `${rows.length} ${status} invoice${rows.length === 1 ? "" : "s"}`, via: ctx.ledgerVia },
      };
    }
    case "get_earnings": {
      const from = String(args.from ?? today.slice(0, 7) + "-01");
      const to = String(args.to ?? today);
      const e = earnedBetween(ledger, from, to);
      return { result: { from, to, ...e }, trace: { tool: name, args, summary: `${gbp(e.received)} received`, via: "ledger" } };
    }
    case "rank_payers": {
      const ranked = customerSummaries(ledger, today)
        .filter((c) => c.avgDaysLate !== undefined || c.maxDaysOverdue > 0)
        .sort((a, b) => (b.avgDaysLate ?? 0) + b.maxDaysOverdue - ((a.avgDaysLate ?? 0) + a.maxDaysOverdue));
      return { result: ranked, trace: { tool: name, args, summary: `ranked ${ranked.length} customers`, via: "ledger" } };
    }
    case "draft_payment_reminder": {
      const inv = findTarget(ledger, args, today);
      if (!inv) return { result: { error: "No matching unpaid invoice found." }, trace: { tool: name, args, summary: "no match", via: "ledger" } };
      const stage = (["nudge", "firm", "final"].includes(String(args.stage)) ? args.stage : undefined) as ReminderStage | undefined;
      const { draft } = useAI ? await draftReminder(inv, settings, stage) : { draft: templateReminder(inv, settings, stage, today) };
      const pending: PendingAction = {
        type: "send_reminder",
        invoiceId: inv.id,
        invoiceNumber: inv.number,
        customerName: inv.customerName,
        stage: draft.stage,
        subject: draft.subject,
        body: draft.body,
      };
      return {
        result: { drafted: true, awaitingUserConfirmation: true, invoice: brief(inv, today), stage: draft.stage, subject: draft.subject },
        trace: { tool: name, args, summary: `${STAGE_LABEL[draft.stage]} for ${inv.number}`, via: "ledger" },
        pending,
      };
    }
    case "create_invoice_draft": {
      const notes = String(args.notes ?? "");
      const draft = useAI ? (await parseNotes(notes, settings)).draft : parseJobNotes(notes, settings, today).draft;
      return {
        result: { drafted: true, awaitingUserConfirmation: true, customer: draft.customerName, email: draft.customerEmail, items: draft.items, warnings: draft.warnings },
        trace: { tool: name, args: { notes: notes.slice(0, 80) }, summary: `draft for ${draft.customerName || "unknown customer"}`, via: "ledger" },
        pending: { type: "create_invoice", draft },
      };
    }
    case "propose_mark_paid": {
      const inv = findTarget(ledger, args, today);
      if (!inv) return { result: { error: "No matching unpaid invoice found." }, trace: { tool: name, args, summary: "no match", via: "ledger" } };
      return {
        result: { proposed: true, awaitingUserConfirmation: true, invoice: brief(inv, today) },
        trace: { tool: name, args, summary: `mark ${inv.number} paid?`, via: "ledger" },
        pending: { type: "mark_paid", invoiceId: inv.id, invoiceNumber: inv.number, customerName: inv.customerName, amount: balance(inv) },
      };
    }
    default:
      return { result: { error: `Unknown tool ${name}` }, trace: { tool: name, args, summary: "unknown tool" } };
  }
}

// ---------------- LLM agent loop ----------------

function systemPrompt(ctx: AgentContext) {
  const today = todayISO();
  return `You are the Sorted assistant, a friendly, sharp money assistant for a UK sole trader: ${ctx.settings.traderName} of ${ctx.settings.businessName}.
Today is ${today} (Europe/London). Currency is GBP (£). Use British English. Be concise: short sentences, bullet points for lists, bold key amounts with **.
Always use tools to get numbers — never guess figures. "Latest payer" means the customer who pays latest/slowest.
For any action that sends something to a customer or changes an invoice (reminders, new invoices, marking paid) call the matching draft/propose tool; it will NOT happen until the user taps Confirm in the app, so tell them to review and confirm.
Invoices are issued and paid through PayPal${ctx.mode === "demo" ? " (currently demo mode with a mock PayPal backend)" : ""}.`;
}

export async function runAgent(messages: ChatMessage[], ctx: AgentContext): Promise<ChatResponse> {
  const llm = getLLM();
  if (llm) {
    try {
      return await runLLMAgent(messages, ctx, llm);
    } catch (e) {
      const res = await runRulesAgent(messages, ctx);
      res.engine = fallbackEngine();
      res.toolTrace.unshift({ tool: "ai_unavailable", args: {}, summary: friendlyAIError(e) });
      return res;
    }
  }
  return runRulesAgent(messages, ctx);
}

// Keeps LLM calls to a minimum: tools never make nested LLM calls (notes are
// parsed and reminders templated deterministically inside the loop), and when a
// step produces a "Needs your OK" action we answer without a second model call.
async function runLLMAgent(messages: ChatMessage[], ctx: AgentContext, llm: LLMRouter): Promise<ChatResponse> {
  const convo: LLMMessage[] = messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const trace: ToolTraceEntry[] = [];
  let pending: PendingAction | undefined;
  let engine = llm.info ?? RULES_ENGINE;
  for (let step = 0; step < 3; step++) {
    const res = await llm.chat({ system: systemPrompt(ctx), messages: convo, tools: TOOLS, maxTokens: 900 });
    engine = res.engine;
    if (!res.toolCalls.length) {
      return { reply: res.text.trim() || "Done.", engine, toolTrace: trace, pendingAction: pending };
    }
    convo.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const out = await runTool(call.name, call.args, ctx, false);
      trace.push(out.trace);
      if (out.pending) pending = out.pending;
      convo.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(out.result).slice(0, 6000) });
    }
    if (pending) {
      const lead = res.text.trim();
      const what =
        pending.type === "send_reminder"
          ? `I've drafted the ${STAGE_LABEL[pending.stage].toLowerCase()} to ${pending.customerName} (${pending.invoiceNumber}).`
          : pending.type === "create_invoice"
            ? `I've drafted an invoice for ${pending.draft.customerName || "the customer"}.`
            : `Ready to mark ${pending.invoiceNumber} (${pending.customerName}) as paid.`;
      const reply = `${lead ? `${lead}\n\n` : ""}${what} Review it below and tap Confirm when you're happy. Nothing happens until you do.`;
      return { reply, engine, toolTrace: trace, pendingAction: pending };
    }
  }
  return { reply: "I've gathered what I can — see the details above.", engine, toolTrace: trace, pendingAction: pending };
}

// ---------------- Deterministic rules agent ----------------

function monthRange(q: string, today: string): { from: string; to: string; label: string } | null {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const fmt = (yy: number, mm: number, dd: number) => `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const monthLabel = (mm: number, yy: number) => `${MONTHS[mm - 1][0].toUpperCase()}${MONTHS[mm - 1].slice(1)} ${yy}`;
  if (/\bthis month\b/.test(q)) return { from: fmt(y, m, 1), to: today, label: `${monthLabel(m, y)} so far` };
  if (/\blast month\b/.test(q)) {
    const lm = m === 1 ? 12 : m - 1;
    const ly = m === 1 ? y - 1 : y;
    return { from: fmt(ly, lm, 1), to: fmt(ly, lm, lastDay(ly, lm)), label: monthLabel(lm, ly) };
  }
  if (/\bthis year\b|\bso far\b/.test(q)) return { from: fmt(y, 1, 1), to: today, label: "this year" };
  if (/\bthis tax year\b/.test(q)) {
    const start = m > 4 || (m === 4 && Number(today.slice(8)) >= 6) ? y : y - 1;
    return { from: fmt(start, 4, 6), to: today, label: "this tax year" };
  }
  if (/\blast (?:7 days|week)\b/.test(q)) return { from: addDays(today, -7), to: today, label: "the last 7 days" };
  if (/\blast (?:30 days)\b/.test(q)) return { from: addDays(today, -30), to: today, label: "the last 30 days" };
  for (let i = 0; i < 12; i++) {
    const name = MONTHS[i];
    const re = new RegExp(`\\b(${name}|${name.slice(0, 3)})\\b(?:\\s+(\\d{4}))?`);
    const mm = q.match(re);
    if (mm && !(name === "may" && !/\bin may\b|\bmay \d{4}\b|\bof may\b|\bmay\?/.test(q))) {
      const mon = i + 1;
      const yy = mm[2] ? Number(mm[2]) : mon > m ? y - 1 : y;
      const label = `${name[0].toUpperCase()}${name.slice(1)} ${yy}`;
      return { from: fmt(yy, mon, 1), to: fmt(yy, mon, lastDay(yy, mon)), label };
    }
  }
  return null;
}

function customerMentioned(q: string, ledger: Invoice[]): string | undefined {
  const ql = q.toLowerCase();
  const names = [...new Set(ledger.map((i) => i.customerName))];
  // try surname / distinctive token match
  for (const n of names.sort((a, b) => b.length - a.length)) {
    const tokens = n
      .toLowerCase()
      .replace(/^(mrs|mr|ms|miss|dr)\.?\s+/, "")
      .split(/[\s&]+/)
      .filter((t) => t.length > 3 && !["ltd", "limited", "the", "property", "management", "builders", "surgery", "village"].includes(t));
    if (tokens.some((t) => new RegExp(`\\b${t.replace(/[^a-z']/g, "")}\\b`).test(ql))) return n;
  }
  return undefined;
}

const bullet = (s: string) => `• ${s}`;

async function runRulesAgent(messages: ChatMessage[], ctx: AgentContext): Promise<ChatResponse> {
  const today = todayISO();
  const raw = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const q = raw.toLowerCase();
  const trace: ToolTraceEntry[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await runTool(name, args, ctx, false);
    trace.push(out.trace);
    return out;
  };
  const respond = (reply: string, pendingAction?: PendingAction): ChatResponse => ({ reply, engine: RULES_ENGINE, toolTrace: trace, pendingAction });
  const who = customerMentioned(q, ctx.ledger);

  // 1) New invoice from notes
  if (/\b(invoice|bill)\b/.test(q) && (/£\s?\d|\d\s*(hrs?|hours?)\b|@/.test(q)) && !/\b(remind|chase|overdue|owe)\b/.test(q)) {
    const notes = raw.replace(/^\s*(please\s+)?(create|make|raise|send|draft)?\s*(an?\s+)?(invoice|bill)\s*(for|:)?\s*/i, "");
    const out = await call("create_invoice_draft", { notes });
    const d = (out.pending as Extract<PendingAction, { type: "create_invoice" }>).draft;
    const total = d.items.reduce((s, li) => s + li.quantity * li.unitAmount, 0) * (d.vatEnabled ? 1 + d.vatRate / 100 : 1);
    return respond(
      `I've drafted an invoice for **${d.customerName || "an unnamed customer"}** — **${gbp(total)}**, due ${ukDate(d.dueDate)}.\n${d.items
        .map((li) => bullet(`${li.description}: ${li.quantity} × ${gbp(li.unitAmount)}`))
        .join("\n")}${d.warnings?.length ? `\n\n⚠️ ${d.warnings.join(" ")}` : ""}\n\nReview it and tap **Confirm** to open it in the editor before sending through PayPal.`,
      out.pending,
    );
  }

  // 2) Reminder / chase
  if (/\b(remind|reminder|chase|nudge|final notice|follow up|follow-up|send .*notice)\b/.test(q)) {
    let target = who;
    if (!target) {
      const od = overdueInvoices(ctx.ledger, today)[0];
      target = od?.customerName;
    }
    const stage = /\bfinal\b/.test(q) ? "final" : /\bfirm\b|\bstern\b/.test(q) ? "firm" : /\bfriendly|gentle|nudge\b/.test(q) ? "nudge" : undefined;
    const out = await call("draft_payment_reminder", { customer: target, ...(stage ? { stage } : {}) });
    if (!out.pending) return respond(`I couldn't find an unpaid invoice${target ? ` for ${target}` : ""} to chase. 🎉`);
    const p = out.pending as Extract<PendingAction, { type: "send_reminder" }>;
    return respond(
      `Here's a **${STAGE_LABEL[p.stage].toLowerCase()}** for **${p.customerName}** (invoice ${p.invoiceNumber}). Nothing's been sent — check the wording and tap **Confirm** to send it via PayPal.`,
      p,
    );
  }

  // 3) Mark paid
  if (/\bmark(ed)?\b.*\bpaid\b|\b(has|have|just) paid\b|\bpaid (me|cash|in cash|by bank)\b/.test(q)) {
    const out = await call("propose_mark_paid", { customer: who ?? "" });
    if (!out.pending) return respond(`I couldn't find an unpaid invoice${who ? ` for ${who}` : ""} to mark as paid.`);
    const p = out.pending as Extract<PendingAction, { type: "mark_paid" }>;
    return respond(`Mark invoice ${p.invoiceNumber} for **${p.customerName}** (**${gbp(p.amount)}**) as paid? Tap **Confirm** and I'll record the payment.`, p);
  }

  // 4) Earnings
  if (/\b(earn|earned|made|make|income|revenue|took|taken|received|turnover|takings|billed|invoiced)\b/.test(q)) {
    const r = monthRange(q, today) ?? monthRange("this month", today)!;
    const out = await call("get_earnings", { from: r.from, to: r.to });
    const e = out.result as ReturnType<typeof earnedBetween>;
    return respond(
      `In **${r.label}** you received **${gbp(e.received)}** from ${e.receivedCount} paid invoice${e.receivedCount === 1 ? "" : "s"}, and billed **${gbp(e.billed)}** across ${e.billedCount} invoice${e.billedCount === 1 ? "" : "s"} (${ukDate(r.from)} – ${ukDate(r.to)}).`,
    );
  }

  // 5) Slowest / latest / best payer
  if (/\b(latest|slowest|worst|late|best|fastest|quickest|prompt)\b.*\b(payer|payers|pay|paying)\b|\bwho pays\b|\btakes? (the )?longest\b/.test(q)) {
    const out = await call("rank_payers");
    const ranked = out.result as ReturnType<typeof customerSummaries>;
    if (/\b(best|fastest|quickest|prompt)\b/.test(q)) {
      const best = customerSummaries(ctx.ledger, today)
        .filter((c) => c.avgDaysToPay !== undefined && c.overdue === 0)
        .sort((a, b) => (a.avgDaysToPay ?? 99) - (b.avgDaysToPay ?? 99))
        .slice(0, 3);
      return respond(`Your quickest payers:\n${best.map((c) => bullet(`**${c.name}** — pays in ${c.avgDaysToPay} day${c.avgDaysToPay === 1 ? "" : "s"} on average`)).join("\n")}`);
    }
    const top = ranked.slice(0, 3);
    if (!top.length) return respond("Nobody's paying late at the moment. 👍");
    return respond(
      `Your latest payers:\n${top
        .map((c) =>
          bullet(
            `**${c.name}** — ${c.maxDaysOverdue > 0 ? `${gbp(c.overdue)} currently ${c.maxDaysOverdue} days overdue` : "nothing overdue now"}${c.avgDaysLate !== undefined ? `, ${c.avgDaysLate} days late on average` : ""}`,
          ),
        )
        .join("\n")}\n\nWant me to draft a reminder for ${top[0].name}?`,
    );
  }

  // 6) Overdue
  if (/\b(overdue|late|chasing|past due)\b/.test(q)) {
    const out = await call("list_invoices", { status: "overdue" });
    const rows = out.result as ReturnType<typeof brief>[];
    if (!rows.length) return respond("Nothing is overdue right now. 🎉");
    const sum = rows.reduce((s, r) => s + r.outstanding, 0);
    return respond(
      `**${rows.length} overdue invoice${rows.length === 1 ? "" : "s"}** totalling **${gbp(sum)}**:\n${rows
        .map((r) => bullet(`**${r.customer}** — ${gbp(r.outstanding)}, ${r.daysOverdue} days overdue (${r.number}${r.remindersSent ? `, ${r.remindersSent} reminder${r.remindersSent === 1 ? "" : "s"} sent` : ""})`))
        .join("\n")}`,
    );
  }

  // 7) A specific customer
  if (who && !/\bwho\b/.test(q)) {
    const out = await call("list_invoices", { status: "all", customer: who.replace(/^(Mrs|Mr|Ms|Miss|Dr)\.?\s+/, "") });
    const rows = out.result as ReturnType<typeof brief>[];
    const owed = rows.reduce((s, r) => s + r.outstanding, 0);
    return respond(
      `**${who}**: ${rows.length} invoice${rows.length === 1 ? "" : "s"}, ${owed > 0 ? `**${gbp(owed)} outstanding**` : "all paid up"}.\n${rows
        .slice(0, 6)
        .map((r) => bullet(`${r.number} · ${r.job} · ${gbp(r.total)} · ${r.paid ? `paid ${ukDate(r.paid)}` : r.daysOverdue ? `${r.daysOverdue} days overdue` : `due ${ukDate(r.due)}`}`))
        .join("\n")}`,
    );
  }

  // 8) Who owes / outstanding
  if (/\b(owe|owes|owed|owing|outstanding|unpaid|due|debtors?)\b/.test(q)) {
    const out = await call("get_ledger_summary");
    const s = out.result as ReturnType<typeof totals> & { customers: ReturnType<typeof customerSummaries> };
    const owing = s.customers.filter((c) => c.outstanding > 0);
    if (!owing.length) return respond("Nobody owes you anything right now. 🎉");
    return respond(
      `You're owed **${gbp(s.outstanding)}** across ${owing.length} customer${owing.length === 1 ? "" : "s"}${s.overdue > 0 ? ` — **${gbp(s.overdue)} is overdue**` : ""}:\n${owing
        .map((c) => bullet(`**${c.name}** — ${gbp(c.outstanding)}${c.overdue > 0 ? ` (${c.maxDaysOverdue} days overdue)` : " (not due yet)"}`))
        .join("\n")}`,
    );
  }

  // 9) Biggest customers
  if (/\b(biggest|top|best|largest|most valuable)\b.*\b(customer|client)s?\b/.test(q)) {
    const out = await call("get_ledger_summary");
    const s = out.result as { customers: ReturnType<typeof customerSummaries> };
    const top = [...s.customers].sort((a, b) => b.billed - a.billed).slice(0, 5);
    return respond(`Your biggest customers by amount billed:\n${top.map((c) => bullet(`**${c.name}** — ${gbp(c.billed)} over ${c.invoices} invoice${c.invoices === 1 ? "" : "s"}`)).join("\n")}`);
  }

  // 10) Average days to pay / general summary
  if (/\b(average|how long|days to pay|summary|overview|how am i doing|cash ?flow|status)\b/.test(q)) {
    const out = await call("get_ledger_summary");
    const s = out.result as ReturnType<typeof totals>;
    return respond(
      `Here's where you stand:\n${[
        bullet(`Outstanding: **${gbp(s.outstanding)}**`),
        bullet(`Overdue: **${gbp(s.overdue)}** (${s.overdueCount} invoice${s.overdueCount === 1 ? "" : "s"})`),
        bullet(`Billed this month: ${gbp(s.billedThisMonth)}`),
        bullet(`Received this month: ${gbp(s.paidThisMonth)}`),
        s.avgDaysToPay !== undefined ? bullet(`Customers take **${s.avgDaysToPay} days** on average to pay`) : "",
      ]
        .filter(Boolean)
        .join("\n")}`,
    );
  }

  return respond(
    `I can help with things like:\n${[
      "“Who owes me what?”",
      "“How much did I earn in October?”",
      "“Who's my latest payer?”",
      "“What's overdue?”",
      "“Chase Harbourside Lettings”",
      "“Invoice Mr Jones for 3 hrs, parts £40, jones@example.com”",
    ]
      .map(bullet)
      .join("\n")}`,
  );
}
