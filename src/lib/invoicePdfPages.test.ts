/**
 * The invoice PDF with the real jsPDF and jspdf-autotable (no mocks): where things land when a table runs over a page.
 */
import { describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { drawInvoicePdf, type InvoicePdfData } from '../../supabase/functions/_shared/pdf/invoicePdf.ts';

type Drawn = { text: string; page: number; x: number; y: number };

/** A real jsPDF that records each text call with the page it lands on. */
function recordingPdf(log: Drawn[]): typeof jsPDF {
  function RecordingPdf(this: unknown, ...args: ConstructorParameters<typeof jsPDF>) {
    const doc = new jsPDF(...args);
    const text = doc.text.bind(doc);
    doc.text = ((value: string | string[], x: number, y: number, ...rest: unknown[]) => {
      for (const line of [value].flat()) log.push({ text: line, page: doc.getCurrentPageInfo().pageNumber, x, y });
      return (text as (...a: unknown[]) => jsPDF)(value, x, y, ...rest);
    }) as typeof doc.text;
    return doc;
  }
  return RecordingPdf as unknown as typeof jsPDF;
}

describe('invoice PDF page breaks (real jsPDF)', () => {
  it('keeps the totals on the page where Who pays starts when many payers with long names run onto the next page', () => {
    const payers = Array.from({ length: 30 }, (_, i) => ({
      customer_name: `Maple Hollow Farms and Cedar Ridge Ag Landholding Partnership number ${i + 1}`,
      split_percentage: i < 10 ? 3.34 : 3.33,
      acres: null,
      amount_cents: 1000 + i,
      invoice_id: `inv-${i}`,
      invoice_number: `CS-2026-0005-${i + 1}`,
    }));
    const data: InvoicePdfData = {
      invoice_number: 'CS-2026-0005-1', invoice_date: '2026-11-06', due_date: '2026-12-06', invoice_type: 'chemical_sale', status: 'posted', // posted: a draft prints no pay note
      customer_name: 'Maple Hollow Farms', items: [
        { description: 'Atrazine 4L', product_name: 'Atrazine 4L', quantity: 2, unit_size: 'GL', unit_price_cents: 500, extended_cents: 1000 },
      ],
      shares: payers, total_amount_cents: 1000, total_cost_cents: 0, paid_amount_cents: 0, prepay_applied_cents: 0, balance_cents: 1000,
      options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
    };
    const log: Drawn[] = [];
    const doc = drawInvoicePdf({ jsPDF: recordingPdf(log), autoTable }, data);
    const at = (text: string) => log.find((d) => d.text === text)!;
    const whoPays = at('WHO PAYS FOR THIS DELIVERY');
    const lastPage = doc.getNumberOfPages();
    expect(lastPage).toBeGreaterThan(whoPays.page); // the payer table did run over
    const pageBottom = doc.internal.pageSize.getHeight() - 66;
    const payerTableRight = doc.internal.pageSize.getWidth() - 42 - 210 - 24;
    for (const label of ['Products', 'Invoice total', 'Balance due']) {
      expect(at(label).page).toBe(whoPays.page);
      expect(at(label).y).toBeGreaterThan(whoPays.y);
      expect(at(label).y).toBeLessThan(pageBottom);
      expect(at(label).x).toBeGreaterThan(payerTableRight); // beside the payer table, never over it
    }
    // The pay note follows the payer table on the last page, below it.
    const note = at('Please pay by 12/06/2026.');
    expect(note.page).toBe(lastPage);
    expect(note.y).toBeGreaterThan(doc.lastAutoTable.finalY);
    expect(at(`Page ${lastPage} of ${lastPage}`).page).toBe(lastPage);
  });
});
