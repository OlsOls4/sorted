// Minimal, robust PayPal Invoicing API v2 client (server-only).
// Docs: https://developer.paypal.com/docs/api/invoicing/v2/

import "server-only";

export class PayPalError extends Error {
  status: number;
  debugId?: string;
  details?: unknown;
  constructor(message: string, status: number, debugId?: string, details?: unknown) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.debugId = debugId;
    this.details = details;
  }
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string; // https://api-m.sandbox.paypal.com or https://api-m.paypal.com
}

export function paypalConfigFromEnv(): PayPalConfig | null {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const env = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
  const baseUrl =
    process.env.PAYPAL_API_BASE?.trim() || (env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
  return { clientId, clientSecret, baseUrl };
}

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

/**
 * Credentials a user pasted into "Connect PayPal sandbox" (stored in their browser,
 * sent per request over HTTPS). Always pinned to the SANDBOX API — user-supplied
 * credentials can never touch live money. Values are never logged or echoed back.
 */
export function paypalConfigFromHeaders(req: Request): PayPalConfig | null {
  const clientId = req.headers.get("x-paypal-client-id")?.trim();
  const clientSecret = req.headers.get("x-paypal-client-secret")?.trim();
  if (!clientId || !clientSecret) return null;
  if (clientId.length > 200 || clientSecret.length > 200 || /\s/.test(clientId + clientSecret)) return null;
  return { clientId, clientSecret, baseUrl: SANDBOX_BASE };
}

/** Short non-reversible fingerprint used for cache keys (never the raw secret). */
export function credKey(cfg: PayPalConfig): string {
  let h = 2166136261;
  const s = `${cfg.clientSecret}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${cfg.baseUrl}|${cfg.clientId}|${(h >>> 0).toString(36)}`;
}

export function isSandbox(cfg: PayPalConfig) {
  return cfg.baseUrl.includes("sandbox");
}

type TokenCache = { token: string; expiresAt: number };
const tokenCache = new Map<string, TokenCache>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PayPalClient {
  constructor(private cfg: PayPalConfig) {}

  get baseUrl() {
    return this.cfg.baseUrl;
  }

  /** OAuth2 client_credentials, cached until ~60s before expiry. */
  async getAccessToken(force = false): Promise<string> {
    const key = credKey(this.cfg);
    const hit = tokenCache.get(key);
    if (!force && hit && hit.expiresAt > Date.now() + 60_000) {
      return hit.token;
    }
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await fetch(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== "string") {
      throw new PayPalError(
        `PayPal auth failed (${res.status}): ${String(body.error_description ?? body.error ?? "unknown error")}`,
        res.status,
        res.headers.get("paypal-debug-id") ?? undefined,
        body,
      );
    }
    if (tokenCache.size > 200) tokenCache.clear();
    tokenCache.set(key, { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3000) * 1000 });
    return body.access_token;
  }

  /**
   * Authenticated request with:
   *  - one transparent token refresh on 401
   *  - retries with backoff on 429/5xx and network errors (idempotent via PayPal-Request-Id on POST)
   */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    opts: { requestId?: string; preferRepresentation?: boolean; retries?: number } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const retries = opts.retries ?? 2;
    const requestId = opts.requestId ?? (method === "POST" ? crypto.randomUUID() : undefined);
    let forcedRefresh = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const token = await this.getAccessToken();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        if (requestId) headers["PayPal-Request-Id"] = requestId;
        if (opts.preferRepresentation) headers["Prefer"] = "return=representation";
        res = await fetch(`${this.cfg.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
        });
      } catch (err) {
        if (err instanceof PayPalError) throw err;
        if (attempt < retries) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw new PayPalError(`Network error talking to PayPal: ${(err as Error).message}`, 0);
      }

      if (res.status === 401 && !forcedRefresh) {
        forcedRefresh = true;
        await this.getAccessToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const d = (data ?? {}) as { message?: string; name?: string; details?: { issue?: string; description?: string; field?: string }[] };
        const detail = d.details?.map((x) => [x.field, x.issue, x.description].filter(Boolean).join(": ")).join("; ");
        throw new PayPalError(
          `PayPal ${method} ${path} failed (${res.status}${d.name ? ` ${d.name}` : ""}): ${d.message ?? "error"}${detail ? ` — ${detail}` : ""}`,
          res.status,
          res.headers.get("paypal-debug-id") ?? undefined,
          data,
        );
      }
      return { status: res.status, data: data as T, headers: res.headers };
    }
  }

  // ---- Invoicing v2 ----

  async generateInvoiceNumber(): Promise<string | undefined> {
    try {
      const { data } = await this.request<{ invoice_number?: string }>("POST", "/v2/invoicing/generate-next-invoice-number");
      return data?.invoice_number;
    } catch {
      return undefined; // PayPal will auto-assign one
    }
  }

  async createInvoice(payload: unknown): Promise<PayPalInvoice> {
    const { data } = await this.request<PayPalInvoice & { href?: string }>("POST", "/v2/invoicing/invoices", payload, {
      preferRepresentation: true,
    });
    if (data && (data as PayPalInvoice).id) return data as PayPalInvoice;
    // Older behaviour: 201 with a link only
    const href = (data as { href?: string })?.href;
    const id = href?.split("/").pop();
    if (!id) throw new PayPalError("PayPal created the invoice but returned no id", 500, undefined, data);
    return this.getInvoice(id);
  }

  async sendInvoice(id: string, opts: { subject?: string; note?: string; sendToInvoicer?: boolean } = {}) {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
      send_to_invoicer: opts.sendToInvoicer ?? true,
      send_to_recipient: true,
      ...(opts.subject ? { subject: opts.subject } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    });
  }

  async remind(id: string, opts: { subject: string; note: string }) {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
      subject: opts.subject.slice(0, 4000),
      note: opts.note.slice(0, 4000),
      send_to_invoicer: true,
    });
  }

  async recordPayment(id: string, amount: number, currency: string, date: string, method = "BANK_TRANSFER") {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
      method,
      payment_date: date,
      amount: { currency_code: currency, value: amount.toFixed(2) },
      note: "Recorded via Chase",
    });
  }

  async getInvoice(id: string): Promise<PayPalInvoice> {
    const { data } = await this.request<PayPalInvoice>("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
    return data;
  }

  /** Lists all invoices (follows pagination up to `maxPages`). */
  async listInvoices(maxPages = 5): Promise<PayPalInvoice[]> {
    const out: PayPalInvoice[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.request<{ items?: PayPalInvoice[]; total_pages?: number }>(
        "GET",
        `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true&fields=amount`,
      );
      out.push(...(data.items ?? []));
      if (!data.total_pages || page >= data.total_pages) break;
    }
    return out;
  }
}

// ---- PayPal invoice shape (subset we use) ----
export interface PayPalMoney {
  currency_code: string;
  value: string;
}
export interface PayPalInvoice {
  id: string;
  status: string;
  detail: {
    invoice_number?: string;
    invoice_date?: string;
    currency_code: string;
    note?: string;
    memo?: string;
    payment_term?: { term_type?: string; due_date?: string };
    metadata?: { create_time?: string; recipient_view_url?: string; invoicer_view_url?: string; last_update_time?: string };
  };
  primary_recipients?: { billing_info?: { name?: { given_name?: string; surname?: string; full_name?: string }; email_address?: string; business_name?: string } }[];
  items?: {
    name: string;
    description?: string;
    quantity: string;
    unit_amount: PayPalMoney;
    tax?: { name?: string; percent?: string; amount?: PayPalMoney };
    unit_of_measure?: string;
  }[];
  amount?: { currency_code?: string; value?: string; breakdown?: { item_total?: PayPalMoney; tax_total?: PayPalMoney } };
  due_amount?: PayPalMoney;
  payments?: { paid_amount?: PayPalMoney; transactions?: { payment_date?: string; amount?: PayPalMoney }[] };
}
