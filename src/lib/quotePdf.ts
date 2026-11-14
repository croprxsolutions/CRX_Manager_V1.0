/**
 * quotePdf.ts — generates a professional Crop RX branded PDF for any quote
 * Uses jsPDF + jspdf-autotable (both already in package.json)
 *
 * GAP FIX #1: Quote PDF Generation
 */
// jsPDF and autoTable are dynamically imported inside each function
// to keep them out of the main bundle (~500KB each)
import { CRX_GREEN, GRAY, type JsPDFWithAutoTable } from './pdfTheme';
import {
  QUOTE_CONTENT_BOTTOM, QUOTE_CONTINUED_TOP, QUOTE_LOGO_RATIO, QUOTE_LOGO_WIDTH, QUOTE_MARGIN_TOP, QUOTE_MARGIN_X,
  QUOTE_MUTED, QUOTE_NOTE_BG, QUOTE_NUMBER_COLUMNS, QUOTE_ROW_RULE, QUOTE_TABLE_HEAD_BG, QUOTE_TEXT,
  QUOTE_TOTALS_RULE, QUOTE_TOTALS_WIDTH,
} from './quotePdfLayout';
import { COMPANY_WEBSITE } from './companyInfo';
import { drawCompanyBlock, drawPageFooters, loadLogoDrawer } from './pdfBrand';
import { loadCompanyInfoForPdf } from './companyInfoForPdf';
import { formatUSD as fmt } from './money';


type AutoTableColumnStyle = {
  cellWidth?: 'auto' | 'wrap' | number;
  halign?: 'left' | 'center' | 'right' | 'justify';
  fontStyle?: 'normal' | 'bold' | 'italic' | 'bolditalic';
};


interface PdfQuoteSection {
  section_name: string;
  section_notes?: string;
  section_header_notes?: string;
  items: PdfQuoteItem[];
}

interface PdfQuoteItem {
  product_name: string;
  category?: string;
  notes?: string;
  suggested_rate?: string;
  actual_rate: number;
  rate_unit: string;
  acres: number;
  total_units_needed: number;
  inventory_unit?: string;
  unit_size?: string;
  price_unit?: string;
  price_per_unit: number;
  price_per_acre?: number;
  total_price: number;
}

interface PdfQuoteData {
  quote_number: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  sales_rep_name: string;
  created_at: string;
  expires_at: string;
  tier: number;
  header_notes?: string;
  footer_notes?: string;
  sections: PdfQuoteSection[];
  totals: {
    totalPrice: number;
    totalCost: number;
    totalProfit: number;
    avgMargin: number;
  };
}

// Column definitions for the dynamic PDF column system
const PDF_COLUMN_DEFS: Record<string, { label: string; getValue: (item: PdfQuoteItem) => string; align?: 'right' }> = {
  product: { label: 'Product', getValue: (item) => item.product_name },
  category: { label: 'Category', getValue: (item) => item.category || '' },
  notes: { label: 'Notes', getValue: (item) => item.notes || '' },
  sug_rate: { label: 'Sug. Rate', getValue: (item) => item.suggested_rate || '-' },
  actual_rate: { label: 'Rate', getValue: (item) => `${item.actual_rate} ${item.rate_unit}` },
  rate_unit: { label: 'Unit', getValue: (item) => item.rate_unit || '' },
  acres: { label: 'Acres', getValue: (item) => item.acres?.toLocaleString() || '0' },
  qty: { label: 'Qty', getValue: (item) => `${item.total_units_needed?.toLocaleString() || '0'}${item.inventory_unit ? ' ' + item.inventory_unit : ''}` },
  unit_size: { label: 'Container', getValue: (item) => item.unit_size || '' },
  price_unit: { label: 'Price/Unit', getValue: (item) => `${fmt(item.price_per_unit)}${item.price_unit || item.inventory_unit ? '/' + (item.price_unit || item.inventory_unit) : ''}`, align: 'right' },
  price_per_acre: { label: '$/Acre', getValue: (item) => item.price_per_acre ? fmt(item.price_per_acre) : '-', align: 'right' },
  total_price: { label: 'Total', getValue: (item) => fmt(item.total_price), align: 'right' },
};

// Default columns when none specified (matches legacy behavior)
const DEFAULT_PDF_COLUMNS = ['product', 'actual_rate', 'acres', 'qty', 'price_unit', 'total_price'];

// The label/value pairs in the header's details table.
function quoteDetails(data: PdfQuoteData): [string, string][] {
  return [
    ['Quote #', data.quote_number],
    ['Quote date', new Date(data.created_at).toLocaleDateString()],
    ['Valid until', new Date(data.expires_at).toLocaleDateString()],
    ['Prepared by', data.sales_rep_name],
  ];
}

