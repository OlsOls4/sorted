// Core domain types for Sorted. Shared by client and server.

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "UNPAID"
  | "SCHEDULED"
  | "PAYMENT_PENDING"
  | "PARTIALLY_PAID"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED";

export type LineItemKind = "labour" | "parts" | "callout" | "other";

export interface LineItem {
  id: string;
  kind: LineItemKind;
  description: string;
  quantity: number;
  unitAmount: number; // GBP, ex-VAT
  unit: "HOURS" | "QUANTITY" | "AMOUNT";
}

export type CustomerType = "consumer" | "business";

export interface InvoiceDraft {
  customerName: string;
  customerEmail: string;
  customerType: CustomerType;
  jobSummary: string;
  items: LineItem[];
  vatEnabled: boolean;
  vatRate: number; // percent, e.g. 20
  currency: "GBP";
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  note?: string;
  warnings?: string[]; // things the parser was unsure about
}

export interface ReminderLog {
  sentAt: string; // ISO
  stage: ReminderStage;
  subject: string;
}

export interface Invoice {
  id: string; // PayPal invoice id (INV2-....)
  number: string; // human invoice number
  status: InvoiceStatus;
  customerName: string;
  customerEmail: string;
  customerType: CustomerType;
  jobSummary: string;
  items: LineItem[];
  vatEnabled: boolean;
  vatRate: number;
  currency: "GBP";
  subtotal: number;
  vat: number;
  total: number;
  amountPaid: number;
  issueDate: string;
  dueDate: string;
  paidDate?: string;
  payerViewUrl?: string; // PayPal hosted invoice page for the customer
  merchantViewUrl?: string; // PayPal business dashboard link
  reminders: ReminderLog[];
  source: "paypal" | "mock";
}

export type ReminderStage = "nudge" | "firm" | "final";

export interface ReminderDraft {
  invoiceId: string;
  stage: ReminderStage;
  subject: string;
  body: string;
  statutoryInterest?: {
    applies: boolean;
    ratePercent: number;
    interestToDate: number;
    fixedCompensation: number;
    explanation: string;
  };
}

export interface Settings {
  businessName: string;
  traderName: string;
  traderEmail: string;
  hourlyRate: number;
  vatRegistered: boolean;
  vatRate: number;
  paymentTermsDays: number;
  calloutFee: number;
  bankRate: number; // Bank of England base rate for Late Payment Act calc
}

export const DEFAULT_SETTINGS: Settings = {
  businessName: "Dave Harris Plumbing & Heating",
  traderName: "Dave Harris",
  traderEmail: "dave@harrisplumbing.example",
  hourlyRate: 45,
  vatRegistered: false,
  vatRate: 20,
  paymentTermsDays: 14,
  calloutFee: 0,
  bankRate: 3.75,
};

export type EngineInfo = {
  id: string; // e.g. "gemini", "openai", "anthropic", "rules"
  label: string; // human readable, e.g. "Gemini 2.5 Flash" or "Sorted rules engine"
  ai: boolean;
};

export interface ToolTraceEntry {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  via?: "paypal-agent-toolkit" | "paypal-rest" | "mock-paypal" | "ledger";
}

export type PendingAction =
  | {
      type: "send_reminder";
      invoiceId: string;
      invoiceNumber: string;
      customerName: string;
      stage: ReminderStage;
      subject: string;
      body: string;
    }
  | {
      type: "create_invoice";
      draft: InvoiceDraft;
    }
  | {
      type: "mark_paid";
      invoiceId: string;
      invoiceNumber: string;
      customerName: string;
      amount: number;
    };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  engine: EngineInfo;
  toolTrace: ToolTraceEntry[];
  pendingAction?: PendingAction;
}

export type Mode = "demo" | "live";
