import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import type { Workbook } from 'exceljs';
import type { PricingPreviewResult, PricingWorkbookExport } from './productPricing';
import {
  DOLLAR_HEADER_NOTE,
  generateProductPricingWorkbook,
  groupedUseTimingRefusal,
  MAX_PRICING_WORKBOOK_FILE_BYTES,
  MAX_PRICING_WORKBOOK_ROWS,
  MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES,
  parseProductPricingWorkbook,
  isPriceSheetRefusal,
  priceSheetExpiredText,
  priceSheetReasonText,
  priceSheetRefusalText,
  PRICING_WORKBOOK_FORMAT_VERSION,
  PRICING_WORKBOOK_HEADERS,
  PRICING_WORKBOOK_MANIFEST_SHEET,
  PRICING_WORKBOOK_SHEET,
  PricingWorkbookFormatError,
} from './productPricingWorkbook';

const pricingExport: PricingWorkbookExport = {
  export_id: '11111111-1111-4111-8111-111111111111',
  format_version: PRICING_WORKBOOK_FORMAT_VERSION,
  manifest_fingerprint: 'manifest-fingerprint',
  expires_at: '2026-07-17T21:00:00+00:00',
  rows: [
    {
      product_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sku: '000123',
      product_name: 'Leading Zero Herbicide',
      category: 'Herbicide',
      container_size: '2.5',
      unit_size: 'gal',
      inventory_unit: 'gallon',
      identity_fingerprint: 'identity-a',
      row_token: 'token-a',
      row_version: 7,
      current_cost: '125.40',
      current_tier1_margin_percent: '20',
      current_tier1_price: '156.75',
      current_tier2_margin_percent: '15.5',
      current_tier2_price: '148.40',
      current_tier3_margin_percent: '10.125',
      current_tier3_price: '139.53',
      suggested_rate: '12-16 oz',
      rate_per_acre: '16',
      rate_unit: 'oz',
      use_timing: 'Post-emergence',
      internal_notes: 'Warehouse note',
      quoting_notes: 'Sales guidance',
    },
    {
      product_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sku: null,
      product_name: 'Exact Decimal Product',
      category: null,
      container_size: null,
      unit_size: null,
      inventory_unit: null,
      identity_fingerprint: 'identity-b',
      row_token: 'token-b',
      row_version: 2,
      current_cost: '0.07',
      current_tier1_margin_percent: '12.3456789',
      current_tier1_price: '0.08',
      current_tier2_margin_percent: '0',
      current_tier2_price: '0.07',
      current_tier3_margin_percent: null,
      current_tier3_price: null,
      suggested_rate: null,
      rate_per_acre: null,
      rate_unit: null,
      use_timing: null,
      internal_notes: null,
      quoting_notes: null,
    },
  ],
};

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

async function loadGeneratedWorkbook(
  options: Parameters<typeof generateProductPricingWorkbook>[1] = {},
): Promise<{ workbook: Workbook; buffer: ArrayBuffer }> {
  const ExcelJS = await import('exceljs');
  const blob = await generateProductPricingWorkbook(pricingExport, options);
  const buffer = await blobToArrayBuffer(blob);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return { workbook, buffer };
}

async function writeWorkbook(workbook: Workbook): Promise<ArrayBuffer> {
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as unknown as ArrayBuffer).buffer;
}

function withFirstZipEntryUncompressedSize(buffer: ArrayBuffer, size: number): ArrayBuffer {
  const copy = buffer.slice(0);
  const view = new DataView(copy);
  for (let offset = 0; offset <= view.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, size, true);
      return copy;
    }
  }
  throw new Error('Generated workbook had no ZIP central-directory entry');
}

