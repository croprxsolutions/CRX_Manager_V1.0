/**
 * masterMixSummaryPdf — the print-ready, cross-job Master Mix Summary PDF
 * (field-app parity #14).
 *
 * This is the loader's batch-prep sheet: prepare a whole batch of jobs at once from one
 * document. It has two parts:
 *
 *   • COMBINED MIX — one row per product+unit: the TOTAL of each product to mix across
 *       the whole batch (summed), with the gallon/lb-equivalent re-derived from the
 *       summed quantity. Numbers come from the pure `buildMasterMixSummaryData`
 *       aggregator (the same #12 keying + gal/lb re-derivation), so a single included
 *       job's figures equal that job's own Chemical Application Report (#11).
 *   • LOADS PICTURE — ONE combined loads block per distinct tank capacity + carrier
 *       rate. Same-capacity jobs share a block (their batch's combined per-load split);
 *       different-capacity jobs each get their own block (NEVER averaged), each block
 *       stating which jobs it covers. Jobs missing a capacity / carrier rate are listed
 *       under "Loads need a capacity" with the #10 guard wording — their mix is still in
 *       the combined totals above.
 *
 * Then the included-jobs and (never silently) the excluded-jobs lists, so the combined
 * total is never quietly wrong.
 *
 * Loader/office-facing batch sheet → companyFooterThanks. Landscape (the per-load
 * tables can be wide). Follows the shared dynamic-import + helper pattern of
 * applicatorSheetPdf.ts (drawFooter / ensureRoom, dynamic jsPDF + jspdf-autotable).
 */
import { CRX_GREEN, CHARCOAL, GRAY, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { companyFooterThanks, fitCompanyNameFont, type CompanyInfo } from './companyInfo';
import { loadCompanyInfoForPdf } from './companyInfoForPdf';
import { fmtNum } from './applicatorSheetData';
import type { MasterMixSummaryData, MasterMixLoadGroup } from './masterMixSummaryData';

/** Footer rule + customer-safe company line on every page. */
function drawFooter(doc: JsPDFWithAutoTable, margin: number, company: CompanyInfo): void {
  const pageW = doc.internal.pageSize.getWidth();
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY, pageW - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(doc.splitTextToSize(companyFooterThanks(company), pageW - margin * 2).slice(0, 2), pageW / 2, footerY + 12, { align: 'center' });
}

/** Page-break guard: add a page when the next block won't fit. Returns new y. */
function ensureRoom(doc: JsPDFWithAutoTable, y: number, needed: number, margin: number): number {
  if (y + needed > doc.internal.pageSize.getHeight() - 60) {
    doc.addPage();
    return margin;
  }
  return y;
}

/** The weights caption (or why weights are not shown) under a table; returns new y. */
function drawWeightCaption(doc: JsPDFWithAutoTable, caption: string | null, margin: number, pageW: number, y: number): number {
  if (!caption) return y;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8.5);
  doc.setTextColor(...GRAY);
  const lines = doc.splitTextToSize(caption, pageW - margin * 2);
  doc.text(lines, margin, y - 6);
  return y + lines.length * 10;
}

/**
 * The per-load table's rows: Product | Load 1 | … | Total. With `g.weights` (DM-2), each cell prints the
 * weighed amount (a refused amount prints its reason, never 0) with its weight under it, and a
 * "Product weight" row closes the table, as on the loader worksheet.
 */
export function masterMixLoadBody(g: MasterMixLoadGroup): string[][] {
  const ws = g.worksheet;
  const w = g.weights;
  // The first load carries every group product in order (computeLoaderWorksheet pushes one entry per input
  // product onto each load), so its product list IS the row order and load.products[pi] is THIS product line.
  const body: string[][] = (ws.loads[0]?.products ?? []).map((fp, pi) => {
    const row: string[] = [fp.unit ? `${fp.product_name} (${fp.unit})` : fp.product_name];
    let rowTotal = 0;
    let refused = false;
    ws.loads.forEach((l, li) => {
      const lp = l.products[pi];
      if (!lp) {
        row.push('—');
        return;
      }
      rowTotal = Math.round((rowTotal + lp.amount) * 10000) / 10000;
      const cell = w?.loads[li]?.cells[pi];
      if (!cell) {
        row.push(fmtNum(lp.amount));
        return;
      }
      // Judge each load on its own: one refused load withholds only the row total, never another load's weight.
      const cellRefused = cell.amountCell !== fmtNum(lp.amount);
      if (cellRefused) refused = true;
      row.push(cellRefused ? cell.amountCell : `${cell.amountCell}\n${cell.weightText}`);
    });
    row.push(refused ? '—' : fmtNum(rowTotal));
    return row;
  });
  if (w && body.length > 0) {
    body.push(['Product weight', ...w.loads.map((load) =>
      load.totalLb != null ? load.totalText.replace(/^Product weight: /, '') : load.totalText), '']);
  }
  return body;
}

