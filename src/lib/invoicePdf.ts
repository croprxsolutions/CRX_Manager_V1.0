/**
 * invoicePdf.ts — CRX-branded Invoice PDFs for the app: Print, Old Print, batch print.
 * Uses jsPDF + jspdf-autotable (dynamically imported to keep out of the main bundle).
 *
 * The data reads and the current layout live in the Edge Functions' shared folder
 * (supabase/functions/_shared/pdf/invoicePdf.ts), so send-email draws an emailed
 * invoice with the same code (KNOWN_ISSUES KI-98). This file adds the browser parts:
 * the app's Supabase client, the "Old Print" layout, downloads and batch printing.
 *
 * Sprint 12: Invoice & Statement PDF Redesign
 */

import { supabase } from './db';
import { Sentry } from './sentry';
import { COMPANY_LEGAL_NAME, companyTaglineHeader, DEFAULT_COMPANY_INFO, fitCompanyNameFont } from './companyInfo';
import { loadCompanyInfoForPdf } from './companyInfoForPdf';
import { formatCents as fmt } from './money';
import type jsPDF from 'jspdf';
import { generatedDateLabel, type JsPDFWithAutoTable } from '../../supabase/functions/_shared/pdf/theme.ts';
import {
  buildDiluentLine,
  buildInvoicePdfDataFromRow as buildSharedInvoicePdfDataFromRow,
  deriveFieldAppAppliedAcres as deriveSharedFieldAppAppliedAcres,
  drawInvoicePdf,
  fmtDate,
  fmtNum,
  InvoiceLinesUnavailableError,
  isFuelSurchargeLine,
  productCellText,
  type InvoicePdfData,
  type InvoicePrintOptions,
  type InvoiceRowForPdf,
} from '../../supabase/functions/_shared/pdf/invoicePdf.ts';
import { invoiceLineEpaText } from '../../supabase/functions/_shared/brandNotes.ts';

export {
  assertInvoiceLinesLoaded,
  groupReturnCreditDisplayItems,
  InvoiceDetailsUnavailableError,
  isBillSplitInvoice,
  readsBillSplitPayers,
  loadBillSplitPayers,
  InvoiceLinesUnavailableError,
  isFuelSurchargeLine,
  mapInvoicePdfItem,
  type BillSplitPayer,
  type InvoicePdfData,
  type InvoicePdfItem,
  type InvoicePdfShare,
} from '../../supabase/functions/_shared/pdf/invoicePdf.ts';

/** Applied acres for a field-application invoice's diluent total (see the shared module). */
export function deriveFieldAppAppliedAcres(
  invoiceId: string,
  invoiceGroupId: string | null | undefined,
): Promise<number | null> {
  return deriveSharedFieldAppAppliedAcres(supabase, invoiceId, invoiceGroupId);
}

/**
 * Build a complete InvoicePdfData from a list row by fetching the line items,
 * shares, and customer billing fields (see the shared module).
 */
export function buildInvoicePdfDataFromRow(
  inv: InvoiceRowForPdf,
  options?: InvoicePrintOptions,
): Promise<InvoicePdfData> {
  return buildSharedInvoicePdfDataFromRow(supabase, inv, options);
}

export async function generateInvoicePdf(data: InvoicePdfData): Promise<JsPDFWithAutoTable> {
  if (!data.company) data = { ...data, company: await loadCompanyInfoForPdf() };
  // Field-app parity #30: route to the legacy ("Old Print") layout when asked.
  // Both formats consume the SAME InvoicePdfData, so the money lines are
  // identical — no recompute, Total/Payments/Prepay/Balance Due reconcile.
  if (data.options?.format === 'legacy') {
    return generateLegacyInvoicePdf(data);
  }
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  return drawInvoicePdf({ jsPDF, autoTable }, data);
}

const BATCH_PDF_CONCURRENCY = 5;

/**
 * Build PDF data for a batch print. An invoice whose lines could not be read is skipped,
 * reported to Sentry and named in `skipped`, so the rest still print. Any other error
 * fails the whole batch, and so does a batch where every invoice was skipped.
 */
