/**
 * The invoice PDF with the real jsPDF and jspdf-autotable (no mocks): where things land when a table runs over a page.
 */
import { describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { drawInvoicePdf, type InvoicePdfData } from '../../supabase/functions/_shared/pdf/invoicePdf.ts';

type Drawn = { text: string; page: number; x: number; y: number; width: number };

/** A real jsPDF that records each text call with the page it lands on. */
function recordingPdf(log: Drawn[]): typeof jsPDF {
  function RecordingPdf(this: unknown, ...args: ConstructorParameters<typeof jsPDF>) {
    const doc = new jsPDF(...args);
    const text = doc.text.bind(doc);
    doc.text = ((value: string | string[], x: number, y: number, ...rest: unknown[]) => {
      for (const line of [value].flat()) log.push({ text: line, page: doc.getCurrentPageInfo().pageNumber, x, y, width: doc.getTextWidth(line) });
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
      invoice_number: 'CS-2026-0005-1', invoice_date: '2026-11-06', due_date: '2026-12-06', invoice_type: 'chemical_sale', bill_split_on_load: true, status: 'posted', // posted: a draft prints no pay note
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

// Review #1873 LOW: long values wrap inside the page instead of running off its right edge.
describe('invoice PDF long values (real jsPDF)', () => {
  const long = 'North Bottom Ground by the Creek Crossing West of the Grain Bins Section Fourteen';
  const data: InvoicePdfData = {
    invoice_number: 'INV-2026-0042', invoice_date: '2026-11-06', invoice_type: 'field_application', bill_split_on_load: false, status: 'posted',
    customer_name: 'Test Farm', customer_address: `RR 2 Box 14, ${long}`, customer_city: 'Testville', customer_state: 'IL', customer_zip: '62000',
    crop_type: 'Corn', total_acres: 91.9, field_names: [long, `${long} Two`],
    items: [{ description: 'Atrazine 4L', product_name: 'Atrazine 4L', quantity: 2, unit_size: 'GL', unit_price_cents: 500, extended_cents: 1000 }],
    shares: [
      { customer_name: `Test Grower Partnership ${long}`, split_percentage: 50, acres: 45.95, amount_cents: 500 },
      { customer_name: `Second Test Grower ${long}`, split_percentage: 50, acres: 45.95, amount_cents: 500 },
    ],
    total_amount_cents: 1000, total_cost_cents: 0, paid_amount_cents: 0, prepay_applied_cents: 0, balance_cents: 1000,
    company: { name: 'Test Ag Co', phone: `555-0199 office, 555-0100 shop, 555-0111 after hours, ask for ${long}`, email: '', address: '' },
    options: { show_shares: true, show_price_per_acre: false, show_epa_registration: true },
  };

  it('wraps the bill-to street, the crop and fields line, the growers line and the company phone', () => {
    const log: Drawn[] = [];
    const doc = drawInvoicePdf({ jsPDF: recordingPdf(log), autoTable }, data);
    const right = doc.internal.pageSize.getWidth() - 42;
    const drawn = log.filter((d) => d.page === 1 && d.y < 300 && d.text.includes('Creek'));
    expect(drawn.length).toBeGreaterThan(5); // street, fields, growers and phone each took more than one line
    for (const d of drawn) expect(d.x + d.width).toBeLessThanOrEqual(right + 0.5);
    // The company block keeps to its column, left of the logo.
    const companyColumn = (doc.internal.pageSize.getWidth() - 84 - 32) / 3;
    const companyLines = log.filter((d) => d.page === 1 && d.x === 42 && d.y < 110);
    expect(companyLines.some((d) => d.text.includes('Creek'))).toBe(true);
    for (const d of companyLines) expect(d.width).toBeLessThanOrEqual(companyColumn + 0.5);
  });
});

// Sol on #1873 (MED 5): a huge value can't push the page off its bottom edge.
describe('invoice PDF very long values (real jsPDF)', () => {
  const huge = Array.from({ length: 40 }, (_, i) => `Lot ${i + 1} on the long gravel road past the test elevator`).join(', ');
  const base: InvoicePdfData = {
    invoice_number: 'INV-2026-0043', invoice_date: '2026-11-06', invoice_type: 'field_application', bill_split_on_load: false, status: 'draft',
    customer_name: 'Test Farm', customer_address: huge, crop_type: 'Corn', total_acres: 10,
    field_names: Array.from({ length: 600 }, (_, i) => `Test Field Number ${i + 1}`),
    items: [{ description: 'Atrazine 4L', product_name: 'Atrazine 4L', quantity: 2, unit_size: 'GL', unit_price_cents: 500, extended_cents: 1000 }],
    total_amount_cents: 1000, total_cost_cents: 0, paid_amount_cents: 0, prepay_applied_cents: 0, balance_cents: 1000,
    options: { show_shares: false, show_price_per_acre: false, show_epa_registration: true },
  };

  it('caps an absurd bill-to street at six lines, the last ending "..."', () => {
    const log: Drawn[] = [];
    drawInvoicePdf({ jsPDF: recordingPdf(log), autoTable }, base);
    const street = log.filter((d) => d.x === 69 && d.text.includes('Lot'));
    expect(street).toHaveLength(6);
    expect(street[5].text.endsWith('...')).toBe(true);
  });

  it('prints a four-line street in full', () => {
    const log: Drawn[] = [];
    const street = 'Lot 12, Suite 4B, North Gravel Road past the test elevator and the grain bins, County Road 18, Rural Route 2';
    drawInvoicePdf({ jsPDF: recordingPdf(log), autoTable }, { ...base, customer_address: street });
    const lines = log.filter((d) => d.x === 69 && /Lot 12|Suite|Road|Route|elevator|bins/.test(d.text));
    expect(lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ')).toContain('Rural Route 2');
    expect(lines.some((l) => l.text.endsWith('...'))).toBe(false);
  });

  it('moves the rest of a long fields line to the next page instead of past the footer', () => {
    const log: Drawn[] = [];
    const doc = drawInvoicePdf({ jsPDF: recordingPdf(log), autoTable }, base);
    const fields = log.filter((d) => d.text.includes('Test Field Number'));
    expect(fields.some((d) => d.text.includes('Test Field Number 600'))).toBe(true); // nothing is dropped
    expect(new Set(fields.map((d) => d.page)).size).toBeGreaterThan(1);
    for (const d of fields) expect(d.y).toBeLessThanOrEqual(doc.internal.pageSize.getHeight() - 66);
  });
});
