import { describe, expect, it } from 'vitest';
import type { Workbook } from 'exceljs';
import type { PricingWorkbookExport } from './productPricing';
import {
  generateProductPricingWorkbookWithSupplierEvidence,
  parseProductPricingWorkbookWithSupplierEvidence,
  PRICING_MARKET_EVIDENCE_HEADERS,
  PRICING_SUPPLIER_EVIDENCE_SHEET,
} from './productPricingSupplierEvidenceWorkbook';
import {
  generateProductPricingWorkbook,
  parseProductPricingWorkbook,
  PRICING_WORKBOOK_FORMAT_VERSION,
  PRICING_WORKBOOK_HEADERS,
  PRICING_WORKBOOK_SHEET,
  PricingWorkbookFormatError,
} from './productPricingWorkbook';

// The parse as it was before it loaded the file once: kept as the oracle the new parse must match.
async function legacyParseWithSupplierEvidence(arrayBuffer: ArrayBuffer) {
  try {
    return await parseProductPricingWorkbook(arrayBuffer);
  } catch (error) {
    if (!(error instanceof PricingWorkbookFormatError)
      || error.message !== 'The Pricing Update sheet headers do not match the CRX template.') {
      throw error;
    }
  }
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer);
  const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET);
  if (!worksheet) throw new PricingWorkbookFormatError(`Missing required worksheet ${PRICING_WORKBOOK_SHEET}.`);
  const expectedHeaders = [...PRICING_WORKBOOK_HEADERS, ...PRICING_MARKET_EVIDENCE_HEADERS];
  const actualHeaders = Array.from(
    { length: worksheet.getRow(1).cellCount },
    (_, index) => worksheet.getCell(1, index + 1).value,
  );
  if (actualHeaders.length !== expectedHeaders.length
    || expectedHeaders.some((header, index) => actualHeaders[index] !== header)) {
    throw new PricingWorkbookFormatError('The Pricing Update sheet headers do not match the CRX Phase 1b template.');
  }
  worksheet.spliceColumns(PRICING_WORKBOOK_HEADERS.length + 1, PRICING_MARKET_EVIDENCE_HEADERS.length);
  return parseProductPricingWorkbook(await toArrayBuffer(workbook));
}

async function toArrayBuffer(workbook: Workbook): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function outcome(parse: Promise<unknown>) {
  try {
    return { parsed: await parse };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

const equivalenceExport: PricingWorkbookExport = {
  export_id: '22222222-2222-4222-8222-222222222222',
  format_version: PRICING_WORKBOOK_FORMAT_VERSION,
  manifest_fingerprint: 'fingerprint-eq',
  expires_at: '2026-12-01T00:00:00+00:00',
  rows: Array.from({ length: 12 }, (_, i) => ({
    product_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    sku: i % 3 === 0 ? null : `00${i}`, product_name: `Product ${i}`, category: i % 2 ? 'Herbicide' : null,
    container_size: '2.5', unit_size: 'gal', inventory_unit: 'gallon',
    identity_fingerprint: `identity-${i}`, row_token: `token-${i}`, row_version: i + 1,
    current_cost: i === 4 ? null : `${10 + i}.0${i % 10}`,
    current_tier1_margin_percent: i === 4 ? null : '33.33333333', current_tier1_price: i === 4 ? null : '15.00',
    current_tier2_margin_percent: `${i}.5`, current_tier2_price: '13.07',
    current_tier3_margin_percent: '0', current_tier3_price: '12.00',
    suggested_rate: '1 pt', rate_per_acre: i % 2 ? '1.5' : null, rate_unit: 'pt',
    use_timing: 'Pre', internal_notes: i % 4 ? 'note' : null, quoting_notes: 'q',
  })),
};

const equivalenceEvidence = equivalenceExport.rows.slice(0, 6).map((row, i) => ({
  product_id: row.product_id, supplier_quote_count: 1, comparable_quote_count: 1,
  replacement_cost_cents: BigInt(1_000 + i), replacement_cost_as_of: '2026-07-18',
  best_supplier: 'The Andersons', comparison_status: 'comparable' as const,
  last_paid_cents: null, last_paid_as_of: null,
  recent_po_weighted_average_cents: null, recent_po_window: 'trailing_12_months' as const,
  suppliers: [],
}));

const columnOf = (header: (typeof PRICING_WORKBOOK_HEADERS)[number]) => PRICING_WORKBOOK_HEADERS.indexOf(header) + 1;
const evidenceColumn = PRICING_WORKBOOK_HEADERS.length + 1;
const afterEvidenceColumn = evidenceColumn + PRICING_MARKET_EVIDENCE_HEADERS.length;
const lastRowPlusOne = equivalenceExport.rows.length + 2;

async function edited(blob: Blob, change: (workbook: Workbook) => void): Promise<ArrayBuffer> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await blob.arrayBuffer());
  change(workbook);
  return toArrayBuffer(workbook);
}

