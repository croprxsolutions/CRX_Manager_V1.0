import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';
import { checkedDocumentUrl, type BrandDocumentWorkspaceRow } from './brandDocuments';
import { addBrandDocumentSheet, parseBrandDocumentSheet } from './productSetupBrandDocumentsWorkbook';

const entry: BrandDocumentWorkspaceRow = {
  id: 'brand-id', parent_brand: true, brand_version: 3, brand_name: 'Example brand', owner_name: 'Example group',
  product_id: 'example-size',
  links: [{
    id: 'sds-id', parent_brand_id: 'brand-id', legacy_brand_id: null, document_kind: 'sds',
    url: 'https://manufacturer.example/sds', state_code: null, expires_on: null, row_version: 9,
    hidden_at: null, reported_at: null,
  }],
};

describe('Brand Links workbook tab', () => {
  it('does not create link changes for old workbooks, untouched files or blanked links', async () => {
    const old = new Workbook();
    expect(parseBrandDocumentSheet(old)).toBeNull();
    const reportedLink = { ...entry.links[0], reported_at: '2026-11-25T14:00:00Z', reported_by: 'staff-id' };
    addBrandDocumentSheet(old, [{ ...entry, owner_name: ' Example group ', links: [reportedLink] }]);
    const roundTrip = new Workbook();
    await roundTrip.xlsx.load(await old.xlsx.writeBuffer());
    expect(roundTrip.getWorksheet('Brand Links')?.getCell('H2').value).not.toMatch(/reported_at|reported_by|staff-id/);
    expect(parseBrandDocumentSheet(roundTrip)).toEqual({ rows: [], issues: [] });
    roundTrip.getWorksheet('Brand Links')!.getCell('D2').value = '';
    expect(parseBrandDocumentSheet(roundTrip)).toEqual({ rows: [], issues: [] });
  });

  it('ignores a cleared visible row and isolates a damaged links tab', () => {
    const workbook = new Workbook();
    addBrandDocumentSheet(workbook, [entry, { ...entry, id: 'second-brand' }]);
    const sheet = workbook.getWorksheet('Brand Links')!;
    for (let col = 1; col <= 7; col++) sheet.getCell(2, col).value = null;
    sheet.getCell('D3').value = 'https://manufacturer.example/new';
    expect(parseBrandDocumentSheet(workbook)).toMatchObject({
      issues: [], rows: [{ target: { id: 'second-brand' } }],
    });
    sheet.getCell('H3').value = null;
    expect(parseBrandDocumentSheet(workbook)?.issues).toEqual([
      'Brand Links row 3 · The download record is missing or damaged. Download a fresh workbook.',
    ]);
    sheet.getCell('A1').value = 'Changed header';
    expect(parseBrandDocumentSheet(workbook)).toEqual({
      rows: [], issues: ['The Brand Links tab layout changed or has too many rows. Download a fresh workbook.'],
    });
  });

  it('binds link changes to the downloaded brand and document version', () => {
    const workbook = new Workbook();
    addBrandDocumentSheet(workbook, [entry]);
    const sheet = workbook.getWorksheet('Brand Links')!;
    sheet.getCell('D2').value = 'https://manufacturer.example/replacement';
    sheet.getCell('E2').value = 'https://manufacturer.example/supplemental';
    sheet.getCell('F2').value = 'ia';
    sheet.getCell('G2').value = '2027-02-02';
    expect(parseBrandDocumentSheet(workbook)).toEqual({
      issues: [],
      rows: [{
        target: { id: 'brand-id', parent_brand: true, brand_version: 3 },
        brandName: 'Example brand', ownerName: 'Example group',
        changes: [
          { action: 'save', kind: 'sds', id: 'sds-id', version: 9, url: 'https://manufacturer.example/replacement' },
          { action: 'save', kind: 'supplemental', url: 'https://manufacturer.example/supplemental',
            state: 'IA', expires_on: '2027-02-02' },
        ],
      }],
    });
  });

  it('leaves existing supplements off the workbook and refuses old supplemental edit records', () => {
    const workbook = new Workbook();
    const supplement = { ...entry.links[0], id: 'supplement-id', document_kind: 'supplemental' as const,
      url: 'https://manufacturer.example/old-supplement', state_code: 'IA', expires_on: '2027-01-01' };
    addBrandDocumentSheet(workbook, [{ ...entry, links: [...entry.links, supplement] }]);
    const sheet = workbook.getWorksheet('Brand Links')!;
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getCell('E2').value ?? '').toBe('');
    expect(sheet.getCell('H2').text).not.toContain(supplement.id);

    sheet.getCell('E2').value = 'https://manufacturer.example/pasted';
    sheet.getCell('F2').value = 'IA';
    sheet.getCell('G2').value = '2027-12-31';
    sheet.getCell('H2').value = JSON.stringify({ ...JSON.parse(sheet.getCell('H2').text), primary: false, supplemental: supplement });
    expect(parseBrandDocumentSheet(workbook)).toEqual({
      rows: [],
      issues: ['Brand Links row 2 · Edit existing supplemental links on Product Detail. Download a fresh workbook for new links.'],
    });
  });

  it('refuses blocked hosts and accepts manufacturer URLs', () => {
    expect(() => checkedDocumentUrl('http://manufacturer.example/sds')).toThrow(/HTTPS/);
    expect(() => checkedDocumentUrl('https://docs.CDMS.net./example')).toThrow(/CDMS/);
    expect(() => checkedDocumentUrl('https://manufacturer.example:0/sds')).toThrow(/valid HTTPS/);
    expect(() => checkedDocumentUrl(`https://${'a'.repeat(64)}.example/sds`)).toThrow(/valid HTTPS/);
    expect(() => checkedDocumentUrl('https://greenbook.net:443/example')).toThrow(/Greenbook/);
    expect(checkedDocumentUrl('https://manufacturer.example/sds')).toBe('https://manufacturer.example/sds');
  });
});
