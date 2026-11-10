/**
 * reportPdf.ts — generates CRX-branded PDF reports (tabular data) in the quote PDF's design
 * Uses jsPDF + jspdf-autotable (dynamically imported to keep out of main bundle)
 *
 * Sprint 9: Generic Report PDF Generator
 */

import type { JsPDFWithAutoTable } from './pdfTheme';
import {
  QUOTE_CONTENT_BOTTOM, QUOTE_CONTINUED_TOP, QUOTE_LOGO_RATIO, QUOTE_LOGO_WIDTH, QUOTE_MARGIN_TOP, QUOTE_MARGIN_X,
  QUOTE_MUTED, QUOTE_ROW_RULE, QUOTE_TABLE_HEAD_BG, QUOTE_TEXT,
} from './quotePdfLayout';
import { drawCompanyBlock, drawPageFooters, loadLogoDrawer } from './pdfBrand';
import { localToday } from './dateUtils';
import { loadCompanyInfoForPdf } from './companyInfoForPdf';
import { formatUSD as fmtCurrency } from './money';



export interface ReportPdfColumn {
  header: string;
  key: string;
  align?: 'left' | 'center' | 'right';
  format?: (value: unknown) => string;
  width?: number;
}

export interface ReportPdfOptions {
  title: string;
  /** Names the downloaded file instead of the title. */
  fileName?: string;
  subtitle?: string;
  dateRange?: { start: string; end: string };
  columns: ReportPdfColumn[];
  data: Record<string, unknown>[];
  orientation?: 'portrait' | 'landscape';
  footerNote?: string;
  /**
   * Optional aggregated TOTALS row rendered as a bold final row in the table
   * (autotable `foot`). One cell per column, in the same order as `columns`;
   * a null/undefined/'' cell renders blank. Use this for a summed footer like
   * the job-list acre totals (criterion #3) so the printout's totals match the
   * on-screen bottom totals. Additive — existing callers that omit it are
   * unaffected.
   */
  totalsRow?: (string | number | null | undefined)[];
}

export async function generateReportPdf(options: ReportPdfOptions) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const company = await loadCompanyInfoForPdf();

  const doc = new jsPDF({
    orientation: options.orientation || 'landscape',
    unit: 'pt',
    format: 'letter',
  });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = QUOTE_MARGIN_X;
  const contentW = pageW - margin * 2;
  const pageBottom = pageH - QUOTE_CONTENT_BOTTOM;
  const drawLogo = await loadLogoDrawer(doc);
  let y = QUOTE_MARGIN_TOP;

  // Header row like the quote PDF: company block, logo with the report title under it, date range at right.
  const colW = (contentW - 32) / 3;
  const companyY = drawCompanyBlock(doc, company, y, colW);
  drawLogo(pageW / 2 - QUOTE_LOGO_WIDTH / 2, y, QUOTE_LOGO_WIDTH);
  const titleY = y + QUOTE_LOGO_WIDTH * QUOTE_LOGO_RATIO + 15;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13.5);
  doc.setTextColor(...QUOTE_TEXT);
  const titleLines = doc.splitTextToSize(options.title, colW + 32) as string[];
  titleLines.forEach((line, i) => doc.text(line, pageW / 2, titleY + i * 15, { align: 'center' }));
  if (options.dateRange?.start) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.25);
    doc.text(`${options.dateRange.start} — ${options.dateRange.end}`, pageW - margin, y + 9, { align: 'right' });
  }
  y = Math.max(companyY, titleY + (titleLines.length - 1) * 15);

  // Subtitle under the header
  if (options.subtitle) {
    y += 20;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...QUOTE_MUTED);
    doc.text(options.subtitle, margin, y);
  }
  y += 12;

  // Table
  const heads = [options.columns.map((c) => c.header)];
  const body = options.data.map((row) =>
    options.columns.map((col) => {
      const val = row[col.key];
      if (col.format) return col.format(val);
      if (val === null || val === undefined) return '';
      return String(val);
    })
  );

  const colStyles: Record<number, { halign?: string }> = {};
  options.columns.forEach((col, i) => {
    if (col.align) {
      colStyles[i] = { halign: col.align };
    }
  });

  // Optional aggregated TOTALS row -> autotable `foot` (bold, shaded). One cell
  // per column; a null/undefined cell renders blank. This keeps a printed totals
  // row aligned under its column (e.g. acre totals under the acre columns).
  const foot =
    options.totalsRow && options.totalsRow.length > 0
      ? [
          options.columns.map((_, i) => {
            const v = options.totalsRow?.[i];
            return v === null || v === undefined ? '' : String(v);
          }),
        ]
      : undefined;

  // Column-fit safety for WIDE column sets (criterion #4): wrap long cells onto
  // multiple lines and let autotable auto-size columns to the printable width so
  // no column is truncated off the page. Shrink the body font a touch when many
  // columns are present so a wide set still fits landscape letter.
  const wideColumns = options.columns.length > 8;
  const bodyFontSize = wideColumns ? 7 : 8;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, top: QUOTE_CONTINUED_TOP, bottom: QUOTE_CONTENT_BOTTOM },
    head: heads,
    body,
    foot,
    showHead: 'everyPage',
    // A grand-totals foot must appear ONCE on the last page, not repeated at the
    // bottom of every page (autotable defaults showFoot to 'everyPage'). Only set
    // it when a foot exists so non-totals reports are unaffected (Codex P2).
    ...(foot ? { showFoot: 'lastPage' as const } : {}),
    theme: 'plain',
    tableWidth: 'auto',
    styles: {
      font: 'helvetica',
      fontSize: bodyFontSize,
      cellPadding: { top: 3.75, bottom: 3.75, left: 4.5, right: 4.5 },
      textColor: QUOTE_TEXT,
      overflow: 'linebreak',
    },
    headStyles: { fillColor: QUOTE_TABLE_HEAD_BG, textColor: QUOTE_TEXT, fontStyle: 'bold' },
    bodyStyles: { lineColor: QUOTE_ROW_RULE, lineWidth: { bottom: 0.75, top: 0, left: 0, right: 0 } },
    footStyles: { textColor: QUOTE_TEXT, fontStyle: 'bold', lineColor: QUOTE_TEXT, lineWidth: { top: 1.5, bottom: 0, left: 0, right: 0 } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    columnStyles: colStyles as any,
    // Head and totals cells line up with their column, so money headers sit over right-aligned money.
    didParseCell: (cell) => {
      if (cell.section !== 'body') cell.cell.styles.halign = options.columns[cell.column.index]?.align ?? 'left';
    },
  });

  // Summary footer note
  if (options.footerNote) {
    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 14;
    if (y > pageBottom) {
      doc.addPage();
      y = QUOTE_CONTINUED_TOP + 9;
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.25);
    doc.setTextColor(...QUOTE_MUTED);
    doc.text(options.footerNote, margin, y);
  }

  drawPageFooters(doc, `${company.name}  •  Generated ${new Date().toLocaleDateString()}`, drawLogo);

  return doc;
}

export async function downloadReportPdf(options: ReportPdfOptions) {
  const doc = await generateReportPdf(options);
  const filename = (options.fileName ?? options.title).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  doc.save(`${filename}_${localToday()}.pdf`);
}

export { fmtCurrency };
