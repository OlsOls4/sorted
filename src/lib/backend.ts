// Invoice backend: real PayPal (live/sandbox) or the mock PayPal used in demo mode.
// Server-only. Demo mode is stateless on the server: the browser keeps the ledger
// in localStorage and sends the relevant invoice(s) with each mutating request.

import "server-only";
import { computeTotals, isoTimestamp, round2, todayISO } from "./format";
import { PayPalClient, PayPalError, isSandbox, paypalConfigFromEnv, paypalConfigFromHeaders, type PayPalConfig } from "./paypal/client";
import { draftToPayPal, payPalToInvoice } from "./paypal/mapping";
import { runToolkitTool } from "./paypal/toolkit";
import { seedInvoices } from "./seed";
import type { Invoice, InvoiceDraft, Mode, Settings } from "./types";

export interface BackendResult<T> {
  data: T;
  via: "paypal-rest" | "paypal-agent-toolkit" | "mock-paypal";
}

export interface InvoiceBackend {
  mode: Mode;
  createAndSend(draft: InvoiceDraft, settings: Settings, existing?: Invoice[]): Promise<BackendResult<Invoice>>;
  list(clientLedger?: Invoice[]): Promise<BackendResult<Invoice[]>>;
  remind(invoice: Invoice | string, subject: string, note: string): Promise<BackendResult<Invoice | null>>;
  markPaid(invoice: Invoice | string): Promise<BackendResult<Invoice | null>>;
}

export function validateDraft(d: InvoiceDraft): string[] {
  const errs: string[] = [];
  if (!d.customerName?.trim()) errs.push("Customer name is required.");
  if (!d.customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.customerEmail)) errs.push("A valid customer email is required.");
  if (!Array.isArray(d.items) || d.items.length === 0) errs.push("Add at least one line item.");
  for (const li of d.items ?? []) {
    if (!(li.quantity > 0)) errs.push(`"${li.description || "Line item"}" needs a quantity above zero.`);
    if (!(li.unitAmount >= 0)) errs.push(`"${li.description || "Line item"}" needs a valid price.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate ?? "")) errs.push("Due date must be YYYY-MM-DD.");
  if (computeTotals(d).total <= 0) errs.push("Invoice total must be more than £0.");
  return errs;
}

// ---------------- Mock PayPal ----------------

function mockId() {
  const a = Math.random().toString(36).slice(2, 6).toUpperCase();
  const b = Math.random().toString(36).slice(2, 6).toUpperCase();
  const c = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `INV2-${a}-${b}-${c}-DEMO`;
}

function nextNumber(existing: Invoice[]): string {
  const max = existing.reduce((m, i) => {
    const n = parseInt(i.number.replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 1000);
  return `CH-${String(max + 1).padStart(4, "0")}`;
}

class MockBackend implements InvoiceBackend {
  mode: Mode = "demo";

  async createAndSend(draft: InvoiceDraft, _settings: Settings, existing: Invoice[] = []) {
    const t = computeTotals(draft);
    const id = mockId();
    const inv: Invoice = {
      id,
      number: nextNumber(existing),
      status: "SENT",
      customerName: draft.customerName.trim(),
      customerEmail: draft.customerEmail.trim(),
      customerType: draft.customerType,
      jobSummary: draft.jobSummary,
      items: draft.items,
      vatEnabled: draft.vatEnabled,
      vatRate: draft.vatRate,
      currency: "GBP",
      ...t,
      amountPaid: 0,
      issueDate: draft.issueDate,
      dueDate: draft.dueDate,
      payerViewUrl: `https://www.sandbox.paypal.com/invoice/p/#${id}`,
      merchantViewUrl: `https://www.sandbox.paypal.com/invoice/details/${id}`,
      reminders: [],
      source: "mock",
    };
    await new Promise((r) => setTimeout(r, 250)); // feel like a network call
    return { data: inv, via: "mock-paypal" as const };
  }

  async list(clientLedger?: Invoice[]) {
    return { data: clientLedger && clientLedger.length ? clientLedger : seedInvoices(), via: "mock-paypal" as const };
  }

  async remind(invoice: Invoice | string, subject: string) {
    if (typeof invoice === "string") return { data: null, via: "mock-paypal" as const };
    const updated: Invoice = {
      ...invoice,
      reminders: [...invoice.reminders, { sentAt: isoTimestamp(), stage: stageFor(invoice), subject }],
    };
    return { data: updated, via: "mock-paypal" as const };
  }

  async markPaid(invoice: Invoice | string) {
    if (typeof invoice === "string") return { data: null, via: "mock-paypal" as const };
    return {
      data: { ...invoice, status: "MARKED_AS_PAID" as const, amountPaid: invoice.total, paidDate: todayISO() },
      via: "mock-paypal" as const,
    };
  }
}

