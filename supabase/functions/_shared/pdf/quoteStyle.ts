/**
 * quoteStyle.ts — the quote PDF's look (src/lib/quotePdfLayout.ts and pdfBrand.ts on the Quotes branch), copied
 * here for the invoice PDF: this file also runs in Deno for the emailed invoice, which cannot import src.
 * Keep the values equal to the quote PDF's until both share one copy. US Letter, points.
 */
import type { jsPDF } from "npm:jspdf@4.2.1";
import { companyTaglineHeader, type CompanyInfo, DEFAULT_COMPANY_INFO, fitCompanyNameFont } from "./companyInfo.ts";
import { CRX_LOGO_HEIGHT_PX, CRX_LOGO_PNG_BASE64, CRX_LOGO_WIDTH_PX } from "./crxLogo.ts";

type RGB = [number, number, number];

export const Q_TEXT: RGB = [31, 31, 31]; // #1f1f1f
export const Q_MUTED: RGB = [90, 90, 90]; // #5a5a5a, labels
export const Q_FOOTER_TEXT: RGB = [74, 74, 74]; // #4a4a4a
export const Q_NOTE_BG: RGB = [246, 246, 246]; // #f6f6f6
export const Q_TABLE_HEAD_BG: RGB = [238, 238, 238]; // #eeeeee
export const Q_ROW_RULE: RGB = [227, 227, 227]; // #e3e3e3
export const Q_TOTALS_RULE: RGB = [200, 200, 200]; // #c8c8c8
const Q_FOOTER_RULE: RGB = [154, 154, 154]; // #9a9a9a, dashed

export const Q_MARGIN_X = 42;
export const Q_MARGIN_TOP = 36;
/** Where content starts on page 2 and later, below the small logo. */
export const Q_CONTINUED_TOP = 60;
/** Content stops this far from the bottom; the footer sits below. */
export const Q_CONTENT_BOTTOM = 66;
const Q_FOOTER_BASELINE = 30;

export const Q_LOGO_RATIO = CRX_LOGO_HEIGHT_PX / CRX_LOGO_WIDTH_PX;
export const Q_LOGO_WIDTH = 142.5;
const Q_LOGO_SMALL_WIDTH = 64;
export const Q_TOTALS_WIDTH = 210;

/** The quote table look for jspdf-autotable: plain, grey head, a thin rule under each row, head on every page. */
export const Q_TABLE = {
  theme: "plain" as const,
  showHead: "everyPage" as const,
  margin: { top: Q_CONTINUED_TOP, bottom: Q_CONTENT_BOTTOM },
  styles: { font: "helvetica", fontSize: 8, cellPadding: { top: 3.75, bottom: 3.75, left: 4.5, right: 4.5 }, textColor: Q_TEXT },
  headStyles: { fillColor: Q_TABLE_HEAD_BG, textColor: Q_TEXT, fontStyle: "bold" as const },
  bodyStyles: { lineColor: Q_ROW_RULE, lineWidth: { bottom: 0.75, top: 0, left: 0, right: 0 } },
};

/** Draws the logo, embedded once under one alias. Best-effort: a logo that fails to embed never stops the PDF. */
export function drawLogo(doc: jsPDF, x: number, top: number, w: number): void {
  try {
    doc.addImage(CRX_LOGO_PNG_BASE64, "PNG", x, top, w, w * Q_LOGO_RATIO, "crx-logo", "FAST");
  } catch { /* print without the logo */ }
}

/** Company name, tagline, address and phone as saved in Settings, top-left; a blank address prints the default town, as the old header did. Returns the last baseline. */
export function drawCompanyBlock(doc: jsPDF, company: CompanyInfo, top: number, colW: number): number {
  doc.setTextColor(...Q_TEXT);
  doc.setFont("helvetica", "bold");
  fitCompanyNameFont(doc, company.name, colW, 9);
  let y = top + 9;
  (doc.splitTextToSize(company.name, colW) as string[]).forEach((line, i) => {
    if (i) y += 11;
    doc.text(line, Q_MARGIN_X, y);
  });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.25);
  const tagline = companyTaglineHeader(company).split("  •  ")[0];
  const address = company.address.trim() || DEFAULT_COMPANY_INFO.address;
  for (const line of [tagline, ...(doc.splitTextToSize(address, colW) as string[]), company.phone]) {
    y += 12;
    doc.text(line, Q_MARGIN_X, y);
  }
  return y;
}

/** Every page: the small logo top-right from page 2, a dashed rule, the footer text and "Page X of Y". */
export function drawPageFooters(doc: jsPDF, footerText: string): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = Q_MARGIN_X;
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    if (page > 1) drawLogo(doc, pageW - margin - Q_LOGO_SMALL_WIDTH, 24, Q_LOGO_SMALL_WIDTH);
    const footerY = pageH - Q_FOOTER_BASELINE;
    const pageLabel = `Page ${page} of ${pageCount}`;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...Q_FOOTER_TEXT);
    const footerLines = doc.splitTextToSize(footerText, pageW - margin * 2 - doc.getTextWidth(pageLabel) - 18) as string[];
    const footerTop = footerY - (footerLines.length - 1) * 9;
    doc.setDrawColor(...Q_FOOTER_RULE);
    doc.setLineWidth(0.75);
    doc.setLineDashPattern([2, 2], 0);
    doc.line(margin, footerTop - 14, pageW - margin, footerTop - 14);
    doc.setLineDashPattern([], 0);
    doc.text(footerLines, margin, footerTop);
    doc.text(pageLabel, pageW - margin, footerY, { align: "right" });
  }
}
