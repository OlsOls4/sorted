// Map between Chase's domain model and PayPal Invoicing v2 payloads.

import { computeTotals, round2 } from "../format";
import { detectCustomerType } from "../parser";
import type { Invoice, InvoiceDraft, InvoiceStatus, LineItem, Settings } from "../types";
import type { PayPalInvoice } from "./client";

function splitName(full: string): { given_name: string; surname: string } {
  const cleaned = full.replace(/^(Mrs|Mr|Ms|Miss|Dr|Prof)\.?\s+/i, "").trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { given_name: parts[0] || full, surname: "" };
  return { given_name: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
}

export function draftToPayPal(draft: InvoiceDraft, settings: Settings, invoiceNumber?: string) {
  const isBiz = draft.customerType === "business";
  const name = splitName(draft.customerName);
  return {
    detail: {
      ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
      invoice_date: draft.issueDate,
      currency_code: "GBP",
      note: (draft.note || `Thank you for your business — ${settings.businessName}`).slice(0, 4000),
      memo: `Created by Chase from job notes: ${draft.jobSummary}`.slice(0, 500),
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: draft.dueDate },
    },
    invoicer: {
      business_name: settings.businessName.slice(0, 300),
      name: splitName(settings.traderName),
    },
    primary_recipients: [
      {
        billing_info: {
          ...(isBiz ? { business_name: draft.customerName.slice(0, 300) } : {}),
          name: isBiz ? { given_name: "Accounts", surname: "Department" } : name,
          email_address: draft.customerEmail,
          language: "en-GB",
        },
      },
    ],
    items: draft.items
      .filter((li) => li.quantity > 0 && li.unitAmount >= 0)
      .map((li) => ({
        name: li.description.slice(0, 200) || "Work",
        quantity: String(round2(li.quantity)),
        unit_amount: { currency_code: "GBP", value: li.unitAmount.toFixed(2) },
        unit_of_measure: li.unit,
        ...(draft.vatEnabled ? { tax: { name: "VAT", percent: String(draft.vatRate) } } : {}),
      })),
    configuration: {
      partial_payment: { allow_partial_payment: false },
      allow_tip: false,
      tax_calculated_after_discount: true,
      tax_inclusive: false,
    },
  };
}

const KNOWN: InvoiceStatus[] = [
  "DRAFT", "SENT", "UNPAID", "SCHEDULED", "PAYMENT_PENDING", "PARTIALLY_PAID", "PAID", "MARKED_AS_PAID",
  "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED",
];

export function payPalToInvoice(p: PayPalInvoice, sandbox: boolean): Invoice {
  const bi = p.primary_recipients?.[0]?.billing_info;
  const personal = [bi?.name?.given_name, bi?.name?.surname].filter(Boolean).join(" ") || bi?.name?.full_name || "";
  const customerName = bi?.business_name || personal || bi?.email_address || "Unknown customer";
  const email = bi?.email_address ?? "";
  const items: LineItem[] = (p.items ?? []).map((it, i) => ({
    id: `${p.id}_${i}`,
    kind: it.unit_of_measure === "HOURS" ? "labour" : /part|material/i.test(it.name) ? "parts" : "other",
    description: it.name,
    quantity: Number(it.quantity) || 1,
    unitAmount: Number(it.unit_amount?.value) || 0,
    unit: (it.unit_of_measure as LineItem["unit"]) || "QUANTITY",
  }));
  const vatPercent = Number(p.items?.find((it) => it.tax?.percent)?.tax?.percent ?? 0);
  const vatEnabled = vatPercent > 0;
  const calc = computeTotals({ items, vatEnabled, vatRate: vatPercent || 20 });
  const total = p.amount?.value ? Number(p.amount.value) : calc.total;
  const paidAmt = Number(p.payments?.paid_amount?.value ?? 0);
  const lastTx = p.payments?.transactions?.[p.payments.transactions.length - 1];
  const status = (KNOWN.includes(p.status as InvoiceStatus) ? p.status : "SENT") as InvoiceStatus;
  const host = sandbox ? "https://www.sandbox.paypal.com" : "https://www.paypal.com";
  const issueDate = p.detail.invoice_date ?? p.detail.metadata?.create_time?.slice(0, 10) ?? "";
  return {
    id: p.id,
    number: p.detail.invoice_number ?? p.id,
    status,
    customerName,
    customerEmail: email,
    customerType: bi?.business_name ? "business" : detectCustomerType(customerName, email),
    jobSummary: (p.detail.memo?.replace(/^Created by Chase from job notes:\s*/, "") || items[0]?.description || "").slice(0, 120),
    items,
    vatEnabled,
    vatRate: vatPercent || 20,
    currency: "GBP",
    subtotal: p.amount?.breakdown?.item_total?.value ? Number(p.amount.breakdown.item_total.value) : calc.subtotal,
    vat: p.amount?.breakdown?.tax_total?.value ? Number(p.amount.breakdown.tax_total.value) : calc.vat,
    total,
    amountPaid: status === "PAID" || status === "MARKED_AS_PAID" ? total : paidAmt,
    issueDate,
    dueDate: p.detail.payment_term?.due_date ?? issueDate,
    paidDate: lastTx?.payment_date?.slice(0, 10),
    payerViewUrl: p.detail.metadata?.recipient_view_url,
    merchantViewUrl: p.detail.metadata?.invoicer_view_url ?? `${host}/invoice/details/${p.id}`,
    reminders: [],
    source: "paypal",
  };
}