export async function buildBatchInvoicePdfData<R extends { invoice_number: string }>(
  rows: R[],
  build: (row: R) => Promise<InvoicePdfData>,
): Promise<{ list: InvoicePdfData[]; skipped: string[] }> {
  const buildOrSkip = async (row: R): Promise<InvoicePdfData | null> => {
    try {
      return await build(row);
    } catch (err) {
      if (!(err instanceof InvoiceLinesUnavailableError)) throw err;
      Sentry.captureException(err, { level: 'warning', extra: { invoice_number: row.invoice_number, context: 'batch_invoice_pdf_skip' } });
      return null;
    }
  };
  // A few invoices at a time, so a large selection does not fire every read at once.
  const results: Array<InvoicePdfData | null> = [];
  for (let i = 0; i < rows.length; i += BATCH_PDF_CONCURRENCY) {
    results.push(...await Promise.all(rows.slice(i, i + BATCH_PDF_CONCURRENCY).map(buildOrSkip)));
  }
  const list = results.filter((d): d is InvoicePdfData => d !== null);
  const skipped = rows.filter((_, i) => results[i] === null).map((r) => r.invoice_number);
  if (list.length === 0 && skipped.length > 0) {
    throw new Error(`Could not load the invoice lines for ${listInvoiceNumbers(skipped)}, so no PDF was made. Please try again.`);
  }
  return { list, skipped };
}

/** Invoice numbers for a toast: the first five, then a count, so a large batch stays readable. */
function listInvoiceNumbers(numbers: string[]): string {
  if (numbers.length <= 5) return numbers.join(', ');
  return `${numbers.slice(0, 5).join(', ')} and ${numbers.length - 5} more`;
}

/**
 * The toast for a finished batch print: success, or a warning naming the invoices that were
 * skipped (lines not loaded) or whose PDF failed to build. `printed` counts only real downloads.
 */
export function batchInvoicePrintToast(
  printed: number,
  skipped: string[],
  failed: string[] = [],
): { type: 'success' | 'warning'; message: string } {
  if (skipped.length === 0 && failed.length === 0) return { type: 'success', message: `Printed ${printed} invoice(s)` };
  const parts = [`Printed ${printed} invoice(s).`];
  if (skipped.length > 0) parts.push(`Skipped ${listInvoiceNumbers(skipped)}: the invoice lines could not be loaded.`);
  if (failed.length > 0) parts.push(`Could not make the PDF for ${listInvoiceNumbers(failed)}.`);
  parts.push('Please print those again.');
  return { type: 'warning', message: parts.join(' ') };
}