function createZipWithForgedSmallExpandedSize(actualSize: number): ArrayBuffer {
  const fileName = new TextEncoder().encode('bomb.bin');
  const compressed = deflateRawSync(new Uint8Array(actualSize));
  const declaredUncompressedSize = 1;
  const localHeaderSize = 30 + fileName.byteLength;
  const directoryOffset = localHeaderSize + compressed.byteLength;
  const directorySize = 46 + fileName.byteLength;
  const endOffset = directoryOffset + directorySize;
  const archive = new Uint8Array(endOffset + 22);
  const view = new DataView(archive.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 8, true);
  view.setUint32(18, compressed.byteLength, true);
  view.setUint32(22, declaredUncompressedSize, true);
  view.setUint16(26, fileName.byteLength, true);
  archive.set(fileName, 30);
  archive.set(compressed, localHeaderSize);

  view.setUint32(directoryOffset, 0x02014b50, true);
  view.setUint16(directoryOffset + 4, 20, true);
  view.setUint16(directoryOffset + 6, 20, true);
  view.setUint16(directoryOffset + 10, 8, true);
  view.setUint32(directoryOffset + 20, compressed.byteLength, true);
  view.setUint32(directoryOffset + 24, declaredUncompressedSize, true);
  view.setUint16(directoryOffset + 28, fileName.byteLength, true);
  archive.set(fileName, directoryOffset + 46);

  view.setUint32(endOffset, 0x06054b50, true);
  view.setUint16(endOffset + 8, 1, true);
  view.setUint16(endOffset + 10, 1, true);
  view.setUint32(endOffset + 12, directorySize, true);
  view.setUint32(endOffset + 16, directoryOffset, true);
  return archive.buffer;
}

