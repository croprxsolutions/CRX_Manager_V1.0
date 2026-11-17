/**
 * pdfBrand.ts — the quote PDF's letterhead and footer, shared by the quote PDF and the list/report PDFs.
 */
import type { jsPDF } from 'jspdf';
import {
  QUOTE_FOOTER_BASELINE, QUOTE_FOOTER_RULE, QUOTE_FOOTER_TEXT, QUOTE_LOGO_RATIO, QUOTE_LOGO_SMALL_WIDTH,
  QUOTE_MARGIN_X, QUOTE_TEXT,
} from './quotePdfLayout';
import { companyTaglineHeader, fitCompanyNameFont, type CompanyInfo } from './companyInfo';

export type LogoDrawer = (x: number, top: number, w: number) => void;

/** Draws the logo, embedded once under one alias. Best-effort: a logo that fails to embed never stops the PDF. */
export async function loadLogoDrawer(doc: jsPDF): Promise<LogoDrawer> {
  const { default: logo } = await import('../assets/logo_quote_pdf.png?inline');
  return (x, top, w) => {
    try {
      doc.addImage(logo, 'PNG', x, top, w, w * QUOTE_LOGO_RATIO, 'crx-quote-logo', 'FAST');
    } catch { /* print without the logo */ }
  };
}

/** Company name, tagline, address and phone as saved in Settings, top-left. Returns the last baseline. */
export function drawCompanyBlock(doc: jsPDF, company: CompanyInfo, top: number, colW: number): number {
  const margin = QUOTE_MARGIN_X;
  doc.setTextColor(...QUOTE_TEXT);
  doc.setFont('helvetica', 'bold');
  fitCompanyNameFont(doc, company.name, colW, 9);
  // A long name wraps inside its column instead of running into the logo.
  let y = top + 9;
  (doc.splitTextToSize(company.name, colW) as string[]).forEach((line, i) => {
    if (i) y += 11;
    doc.text(line, margin, y);
  });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.25);
  // Today's letterhead tagline, address and phone, one per line; the address prints as saved in Settings.
  const tagline = companyTaglineHeader(company).split('  •  ')[0];
  for (const line of [tagline, ...(doc.splitTextToSize(company.address, colW) as string[]), company.phone]) {
    y += 12;
    doc.text(line, margin, y);
  }
  return y;
}

/** Every page: the small logo top-right from page 2, a dashed rule, the footer text and "Page X of Y". */
export function drawPageFooters(doc: jsPDF, footerText: string, drawLogo: LogoDrawer): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = QUOTE_MARGIN_X;
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    if (page > 1) drawLogo(pageW - margin - QUOTE_LOGO_SMALL_WIDTH, 24, QUOTE_LOGO_SMALL_WIDTH);
    const footerY = pageH - QUOTE_FOOTER_BASELINE;
    const pageLabel = `Page ${page} of ${pageCount}`;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...QUOTE_FOOTER_TEXT);
    const footerLines = doc.splitTextToSize(footerText, pageW - margin * 2 - doc.getTextWidth(pageLabel) - 18) as string[];
    const footerTop = footerY - (footerLines.length - 1) * 9;
    doc.setDrawColor(...QUOTE_FOOTER_RULE);
    doc.setLineWidth(0.75);
    doc.setLineDashPattern([2, 2], 0);
    doc.line(margin, footerTop - 14, pageW - margin, footerTop - 14);
    doc.setLineDashPattern([], 0);
    doc.text(footerLines, margin, footerTop);
    doc.text(pageLabel, pageW - margin, footerY, { align: 'right' });
  }
}
