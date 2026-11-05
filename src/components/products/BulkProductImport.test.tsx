/**
 * BulkProductImport.test.tsx — the CSV reader, column mapping and row building, and the screen's
 * preview-then-import flow against a mocked preview_product_import / apply_product_setup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockToast, rpc } = vi.hoisted(() => ({ mockToast: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/db', () => ({
  supabase: { rpc },
  assertRpcResult: (data: unknown) => data,
}));
vi.mock('../../lib/productSetup', () => ({
  listProductCategories: vi.fn(async () => [
    { name: 'Herbicide', is_active: true }, { name: 'Retired', is_active: false },
  ]),
}));
vi.mock('../../lib/documentOCR', () => ({ isCSVFile: vi.fn(() => true) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'u1' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import BulkProductImport from './BulkProductImport';
import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_TEMPLATE,
  buildProductImportRow,
  importRefusalReason,
  isRetiredPricingColumn,
  mapProductImportHeaders,
  parseCsvRecords,
  productImportColumn,
  toCsv,
} from './bulkProductImportSafety';

const parseCsv = (text: string) => parseCsvRecords(text).map((r) => r.cells);

const okRow = (over: Record<string, unknown> = {}) => ({
  status: 'ok', error: null, after: { rate_per_acre: null, rate_unit: null, tier1_price_per_acre: null, tier2_price_per_acre: null, tier3_price_per_acre: null },
  expected_prices: null, sku_matches: [], name_matches: [], epa_matches: [], in_file_duplicate: false, ...over,
});

async function upload(csv: string) {
  const file = new File([csv], 'products.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
  fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: /check file/i }));
}

describe('CSV reader', () => {
  it('keeps a quoted note with a comma, a doubled quote and a line break intact', () => {
    expect(parseCsv('﻿product_name,notes\r\nChem,"line one\nline two, ""quoted"""\r\nOther,plain\r\n'))
      .toEqual([['product_name', 'notes'], ['Chem', 'line one\nline two, "quoted"'], ['Other', 'plain']]);
  });
  it('drops blank lines and keeps a last row without a newline', () => {
    expect(parseCsv('a,b\n\n1,2\n , \n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('refuses an unclosed quote instead of swallowing later rows', () => {
    expect(() => parseCsv('product_name,notes\nA,"open note\nB,x\n')).toThrow(/never closed/);
  });
  it('round-trips through its own writer', () => {
    const rows = [['a', 'b,c'], ['line\nbreak', 'say "hi"']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('numbers each record by the file line it starts on, past multi-line notes and blank lines', () => {
    const text = 'product_name,notes\r\nA,"one\r\ntwo\nthree"\r\n\r\nB,x\nC,"a\rb"\nD,y';
    expect(parseCsvRecords(text).map((r) => r.line)).toEqual([1, 2, 6, 7, 9]);
  });
});

describe('template and columns', () => {
  it('the template round-trips: every header maps to its own column', () => {
    const [headers] = parseCsv(PRODUCT_IMPORT_TEMPLATE);
    expect(headers).toEqual([...PRODUCT_IMPORT_COLUMNS]);
    const mapping = mapProductImportHeaders(headers);
    expect(Object.values(mapping.byIndex)).toEqual([...PRODUCT_IMPORT_COLUMNS]);
    expect(mapping.ignored).toEqual([]);
    expect(mapping.conflicts).toEqual([]);
  });
  it('no longer guesses "unit" or "type"', () => {
    expect(productImportColumn('unit')).toBeNull();
    expect(productImportColumn('Type')).toBeNull();
    expect(productImportColumn('Rate Unit')).toBe('rate_unit');
    expect(productImportColumn('EPA Reg')).toBe('epa_registration');
  });
  it('names two columns that mean the same field, and lists unknown ones', () => {
    const m = mapProductImportHeaders(['product_name', 'product', 'colour']);
    expect(m.conflicts).toEqual(['"product_name" and "product" both mean product_name']);
    expect(m.ignored).toEqual(['colour']);
  });
  it('refuses the old ambiguous "unit" and "type" headers instead of dropping them', () => {
    const m = mapProductImportHeaders(['product_name', 'Unit', 'type']);
    expect(m.ambiguous).toEqual(['"Unit" (rename it to unit_size or rate_unit)', '"type" (rename it to category, product_form or container_type)']);
    expect(Object.values(m.byIndex)).toEqual(['product_name']);
  });
  it.each([['application_per_acre', 'rate_per_acre'], ['pricing_unit', 'inventory_unit'], ['type_liquid_dry', 'product_form'],
    ['container', 'container_size'], ['units', 'unit_size'], ['use timing', 'use_timing']])(
    'still reads the earlier template header %s as %s', (h, col) => expect(productImportColumn(h)).toBe(col));
  it.each(['cost', 'supplier-cost-cents', 'tier1_price', 't3_gross_margin', 'tier3_price_per_acre', 'pricing_version'])(
    'rejects pricing header %s', (h) => expect(isRetiredPricingColumn(h)).toBe(true));
  it('does not mistake rate details for pricing', () => {
    expect(isRetiredPricingColumn('rate_per_acre')).toBe(false);
    expect(isRetiredPricingColumn('suggested_rate')).toBe(false);
  });
});

describe('row building', () => {
  const build = (headers: string[], cells: string[]) =>
    buildProductImportRow(cells, mapProductImportHeaders(headers), 2, ['Herbicide', 'Seed']);

  it('fixes spelling only, and says so', () => {
    const r = build(['product_name', 'category', 'product_form', 'container_type', 'signal_word', 'is_rup'],
      ['Chem', 'herbicide', 'Liquid', 'jug', 'CAUTION', 'Yes']);
    expect(r.insert).toEqual({ product_name: 'Chem', category: 'Herbicide', product_form: 'liquid', container_type: 'Jug', signal_word: 'Caution', is_rup: true });
    expect(r.fixes).toEqual(['category: "herbicide" → "Herbicide"', 'product_form: "Liquid" → "liquid"', 'container_type: "jug" → "Jug"', 'signal_word: "CAUTION" → "Caution"']);
    expect(r.error).toBeUndefined();
  });
  it('sends no rate columns in the insert; rates travel separately', () => {
    const r = build(['product_name', 'rate_per_acre', 'rate_unit', 'suggested_rate'], ['Chem', '4', 'oz', '4 oz/A']);
    expect(r.insert).toEqual({ product_name: 'Chem' });
    expect(r.rates).toEqual({ rate_per_acre: '4', rate_unit: 'oz', suggested_rate: '4 oz/A' });
  });
  it('a seed unit alone is not a rate', () => {
    expect(build(['product_name', 'product_form', 'rate_unit'], ['Corn', 'seed', 'Lb']).rates).toBeUndefined();
  });
  it.each([
    [['product_name'], [''], /Missing product name/],
    [['product_name', 'container_size'], ['Chem', '0'], /Container size must be/],
    [['product_name', 'container_size'], ['Chem', '0x1A'], /Container size must be/],
    [['product_name', 'rate_per_acre', 'rate_unit'], ['Chem', '-1', 'oz'], /Rate per acre must be/],
    [['product_name', 'rate_per_acre', 'rate_unit'], ['Chem', '1e21', 'oz'], /Rate per acre must be/],
    [['product_name', 'rei'], ['Chem', '12.5'], /REI hours must be a whole number/],
    [['product_name', 'rup'], ['Chem', 'maybe'], /RUP must be yes or no/],
  ])('refuses a bad value before the database sees it: %j', (headers, cells, why) => {
    expect(build(headers, cells).error).toMatch(why);
  });
  it('strips the refusal code and the repeated product name', () => {
    expect(importRefusalReason('PRODUCT_SETUP_ROW_REFUSED: Chem: PRODUCT_SETUP_INVALID: EPA number must look like 524-475', 'Chem'))
      .toBe('EPA number must look like 524-475');
    expect(importRefusalReason('Unknown use timing "X". Pick from the list.', 'Chem')).toBe('Unknown use timing "X". Pick from the list.');
    // The exact texts the local browser proof showed (2026-11-05).
    expect(importRefusalReason('PRODUCT_SETUP_ROW_REFUSED: Bad Cat: insert or update on table "products" violates foreign key constraint "product_setup_category_fk"', 'Bad Cat'))
      .toBe('Choose a category from the product category list');
    expect(importRefusalReason('PRODUCT_SETUP_ROW_REFUSED: Bad Box: new row for relation "products" violates check constraint "products_container_type_check"', 'Bad Box'))
      .toMatch(/^Choose a container type: Jug, Drum/);
    expect(importRefusalReason('PRODUCT_SETUP_ROW_REFUSED: Bad EPA: PRODUCT_SETUP_INVALID: EPA number', 'Bad EPA'))
      .toBe('Enter a valid EPA number, like 524-475 or 100-1234-5905');
    expect(importRefusalReason('PRODUCT_SETUP_INVALID: a maximum label rate needs a unit of oz or pt (per acre): Label', 'Label'))
      .toBe('A maximum label rate needs a unit of oz or pt (per acre)');
  });
});

describe('BulkProductImport screen', () => {
  const props = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => { vi.clearAllMocks(); });

  it('offers the template and blocks a pricing column before anything is sent', async () => {
    render(<BulkProductImport {...props} />);
    expect(screen.getByRole('button', { name: /download template/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Select File')).toHaveAttribute('accept', '.csv,text/csv');
    await upload('product_name,supplier_cost\nAtrazine,12.34');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/pricing columns are not allowed.*supplier_cost/i)));
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses two columns that mean the same thing', async () => {
    render(<BulkProductImport {...props} />);
    await upload('product_name,name\nA,B');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/Two columns mean the same thing/)));
    expect(rpc).not.toHaveBeenCalled();
  });

  it('previews every row with its reason, imports only the ready ones with their previewed prices, once', async () => {
    const prices = { tier1_price_per_acre: 1.25, tier2_price_per_acre: 1.13, tier3_price_per_acre: 1 };
    rpc.mockImplementation(async (name: string) => (name === 'preview_product_import'
      ? { data: { rates_locked: false, rows: [
        okRow({ after: { rate_per_acre: '4', rate_unit: 'oz', ...prices }, expected_prices: prices }),
        okRow({ status: 'refused', error: 'PRODUCT_SETUP_ROW_REFUSED: Bad: PRODUCT_SETUP_INVALID: EPA number must look like 524-475' }),
        okRow({ status: 'refused', error: 'PRODUCT_SETUP_DUPLICATE: x', sku_matches: [{ product_name: 'Old Chem', is_active: true }] }),
      ] }, error: null }
      : { data: null, error: { message: 'network' } }));
    render(<BulkProductImport {...props} />);
    await upload('product_name,sku,epa_registration,rate_per_acre,rate_unit,notes\nGood,G1,,4,oz,"two\nlines"\nBad,B1,abc,,,\nAgain,OLD,,,,\n');
    expect(await screen.findByText('EPA number must look like 524-475')).toBeInTheDocument();
    expect(screen.getByText('Duplicate of Old Chem: skipped.')).toBeInTheDocument();
    expect(screen.getByText('$1.25 / $1.13 / $1.00')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('preview_product_import', { p_rows: [
      { insert: { product_name: 'Good', sku: 'G1', notes: 'two\nlines' }, rates: { rate_per_acre: '4', rate_unit: 'oz', suggested_rate: null } },
      { insert: { product_name: 'Bad', sku: 'B1', epa_registration: 'abc' } },
      { insert: { product_name: 'Again', sku: 'OLD' } },
    ] });
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Product/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/^The import was not confirmed \(network\)/)));
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Product/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    const saves = rpc.mock.calls.filter(([n]) => n === 'apply_product_setup');
    expect(saves[0][1]).toMatchObject({ p_performed_by: 'u1', p_rows: [
      { insert: { product_name: 'Good', sku: 'G1', notes: 'two\nlines' }, rates: { rate_per_acre: '4', rate_unit: 'oz', suggested_rate: null }, expected_prices: prices },
    ] });
    expect(saves[1][1].p_idempotency_key).toBe(saves[0][1].p_idempotency_key);
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it('shows the lock, skips rated rows it refuses, and reports the import', async () => {
    rpc.mockImplementation(async (name: string) => (name === 'preview_product_import'
      ? { data: { rates_locked: true, rows: [
        okRow({ status: 'refused', error: 'PRODUCT_RATES_LOCKED: rates are locked; an admin can correct one product\'s rates' }),
        okRow(),
      ] }, error: null }
      : { data: { inserted_count: 1, rows: [] }, error: null }));
    const { rerender } = render(<BulkProductImport {...props} />);
    await upload('product_name,rate_per_acre,rate_unit\nRated,1,oz\nPlain,,\n');
    expect(await screen.findByText(/Rates are locked\. Rows that set a rate are skipped/)).toBeInTheDocument();
    expect(screen.getByText(/^Rates are locked; an admin can correct/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Product/ }));
    expect(await screen.findByText('Import Complete')).toBeInTheDocument();
    expect(rpc.mock.calls.find(([n]) => n === 'apply_product_setup')?.[1].p_rows).toEqual([{ insert: { product_name: 'Plain' } }]);
    expect(props.onSuccess).toHaveBeenCalled();
    // The page closes the window on success; reopening starts a new import.
    rerender(<BulkProductImport {...props} open={false} />);
    rerender(<BulkProductImport {...props} />);
    expect(screen.queryByText('Import Complete')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Select File')).toBeInTheDocument();
  });
});
