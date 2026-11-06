/**
 * BulkProductImport.test.tsx — the CSV reader, column mapping and row building, and the screen's
 * preview-then-import flow against a mocked preview_product_import / apply_product_setup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

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
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'u1' }, role: 'admin' }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import BulkProductImport from './BulkProductImport';
import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_TEMPLATE,
  buildProductImportRow,
  csvRecordProblem,
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
  it('keeps a quote inside an unquoted value as text, so it cannot swallow the next row', () => {
    expect(parseCsv('product_name,notes\nA,Hello "bad\nB,another " note\n'))
      .toEqual([['product_name', 'notes'], ['A', 'Hello "bad'], ['B', 'another " note']]);
  });
  it('still reads a quoted value that follows a space, commas and all', () => {
    expect(parseCsv('product_name,sku\n "2,4-D",CHEM-1\n')).toEqual([['product_name', 'sku'], ['2,4-D', 'CHEM-1']]);
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
  it('refuses a row with more values than columns, or text after a closing quote, but allows trailing blanks', () => {
    const [, extra, stray, blanks, spaced] = parseCsvRecords('product_name,notes\nChem,Handle,with care\n"abc"x,n\nOk,n,, \n "2,4-D" ,n\n');
    expect(csvRecordProblem(extra, 2)).toMatch(/1 more value\(s\) than the header/);
    expect(csvRecordProblem(stray, 2)).toMatch(/Text follows a closing quote/);
    expect(csvRecordProblem(blanks, 2)).toBeUndefined();
    expect(csvRecordProblem(spaced, 2)).toBeUndefined();
    const [, twoQuoted] = parseCsvRecords('product_name,notes\n"" "Chem",n\n');
    expect(csvRecordProblem(twoQuoted, 2)).toMatch(/Text follows a closing quote/);
    const [, blankThenQuoted] = parseCsvRecords('product_name,notes\nChem," " "x"\n');
    expect(csvRecordProblem(blankThenQuoted, 2)).toMatch(/Text follows a closing quote/);
    expect(spaced.cells[0].trim()).toBe('2,4-D');
    const [, blankInside] = parseCsvRecords('product_name,notes\nA,B,,C\n');
    expect(csvRecordProblem(blankInside, 2)).toMatch(/2 more value\(s\) than the header/);
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
    expect(build(['product_name', 'product_form', 'inventory_unit', 'rate_unit'], ['Corn', 'seed', 'Lb', 'lb']).error).toBeUndefined();
  });
  it('refuses a seed or each rate unit that contradicts the stock unit instead of dropping it', () => {
    expect(build(['product_name', 'product_form', 'inventory_unit', 'rate_unit'], ['Corn', 'seed', 'Lb', 'Gal']).error)
      .toMatch(/rate unit must match its stock unit \(Lb\), not Gal/);
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
  it('cleans a database permission message instead of showing the table name', () => {
    expect(importRefusalReason('PRODUCT_SETUP_ROW_REFUSED: Chem: permission denied for table products', 'Chem'))
      .toBe('You do not have permission to perform this action');
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
  beforeEach(() => {
    vi.clearAllMocks();
    // The unconfirmed-import record lives in browser storage; each test starts with none.
    window.localStorage.clear();
    window.sessionStorage.clear();
    globalThis.indexedDB = new IDBFactory();
  });

  it('refuses a new import too large for browser storage before anything is saved or locked', async () => {
    rpc.mockImplementation(async () => ({ data: { rates_locked: false, rows: [okRow()] }, error: null }));
    render(<BulkProductImport {...props} />);
    await upload(`product_name,notes\nBig,${'x'.repeat(1_000_001)}\n`);
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 Product/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/too large to import safely/)));
    expect(rpc).not.toHaveBeenCalledWith('apply_product_setup', expect.anything());
    expect(screen.queryByText(/was not confirmed/)).not.toBeInTheDocument();
  });

  it('skips a row with more values than columns before anything is sent', async () => {
    rpc.mockImplementation(async () => ({ data: { rates_locked: false, rows: [okRow()] }, error: null }));
    render(<BulkProductImport {...props} />);
    await upload('product_name,notes\nChem,Handle,with care\nOk,fine\n');
    expect(await screen.findByText(/1 more value\(s\) than the header has columns/)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('preview_product_import', { p_rows: [{ insert: { product_name: 'Ok', notes: 'fine' } }] });
  });

  it('offers the template and blocks a pricing column before anything is sent', async () => {
    render(<BulkProductImport {...props} />);
    expect(screen.getByRole('button', { name: /download template/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Select File')).toHaveAttribute('accept', '.csv,text/csv');
    await upload('product_name,supplier_cost\nAtrazine,12.34');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/pricing columns are not allowed.*supplier_cost/i)));
    expect(rpc).not.toHaveBeenCalled();
  });

  it('skips both rows that share a SKU, even when one of them has another mistake', async () => {
    rpc.mockImplementation(async () => ({ data: { rates_locked: false, rows: [okRow()] }, error: null }));
    render(<BulkProductImport {...props} />);
    await upload('product_name,sku,rup\nCorrect Product,SKU-1,maybe\nWrong Product,sku-1 ,no\nOther,SKU-2,no\n');
    expect(await screen.findByText('This name or SKU appears more than once in the file: skipped.')).toBeInTheDocument();
    expect(screen.getByText('RUP must be yes or no.')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('preview_product_import', { p_rows: [{ insert: { product_name: 'Other', sku: 'SKU-2', is_rup: false } }] });
  });

  it('refuses a header row with text after a closing quote before anything is sent (Sol LOW)', async () => {
    render(<BulkProductImport {...props} />);
    await upload('"product_name"!,notes\nChemical,note\n');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/header row has text after a closing quote/)));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Finish Earlier Import (1)' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    const saves = rpc.mock.calls.filter(([n]) => n === 'apply_product_setup');
    expect(saves[0][1]).toMatchObject({ p_performed_by: 'u1', p_rows: [
      { insert: { product_name: 'Good', sku: 'G1', notes: 'two\nlines' }, rates: { rate_per_acre: '4', rate_unit: 'oz', suggested_rate: null }, expected_prices: prices },
    ] });
    expect(saves[1][1].p_idempotency_key).toBe(saves[0][1].p_idempotency_key);
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it('offers the clear button once an unconfirmed import is past its retry window (Sol HIGH)', async () => {
    rpc.mockImplementation(async (name: string) => (name === 'preview_product_import'
      ? { data: { rates_locked: false, rows: [okRow()] }, error: null }
      : { data: null, error: { message: 'network' } }));
    const first = render(<BulkProductImport {...props} />);
    await upload('product_name\nLost Reply\n');
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 Product/ }));
    await screen.findByRole('button', { name: 'Finish Earlier Import (1)' });
    expect(screen.queryByRole('button', { name: /clear this/ })).not.toBeInTheDocument();
    first.unmount();
    const realNow = Date.now();
    const later = vi.spyOn(Date, 'now').mockReturnValue(realNow + 25 * 60 * 60 * 1000);
    try {
      render(<BulkProductImport {...props} />);
      expect(await screen.findByRole('button', { name: /I checked the records — clear this/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Finish Earlier Import (1)' })).toBeDisabled();
    } finally {
      later.mockRestore();
    }
  });

  it('checks a large file in batches of 100 (KI-103) but still saves it in one all-or-nothing call', async () => {
    rpc.mockImplementation(async (name: string, args: { p_rows: { insert: { product_name: string } }[] }) => {
      if (name !== 'preview_product_import') return { data: { inserted_count: 250, rows: [] }, error: null };
      // The name check proves each result lands on its own row.
      return { data: { rates_locked: true, rows: args.p_rows.map((r) => okRow({
        status: r.insert.product_name === 'P 150' ? 'refused' : 'ok', error: r.insert.product_name === 'P 150' ? 'Row 150 refused' : null,
      })) }, error: null };
    });
    render(<BulkProductImport {...props} />);
    const csv = ['product_name', ...Array.from({ length: 250 }, (_, i) => `P ${i + 1}`)].join('\n');
    await upload(csv);
    expect(await screen.findByRole('button', { name: /Import 249 Product/ })).toBeInTheDocument();
    const sizes = rpc.mock.calls.filter(([n]) => n === 'preview_product_import').map(([, a]) => a.p_rows.length);
    expect(sizes).toEqual([100, 100, 50]);
    expect(screen.getByText('Row 150 refused')).toBeInTheDocument();
    expect(screen.getByText(/Rates are locked\. Rows that set a rate are skipped/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Import 249 Product/ }));
    // 249 rows are written to browser storage before the save; CI with coverage needs more than the default 1 s.
    expect(await screen.findByText('Import Complete', undefined, { timeout: 5000 })).toBeInTheDocument();
    const saves = rpc.mock.calls.filter(([n]) => n === 'apply_product_setup');
    expect(saves).toHaveLength(1);
    expect(saves[0][1].p_rows).toHaveLength(249);
  });

  it('asks for a fresh check when rates are locked or unlocked between batches', async () => {
    let previews = 0;
    rpc.mockImplementation(async (_n: string, args: { p_rows: unknown[] }) => {
      previews += 1;
      return { data: { rates_locked: previews > 1, rows: args.p_rows.map(() => okRow()) }, error: null };
    });
    render(<BulkProductImport {...props} />);
    await upload(['product_name', ...Array.from({ length: 150 }, (_, i) => `P ${i + 1}`)].join('\n'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error',
      'Could not check the file: Rates were locked or unlocked while the file was being checked. Check the file again.'));
    expect(screen.queryByRole('button', { name: /Import \d+ Product/ })).not.toBeInTheDocument();
  });

  it('refuses a check reply with the wrong number of rows instead of pinning results to the wrong products', async () => {
    rpc.mockImplementation(async () => ({ data: { rates_locked: false, rows: [okRow()] }, error: null }));
    render(<BulkProductImport {...props} />);
    await upload('product_name\nA\nB\n');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/^Could not check the file/)));
    expect(screen.queryByRole('button', { name: /Import \d+ Product/ })).not.toBeInTheDocument();
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

  it('locks the file and buttons while checking, and ignores a check reply for a file that was replaced', async () => {
    let answer!: (v: unknown) => void;
    rpc.mockImplementation(() => new Promise((r) => { answer = r; }));
    render(<BulkProductImport {...props} />);
    await upload('product_name\nFromA\n');
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.getByLabelText('Select File')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Checking/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // A change that slips through anyway (file B) makes A's late reply stale.
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [new File(['x'], 'b.csv')] } });
    answer({ data: { rates_locked: false, rows: [okRow()] }, error: null });
    await waitFor(() => expect(screen.getByRole('button', { name: /Check File/ })).toBeEnabled());
    expect(screen.queryByText('FromA')).not.toBeInTheDocument();
    expect(screen.getByText(/b\.csv/)).toBeInTheDocument();
  });

  it('after an unconfirmed save, a reload offers only the same import, re-sent unchanged under the same key', async () => {
    let saves = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name === 'preview_product_import') return { data: { rates_locked: false, rows: [okRow()] }, error: null };
      saves += 1;
      return saves === 1 ? { data: null, error: { message: 'network' } } : { data: { inserted_count: 1, rows: [] }, error: null };
    });
    const first = render(<BulkProductImport {...props} />);
    await upload('product_name\nOne\n');
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 Product/ }));
    expect(await screen.findByText(/An earlier import of 1 product\(s\) was not confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Different File' })).toBeDisabled();
    // The page reloads: nothing in memory survives.
    first.unmount();
    render(<BulkProductImport {...props} />);
    expect(await screen.findByText(/An earlier import of 1 product\(s\) was not confirmed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Select File')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Check File/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Earlier Import (1)' }));
    expect(await screen.findByText('Import Complete')).toBeInTheDocument();
    const saved = rpc.mock.calls.filter(([n]) => n === 'apply_product_setup').map(([, a]) => a);
    expect(saved).toHaveLength(2);
    expect(saved[1].p_idempotency_key).toBe(saved[0].p_idempotency_key);
    expect(saved[1].p_rows).toEqual([{ insert: { product_name: 'One' } }]);
    expect(screen.queryByText(/was not confirmed/)).not.toBeInTheDocument();
  });

  it('a refused save frees the screen; closing mid-save keeps the import, so the late success is still confirmed', async () => {
    let answer!: (v: unknown) => void;
    rpc.mockImplementation((name: string) => (name === 'preview_product_import'
      ? Promise.resolve({ data: { rates_locked: false, rows: [okRow()] }, error: null })
      : new Promise((r) => { answer = r; })));
    const { rerender } = render(<BulkProductImport {...props} />);
    await upload('product_name\nOne\n');
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 Product/ }));
    expect(screen.getByRole('button', { name: 'Choose Different File' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('apply_product_setup', expect.anything()));
    answer({ data: null, error: { code: 'P0001', message: 'Nothing was saved. Bad row.' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose Different File' })).toBeEnabled());
    expect(screen.queryByText(/was not confirmed/)).not.toBeInTheDocument();
    // Save again, and the page closes the window before the reply lands.
    fireEvent.click(screen.getByRole('button', { name: /Import 1 Product/ }));
    rerender(<BulkProductImport {...props} open={false} />);
    rerender(<BulkProductImport {...props} />);
    await waitFor(() => expect(rpc.mock.calls.filter(([n]) => n === 'apply_product_setup')).toHaveLength(2));
    answer({ data: { inserted_count: 1, rows: [] }, error: null });
    expect(await screen.findByText('Import Complete')).toBeInTheDocument();
    expect(props.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('drops a check error for a file that was since replaced', async () => {
    let fail!: (e: unknown) => void;
    rpc.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    render(<BulkProductImport {...props} />);
    await upload('product_name\nFromA\n');
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Select File'), { target: { files: [new File(['x'], 'b.csv')] } });
    fail(new Error('boom'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Check File/ })).toBeEnabled());
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringMatching(/Could not check the file/));
  });
});