describe('product pricing workbook', () => {
  it('has an editable source column after the reason, and reads what the admin typed into both', async () => {
    const reasonIndex = PRICING_WORKBOOK_HEADERS.indexOf('change_reason');
    expect(PRICING_WORKBOOK_HEADERS[reasonIndex + 1]).toBe('price_source');

    const { workbook } = await loadGeneratedWorkbook();
    const sheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const sourceColumn = PRICING_WORKBOOK_HEADERS.indexOf('price_source') + 1;
    expect(sheet.getCell(2, sourceColumn).protection?.locked).toBe(false);
    sheet.getCell(2, reasonIndex + 1).value = 'Supplier raised cost';
    sheet.getCell(2, sourceColumn).value = 'Helena list Oct 2026';

    const parsed = await parseProductPricingWorkbook(await writeWorkbook(workbook));
    expect(parsed.rows[0]).toMatchObject({ change_reason: 'Supplier raised cost', price_source: 'Helena list Oct 2026' });
    expect(parsed.rows[1]).toMatchObject({ change_reason: '', price_source: '' });
  }, 20000);

  it('round-trips exact server strings and preserves leading-zero SKUs', async () => {
    const { buffer } = await loadGeneratedWorkbook();

    const parsed = await parseProductPricingWorkbook(buffer);

    expect(parsed).toMatchObject({
      formatVersion: PRICING_WORKBOOK_FORMAT_VERSION,
      exportId: pricingExport.export_id,
      manifestFingerprint: pricingExport.manifest_fingerprint,
      expiresAt: pricingExport.expires_at,
      rowCount: 2,
    });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      product_id: pricingExport.rows[0].product_id,
      sku: '000123',
      row_version: '7',
      current_cost: '125.40',
      current_tier1_margin_percent: '20',
      current_tier2_margin_percent: '15.5',
      current_tier3_margin_percent: '10.125',
      pricing_mode: '',
      new_cost: '125.40',
      tier1_margin_percent: '20',
      tier1_price: '156.75',
      suggested_rate: '12-16 oz',
      rate_per_acre: '16',
      rate_unit: 'oz',
      use_timing: 'Post-emergence',
      internal_notes: 'Warehouse note',
      quoting_notes: 'Sales guidance',
      has_formula: false,
      formula_cells: [],
    });
    // Generates and re-parses a real xlsx via ExcelJS. Standalone it runs in
    // ~1.3s, but under full-suite parallel load it has repeatedly crossed the
    // 5s default and failed the pre-commit gate. The work is I/O-bound, not
    // hung — give it headroom rather than retrying the commit until it passes.
  }, 20000);

  it('creates the exact sheets, a veryHidden manifest, hidden row tokens, and blank mode validation', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const manifest = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET)!;
    const identityColumn = PRICING_WORKBOOK_HEADERS.indexOf('identity_fingerprint') + 1;
    const tokenColumn = PRICING_WORKBOOK_HEADERS.indexOf('row_token') + 1;
    const modeColumn = PRICING_WORKBOOK_HEADERS.indexOf('pricing_mode') + 1;
    const currentCostColumn = PRICING_WORKBOOK_HEADERS.indexOf('current_cost') + 1;
    const quotingNotesColumn = PRICING_WORKBOOK_HEADERS.indexOf('quoting_notes') + 1;
    const ratePerAcreColumn = PRICING_WORKBOOK_HEADERS.indexOf('rate_per_acre') + 1;

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      PRICING_WORKBOOK_SHEET,
      PRICING_WORKBOOK_MANIFEST_SHEET,
    ]);
    expect(manifest.state).toBe('veryHidden');
    expect(worksheet.getColumn(identityColumn).hidden).toBe(true);
    expect(worksheet.getColumn(tokenColumn).hidden).toBe(true);
    expect(worksheet.getCell(2, modeColumn).value).toBe('');
    expect(worksheet.getCell(2, currentCostColumn).value).toBe('125.40');
    expect(worksheet.getCell(2, currentCostColumn).numFmt).toBe('@');
    expect(worksheet.getCell(2, quotingNotesColumn).value).toBe('Sales guidance');
    expect(worksheet.getCell(2, quotingNotesColumn).protection.locked).toBe(false);
    expect(worksheet.getCell(2, ratePerAcreColumn).numFmt).toBe('@');
    for (const header of ['suggested_rate', 'rate_per_acre', 'rate_unit'] as const) {
      expect(worksheet.getCell(2, PRICING_WORKBOOK_HEADERS.indexOf(header) + 1).protection?.locked).not.toBe(false);
    }
    expect(manifest.getCell(5, 2).value).toBe('2');
    expect(worksheet.getCell(2, modeColumn).dataValidation).toMatchObject({
      type: 'list',
      allowBlank: true,
      formulae: ['"margin_driven,price_driven"'],
    });
  });

  it('emits formula flags per row so the server can reject the row', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const newCostColumn = PRICING_WORKBOOK_HEADERS.indexOf('new_cost') + 1;
    worksheet.getCell(2, newCostColumn).value = { formula: '100+25.4', result: 125.4 };

    const parsed = await parseProductPricingWorkbook(await writeWorkbook(workbook));

    expect(parsed.rows[0].has_formula).toBe(true);
    expect(parsed.rows[0].formula_cells).toEqual(['new_cost']);
    expect(parsed.rows[0].new_cost).toBe('125.40');
  });

  it('serializes numeric cells as plain decimal strings without cents or ratio conversion', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const newCostColumn = PRICING_WORKBOOK_HEADERS.indexOf('new_cost') + 1;
    const marginColumn = PRICING_WORKBOOK_HEADERS.indexOf('tier1_margin_percent') + 1;
    worksheet.getCell(2, newCostColumn).value = 0.0000001;
    worksheet.getCell(2, marginColumn).value = 19.75;

    const parsed = await parseProductPricingWorkbook(await writeWorkbook(workbook));

    expect(parsed.rows[0].new_cost).toBe('0.0000001');
    expect(parsed.rows[0].tier1_margin_percent).toBe('19.75');
    expect(Object.keys(parsed.rows[0]).some((key) => key.endsWith('_cents'))).toBe(false);
    expect(parsed.rows[0]).not.toHaveProperty('tier1_margin', 0.1975);
  });

  it('keeps exported cents exact beyond JavaScript safe-integer precision', async () => {
    const exactValue = '90071992547409.93';
    const exactExport: PricingWorkbookExport = {
      ...pricingExport,
      rows: [{
        ...pricingExport.rows[0],
        current_cost: exactValue,
        current_tier1_price: exactValue,
      }],
    };
    const ExcelJS = await import('exceljs');
    const blob = await generateProductPricingWorkbook(exactExport);
    const buffer = await blobToArrayBuffer(blob);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const currentCostColumn = PRICING_WORKBOOK_HEADERS.indexOf('current_cost') + 1;

    expect(worksheet.getCell(2, currentCostColumn).value).toBe(exactValue);
    const parsed = await parseProductPricingWorkbook(buffer);
    expect(parsed.rows[0].current_cost).toBe(exactValue);
    expect(parsed.rows[0].new_cost).toBe(exactValue);
    expect(parsed.rows[0].tier1_price).toBe(exactValue);
  });

  it('writes locked current margins as 2-decimal numbers that read back as the exact server text', async () => {
    // The server's margin text: trim_scale(round(ratio * 100, 8))::text, so up to 8 decimals, no trailing zeros.
    const baseline = [
      '0', '1', '5', '10', '20', '25', '33', '50', '99', '100', '250', '-5', '-100',
      '0.5', '12.5', '15.5', '10.125', '12.3456789', '33.33333333', '66.66666667', '99.99999999',
      '0.00000001', '0.0000001', '0.000001', '0.00001', '-0.00000001', '-33.33333333', '0.1', '0.2', '0.3',
      '12345678.12345678', '-98765432.87654321', '14.28571429', '28.57142857', '11.11111111', '9.09090909', '16.66666667', '1234567.12345678',
      // Too many digits for a number to hold exactly: must stay text, and still read back exactly.
      '-12345678901.12345678', '9876543210.98765432',
    ];
    // Plus a fixed pseudo-random spread of 0-999 with 0 to 8 decimals.
    let seed = 20261124;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let i = 0; i < 1500; i += 1) {
      const decimals = next() % 9;
      const integer = String(next() % 1000);
      const fraction = String(next() % 10 ** decimals).padStart(decimals, '0').replace(/0+$/, '');
      baseline.push(fraction ? `${integer}.${fraction}` : integer);
    }
    const rows = [];
    for (let i = 0; i < baseline.length; i += 3) {
      rows.push({
        ...pricingExport.rows[0],
        product_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        current_tier1_margin_percent: baseline[i],
        current_tier2_margin_percent: baseline[i + 1] ?? '',
        current_tier3_margin_percent: baseline[i + 2] ?? '',
      });
    }
    const blob = await generateProductPricingWorkbook({ ...pricingExport, rows });
    const buffer = await blobToArrayBuffer(blob);
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const parsed = await parseProductPricingWorkbook(buffer);

    const mismatches: string[] = [];
    let numberCells = 0;
    rows.forEach((row, index) => {
      for (const tier of [1, 2, 3] as const) {
        const header = `current_tier${tier}_margin_percent` as const;
        const cell = worksheet.getCell(index + 2, PRICING_WORKBOOK_HEADERS.indexOf(header) + 1);
        if (row[header] !== '') {
          if (typeof cell.value === 'number') {
            numberCells += 1;
            expect(cell.numFmt).toBe('0.00');
          } else {
            expect(cell.value).toBe(row[header]);
            expect(cell.numFmt).toBe('@');
          }
        }
        if (parsed.rows[index][header] !== row[header]) mismatches.push(`${row[header]} -> ${parsed.rows[index][header]}`);
        // The editable copy stays text, byte for byte.
        const editable = worksheet.getCell(index + 2, PRICING_WORKBOOK_HEADERS.indexOf(`tier${tier}_margin_percent`) + 1);
        if (row[header] !== '') expect(editable.value).toBe(row[header]);
        expect(parsed.rows[index][`tier${tier}_margin_percent`]).toBe(row[header]);
      }
    });
    expect(mismatches).toEqual([]);
    expect(baseline.length).toBeGreaterThan(1500);
    // Every value except the two over-long ones is written as a number.
    expect(numberCells).toBe(baseline.length - 2);
  }, 30000);

  it('notes the dollar headers as per inventory unit, keeps the header text, and still parses', async () => {
    const { workbook, buffer } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const noted = PRICING_WORKBOOK_HEADERS.filter((_, index) => worksheet.getCell(1, index + 1).note);
    expect(noted).toEqual([
      'current_cost', 'current_tier1_price', 'current_tier2_price', 'current_tier3_price',
      'new_cost', 'tier1_price', 'tier2_price', 'tier3_price',
    ]);
    expect(worksheet.getCell(1, PRICING_WORKBOOK_HEADERS.indexOf('new_cost') + 1).note).toBe(DOLLAR_HEADER_NOTE);
    expect(DOLLAR_HEADER_NOTE).toBe('Dollars per inventory unit (see the inventory_unit column)');
    expect(Array.from({ length: worksheet.getRow(1).cellCount }, (_, index) => worksheet.getCell(1, index + 1).value))
      .toEqual([...PRICING_WORKBOOK_HEADERS]);
    const parsed = await parseProductPricingWorkbook(buffer);
    expect(parsed.rows[0].current_cost).toBe('125.40');
    // A sheet saved again with the notes (as Excel would) still parses.
    const reparsed = await parseProductPricingWorkbook(await writeWorkbook(workbook));
    expect(reparsed.rows).toEqual(parsed.rows);
  }, 30000);

  it('accepts the zero-row workbook emitted by the generator', async () => {
    const blob = await generateProductPricingWorkbook({ ...pricingExport, rows: [] });
    const parsed = await parseProductPricingWorkbook(await blobToArrayBuffer(blob));

    expect(parsed.rowCount).toBe(0);
    expect(parsed.rows).toEqual([]);
  });

  it('rejects duplicate headers before sending workbook rows to the server', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    worksheet.getCell(1, 2).value = 'product_id';

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow('duplicate headers');
  });

  it('rejects a workbook with no CRX manifest', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const manifest = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET)!;
    workbook.removeWorksheet(manifest.id);

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow(PricingWorkbookFormatError);
    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow('Missing CRX workbook manifest');
  });

  it('rejects an expired v1 workbook format and requires a fresh v2 export', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const manifest = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET)!;
    manifest.getCell(1, 2).value = 'crx-product-pricing-phase1a-v1';

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow('not supported');
  });

  it('rejects a manifest that could make the browser parse an excessive row count', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const manifest = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET)!;
    manifest.getCell(5, 2).value = String(MAX_PRICING_WORKBOOK_ROWS + 1);

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow(`limited to ${MAX_PRICING_WORKBOOK_ROWS} rows`);
  });

  it('explains a deleted row in plain words', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!.spliceRows(3, 1);

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow('Rows were added to or deleted from the Pricing Update sheet.');
  });

  it('rejects an oversized upload before ExcelJS parses it', async () => {
    await expect(parseProductPricingWorkbook(new ArrayBuffer(MAX_PRICING_WORKBOOK_FILE_BYTES + 1)))
      .rejects.toThrow('10 MB or smaller');
  });

  it('rejects an archive whose declared expanded size exceeds the browser safety limit', async () => {
    const { buffer } = await loadGeneratedWorkbook();
    const oversizedArchive = withFirstZipEntryUncompressedSize(
      buffer,
      MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES + 1,
    );

    await expect(parseProductPricingWorkbook(oversizedArchive))
      .rejects.toThrow('expand to at most 25 MB');
  });

  it('bounds actual decompression when a hostile ZIP lies about its expanded size', async () => {
    const forgedArchive = createZipWithForgedSmallExpandedSize(
      MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES + 1,
    );

    await expect(parseProductPricingWorkbook(forgedArchive))
      .rejects.toThrow('expand to at most 25 MB');
    // 45s (was 15s): the guard being tested is the REJECTION MESSAGE, not the
    // clock — a broken bound would let ExcelJS expand the forged entry and the
    // assertion would fail on the missing throw, not by running long. Building
    // and streaming the forged archive is CPU-bound, so 15s was not enough
    // headroom during a pre-commit run on a busy box.
  }, 45_000);

  it('locks and notes a grouped size\'s Use Timing cell and leaves other rows editable', async () => {
    const groupedParents = new Map([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Leading Zero 4L']]);
    const { workbook, buffer } = await loadGeneratedWorkbook({ groupedParents });
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const timingColumn = PRICING_WORKBOOK_HEADERS.indexOf('use_timing') + 1;
    expect(worksheet.getCell(2, timingColumn).protection?.locked).not.toBe(false);
    expect(worksheet.getCell(2, timingColumn).note).toBe('Set on parent Leading Zero 4L; change it on the product page\'s Parent panel');
    expect(worksheet.getCell(3, timingColumn).protection?.locked).toBe(false);
    expect(worksheet.getCell(3, timingColumn).note).toMatch(/separate labels with a semicolon/);
    // Headers and manifest unchanged, so the server still accepts the file.
    expect((await parseProductPricingWorkbook(buffer)).rowCount).toBe(2);
  });

  it('refuses a use timing change on a grouped size by product and parent name', () => {
    const row = (productId: string, name: string, changes: Record<string, { before: unknown; after: unknown }>) => ({
      sequence: 1, product_id: productId, submitted_row: {}, row_status: 'ready', error_code: null,
      effect: { product_id: productId, product_name: name, product_info_changes: changes },
    });
    const preview = { rows: [
      row('p1', 'Atrazine 1 gal', { use_timing: { before: 'Pre-Emerge', after: 'Post-Emergence' } }),
      row('p2', 'Loose Product', { use_timing: { before: null, after: 'Pre-Emerge' } }),
      row('p3', 'Atrazine 2.5 gal', { internal_notes: { before: null, after: 'x' } }),
    ] } as unknown as PricingPreviewResult;
    const grouped = new Map([['p1', 'Atrazine 4L'], ['p3', 'Atrazine 4L']]);
    expect(groupedUseTimingRefusal(preview, grouped)).toBe('Nothing was saved. Use Timing is set on the parent: '
      + 'Atrazine 1 gal (parent "Atrazine 4L"). Change it on the product page\'s Parent panel, then download a new workbook.');
    expect(groupedUseTimingRefusal(preview, new Map())).toBeNull();
  });
});

