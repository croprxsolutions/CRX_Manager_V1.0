import { describe, expect, it } from 'vitest';
import {
  buildSetupPreview,
  rebaseRateRowsAfterSetup,
  editedRateRows,
  generateSetupWorkbook,
  parseSetupWorkbook,
  rateSaveRows,
  type SetupWorkbookExport,
  type SetupWorkbookProduct,
} from './productSetupWorkbook';
import { loadExcelJs } from './productPricingWorkbook';
import type { UseTimingOption } from '../types';

const CATEGORIES = ['Herbicide', 'Fungicide'];
const OPTIONS: UseTimingOption[] = [
  { code: 'pre_emerge', label: 'Pre-Emerge', timing_code: 'pre_emergence', crop: null, category: 'Herbicide', sort_order: 10, is_active: true },
  { code: 'post_emergence', label: 'Post-Emergence', timing_code: 'post_emergence', crop: null, category: 'Herbicide', sort_order: 40, is_active: true },
];

function product(overrides: Partial<SetupWorkbookProduct> = {}): SetupWorkbookProduct {
  return {
    product_id: '11111111-1111-4111-8111-111111111111', product_name: 'Atrazine 4L', sku: 'ATZ-1', is_active: true,
    category: 'Herbicide', manufacturer: 'Acme', product_form: 'liquid', inventory_unit: 'Gal', unit_size: '2.5',
    container_unit: 'Gal', container_size: '2.50', container_type: 'Jug', epa_registration: '524-475', is_rup: true,
    signal_word: 'Caution', rei_hours: 12, phi_days: 60, max_label_rate: '32', max_label_rate_unit: 'oz',
    use_timings: ['pre_emerge'], notes: null, internal_notes: 'inside', quoting_notes: null,
    setup_fingerprint: 'a'.repeat(32), rate_per_acre: '13.000', rate_unit: 'oz', suggested_rate: '13 oz/A',
    pricing_version: 4, tier1_price_per_acre: 4.06, tier2_price_per_acre: 3.66, tier3_price_per_acre: 3.25,
    ...overrides,
  };
}
const exported = (rows: SetupWorkbookProduct[], rates_locked = false): SetupWorkbookExport => ({ rates_locked, rows });

async function roundTrip(exp: SetupWorkbookExport, edit?: (wb: import('exceljs').Workbook) => void) {
  const blob = await generateSetupWorkbook(exp, OPTIONS);
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  }));
  edit?.(wb);
  // A copy: Node may hand back a slice of a larger pooled buffer.
  return parseSetupWorkbook(new Uint8Array(await wb.xlsx.writeBuffer() as unknown as ArrayBuffer).slice().buffer);
}
const setCell = (wb: import('exceljs').Workbook, sheet: string, header: string, value: string | number) => {
  const ws = wb.getWorksheet(sheet)!;
  const headers = (ws.getRow(1).values as string[]).slice(1);
  ws.getCell(2, headers.indexOf(header) + 1).value = value;
};

