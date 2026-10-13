// The built-in "Money owed" report, as AG Studio state. Field ids refer to ./data.ts.

import type { AgReportState, AgWidgetLayoutState } from "ag-studio";
import type { SortedRegistry } from "./widgets";

export const PAGE_ID = "money-owed";
/** Widget ids Ask Sorted adds start with this, so "reset" can find and remove them. */
export const ASK_PREFIX = "ask-";

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string) => ({ title: { enabled: true, text } });
const sum = (id: string) => ({ id, aggregation: "sum" as const });

const typography = (fontSize: number, fontWeight: "normal" | "bold" = "normal") => ({
  fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontSize,
  fontWeight,
  fontStyle: "normal" as const,
});

const kpi = (text: string, value: { id: string; aggregation?: "sum" | "countd" }) => ({
  type: "value" as const,
  dataMapping: { value: [value] },
  format: {
    title: { enabled: true, text, typography: typography(12, "bold") },
    caption: { enabled: true, text: "", typography: typography(0) },
    style: { typography: typography(24, "bold") },
  },
});

export function initialReport(): AgReportState<SortedRegistry> {
  return {
    pages: [
      {
        id: PAGE_ID,
        widgets: {
          "kpi-owed": kpi("Owed to you", sum("invoices.owed")),
          "kpi-overdue": kpi("Overdue", sum("invoices.overdueAmount")),
          "kpi-cash": kpi("Cash in", sum("payments.amount")),
          city: {
            type: "button-filter",
            dataMapping: { value: [{ id: "invoices.city" }] },
            // No title: the filter labels itself ("Filter by: City"), and a title as well clips the buttons.
            format: { title: { enabled: false }, style: { selection: { type: "multiple" }, dimensions: { height: 28, minWidth: 56 } } },
          },
          scoreboard: {
            type: "sorted-scoreboard",
            dataMapping: {
              category: [{ id: "invoices.customer" }],
              value: [sum("invoices.owed")],
              late: [{ id: "invoices.daysOverdue", aggregation: "max" }],
            },
            format: title("Who still owes what"),
          },
          heat: {
            type: "sorted-heat",
            dataMapping: {
              bucket: [{ id: "invoices.agingBucket" }],
              value: [sum("invoices.owed")],
              count: [{ id: "invoices.id", aggregation: "countd" }],
            },
            format: title("How late is it?"),
          },
          "cash-by-month": {
            type: "column-chart-grouped",
            dataMapping: { categoryKey: [{ id: "calendar::month" }], valueKey: [sum("payments.amount")] },
            format: title("Cash in by month"),
          },
          "ledger-sync": {
            type: "sorted-ledger-sync",
            dataMapping: { key: [{ id: "invoices.id" }], value: [sum("invoices.owed")] },
          },
        },
        widgetLayout: {
          "kpi-owed": at(0, 0, 5, 6),
          "kpi-overdue": at(5, 0, 5, 6),
          "kpi-cash": at(10, 0, 5, 6),
          city: at(15, 0, 9, 6),
          scoreboard: at(0, 6, 9, 25),
          heat: at(9, 6, 15, 9),
          "cash-by-month": at(9, 15, 15, 16),
          "ledger-sync": at(0, 31, 24, 3),
        },
      },
    ],
    selectedPageId: PAGE_ID,
    panels: { filters: { collapsed: true } },
  } as unknown as AgReportState<SortedRegistry>;
}
