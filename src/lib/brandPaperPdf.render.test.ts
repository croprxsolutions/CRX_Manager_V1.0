import { describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DEFAULT_COMPANY_INFO } from './companyInfo';
import { generateInvoicePdf, type InvoicePdfData, type InvoicePdfItem } from './invoicePdf';
import { generateDeliveryPdf } from './deliveryPdf';
import { receiptBrandNotes } from '../../supabase/functions/_shared/brandNotes.ts';

const companyInfo = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./companyInfoForPdf', () => ({ loadCompanyInfoForPdf: companyInfo.load }));
companyInfo.load.mockResolvedValue(DEFAULT_COMPANY_INFO);

const brandLines = [
  { brand_key: 'a', brand_name: 'Alpha', epa_registration: '1-1', quantity: 2, line_delivered: 5, delivery_item_id: 'di1' },
  { brand_key: 'b', brand_name: 'Beta', epa_registration: '2-2', quantity: 3, line_delivered: 5, delivery_item_id: 'di1' },
];
const item = (quantity: number, brand_lines: unknown = brandLines): InvoicePdfItem => ({
  description: 'Synthetic Herbicide', product_name: 'Synthetic Herbicide', quantity,
  unit_size: 'gal', unit_price_cents: 1000, extended_cents: quantity * 1000,
  epa_registration: '9-9', brand_lines,
});
const invoice = (items: InvoicePdfItem[], bill_split_on_load = false): InvoicePdfData => ({
  invoice_number: 'INV-SYNTHETIC', invoice_date: '2026-11-13', invoice_type: 'chemical_sale', status: 'posted',
  bill_split_on_load, customer_name: 'Synthetic Farm', items,
  total_amount_cents: items.reduce((sum, row) => sum + row.extended_cents, 0), total_cost_cents: 0,
  paid_amount_cents: 0, prepay_applied_cents: 0,
  balance_cents: items.reduce((sum, row) => sum + row.extended_cents, 0), company: DEFAULT_COMPANY_INFO,
});

async function renderedText(doc: { output: (type: 'arraybuffer') => ArrayBuffer }): Promise<string> {
  const pdf = await getDocument({ data: new Uint8Array(doc.output('arraybuffer')) }).promise;
  const pages = await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => {
    const text = await (await pdf.getPage(i + 1)).getTextContent();
    return text.items.map((part) => ('str' in part ? part.str : '')).join(' ');
  }));
  return pages.join(' ');
}

describe('rendered brand paperwork', () => {
  it('renders a partial invoice with names and EPA numbers, while another full line keeps its amount', async () => {
    const text = await renderedText(await generateInvoicePdf(invoice([
      item(3),
      item(5, [{ brand_key: 'c', brand_name: 'Charlie', epa_registration: '3-3', quantity: 5, line_delivered: 5, delivery_item_id: 'di2' }]),
    ])));
    expect(text).toContain('Brand: Alpha (EPA 1-1)');
    expect(text).toContain('Brand: Beta (EPA 2-2)');
    expect(text).toContain('Full-load brand amounts are on the delivery receipt.');
    expect(text).not.toContain('Brand: Alpha (EPA 1-1) - 2');
    expect(text).toContain('Brand: Charlie (EPA 3-3) - 5');
  });

  it('renders Bill Split amounts as on the load, and hides a repeated whole-load snapshot', async () => {
    const split = await renderedText(await generateInvoicePdf(invoice([item(3)], true)));
    expect(split).toContain('Brand: Alpha (EPA 1-1) - 2 on the load');
    const repeated = await renderedText(await generateInvoicePdf(invoice([item(5), item(5)])));
    expect(repeated).toContain('Full-load brand amounts are on the delivery receipt.');
    expect(repeated).not.toContain('Brand: Alpha (EPA 1-1) - 2');
  });

  it('renders a pre-delivery planned-load mismatch note without an amount per brand', async () => {
    const brand_notes = receiptBrandNotes({
      qty: 3, brands: [{ name: 'Alpha', epa_registration: '1-1' }],
      brand_picked_quantity: 4, brand_planned_quantity: 5,
    });
    const text = await renderedText(await generateDeliveryPdf({
      delivery_number: 'DEL-SYNTHETIC', order_number: 'ORD-SYNTHETIC', customer_name: 'Synthetic Farm',
      driver_name: 'Test Driver', scheduled_date: '2026-11-13', status: 'in_progress',
      items: [{ product_name: 'Synthetic Herbicide', quantity: 5, quantity_delivered: 3, unit_size: 'gal', brand_notes }],
    }));
    expect(text).toContain('Brand: Alpha (EPA 1-1)');
    expect(text).toContain('Brand amounts do not match planned load: 4 of 5 picked');
    expect(text).not.toContain('Brand: Alpha (EPA 1-1) - 4');
  });
});