describe('setup workbook', () => {
  it('reads back an untouched download as no changes on either tab', async () => {
    const exp = exported([product()]);
    const parsed = await roundTrip(exp);
    expect(buildSetupPreview(parsed.setupRows, exp, OPTIONS, CATEGORIES)).toEqual({ changes: [], stale: [], invalid: [] });
    expect(editedRateRows(parsed.rateRows)).toEqual([]);
  });

  it('previews only the setup fields that changed, with before and after', async () => {
    const exp = exported([product()]);
    const parsed = await roundTrip(exp, (wb) => {
      setCell(wb, 'Setup', 'sku', ' ATZ-2 ');
      setCell(wb, 'Setup', 'is_rup', 'no');
      setCell(wb, 'Setup', 'rei_hours', '24');
      setCell(wb, 'Setup', 'container_size', '2.5'); // same amount as 2.50: not a change
      setCell(wb, 'Setup', 'use_timings', 'pre-emerge; Post-Emergence');
    });
    const preview = buildSetupPreview(parsed.setupRows, exp, OPTIONS, CATEGORIES);
    expect(preview.stale).toEqual([]);
    expect(preview.invalid).toEqual([]);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0].changes).toEqual({ sku: 'ATZ-2', is_rup: false, rei_hours: 24, use_timings: ['pre_emerge', 'post_emergence'] });
    expect(preview.changes[0].display).toContainEqual({ field: 'is_rup', before: 'yes', after: 'no' });
  });

  it('names a row changed since the download as stale, and bad values as invalid', async () => {
    const exp = exported([product(), product({ product_id: '22222222-2222-4222-8222-222222222222', product_name: 'Other' })]);
    const parsed = await roundTrip(exp, (wb) => {
      setCell(wb, 'Setup', 'manufacturer', 'Late');
      const ws = wb.getWorksheet('Setup')!;
      const headers = (ws.getRow(1).values as string[]).slice(1);
      ws.getCell(3, headers.indexOf('use_timings') + 1).value = 'Sometime';
      ws.getCell(3, headers.indexOf('phi_days') + 1).value = '-1';
      ws.getCell(3, headers.indexOf('product_name') + 1).value = ' ';
    });
    const now = exported([product({ setup_fingerprint: 'b'.repeat(32) }), exp.rows[1]]);
    const preview = buildSetupPreview(parsed.setupRows, now, OPTIONS, CATEGORIES);
    expect(preview.changes).toEqual([]);
    expect(preview.stale.map((p) => p.product_name)).toEqual(['Atrazine 4L']);
    expect(preview.invalid[0].product_name).toBe('Other');
    expect(preview.invalid[0].problem).toMatch(/phi_days must be a whole number/);
    expect(preview.invalid[0].problem).toMatch(/unknown use timing "Sometime"/);
    expect(preview.invalid[0].problem).toMatch(/product_name cannot be blank/);
  });

  it('sends edited rates with the downloaded values as expected, and saves only previewed changes with their prices', async () => {
    const exp = exported([product()]);
    const parsed = await roundTrip(exp, (wb) => setCell(wb, 'Rates', 'rate_per_acre', '13.5'));
    const edited = editedRateRows(parsed.rateRows);
    expect(edited).toEqual([{
      product_id: exp.rows[0].product_id, rate_per_acre: '13.5', rate_unit: 'oz', suggested_rate: '13 oz/A',
      expected: { rate_per_acre: '13.000', rate_unit: 'oz', suggested_rate: '13 oz/A', pricing_version: 4,
        unit_size: '2.5', inventory_unit: 'Gal', product_form: 'liquid' },
    }]);
    const prices = { tier1_price_per_acre: 4.22, tier2_price_per_acre: 3.8, tier3_price_per_acre: 3.38 };
    const save = rateSaveRows({ rates_locked: false, rows: [{ product_id: exp.rows[0].product_id, status: 'change',
      after: { rate_per_acre: '13.5', rate_unit: 'oz', suggested_rate: '13 oz/A', ...prices } }] }, edited);
    expect(save[0].expected.prices).toEqual(prices);
    expect(rateSaveRows({ rates_locked: false, rows: [{ product_id: exp.rows[0].product_id, status: 'stale' }] }, edited)).toEqual([]);
  });

  it('ignores stray spaces and old bad values nobody edited, and refuses an unlisted category or a zero container size', async () => {
    const exp = exported([product({ notes: ' spaced ', rei_hours: -1 as unknown as number })]);
    expect(buildSetupPreview((await roundTrip(exp)).setupRows, exp, OPTIONS, CATEGORIES)).toEqual({ changes: [], stale: [], invalid: [] });
    const edited = await roundTrip(exp, (wb) => { setCell(wb, 'Setup', 'category', 'Post Emergence'); setCell(wb, 'Setup', 'container_size', '0'); });
    const preview = buildSetupPreview(edited.setupRows, exp, OPTIONS, CATEGORIES);
    expect(preview.invalid[0].problem).toMatch(/container_size must be above 0/);
    expect(preview.invalid[0].problem).toMatch(/unknown category "Post Emergence"/);
  });

  it('after its own Setup save, moves a Rates row expected version only from the downloaded one', () => {
    const row = { product_id: 'p1', rate_per_acre: '1', rate_unit: 'oz', suggested_rate: null,
      expected: { rate_per_acre: null, rate_unit: null, suggested_rate: null, pricing_version: 4, unit_size: null, inventory_unit: 'Gal', product_form: 'liquid' } };
    const saved = (before: number) => ({ changed_count: 1, rows: [{ product_id: 'p1', product_name: 'P', pricing_version_before: before, pricing_version_after: before + 1, fields: ['notes'] }] });
    expect(rebaseRateRowsAfterSetup([row], saved(4))[0].expected.pricing_version).toBe(5);
    expect(rebaseRateRowsAfterSetup([row], saved(5))[0].expected.pricing_version).toBe(4); // someone else moved it first
  });

  it('protects the sheets with blank editable cells open, refuses a changed Rates product id, and names a product listed twice', async () => {
    const exp = exported([product({ sku: null }), product({ product_id: '22222222-2222-4222-8222-222222222222', product_name: 'Other' })]);
    let sheetProtected = false;
    let blankSkuLocked: boolean | undefined;
    await roundTrip(exp, (wb) => {
      const ws = wb.getWorksheet('Setup')!;
      sheetProtected = Boolean((ws as unknown as { sheetProtection?: object }).sheetProtection);
      const headers = (ws.getRow(1).values as string[]).slice(1);
      blankSkuLocked = ws.getCell(2, headers.indexOf('sku') + 1).protection?.locked;
    });
    expect(sheetProtected).toBe(true);
    expect(blankSkuLocked).toBe(false);
    await expect(roundTrip(exp, (wb) => setCell(wb, 'Rates', 'product_id', exp.rows[1].product_id)))
      .rejects.toThrow(/Rates row 2 is damaged/);
    const twice = await roundTrip(exp, (wb) => {
      setCell(wb, 'Setup', 'product_id', exp.rows[1].product_id);
      setCell(wb, 'Setup', 'manufacturer', 'Twice');
    });
    expect(buildSetupPreview(twice.setupRows, exp, OPTIONS, CATEGORIES).invalid.map((p) => p.problem)).toContain('listed twice in the file');
  });

  it('refuses a file with added rows or another format', async () => {
    const exp = exported([product()]);
    await expect(roundTrip(exp, (wb) => wb.getWorksheet('Setup')!.addRow(['x']))).rejects.toThrow(/added or removed rows/);
    await expect(roundTrip(exp, (wb) => { wb.getWorksheet('_crx_manifest')!.getCell(1, 2).value = 'crx-product-setup-v0'; }))
      .rejects.toThrow(/not a current CRX setup workbook/);
  });
});
