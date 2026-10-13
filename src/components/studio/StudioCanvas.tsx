"use client";

// The AG Studio instance itself. Loaded client-only (next/dynamic, ssr: false) by MoneyOwedStudio.

import { useMemo, useRef, useState } from "react";
import { AgStudioAiModule, enableStudioDevValidations, type AgAiHarness, type AgAiHarnessSetup, type AgStudioApi, type AgStudioMode } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import type { StudioInvoiceRow, StudioPaymentRow } from "@/lib/studio/rows";
import { buildHarness, type IntentFetcher } from "./agent";
import { buildStudioData } from "./data";
import { initialReport } from "./report";
import { sortedStudioTheme } from "./theme";
import { sortedWidgets, type SortedRegistry, type SortedStudioContext } from "./widgets";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const STUDIO_MODULES = [AgStudioAiModule];
// Module-level constants: AG Studio treats a new object as a property change and refreshes.
const STUDIO_STYLE = { height: "100%", width: "100%" };
const STUDIO_LAYOUT = { widgetBorderEnabled: true };

export interface StudioCanvasProps {
  rows: { invoices: StudioInvoiceRow[]; payments: StudioPaymentRow[] };
  today: string;
  mode: AgStudioMode;
  licenseKey?: string;
  fetchIntent: IntentFetcher;
  onLedgerIds: (ids: string[] | null) => void;
  onReady: (api: AgStudioApi, harness: AgAiHarness | null) => void;
}

export default function StudioCanvas({ rows, today, mode, licenseKey, fetchIntent, onLedgerIds, onReady }: StudioCanvasProps) {
  const data = useMemo(() => buildStudioData(rows, today), [rows, today]);
  const [initialState] = useState(initialReport);
  const widgets = useMemo(() => sortedWidgets(), []);
  // Studio reads context and ai once; the host passes stable callbacks (setState / useMemo).
  const context = useMemo<SortedStudioContext>(() => ({ onLedgerIds }), [onLedgerIds]);
  const harnessRef = useRef<AgAiHarness | null>(null);
  const ai = useMemo<AgAiHarnessSetup>(
    () =>
      ({ api }) => {
        harnessRef.current = buildHarness(api, fetchIntent);
        return harnessRef.current;
      },
    [fetchIntent],
  );

  return (
    <AgStudioProvider licenseKey={licenseKey} modules={STUDIO_MODULES}>
      <AgStudio<SortedRegistry>
        style={STUDIO_STYLE}
        theme={sortedStudioTheme}
        layout={STUDIO_LAYOUT}
        data={data as never}
        widgets={widgets as never}
        context={context}
        ai={ai}
        initialState={initialState}
        mode={mode}
        onStudioReady={(e) => onReady(e.api as unknown as AgStudioApi, harnessRef.current)}
      />
    </AgStudioProvider>
  );
}
