// AG Studio data sources for the "Money owed" dashboard: one row per invoice, one per payment,
// joined on invoice id, with a shared calendar for the cash-in chart.

import type { AgDataSourcesDefinition, AgFieldDefinition, AgFormat } from "ag-studio";
import type { StudioInvoiceRow, StudioPaymentRow } from "@/lib/studio/rows";

type FieldSpec = [id: string, name: string, format: AgFormat, hide?: boolean];
// Money is pounds and pence everywhere Studio shows it (KPIs, chart axes, tooltips).
const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const fields = (specs: FieldSpec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide]) => ({ id, name, format, ...(format === "currencyFormat" && { formatOptions: { format: GBP } }), ...(hide && { hide }) }));

export const CALENDAR_ID = "calendar";

export function buildStudioData(rows: { invoices: StudioInvoiceRow[]; payments: StudioPaymentRow[] }, today: string): AgDataSourcesDefinition {
  const dates = [...rows.invoices.map((r) => r.issueDate), ...rows.payments.map((r) => r.date)].filter(Boolean).sort();
  return {
    description:
      "A UK sole-trader plumber's invoices (GBP) and the payments received against them. " +
      "Owed is what is still unpaid on an invoice; Overdue is owed past its due date. Cash in is money received, by payment date.",
    sources: [
      {
        id: "invoices",
        name: "Jobs",
        description: "One row per invoice (job). Area and city are where the job was.",
        data: rows.invoices,
        fields: fields([
          ["id", "Invoice ID", "textFormat", true],
          ["number", "Invoice", "textFormat"],
          ["customer", "Customer", "textFormat"],
          ["customerKey", "Customer key", "textFormat", true],
          ["customerType", "Customer type", "textFormat"],
          ["job", "Job", "textFormat"],
          ["area", "Area", "textFormat"],
          ["city", "City", "textFormat"],
          ["status", "Status", "textFormat"],
          ["issueDate", "Issued", "dateFormat"],
          ["issueMonth", "Issue month", "textFormat"],
          ["dueDate", "Due", "dateFormat"],
          ["paidDate", "Paid on", "dateFormat"],
          ["total", "Billed", "currencyFormat"],
          ["paid", "Paid", "currencyFormat"],
          ["owed", "Owed", "currencyFormat"],
          ["overdueAmount", "Overdue", "currencyFormat"],
          ["daysOverdue", "Days overdue", "integerFormat"],
          ["agingBucket", "How late", "textFormat"],
          ["isOpen", "Still owed", "booleanFormat"],
          ["isOverdue", "Is overdue", "booleanFormat"],
          ["reminders", "Reminders sent", "integerFormat"],
          ["daysToPay", "Days to pay", "integerFormat"],
        ]),
      },
      {
        id: "payments",
        name: "Payments",
        description: "Money received, one row per paid invoice, dated when it was paid.",
        data: rows.payments,
        fields: fields([
          ["id", "Payment ID", "textFormat", true],
          ["invoiceId", "Invoice ID", "textFormat", true],
          ["date", "Paid date", "dateFormat"],
          ["month", "Paid month", "textFormat"],
          ["amount", "Amount received", "currencyFormat"],
        ]),
      },
    ],
    relationships: [
      { id: "payment-invoice", source: { tableId: "payments", fieldId: "invoiceId" }, target: { tableId: "invoices", fieldId: "id" }, type: "many-to-one" },
      { id: "payments-date-calendar", source: { tableId: "payments", fieldId: "date" }, target: { calendarId: CALENDAR_ID } },
    ],
    calendars: [
      {
        id: CALENDAR_ID,
        label: "Calendar",
        range: { from: { type: "date", value: dates[0] ?? today }, to: { type: "date", value: today } },
        fragments: ["year", "quarter", "month", "week", "day"],
      },
    ],
  };
}
