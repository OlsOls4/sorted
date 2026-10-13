// AG Studio theme in Sorted's palette (src/app/globals.css): brand greens on a paper canvas,
// ink text, soft line borders, warn/bad for lateness. Same values the ledger grid theme uses.

import { studioTheme } from "ag-studio";

export const SORTED = {
  ink: "#0b1f33",
  ink2: "#23384d",
  muted: "#5b6b7c",
  line: "#e3e8ee",
  paper: "#f6f8fa",
  white: "#ffffff",
  brand: "#0a7f5a",
  brand2: "#0f9d6f",
  brandSoft: "#e5f6ef",
  hover: "#f0faf6",
  warn: "#b45309",
  warnSoft: "#fef3c7",
  bad: "#b42318",
  badSoft: "#fee4e2",
  pp: "#003087",
  font: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
} as const;

// Chart series: greens first (money in), then neutrals, then the warm "late" tones.
const CHART = [SORTED.brand, SORTED.brand2, "#5cc29a", "#a7dfc6", SORTED.ink2, "#7d8b99", SORTED.warn, "#e3a008", SORTED.bad, SORTED.pp];
const line = (color: string) => ({ width: 1, color });

const palette = Object.fromEntries(
  CHART.flatMap((c, i) => [
    [`chartPaletteFills${i + 1}Color`, c],
    [`chartPaletteStrokes${i + 1}Color`, c],
  ]),
);

export const sortedStudioTheme = studioTheme.withParams({
  fontFamily: SORTED.font,
  fontSize: 14,
  textColor: SORTED.ink,
  foregroundColor: SORTED.ink,
  subtleTextColor: SORTED.muted,
  backgroundColor: SORTED.white,
  borderColor: SORTED.line,
  accentColor: SORTED.brand,
  iconColor: SORTED.ink2,
  rowHoverColor: SORTED.hover,

  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: SORTED.paper,
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: SORTED.paper,
  studioCanvasPadding: 12,
  studioCanvasRowHeight: 18,
  studioCanvasFontFamily: SORTED.font,

  // Widgets are Sorted's cards: white, 1px line border, 16px radius.
  studioWidgetBackgroundColor: SORTED.white,
  studioWidgetBorder: line(SORTED.line),
  studioWidgetBorderRadius: 16,
  studioWidgetPadding: 12,
  studioWidgetTitleFontFamily: SORTED.font,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 700,
  studioWidgetTitleTextColor: SORTED.ink,
  studioWidgetSubtitleFontFamily: SORTED.font,
  studioWidgetSubtitleFontSize: 12,
  studioWidgetSubtitleTextColor: SORTED.muted,
  studioWidgetCaptionFontFamily: SORTED.font,
  studioWidgetCaptionFontSize: 12,
  studioWidgetCaptionTextColor: SORTED.muted,
  studioWidgetResizeBorderColor: SORTED.brand,

  studioPanelContainerBackgroundColor: SORTED.white,
  studioPanelContainerBorder: line(SORTED.line),
  studioPanelContainerBorderRadius: 0,
  studioPanelDividerColor: SORTED.line,
  studioPanelDividerActiveColor: SORTED.brand,
  studioPanelSectionBorderColor: SORTED.line,
  studioPanelHeaderFontFamily: SORTED.font,
  studioPanelHeaderFontWeight: 700,
  studioPanelChevronButtonHoverBackgroundColor: SORTED.hover,
  studioPanelChevronButtonHoverColor: SORTED.brand,
  studioToggleButtonActiveBackgroundColor: SORTED.brandSoft,
  studioToggleButtonActiveBorderColor: SORTED.brand,
  studioToggleButtonActiveColor: SORTED.brand,

  gridFontFamily: SORTED.font,
  gridFontSize: 13,
  gridCellTextColor: SORTED.ink,
  gridHeaderBackgroundColor: SORTED.paper,
  gridHeaderTextColor: SORTED.muted,
  gridHeaderFontWeight: 600,
  gridHeaderFontSize: 12,
  gridRowHeight: 36,
  gridRowBorder: line(SORTED.line),
  gridHeaderRowBorder: line(SORTED.line),
  gridPinnedRowBorder: line(SORTED.line),
  gridRowHoverColor: SORTED.hover,
  gridWrapperBorder: false,

  chartFontFamily: SORTED.font,
  chartTextColor: SORTED.ink,
  chartSubtleTextColor: SORTED.muted,
  chartAxisLineColor: SORTED.line,
  chartGridLineColor: SORTED.line,
  ...palette,
});