/** Draw ONE combined-loads block (group summary + per-load split) for a capacity group. */
function drawLoadGroup(
  doc: JsPDFWithAutoTable,
  autoTable: typeof import('jspdf-autotable').default,
  g: MasterMixLoadGroup,
  margin: number,
  pageW: number,
  startY: number,
  groupIndex: number,
  groupCount: number,
  weightsCaption: string | null,
): number {
  let y = ensureRoom(doc, startY, 90, margin);
  const ws = g.worksheet;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  const title = groupCount > 1
    ? `Loads Group ${groupIndex + 1} of ${groupCount} — ${g.capacity_label}`
    : `Combined Loads — ${g.capacity_label}`;
  doc.text(title, margin, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  const coverLines = doc.splitTextToSize(
    `Covers job(s): ${g.job_numbers.join(', ')}     ·     Batch acres: ${fmtNum(g.total_acres) || '0'}`
    + (ws.valid ? `     ·     Spray volume: ${fmtNum(ws.spray_volume)} gal     ·     Loads: ${ws.loads_count}`
      + (ws.partial_load_volume > 0 ? `  (last is partial: ${fmtNum(ws.partial_load_volume)} gal)` : '') : ''),
    pageW - margin * 2,
  );
  doc.text(coverLines, margin, y);
  y += coverLines.length * 11 + 6;

  if (!ws.valid) {
    y = ensureRoom(doc, y, 40, margin);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    const reason = doc.splitTextToSize(ws.invalid_reason || 'Loads cannot be calculated for this group.', pageW - margin * 2);
    doc.text(reason, margin, y);
    return y + reason.length * 11 + 12;
  }

  // Per-load table: Product | Load 1 | … | Total. Mirrors the #10 loader layout.
  const head: string[] = ['Product'];
  ws.loads.forEach((l) => {
    head.push(`Load ${l.load_number}\n${fmtNum(l.volume)} gal${l.is_partial ? ' (partial)' : ''}`);
  });
  head.push('Total');
  const body = masterMixLoadBody(g);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [head],
    body: body.length > 0 ? body : [['No products to mix', ...ws.loads.map(() => '—'), '—']],
    // An amount and the weight printed under it stay on one page.
    rowPageBreak: 'avoid',
    styles: { fontSize: 9, cellPadding: 4, halign: 'right' },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold', halign: 'center', fontSize: 8 },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
    columnStyles: { 0: { halign: 'left', fontStyle: 'bold', textColor: CHARCOAL } },
  });
  return drawWeightCaption(doc, weightsCaption, margin, pageW, doc.lastAutoTable.finalY + 16) + 4;
}