describe('price sheet refusal wording', () => {
  const expiresAt = '2026-11-24T18:00:00+00:00';
  const before = Date.parse('2026-11-24T17:59:59Z');
  const after = Date.parse('2026-11-24T18:00:00Z');

  it('says expired only once expires_at has passed', () => {
    expect(priceSheetExpiredText(expiresAt, before)).toBeNull();
    expect(priceSheetExpiredText(expiresAt, after)).toBe('No prices were changed. This price sheet expired (sheets last 7 days). Download a fresh one');
    expect(priceSheetExpiredText('not a date', after)).toBeNull();
  });

  it('tells an expired sheet from a used sheet or another user sheet for each combined server code', () => {
    for (const code of ['WORKBOOK_V2_EXPORT_REQUIRED', 'WORKBOOK_EXPORT_INVALID_OR_EXPIRED', 'WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED']) {
      expect(priceSheetRefusalText({ message: code }, expiresAt, after)).toMatch(/This price sheet expired \(sheets last 7 days\)/);
      expect(priceSheetRefusalText(new Error(code), expiresAt, before))
        .toBe('No prices were changed. This price sheet was already applied, was downloaded by another user, or came from an older template. Download a fresh one');
    }
  });

  it('leaves other errors, and an unreadable expiry, to the general wording', () => {
    expect(priceSheetRefusalText({ message: 'PRICING_DUPLICATE_PRODUCT_ID' }, expiresAt, before)).toBeNull();
    expect(priceSheetRefusalText({ message: 'WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED' }, '', before)).toBeNull();
    expect(priceSheetRefusalText(null, expiresAt, before)).toBeNull();
  });
});