export async function generateQuotePdf(data: PdfQuoteData, columns?: string[]) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const company = await loadCompanyInfoForPdf();

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = QUOTE_MARGIN_X;
  const contentW = pageW - margin * 2;
  const pageBottom = pageH - QUOTE_CONTENT_BOTTOM;
  let y = QUOTE_MARGIN_TOP;

  const newPage = () => {
    doc.addPage();
    y = QUOTE_CONTINUED_TOP;
  };
  const drawLogo = await loadLogoDrawer(doc);

  // ─── Header row: company block, logo + "Quote", details table ──
  const colW = (contentW - 32) / 3;
  const companyY = drawCompanyBlock(doc, company, y, colW);

  drawLogo(pageW / 2 - QUOTE_LOGO_WIDTH / 2, y, QUOTE_LOGO_WIDTH);
  const quoteWordY = y + QUOTE_LOGO_WIDTH * QUOTE_LOGO_RATIO + 15;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13.5);
  doc.text('Quote', pageW / 2, quoteWordY, { align: 'center' });

  const details = quoteDetails(data);
  doc.setFontSize(8.25);
  const labelW = Math.max(...details.map(([label]) => doc.getTextWidth(label))) + 9;
  doc.setFont('helvetica', 'normal');
  // Values wrap inside the right-hand column, so a long rep name or quote number never reaches the logo.
  const detailLines = details.map(([, value]) => doc.splitTextToSize(value, colW - labelW) as string[]);
  const valueW = Math.max(...detailLines.flat().map((line) => doc.getTextWidth(line)));
  const detailsX = pageW - margin - labelW - valueW;
  let detailsY = y + 9;
  details.forEach(([label], i) => {
    doc.setFont('helvetica', 'bold');
    doc.text(label, detailsX, detailsY);
    doc.setFont('helvetica', 'normal');
    for (const line of detailLines[i]) {
      doc.text(line, detailsX + labelW, detailsY);
      detailsY += 12;
    }
  });
  y = Math.max(companyY, quoteWordY, detailsY - 12);

  // ─── Prepared for (where a window envelope shows it) ──────
  const forX = margin + 27;
  y += 30;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...QUOTE_MUTED);
  doc.text('PREPARED FOR', forX, y);
  doc.setTextColor(...QUOTE_TEXT);
  doc.setFontSize(9);
  y += 13;
  doc.text(data.customer_name, forX, y);
  doc.setFont('helvetica', 'normal');
  const contactLine = [data.customer_phone, data.customer_email].filter(Boolean).join('  ·  ');
  const forLines = [
    ...(data.customer_address ? (doc.splitTextToSize(data.customer_address, colW * 1.5) as string[]) : []),
    ...(contactLine ? [contactLine] : []),
  ];
  for (const line of forLines) {
    y += 13;
    doc.text(line, forX, y);
  }
  y += 8;

  // Wrapped note, one line at a time so a long note continues on a new page
  // instead of printing over the footer area.
  const drawNote = (text: string, lineHeight: number, indent = 4) => {
    for (const line of doc.splitTextToSize(text, contentW - indent * 2) as string[]) {
      if (y + lineHeight > pageBottom) newPage();
      doc.text(line, margin + indent, y + lineHeight - 6);
      y += lineHeight;
    }
    y += 4;
  };
  // Header and bottom notes: the same wrapped note in a light grey box, split across pages if long.
  const drawBoxedNote = (text: string) => {
    const padX = 7.5;
    const padY = 6;
    const lineHeight = 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.25);
    doc.setTextColor(...QUOTE_TEXT);
    const lines = doc.splitTextToSize(text, contentW - padX * 2) as string[];
    while (lines.length) {
      const fits = Math.floor((pageBottom - y - padY * 2) / lineHeight);
      if (fits < 1) { newPage(); continue; }
      const chunk = lines.splice(0, fits);
      doc.setFillColor(...QUOTE_NOTE_BG);
      doc.rect(margin, y, contentW, chunk.length * lineHeight + padY * 2, 'F');
      chunk.forEach((line, i) => doc.text(line, margin + padX, y + padY + (i + 1) * lineHeight - 3));
      y += chunk.length * lineHeight + padY * 2;
      if (lines.length) newPage();
    }
  };

  // ─── Header notes ─────────────────────────────────────────
  if (data.header_notes) {
    y += 10;
    drawBoxedNote(data.header_notes);
  }

  // ─── Sections: bold title over a green rule, plain grey table head ──
  const activeCols = (columns || DEFAULT_PDF_COLUMNS).filter((c) => PDF_COLUMN_DEFS[c]);
  // Build column styles: right-align numbers and money, last col bold
  const colStyles: Record<number, AutoTableColumnStyle> = { 0: { cellWidth: 'auto' } };
  activeCols.forEach((c, i) => {
    if (PDF_COLUMN_DEFS[c].align === 'right' || QUOTE_NUMBER_COLUMNS.has(c)) {
      colStyles[i] = { ...(colStyles[i] || {}), halign: 'right' };
    }
    // Bold the last column (usually total)
    if (i === activeCols.length - 1 && PDF_COLUMN_DEFS[c].align === 'right') {
      colStyles[i] = { ...(colStyles[i] || {}), fontStyle: 'bold' };
    }
  });
  const headerRow = activeCols.map((c, i) => ({
    content: PDF_COLUMN_DEFS[c].label,
    styles: { halign: colStyles[i]?.halign ?? ('left' as const) },
  }));
  const sectionTotal = (section: PdfQuoteSection) => section.items.reduce((sum, item) => sum + item.total_price, 0);

  for (const section of data.sections) {
    // The section needs room for its title, table heading and a row
    y += 16;
    if (y + 70 > pageBottom) newPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...QUOTE_TEXT);
    doc.text(section.section_name.toUpperCase(), margin, y + 9);
    doc.setDrawColor(...CRX_GREEN);
    doc.setLineWidth(1.125);
    doc.line(margin, y + 13, pageW - margin, y + 13);
    y += 17;

    // Section header notes (above items table)
    if (section.section_header_notes) {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(...GRAY);
      drawNote(section.section_header_notes, 11);
    }

    const rows = section.items.map((item) =>
      activeCols.map((c) => PDF_COLUMN_DEFS[c].getValue(item))
    );

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin, top: QUOTE_CONTINUED_TOP, bottom: QUOTE_CONTENT_BOTTOM },
      head: [headerRow],
      body: rows,
      showHead: 'everyPage',
      theme: 'plain',
      styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 3.75, bottom: 3.75, left: 4.5, right: 4.5 }, textColor: QUOTE_TEXT },
      headStyles: { fillColor: QUOTE_TABLE_HEAD_BG, textColor: QUOTE_TEXT, fontStyle: 'bold' },
      bodyStyles: { lineColor: QUOTE_ROW_RULE, lineWidth: { bottom: 0.75, top: 0, left: 0, right: 0 } },
      columnStyles: colStyles,
    });

    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY;
    if (y + 14 > pageBottom) newPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.25);
    doc.setTextColor(...QUOTE_TEXT);
    doc.text(`Section total: ${fmt(sectionTotal(section))}`, pageW - margin - 4.5, y + 11, { align: 'right' });
    y += 16;

    if (section.section_notes) {
      doc.setFontSize(8);
      doc.setTextColor(...GRAY);
      doc.setFont('helvetica', 'italic');
      drawNote(section.section_notes, 10);
    }
  }

  // ─── Totals box: each section, then the quote total ───────
  const totalsX = pageW - margin - QUOTE_TOTALS_WIDTH;
  doc.setFontSize(8.25);
  doc.setFont('helvetica', 'normal');
  const totalsRows = data.sections.map((section) => {
    const amount = fmt(sectionTotal(section));
    const labelLines = doc.splitTextToSize(section.section_name, QUOTE_TOTALS_WIDTH - doc.getTextWidth(amount) - 9) as string[];
    return { labelLines, amount };
  });
  const totalsH = totalsRows.reduce((h, r) => h + r.labelLines.length * 12, 0) + 40;
  y += 15;
  if (y + totalsH > pageBottom) newPage();
  doc.setDrawColor(...QUOTE_TEXT);
  doc.setLineWidth(1.5);
  doc.line(totalsX, y, pageW - margin, y);
  y += 4;
  doc.setTextColor(...QUOTE_TEXT);
  for (const { labelLines, amount } of totalsRows) {
    doc.text(labelLines, totalsX, y + 10);
    doc.text(amount, pageW - margin, y + 10, { align: 'right' });
    y += labelLines.length * 12;
  }
  y += 5;
  doc.setDrawColor(...QUOTE_TOTALS_RULE);
  doc.setLineWidth(0.75);
  doc.line(totalsX, y, pageW - margin, y);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.75);
  doc.text('Quote total', totalsX, y + 18);
  doc.setFontSize(13.5);
  doc.setTextColor(...CRX_GREEN);
  doc.text(fmt(data.totals.totalPrice), pageW - margin, y + 18, { align: 'right' });
  y += 26;

  // ─── Bottom note, after the totals ────────────────────────
  if (data.footer_notes) {
    y += 10;
    drawBoxedNote(data.footer_notes);
  }

  // ─── Every page: small logo from page 2, footer with page number ──
  const footerText = [company.name, COMPANY_WEBSITE, company.email, 'Prices valid for the period shown above. Subject to product availability.']
    .filter(Boolean)
    .join('  •  ');
  drawPageFooters(doc, footerText, drawLogo);

  return doc;
}

/** Convenience: generate + immediately download */
export async function downloadQuotePdf(data: PdfQuoteData, columns?: string[]) {
  const doc = await generateQuotePdf(data, columns);
  doc.save(`${data.quote_number}.pdf`);
}