/** Draw the cross-job master mix summary onto the doc. */
function drawMasterMix(
  doc: JsPDFWithAutoTable,
  autoTable: typeof import('jspdf-autotable').default,
  data: MasterMixSummaryData,
  company: CompanyInfo,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  const jobsMixed = data.included_jobs.length;

  // ── Header band ──────────────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 56, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('Master Mix Summary', margin, 26);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  fitCompanyNameFont(doc, company.name, pageW / 2 - margin, 9);
  doc.text(company.name, margin, 40);
  fitCompanyNameFont(doc, company.address, pageW / 2 - margin, 9);
  doc.text(company.address, margin, 50);
  doc.setFontSize(9);
  doc.text(`${jobsMixed} job${jobsMixed !== 1 ? 's' : ''} in this batch`, pageW - margin, 26, { align: 'right' });
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, pageW - margin, 40, { align: 'right' });
  y = 74;

  // ── Batch summary line ───────────────────────────────────────────────────────
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Combined tank mix to prepare for this batch', margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...GRAY);
  const summaryParts = [
    `Distinct products: ${data.distinct_product_lines}`,
    `Jobs included: ${jobsMixed}`,
    `Total acres: ${fmtNum(data.total_acres) || '0'}`,
  ];
  if (data.excluded_jobs.length > 0) summaryParts.push(`Jobs excluded: ${data.excluded_jobs.length}`);
  doc.text(summaryParts.join('     ·     '), margin, y);
  y += 18;

  // ── Combined per-product mix totals (the core) ───────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Combined Mix Totals', margin, y);
  y += 6;

  if (data.rows.length === 0) {
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...GRAY);
    doc.text('No product quantities to mix for the included jobs.', margin, y);
    y += 16;
  } else {
    // DM-2: a Weight column (each job line weighed on its own, then added) whenever weights were asked for.
    const weighed = data.weights_caption != null;
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Product', 'Total to Mix', 'gal/lb Equiv.', ...(weighed ? ['Weight'] : []), 'Jobs']],
      body: data.rows.map((r) => [
        r.product_name,
        r.total_quantity_display,
        r.gl_lb_display,
        ...(weighed ? [r.weight_text ?? '—'] : []),
        String(r.job_count),
      ]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
      columnStyles: weighed
        ? { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right', cellWidth: 200 }, 4: { halign: 'right' } }
        : { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    });
    y = drawWeightCaption(doc, data.weights_caption, margin, pageW, doc.lastAutoTable.finalY + 16) + 2;
  }

  // ── Loads picture (per-capacity combined blocks; never averaged) ─────────────
  y = ensureRoom(doc, y, 40, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...CHARCOAL);
  doc.text('Loads to Mix', margin, y);
  y += 14;

  if (data.mixed_capacities) {
    // Criterion 6 + Codex P1: when jobs differ in tank capacity, carrier rate, OR tank
    // recipe, say so plainly — the loads are grouped (one combined plan per identical
    // capacity+rate+recipe), NEVER averaged into one fake figure and never told to mix one
    // job's product into another job's load.
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    const note = doc.splitTextToSize(
      'The selected jobs differ in tank capacity, carrier rate, or tank recipe, so loads are shown in '
      + 'separate groups (one combined plan per matching capacity + rate + recipe). The combined mix totals '
      + 'above still cover every included job.',
      pageW - margin * 2,
    );
    doc.text(note, margin, y);
    y += note.length * 11 + 8;
  }

  if (data.load_groups.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...GRAY);
    const msg = doc.splitTextToSize(
      'No loads could be planned — none of the included jobs has a tank capacity and carrier rate. '
      + 'The combined mix totals above are still complete; enter a capacity and carrier rate to plan loads.',
      pageW - margin * 2,
    );
    doc.text(msg, margin, y);
    y += msg.length * 12 + 12;
  } else {
    data.load_groups.forEach((g, i) => {
      y = drawLoadGroup(doc, autoTable, g, margin, pageW, y, i, data.load_groups.length, data.weights_caption);
    });
  }

  // ── Jobs whose loads could not be planned (mix still counted) ────────────────
  // The reason VARIES per job (missing capacity, missing carrier rate, or unreadable),
  // so the heading stays NEUTRAL and the per-job "What is missing" column carries the
  // exact corrective action — a capacity-only heading would mislabel the rate / read
  // cases (Codex P3).
  if (data.no_load_jobs.length > 0) {
    y = ensureRoom(doc, y, 60, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text(`Loads not planned (${data.no_load_jobs.length}) — mix counted, see what each job needs`, margin, y);
    y += 6;
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Job #', 'What is missing for loads']],
      body: data.no_load_jobs.map((j) => [j.job_number || j.job_id, j.reason]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  // ── Jobs included in the combined mix ────────────────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text(`Jobs Included (${jobsMixed})`, margin, y);
  y += 6;
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Job #', 'Customer(s)']],
    body: data.included_jobs.length > 0
      ? data.included_jobs.map((j) => [j.job_number || j.job_id, j.customer_label || '—'])
      : [['—', 'No jobs included']],
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
  });
  y = doc.lastAutoTable.finalY + 18;

  // ── Jobs EXCLUDED (never silently dropped) ───────────────────────────────────
  if (data.excluded_jobs.length > 0) {
    y = ensureRoom(doc, y, 70, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text(`Jobs Excluded from the mix (${data.excluded_jobs.length})`, margin, y);
    y += 6;
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Job #', 'Reason not included']],
      body: data.excluded_jobs.map((j) => [j.job_number || j.job_id, j.reason]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
    });
    y = doc.lastAutoTable.finalY + 14;

    y = ensureRoom(doc, y, 30, margin);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    const note = doc.splitTextToSize(
      'These jobs could NOT be added to the combined mix above. The mix covers only the included jobs — '
      + 'review the excluded jobs and re-run if their products must be mixed into the batch.',
      pageW - margin * 2,
    );
    doc.text(note, margin, y);
  }
}

/**
 * Generate and download the cross-job Master Mix Summary PDF.
 *
 * @param data     the aggregated master-mix payload (from buildMasterMixSummaryData).
 * @param filename optional download filename.
 */
export async function generateMasterMixSummaryPdf(
  data: MasterMixSummaryData,
  filename?: string,
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const company = await loadCompanyInfoForPdf();

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;

  drawMasterMix(doc, autoTable, data, company);

  // Footer on every page (drawn last so the page count is final).
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, 40, company);
  }

  doc.save(filename || `master-mix-summary-${data.included_jobs.length}-jobs.pdf`);
}
