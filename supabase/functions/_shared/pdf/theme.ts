/**
 * theme.ts — shared typing and brand palette for the CRX PDF generators.
 *
 * Shared by the app (src/lib/pdfTheme.ts re-exports it) and the send-email Edge
 * Function, which draws invoice and purchase-order PDFs itself (KNOWN_ISSUES KI-98).
 * The `npm:` specifiers are type-only here; the app's tsconfig maps them to
 * node_modules. Keep the versions equal to package.json, so both sides draw the
 * same pages.
 */
import type { jsPDF } from "npm:jspdf@4.2.1";
import type { autoTable } from "npm:jspdf-autotable@5.0.9";

/** jsPDF instance with `lastAutoTable` from the jspdf-autotable plugin. */
export type JsPDFWithAutoTable = jsPDF & {
  lastAutoTable: { finalY: number };
};

/** The two PDF libraries, handed in by the caller (the app loads them lazily, Deno by npm: import). */
export interface PdfLib {
  jsPDF: typeof jsPDF;
  autoTable: typeof autoTable;
}

// ── CRX brand palette (RGB tuples, spread into jsPDF set*Color calls) ────────
export const CRX_GREEN: [number, number, number] = [26, 122, 80]; // #1A7A50 (crx-green in src/index.css)
export const CHARCOAL: [number, number, number] = [46, 46, 46]; // #2E2E2E
export const GRAY: [number, number, number] = [78, 78, 78]; // #4E4E4E
export const LIGHT_BG: [number, number, number] = [245, 250, 247]; // light green tint
export const RED: [number, number, number] = [220, 38, 38];
export const AMBER: [number, number, number] = [217, 119, 6];
export const TABLE_HEADER_BG: [number, number, number] = [240, 240, 240];
export const ALT_ROW_BG: [number, number, number] = [252, 252, 252];
export const BLUE: [number, number, number] = [37, 99, 235];

const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Format an integer number of CENTS as USD. Divides by 100. (src/lib/money.ts re-exports this.) */
export function formatCents(cents: number): string {
  return usdFormatter.format(cents / 100);
}

/** Today's date as the PDF footer prints it, in the business's time zone (the server runs on UTC). */
export function generatedDateLabel(now: Date = new Date()): string {
  return now.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
}
