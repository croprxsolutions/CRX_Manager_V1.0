import { describe, expect, it, vi } from 'vitest';
import {
  buildSetupPreview,
  rebaseRateRowsAfterSetup,
  editedParentRateRows,
  editedRateRows,
  generateSetupWorkbook,
  groupedParentNames,
  parseSetupWorkbook,
  rateSaveRows,
  setupMembershipHash,
  type SetupWorkbookExport,
  type SetupWorkbookProduct,
} from './productSetupWorkbook';
import { loadExcelJs } from './productPricingWorkbook';
import type { ProductParent } from './productParents';
import type { UseTimingOption } from '../types';

// Each test builds and re-reads real ExcelJS workbooks: ~0.5-2.5s locally under coverage, past 5s on loaded CI shards.
vi.setConfig({ testTimeout: 30_000 });

const NONE = new Map<string, string>();

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

async function roundTrip(exp: SetupWorkbookExport, edit?: (wb: import('exceljs').Workbook) => void, parents: ProductParent[] = []) {
  const blob = await generateSetupWorkbook(exp, OPTIONS, parents);
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
    expect(buildSetupPreview(parsed.setupRows, exp, OPTIONS, CATEGORIES, NONE)).toEqual({ changes: [], stale: [], invalid: [] });
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
    const preview = buildSetupPreview(parsed.setupRows, exp, OPTIONS, CATEGORIES, NONE);
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
    const preview = buildSetupPreview(parsed.setupRows, now, OPTIONS, CATEGORIES, NONE);
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
    expect(buildSetupPreview((await roundTrip(exp)).setupRows, exp, OPTIONS, CATEGORIES, NONE)).toEqual({ changes: [], stale: [], invalid: [] });
    const edited = await roundTrip(exp, (wb) => { setCell(wb, 'Setup', 'category', 'Post Emergence'); setCell(wb, 'Setup', 'container_size', '0'); });
    const preview = buildSetupPreview(edited.setupRows, exp, OPTIONS, CATEGORIES, NONE);
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
    expect(buildSetupPreview(twice.setupRows, exp, OPTIONS, CATEGORIES, NONE).invalid.map((p) => p.problem)).toContain('listed twice in the file');
  });

  it('refuses a file with added rows or another format', async () => {
    const exp = exported([product()]);
    await expect(roundTrip(exp, (wb) => wb.getWorksheet('Setup')!.addRow(['x']))).rejects.toThrow(/added or removed rows/);
    await expect(roundTrip(exp, (wb) => { wb.getWorksheet('_crx_manifest')!.getCell(1, 2).value = 'crx-product-setup-v0'; }))
      .rejects.toThrow(/not a current CRX setup workbook/);
  });

  it('refuses a v1 download with a plain message to download a new workbook', async () => {
    await expect(roundTrip(exported([product()]), (wb) => { wb.getWorksheet('_crx_manifest')!.getCell(1, 2).value = 'crx-product-setup-v1'; }))
      .rejects.toThrow('This setup workbook was downloaded before products were grouped under parents. Download a new workbook.');
  });

  describe('grouped sizes (PAR-1)', () => {
    const SIZE_B = '22222222-2222-4222-8222-222222222222';
    const parent = (overrides: Partial<ProductParent> = {}): ProductParent => ({
      id: '99999999-9999-4999-8999-999999999999', name: 'Atrazine 4L', nickname: null, product_form: 'liquid',
      formulation_type: null, safener: null, generic_epa_registration: null, category: 'Herbicide',
      use_timings: ['pre_emerge'], rate_per_acre: '13.000', rate_unit: 'oz', suggested_rate: '13 oz/A',
      parent_version: 7, is_active: true,
      sizes: [{ product_id: SIZE_B, product_name: 'Atrazine 4L 2.5 gal', sku: null, size_role: 'package', fill_source_product_id: null, is_active: true }],
      ...overrides,
    });
    const exp = exported([product(), product({ product_id: SIZE_B, product_name: 'Atrazine 4L 2.5 gal' })]);
    const cell = (wb: import('exceljs').Workbook, sheet: string, row: number, header: string) => {
      const ws = wb.getWorksheet(sheet)!;
      return ws.getCell(row, (ws.getRow(1).values as string[]).slice(1).indexOf(header) + 1);
    };

    it('shows the parent name, locks and notes category and use timing, and moves grouped rates to Parent Rates', async () => {
      let seen: Record<string, unknown> = {};
      const parsed = await roundTrip(exp, (wb) => {
        seen = {
          parentName: cell(wb, 'Setup', 3, 'parent_name').value,
          ungroupedParentName: cell(wb, 'Setup', 2, 'parent_name').value,
          // Excel's default is locked, so a locked cell reads back without a protection entry.
          timingLocked: cell(wb, 'Setup', 3, 'use_timings').protection?.locked !== false,
          timingNote: cell(wb, 'Setup', 3, 'use_timings').note,
          categoryLocked: cell(wb, 'Setup', 3, 'category').protection?.locked !== false,
          ungroupedCategoryLocked: cell(wb, 'Setup', 2, 'category').protection?.locked,
          rateRows: wb.getWorksheet('Rates')!.actualRowCount - 1,
          parentRow: cell(wb, 'Parent Rates', 2, 'parent_name').value,
          parentSizes: cell(wb, 'Parent Rates', 2, 'sizes').value,
        };
      }, [parent()]);
      expect(seen).toEqual({
        parentName: 'Atrazine 4L', ungroupedParentName: '', timingLocked: true, timingNote: 'Set on parent Atrazine 4L',
        categoryLocked: true, ungroupedCategoryLocked: false, rateRows: 1, parentRow: 'Atrazine 4L', parentSizes: 'Atrazine 4L 2.5 gal',
      });
      expect(parsed.rateRows.map((r) => r.product_id)).toEqual([exp.rows[0].product_id]);
      expect(parsed.parentRateRows).toHaveLength(1);
      expect(editedParentRateRows(parsed.parentRateRows)).toEqual([]);
      const preview = buildSetupPreview(parsed.setupRows, exp, OPTIONS, CATEGORIES, groupedParentNames([parent()]));
      expect(preview).toEqual({ changes: [], stale: [], invalid: [] });
    });

    it('refuses a category or use timing change on a grouped row, by product and parent name', async () => {
      const parsed = await roundTrip(exp, (wb) => {
        cell(wb, 'Setup', 3, 'category').value = 'Fungicide';
        cell(wb, 'Setup', 3, 'use_timings').value = 'Post-Emergence';
        cell(wb, 'Setup', 2, 'category').value = 'Fungicide'; // ungrouped: allowed
      }, [parent()]);
      const preview = buildSetupPreview(parsed.setupRows, exp, OPTIONS, CATEGORIES, groupedParentNames([parent()]));
      expect(preview.changes.map((c) => c.product_name)).toEqual(['Atrazine 4L']);
      expect(preview.invalid).toEqual([{ product_id: SIZE_B, product_name: 'Atrazine 4L 2.5 gal',
        problem: 'category is set on parent "Atrazine 4L"; change it on the product page\'s Parent panel; use_timings is set on parent "Atrazine 4L"; change it on the product page\'s Parent panel' }]);
    });

    it('locks a grouped row\'s EPA number and refuses an edit to it, so one cell cannot roll back the whole Setup save', async () => {
      let locked: unknown;
      const parsed = await roundTrip(exp, (wb) => {
        locked = cell(wb, 'Setup', 3, 'epa_registration').protection?.locked !== false;
        cell(wb, 'Setup', 3, 'epa_registration').value = '100-21';
        cell(wb, 'Setup', 2, 'epa_registration').value = '100-21'; // ungrouped: allowed
      }, [parent()]);
      expect(locked).toBe(true);
      const preview = buildSetupPreview(parsed.setupRows, exp, OPTIONS, CATEGORIES, groupedParentNames([parent()]));
      expect(preview.changes.map((c) => c.product_name)).toEqual(['Atrazine 4L']);
      expect(preview.invalid).toEqual([{ product_id: SIZE_B, product_name: 'Atrazine 4L 2.5 gal',
        problem: 'epa_registration is set on parent "Atrazine 4L" and cannot be changed from the workbook' }]);
    });

    it('reads an edited parent rate back with its downloaded version', async () => {
      const parsed = await roundTrip(exp, (wb) => { cell(wb, 'Parent Rates', 2, 'rate_per_acre').value = '14.5'; }, [parent()]);
      expect(editedParentRateRows(parsed.parentRateRows)).toEqual([{
        parent_id: parent().id, parent_name: 'Atrazine 4L', rate_per_acre: '14.5', rate_unit: 'oz', suggested_rate: '13 oz/A',
        expected: { parent_version: 7, rate_per_acre: '13.000', rate_unit: 'oz', suggested_rate: '13 oz/A' },
      }]);
      await expect(roundTrip(exp, (wb) => { cell(wb, 'Parent Rates', 2, 'parent_id').value = 'other'; }, [parent()]))
        .rejects.toThrow(/Parent Rates row 2 is damaged/);
    });

    it('stores a membership hash that changes when a downloaded product is grouped or moved', async () => {
      const ids = exp.rows.map((r) => r.product_id);
      const parsed = await roundTrip(exp, undefined, [parent()]);
      expect(parsed.membershipHash).toBe(await setupMembershipHash(ids, [parent()]));
      expect(await setupMembershipHash([...ids].reverse(), [parent()])).toBe(parsed.membershipHash);
      expect(await setupMembershipHash(ids, [])).not.toBe(parsed.membershipHash);
      expect(await setupMembershipHash(ids, [parent({ id: '88888888-8888-4888-8888-888888888888' })])).not.toBe(parsed.membershipHash);
    });
  });
});