function stageFor(inv: Invoice) {
  const n = inv.reminders.length;
  return n === 0 ? "nudge" : n === 1 ? "firm" : "final";
}

// ---------------- Live PayPal ----------------

class PayPalBackend implements InvoiceBackend {
  mode: Mode = "live";
  private client: PayPalClient;
  constructor(private cfg: PayPalConfig) {
    this.client = new PayPalClient(cfg);
  }

  async createAndSend(draft: InvoiceDraft, settings: Settings) {
    const number = await this.client.generateInvoiceNumber();
    const payload = draftToPayPal(draft, settings, number);
    const created = await this.client.createInvoice(payload);
    await this.client.sendInvoice(created.id, {
      subject: `Invoice ${created.detail.invoice_number ?? ""} from ${settings.businessName}`.trim(),
      note: draft.note,
    });
    const fresh = await this.client.getInvoice(created.id).catch(() => created);
    return { data: payPalToInvoice(fresh, isSandbox(this.cfg)), via: "paypal-rest" as const };
  }

  async list() {
    const items = await this.client.listInvoices();
    return { data: items.map((p) => payPalToInvoice(p, isSandbox(this.cfg))), via: "paypal-rest" as const };
  }

  /** Reminders go through PayPal's Agent Toolkit tool, falling back to direct REST. */
  async remind(invoice: Invoice | string, subject: string, note: string) {
    const id = typeof invoice === "string" ? invoice : invoice.id;
    let via: "paypal-agent-toolkit" | "paypal-rest" = "paypal-agent-toolkit";
    try {
      await runToolkitTool(this.cfg, "send_invoice_reminder", { invoice_id: id, subject, note });
    } catch (e) {
      if (/unavailable/.test((e as Error).message)) {
        via = "paypal-rest";
        await this.client.remind(id, { subject, note });
      } else throw e;
    }
    const fresh = await this.client.getInvoice(id);
    const inv = payPalToInvoice(fresh, isSandbox(this.cfg));
    const prior = typeof invoice === "string" ? [] : invoice.reminders;
    inv.reminders = [...prior, { sentAt: isoTimestamp(), stage: stageFor({ ...inv, reminders: prior }), subject }];
    return { data: inv, via };
  }

  async markPaid(invoice: Invoice | string) {
    const id = typeof invoice === "string" ? invoice : invoice.id;
    const current = payPalToInvoice(await this.client.getInvoice(id), isSandbox(this.cfg));
    const due = round2(current.total - current.amountPaid);
    if (due > 0) await this.client.recordPayment(id, due, "GBP", todayISO());
    const fresh = payPalToInvoice(await this.client.getInvoice(id), isSandbox(this.cfg));
    if (typeof invoice !== "string") fresh.reminders = invoice.reminders;
    return { data: fresh, via: "paypal-rest" as const };
  }
}

// ---------------- Mode resolution ----------------

export type CredSource = "browser" | "server" | null;

export interface RequestContext {
  mode: Mode;
  cfg: PayPalConfig | null;
  credSource: CredSource;
}

function serverConfig(): PayPalConfig | null {
  return process.env.CHASE_FORCE_DEMO === "1" ? null : paypalConfigFromEnv();
}

/**
 * Credential precedence: sandbox creds the user pasted in the browser (per request)
 * → server env vars → none (demo). The client can always force demo via x-chase-mode.
 */
export function resolveContext(req: Request): RequestContext {
  const fromBrowser = paypalConfigFromHeaders(req);
  const cfg = fromBrowser ?? serverConfig();
  const credSource: CredSource = fromBrowser ? "browser" : cfg ? "server" : null;
  const wanted = req.headers.get("x-chase-mode");
  const mode: Mode = wanted === "demo" || !cfg ? "demo" : "live";
  return { mode, cfg, credSource };
}

export function serverLiveConfigured(): boolean {
  return serverConfig() !== null;
}

export function getBackend(ctx: RequestContext): InvoiceBackend {
  if (ctx.mode === "live" && ctx.cfg) return new PayPalBackend(ctx.cfg);
  return new MockBackend();
}

export function errorResponse(e: unknown, fallbackStatus = 500) {
  if (e instanceof PayPalError) {
    return Response.json(
      { error: e.message, paypalDebugId: e.debugId, status: e.status },
      { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
    );
  }
  return Response.json({ error: (e as Error)?.message ?? "Unexpected error" }, { status: fallbackStatus });
}