// ── Legacy "Old Print" generator (field-app parity #30) ──────────────────────
// ChemMan offers a second print layout ("Old Print" / "Old Print All") that
// some growers still expect: a denser, monochrome, typewriter-style sheet with
// a plain text header (no green band), a compact line table, a grower-share
// block, and the same money totals. It is deliberately PLAIN — no brand colors,
// no rounded info boxes — so it photocopies / faxes cleanly like the old system.
//
// Money discipline: this consumes the SAME InvoicePdfData as the current format.
// It NEVER recomputes a total; the printed Total, line extended, Payments,
// Prepay, and Balance Due all come straight from the data object, so a legacy
// print of a posted invoice WITH a payment reconciles exactly (Total − Payments
// − Prepay = Balance Due), and a split's per-customer rows sum to the whole.
async function generateLegacyInvoicePdf(data: InvoicePdfData): Promise<JsPDFWithAutoTable> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const { deriveSplitRef } = await import('../components/field-app/customerSplit');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as JsPDFWithAutoTable;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const opts = data.options ?? { show_shares: true, show_price_per_acre: true, show_epa_registration: true };
  const company = data.company ?? DEFAULT_COMPANY_INFO;
  const isFieldApp = data.invoice_type === 'field_application';

  const black: [number, number, number] = [0, 0, 0];

  const drawLegacyFooter = () => {
    try {
      const footerY = pageH - 24;
      doc.setFontSize(7);
      doc.setFont('courier', 'normal');
      doc.setTextColor(120, 120, 120);
      doc.text(
        [COMPANY_LEGAL_NAME, company.email, '(Old Print format)', `Generated ${generatedDateLabel()}`].filter(Boolean).join('   '),
        pageW / 2,
        footerY,
        { align: 'center' },
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('invoicePdf: drawLegacyFooter failed', e);
    }
  };

  let y = margin;

  // ── Plain text header (no color band) ──────────────────────────────
  doc.setFont('courier', 'bold');
  doc.setTextColor(...black);
  fitCompanyNameFont(doc, company.name.toUpperCase(), pageW - margin * 2 - 110, 13);
  doc.text(company.name.toUpperCase(), margin, y);
  doc.setFont('courier', 'normal');
  doc.setFontSize(8);
  // A long Settings address wraps instead of running under the invoice number.
  doc.text(doc.splitTextToSize(companyTaglineHeader(company), pageW - margin * 2 - 100), margin, y + 13);

  doc.setFont('courier', 'bold');
  doc.setFontSize(11);
  doc.text('INVOICE', pageW - margin, y, { align: 'right' });
  doc.setFont('courier', 'normal');
  doc.setFontSize(9);
  doc.text(`No. ${data.invoice_number}`, pageW - margin, y + 13, { align: 'right' });
  doc.text(`Date: ${fmtDate(data.invoice_date)}`, pageW - margin, y + 25, { align: 'right' });
  if (data.status) {
    doc.text(`Status: ${data.status.toUpperCase()}`, pageW - margin, y + 37, { align: 'right' });
  }

  y += 30;
  // Rule under the header
  doc.setDrawColor(...black);
  doc.setLineWidth(0.8);
  doc.line(margin, y, pageW - margin, y);
  y += 16;

  // ── Bill-to + meta (two columns, plain text) ───────────────────────
  doc.setFont('courier', 'bold');
  doc.setFontSize(8);
  doc.text('BILL TO:', margin, y);
  doc.setFont('courier', 'normal');
  doc.setFontSize(9);
  let billY = y + 12;
  doc.text(data.customer_name.toUpperCase(), margin, billY);
  billY += 11;
  if (data.customer_address) { doc.text(data.customer_address, margin, billY); billY += 11; }
  const cityLine = [data.customer_city, data.customer_state, data.customer_zip].filter(Boolean).join(', ');
  if (cityLine) { doc.text(cityLine, margin, billY); billY += 11; }

  // Right meta column
  const metaX = pageW - margin - 170;
  let metaY = y;
  doc.setFontSize(8);
  const metaLine = (label: string, value: string) => {
    doc.setFont('courier', 'bold');
    doc.text(label, metaX, metaY);
    doc.setFont('courier', 'normal');
    doc.text(value, metaX + 70, metaY);
    metaY += 11;
  };
  if (data.account_number) metaLine('Account:', data.account_number);
  if (data.salesman_name) metaLine('Salesman:', data.salesman_name);
  if (data.purchase_order_ref) metaLine('PO Ref:', data.purchase_order_ref);
  metaLine('Due Date:', data.due_date ? fmtDate(data.due_date) : 'On receipt');
  if (data.payment_terms) metaLine('Terms:', data.payment_terms);

  y = Math.max(billY, metaY) + 8;

  // ── Field-application context line ─────────────────────────────────
  if (isFieldApp && (data.crop_type || data.total_acres || data.field_names?.length)) {
    doc.setFont('courier', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...black);
    const descParts = [
      data.crop_type,
      data.total_acres ? `${fmtNum(data.total_acres, 2)} ac` : null,
      data.field_names?.join(', '),
    ].filter(Boolean);
    const descLines = doc.splitTextToSize(descParts.join(' - '), pageW - margin * 2);
    doc.text(descLines, margin, y);
    y += descLines.length * 11 + 2;
  }

  // ── Diluent / carrier-water line (#2) ──────────────────────────────
  // Rate per acre + computed total (rate x applied acres). Omitted entirely when
  // no rate is recorded — never a phantom 0. A QUANTITY (gallons), never money.
  if (isFieldApp && data.diluent_gpa != null) {
    const diluentLine = buildDiluentLine(data.diluent_gpa, data.total_acres);
    if (diluentLine) {
      doc.setFont('courier', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...black);
      doc.text(diluentLine, margin, y);
      y += 11 + 2;
    }
  }

  // Header notes
  if (data.header_notes) {
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    const noteLines = doc.splitTextToSize(data.header_notes, pageW - margin * 2);
    doc.text(noteLines, margin, y);
    y += noteLines.length * 10 + 4;
  }

  // ── Line-item table (compact monochrome grid) ──────────────────────
  const showEpa = opts.show_epa_registration;
  let head: string[][];
  let body: string[][];

  if (isFieldApp) {
    head = showEpa
      ? [['Product', 'EPA Reg', 'Rate/Ac', 'Total Applied', 'Unit Price', 'Amount']]
      : [['Product', 'Rate/Ac', 'Total Applied', 'Unit Price', 'Amount']];
    body = data.items.map((item) => {
      const isFuel = isFuelSurchargeLine(item);
      const rateStr = isFuel
        ? ''
        : item.rate_per_acre != null
          ? `${fmtNum(item.rate_per_acre, 4)} ${item.rate_unit || item.unit_size || ''}`.trim()
          : '';
      const totalApplied = isFuel
        ? ''
        : item.total_applied != null
          ? `${fmtNum(item.total_applied, item.total_applied === Math.round(item.total_applied) ? 2 : 4)} ${item.total_applied_unit || ''}`.trim()
          : item.is_application_fee
            ? `${fmtNum(item.quantity, 2)} AC`
            : '';
      const unitPrice = isFuel
        ? fmtNum(item.unit_price_cents / 100, 2)
        : item.is_application_fee
          ? `${fmtNum(item.unit_price_cents / 100, 2)}/AC`
          : `${fmtNum(item.unit_price_cents / 100, 2)} ${item.gl_lb_unit || item.unit_size || ''}`.trim();
      const product = productCellText(item, data);
      return showEpa
        ? [product, invoiceLineEpaText(item.brand_lines, item.epa_registration), rateStr, totalApplied, unitPrice, fmt(item.extended_cents)]
        : [product, rateStr, totalApplied, unitPrice, fmt(item.extended_cents)];
    });
  } else {
    // Chemical-sale / misc legacy: Qty | Description | Unit | Amount
    head = [['Qty', 'Description', 'Unit Price', 'Amount']];
    body = data.items.map((item) => [
      fmtNum(item.quantity, 2),
      productCellText(item, data),
      fmt(item.unit_price_cents),
      fmt(item.extended_cents),
    ]);
  }

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body,
    theme: 'grid',
    styles: { font: 'courier', fontSize: 8, cellPadding: 3, textColor: black, lineColor: [120, 120, 120], lineWidth: 0.4 },
    headStyles: { fillColor: [255, 255, 255], textColor: black, fontStyle: 'bold', fontSize: 8, lineColor: black, lineWidth: 0.6 },
    columnStyles: isFieldApp
      ? (showEpa
        ? { 0: { cellWidth: 'auto' }, 1: { cellWidth: 56 }, 2: { halign: 'right', cellWidth: 58 }, 3: { halign: 'right', cellWidth: 78 }, 4: { halign: 'right', cellWidth: 62 }, 5: { halign: 'right', cellWidth: 62, fontStyle: 'bold' } }
        : { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 64 }, 2: { halign: 'right', cellWidth: 84 }, 3: { halign: 'right', cellWidth: 66 }, 4: { halign: 'right', cellWidth: 66, fontStyle: 'bold' } })
      : { 0: { cellWidth: 50, halign: 'right' }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 80 }, 3: { halign: 'right', cellWidth: 80, fontStyle: 'bold' } },
    didDrawPage: drawLegacyFooter,
  });

  y = doc.lastAutoTable.finalY + 8;

  // ── Price per acre (field-app, plain) ──────────────────────────────
  if (isFieldApp && opts.show_price_per_acre && data.total_acres && data.total_acres > 0) {
    const pricePerAcre = data.total_amount_cents / 100 / data.total_acres;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...black);
    doc.text(`Price per acre: ${fmtNum(pricePerAcre, 2)}`, margin, y);
    y += 14;
  }

  // ── Grower shares block (uses deriveSplitRef for the <base>-NNN label) ──
  if (opts.show_shares && data.shares && data.shares.length > 1) {
    const base = data.job_number || data.invoice_number;
    const hasPerAcre = data.shares.some((s) => s.price_per_acre_cents != null);
    // With no acres anywhere, drop the empty column and say Customer (Chem Man's word), which fits a Bill Split
    // payer (a landlord isn't a grower) and a legacy grower split alike.
    const hasAcres = data.shares.some((s) => s.acres != null);
    const shareHead = hasPerAcre
      ? [['Ref', 'Grower', '$/Acre', 'Share', 'Acres', 'Amount']]
      : hasAcres ? [['Ref', 'Grower', 'Share', 'Acres', 'Amount']] : [['Ref', 'Customer', 'Share', 'Amount']];
    const shareBody = data.shares.map((s, idx) => {
      const ref = s.invoice_number || deriveSplitRef(base, idx, true);
      const name = s.pricing_note ? `${s.customer_name} (${s.pricing_note})` : s.customer_name;
      return hasPerAcre
        ? [ref, name, s.price_per_acre_cents != null ? fmt(s.price_per_acre_cents) : '', `${fmtNum(s.split_percentage, 2)}%`, s.acres != null ? fmtNum(s.acres, 2) : '', fmt(s.amount_cents)]
        : hasAcres
          ? [ref, name, `${fmtNum(s.split_percentage, 2)}%`, s.acres != null ? fmtNum(s.acres, 2) : '', fmt(s.amount_cents)]
          : [ref, name, `${fmtNum(s.split_percentage, 2)}%`, fmt(s.amount_cents)];
    });
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: shareHead,
      body: shareBody,
      theme: 'grid',
      styles: { font: 'courier', fontSize: 7.5, cellPadding: 2.5, textColor: black, lineColor: [150, 150, 150], lineWidth: 0.4 },
      headStyles: { fillColor: [255, 255, 255], textColor: black, fontStyle: 'bold', fontSize: 7.5, lineColor: black, lineWidth: 0.6 },
      columnStyles: hasPerAcre
        ? { 0: { cellWidth: 62 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 52 }, 3: { halign: 'right', cellWidth: 46 }, 4: { halign: 'right', cellWidth: 46 }, 5: { halign: 'right', cellWidth: 60, fontStyle: 'bold' } }
        : hasAcres
          ? { 0: { cellWidth: 62 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 52 }, 3: { halign: 'right', cellWidth: 52 }, 4: { halign: 'right', cellWidth: 62, fontStyle: 'bold' } }
          : { 0: { cellWidth: 62 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 52 }, 3: { halign: 'right', cellWidth: 62, fontStyle: 'bold' } },
      didDrawPage: drawLegacyFooter,
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── Totals block (right-aligned, plain) ────────────────────────────
  if (y + 90 > pageH - 48) { doc.addPage(); y = margin; }

  const labelX = pageW - margin - 150;
  const valX = pageW - margin;
  doc.setFont('courier', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...black);

  const totalRow = (label: string, value: string, bold = false) => {
    doc.setFont('courier', bold ? 'bold' : 'normal');
    doc.text(label, labelX, y);
    doc.text(value, valX, y, { align: 'right' });
    y += 13;
  };

  totalRow('Subtotal:', fmt(data.total_amount_cents));
  if (data.paid_amount_cents > 0) totalRow('Payments:', `-${fmt(data.paid_amount_cents)}`);
  if (data.prepay_applied_cents > 0) totalRow('Prepay Applied:', `-${fmt(data.prepay_applied_cents)}`);
  if ((data.write_off_cents ?? 0) > 0) totalRow('Write-off:', `-${fmt(data.write_off_cents ?? 0)}`);
  if (data.finance_charge_cents && data.finance_charge_cents > 0) totalRow('Finance Charges:', fmt(data.finance_charge_cents));

  doc.setDrawColor(...black);
  doc.setLineWidth(0.6);
  doc.line(labelX, y - 4, valX, y - 4);
  y += 4;
  totalRow('BALANCE DUE:', fmt(data.balance_cents), true);
  // #33: informational Discount Earned line — recorded/printed, NOT deducted from the
  // balance (so Balance Due still reconciles to total − payments − prepay − write-off).
  if ((data.discount_earned_cents ?? 0) > 0) {
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(90, 90, 90);
    totalRow('Discount Earned (if paid early):', fmt(data.discount_earned_cents ?? 0));
    doc.setTextColor(...black);
    doc.setFontSize(9);
  }

  // ── Footer notes ───────────────────────────────────────────────────
  if (data.footer_notes) {
    y += 6;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    const lines = doc.splitTextToSize(data.footer_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
  }

  drawLegacyFooter();
  return doc;
}

// ── Layout 1: Field Application ──────────────────────────────────────────


export async function downloadInvoicePdf(data: InvoicePdfData) {
  const doc = await generateInvoicePdf(data);
  doc.save(`${data.invoice_number}.pdf`);
}

// ── Batch PDF Generator ──────────────────────────────────────────────────
// Generates each invoice as a separate PDF and downloads them sequentially.
// jsPDF doesn't support page-level merging between documents, so each
// invoice becomes its own file (same approach as batch statements).

// Returns the last document and the invoice numbers whose PDF failed to build, so the
// caller's toast counts only the PDFs that actually downloaded.
export async function generateBatchInvoicePdf(dataList: InvoicePdfData[]): Promise<{ doc: jsPDF; failures: string[] }> {
  if (dataList.length === 0) {
    throw new Error('No invoices to generate');
  }

  // A single invoice still downloads (a batch can drop to one after skipped invoices).
  if (dataList.length === 1) {
    const doc = await generateInvoicePdf(dataList[0]);
    doc.save(`${dataList[0].invoice_number}.pdf`);
    return { doc, failures: [] };
  }

  // Generate each invoice as a separate Blob, then combine into a single
  // download link using a zip-like concatenation of individual PDF saves.
  // Since each invoice can span multiple pages (autoTable paginates), we
  // can't simply addPage() across invoices. Instead, download sequentially
  // but only trigger ONE browser download using the first doc, and append
  // remaining as individual saves with requestAnimationFrame to avoid
  // popup blockers.
  // Use allSettled so one bad invoice doesn't crash the entire batch
  const company = await loadCompanyInfoForPdf();
  const results = await Promise.allSettled(dataList.map((d) => generateInvoicePdf({ ...d, company })));

  const docs: { doc: jsPDF; name: string }[] = [];
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      docs.push({ doc: r.value, name: dataList[i].invoice_number });
    } else {
      failures.push(dataList[i].invoice_number);
    }
  });

  if (docs.length === 0) {
    throw new Error(`All ${failures.length} invoice PDFs failed to generate`);
  }

  // Save first immediately (always allowed by browser)
  docs[0].doc.save(`${docs[0].name}.pdf`);

  // Queue remaining downloads spaced out via rAF to avoid popup blockers.
  // Most browsers allow sequential downloads from user-initiated actions.
  for (let i = 1; i < docs.length; i++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        docs[i].doc.save(`${docs[i].name}.pdf`);
        resolve();
      });
    });
  }

  if (failures.length > 0) {
    console.warn(`Batch PDF: ${failures.length} invoice(s) failed:`, failures);
  }

  return { doc: docs[docs.length - 1].doc, failures };
}