describe('pricing workbook supplier evidence', () => {
  it('reads every sheet exactly as the earlier load-twice parse did, with evidence, without, and edited', async () => {
    const withEvidence = await generateProductPricingWorkbookWithSupplierEvidence(equivalenceExport, equivalenceEvidence);
    const plain = await generateProductPricingWorkbook(equivalenceExport);
    const sheet = (workbook: Workbook) => workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const cases: Array<[string, ArrayBuffer]> = [
      ['with evidence', await withEvidence.arrayBuffer()],
      ['with evidence columns, no evidence', await (await generateProductPricingWorkbookWithSupplierEvidence(equivalenceExport, [])).arrayBuffer()],
      ['without evidence', await plain.arrayBuffer()],
      ['with evidence and edits', await edited(withEvidence, (workbook) => {
        const ws = sheet(workbook);
        ws.getCell(2, columnOf('pricing_mode')).value = 'margin_driven';
        ws.getCell(2, columnOf('new_cost')).value = 125.4;
        ws.getCell(2, columnOf('tier1_margin_percent')).value = 19.75;
        ws.getCell(2, columnOf('change_reason')).value = 'Supplier quote';
        ws.getCell(3, columnOf('pricing_mode')).value = 'price_driven';
        ws.getCell(3, columnOf('tier1_price')).value = { formula: '10+5', result: 15 };
        ws.getCell(4, columnOf('new_cost')).value = 0.0000001;
        ws.getCell(5, columnOf('quoting_notes')).value = { richText: [{ text: 'rich ' }, { text: 'note' }] };
        ws.getCell(6, columnOf('internal_notes')).value = null;
      })],
      ['without evidence, with edits', await edited(plain, (workbook) => {
        sheet(workbook).getCell(2, columnOf('pricing_mode')).value = 'margin_driven';
        sheet(workbook).getCell(2, columnOf('new_cost')).value = '99.5';
      })],
      ['a row deleted', await edited(withEvidence, (workbook) => { sheet(workbook).spliceRows(5, 1); })],
      ['a row added below', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(lastRowPlusOne, columnOf('product_id')).value = 'extra';
      })],
      ['only an evidence value on an extra row', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(lastRowPlusOne, evidenceColumn).value = 'stray';
      })],
      ['a value past the evidence columns', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(3, afterEvidenceColumn).value = 'stray';
      })],
      ['a value past the evidence columns on an extra row', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(lastRowPlusOne, afterEvidenceColumn).value = 'stray';
      })],
      ['an evidence header renamed', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(1, evidenceColumn + 2).value = 'replacement_cost_date';
      })],
      ['an extra header after the evidence', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(1, afterEvidenceColumn).value = 'extra';
      })],
      ['a pricing header renamed', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(1, columnOf('new_cost')).value = 'cost';
      })],
      ['a pricing header as a formula', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(1, columnOf('sku')).value = { formula: '"sku"', result: 'sku' };
      })],
      ['a duplicate pricing header', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(1, columnOf('category')).value = 'sku';
      })],
      ['a dollar cell as a date', await edited(withEvidence, (workbook) => {
        sheet(workbook).getCell(2, columnOf('new_cost')).value = new Date('2026-01-01T00:00:00Z');
      })],
      ['no manifest', await edited(withEvidence, (workbook) => { workbook.removeWorksheet('_crx_manifest'); })],
      ['not a workbook', new TextEncoder().encode('not a zip').buffer as ArrayBuffer],
    ];
    const differences: string[] = [];
    const results: string[] = [];
    for (const [name, buffer] of cases) {
      const legacy = await outcome(legacyParseWithSupplierEvidence(buffer.slice(0)));
      const current = await outcome(parseProductPricingWorkbookWithSupplierEvidence(buffer.slice(0)));
      if (JSON.stringify(current) !== JSON.stringify(legacy)) {
        differences.push(`${name}: legacy ${JSON.stringify(legacy).slice(0, 300)} now ${JSON.stringify(current).slice(0, 300)}`);
      }
      results.push(`${name}: ${'error' in legacy ? legacy.error : 'parsed'}`);
    }
    expect(differences).toEqual([]);
    // Both outcomes are covered, so this compares real parses, not only refusals.
    expect(results.filter((line) => line.endsWith(': parsed')).length).toBeGreaterThanOrEqual(5);
    expect(results.some((line) => line.includes('Rows were added to or deleted'))).toBe(true);
    expect(results.some((line) => line.includes('CRX Phase 1b template'))).toBe(true);
  }, 60000);

  it('adds locked market-evidence columns and preserves the Phase 1a pricing payload', async () => {
    const pricingExport: PricingWorkbookExport = {
      export_id: 'export-1',
      manifest_fingerprint: 'fingerprint-1',
      expires_at: '2026-07-25T12:00:00Z',
      rows: [{
        product_id: 'product-1', sku: 'SKU-1', product_name: 'Atrazine', category: 'Herbicide',
        container_size: '2.5', unit_size: 'gal', inventory_unit: 'gallon',
        identity_fingerprint: 'identity-1', row_token: 'token-1', row_version: 1,
        current_cost: '20.00', current_tier1_margin_percent: '10', current_tier1_price: '22.22',
        current_tier2_margin_percent: '33.33333333', current_tier2_price: '23.53',
        current_tier3_margin_percent: '20', current_tier3_price: '25.00',
      }],
    };
    const blob = await generateProductPricingWorkbookWithSupplierEvidence(pricingExport, [{
      product_id: 'product-1', supplier_quote_count: 1, comparable_quote_count: 1,
      replacement_cost_cents: 1_900n, replacement_cost_as_of: '2026-07-18',
      best_supplier: 'The Andersons', comparison_status: 'comparable',
      last_paid_cents: 2_100n, last_paid_as_of: '2026-07-10',
      recent_po_weighted_average_cents: 2_050n, recent_po_window: 'trailing_12_months',
      suppliers: [{
        vendor_id: 'vendor-1', vendor_name: 'The Andersons', product_supplier_link_id: 'link-1',
        quoted_package_cost_cents: 9_500n, normalized_cost_cents: 1_900n,
        effective_from: '2026-07-18', comparison_status: 'comparable', is_best_comparable: true,
      }],
    }]);

    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await blob.arrayBuffer());
    const pricingSheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const evidenceSheet = workbook.getWorksheet(PRICING_SUPPLIER_EVIDENCE_SHEET)!;

    expect(Array.from({ length: pricingSheet.getRow(1).cellCount }, (_, index) => (
      pricingSheet.getCell(1, index + 1).value
    ))).toEqual([...PRICING_WORKBOOK_HEADERS, ...PRICING_MARKET_EVIDENCE_HEADERS]);
    expect(pricingSheet.getCell(2, PRICING_WORKBOOK_HEADERS.length + 1).value)
      .toBe('The Andersons');
    expect(pricingSheet.getCell(2, PRICING_WORKBOOK_HEADERS.length + 2).value).toBe('$19.00');
    expect(pricingSheet.getCell(2, PRICING_WORKBOOK_HEADERS.length + 2).protection?.locked)
      .not.toBe(false);
    expect(evidenceSheet.getCell(2, 3).value).toBe('The Andersons');
    expect(evidenceSheet.getCell(2, 4).value).toBe('$95.00');
    expect(evidenceSheet.getCell(2, 5).value).toBe('$19.00');

    const parsed = await parseProductPricingWorkbookWithSupplierEvidence(await blob.arrayBuffer());
    expect(parsed.exportId).toBe('export-1');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].product_id).toBe('product-1');
    // The locked current margin is a 2-decimal number cell that still reads back as the exact server text.
    const margin2 = pricingSheet.getCell(2, PRICING_WORKBOOK_HEADERS.indexOf('current_tier2_margin_percent') + 1);
    expect(margin2.value).toBe(33.33333333);
    expect(margin2.numFmt).toBe('0.00');
    expect(parsed.rows[0].current_tier2_margin_percent).toBe('33.33333333');
    expect(parsed.rows[0].tier2_margin_percent).toBe('33.33333333');
    expect(pricingSheet.getCell(1, PRICING_WORKBOOK_HEADERS.indexOf('current_cost') + 1).note)
      .toBe('Dollars per inventory unit (see the inventory_unit column)');
    // Same ExcelJS generate-and-reparse cost as the product and supplier
    // workbook tests, which already carry this timeout. ~350ms warm, but the
    // first ExcelJS load in a worker is multi-second on a cold module/FS cache
    // (7.0s measured here on the first run after a fresh `npm ci`), which
    // crosses the 5s default and fails the pre-commit gate in a new worktree.
    // The work is I/O- and CPU-bound, not hung — give it headroom rather than
    // retrying the commit until it passes.
  }, 30000);
});