describe('price sheet refusal reason wording', () => {
  it('looks a reason up only for the three combined refusal codes', () => {
    for (const code of ['WORKBOOK_V2_EXPORT_REQUIRED', 'WORKBOOK_EXPORT_INVALID_OR_EXPIRED', 'WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED']) {
      expect(isPriceSheetRefusal(new Error(code))).toBe(true);
      expect(isPriceSheetRefusal({ message: `${code}: detail` })).toBe(true);
    }
    for (const other of [new Error('PRICING_DUPLICATE_PRODUCT_ID'), new Error('ADMIN_REQUIRED'), { message: 'x WORKBOOK_V2_EXPORT_REQUIRED' }, null, 'WORKBOOK_V2_EXPORT_REQUIRED']) {
      expect(isPriceSheetRefusal(other)).toBe(false);
    }
  });

  it('gives one sentence per reason, each saying nothing changed and how to fix it', () => {
    const expected: Record<string, RegExp> = {
      EXPORT_NOT_FOUND: /no record of this price sheet/,
      DOWNLOADED_BY_OTHER_USER: /Another user downloaded this price sheet/,
      ALREADY_APPLIED: /already used for a price change; a product's Sell Price History shows what changed/,
      OLD_TEMPLATE: /came from an older template/,
      EXPIRED: /expired \(sheets last 7 days\)/,
    };
    for (const [reason, pattern] of Object.entries(expected)) {
      const text = priceSheetReasonText(reason);
      expect(text).toMatch(pattern);
      expect(text).toMatch(/^No prices were changed\. .*[Dd]ownload a fresh one( yourself)?$/);
    }
  });

  it('has no sentence for NONE or an unknown code, so the original message stays', () => {
    for (const reason of ['NONE', 'SOMETHING_NEW', '', 'constructor', '__proto__', 'expired']) {
      expect(priceSheetReasonText(reason)).toBeNull();
    }
  });
});
