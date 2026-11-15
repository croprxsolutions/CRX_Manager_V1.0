import { describe, expect, it, vi } from 'vitest';
import { BLANK_RATE_ROWS, generateRateReviewWorkbook, labelCheckText, parseRateReviewWorkbook } from './rateReviewWorkbook';
import { loadExcelJs } from './productPricingWorkbook';
import type { RateReviewWorkbook } from '../types';

vi.mock('./db', () => ({ supabaseUntyped: { rpc: vi.fn() }, assertRpcResult: (d: unknown) => d }));
// Real ExcelJS round trips; slow on loaded CI shards.
vi.setConfig({ testTimeout: 30_000 });

const P1 = '11111111-1111-4111-8111-111111111111';
const R1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const R2 = 'bbbbbbbb-1111-4111-8111-111111111111';
type Rate = RateReviewWorkbook['parents'][number]['rates'][number];
const rate = (o: Partial<Rate>): Rate => ({
  rate_id: R1, basis: 'per_acre', source: 'house_standard', low: null, recommended: '13.5', high: null, unit: 'fl_oz' as Rate['unit'],
  unit_label: 'fl oz', is_quoting_default: true, status: 'draft', origin: 'derived_house', basis_confirmed: true,
  source_text: '13.5 oz/A', over_label_reason: null, row_version: 3, approved_by: null, approved_at: null,
  label_check: { status: 'within' }, ...o,
});
const exported: RateReviewWorkbook = {
  parents: [{
    parent_id: P1, parent_name: 'Atrazine 4L', product_form: 'liquid', sizes: ['Atrazine 4L 2.5 gal'],
    outcome: null, outcome_note: null, outcome_version: 2, outcome_decided_by: null, outcome_decided_at: null, outcome_problem: null,
    rates: [rate({}), rate({ rate_id: R2, source: 'label', low: '1.00', high: '2.0', recommended: null, is_quoting_default: false, row_version: 1,
      status: 'approved', approved_by: 'Mason', approved_at: '2026-11-11T10:00:00Z', label_check: { status: 'not_applicable' } })],
    notes: [{ note_code: 'basis_from_text', text: 'read from label text' }],
  }],
  units: [{ code: 'fl_oz' as Rate['unit'], label: 'fl oz', kind: 'volume' }],
  totals: { rates: 2, drafts: 1, approved: 1, per_100_gal: 0, per_100_gal_approved: 0, parents: 1, parents_undecided: 1,
    approved_default: 0, no_per_acre_default: 0, needs_label_data: 0, outcomes_no_longer_valid: 0 },
};

type Wb = import('exceljs').Workbook;
async function roundTrip(edit?: (wb: Wb) => void, data: RateReviewWorkbook = exported) {
  const blob = await generateRateReviewWorkbook(data);
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  }));
  edit?.(wb);
  return parseRateReviewWorkbook(new Uint8Array(await wb.xlsx.writeBuffer() as unknown as ArrayBuffer).slice().buffer);
}
const set = (wb: Wb, sheet: string, row: number, header: string, value: unknown) => {
  const ws = wb.getWorksheet(sheet)!;
  const col = (ws.getRow(1).values as string[]).indexOf(header);
  ws.getCell(row, col).value = value as never;
};

describe('rate review workbook', () => {
  it('reports independent semantic mistakes on one rate row, then accepts the corrected row', async () => {
    const invalid = roundTrip((wb) => {
      set(wb, 'Draft Rates', 2, 'decision', 'approved');
      set(wb, 'Draft Rates', 2, 'is_quoting_default', 'maybe');
    });
    await expect(invalid).rejects.toThrow('Draft Rates row 2: decision must be');
    await expect(invalid).rejects.toThrow('Draft Rates row 2: is_quoting_default must be');
    const corrected = await roundTrip((wb) => {
      set(wb, 'Draft Rates', 2, 'decision', 'approve');
      set(wb, 'Draft Rates', 2, 'is_quoting_default', 'yes');
    });
    expect(corrected.rates[0]).toMatchObject({ decision: 'approve', is_quoting_default: true });
  });

  it('reports both invalid outcome and invalid Reconfirm on the same row', async () => {
    const invalid = roundTrip((wb) => {
      set(wb, 'Rate Outcomes', 2, 'outcome', 'approved');
      set(wb, 'Rate Outcomes', 2, 'reconfirm', 'maybe');
    });
    await expect(invalid).rejects.toThrow('outcome must be');
    await expect(invalid).rejects.toThrow('Rate Outcomes row 2: reconfirm must be');
  });

  it('reports bad rate choices together with an unknown parent or damaged download record', async () => {
    const unknownParent = roundTrip((wb) => {
      set(wb, 'Draft Rates', 4, 'parent_name', 'Unknown parent');
      set(wb, 'Draft Rates', 4, 'decision', 'approved');
      set(wb, 'Draft Rates', 4, 'is_quoting_default', 'maybe');
    });
    for (const problem of ['decision must be', 'is_quoting_default must be', 'type a parent name exactly']) {
      await expect(unknownParent).rejects.toThrow(problem);
    }
    const damaged = roundTrip((wb) => {
      set(wb, 'Draft Rates', 2, 'rate_id', R2);
      set(wb, 'Draft Rates', 2, 'is_quoting_default', 'maybe');
    });
    await expect(damaged).rejects.toThrow('is_quoting_default must be');
    await expect(damaged).rejects.toThrow('Draft Rates row 2 is damaged');
  });

  it('does not invent dependent errors when an unreadable row hides the required edit or parent', async () => {
    const decided: RateReviewWorkbook = { ...exported, parents: [{ ...exported.parents[0], outcome: 'approved_default' }] };
    const badRate = roundTrip((wb) => {
      set(wb, 'Draft Rates', 2, 'decision', 'approved');
      set(wb, 'Rate Outcomes', 2, 'reconfirm', 'yes');
    }, decided);
    await expect(badRate).rejects.toThrow('decision must be');
    await expect(badRate).rejects.not.toThrow('Reconfirm needs an edited');
    const badOutcome = roundTrip((wb) => {
      set(wb, 'Rate Outcomes', 2, 'note', { formula: '1+1', result: 2 });
      set(wb, 'Draft Rates', 4, 'parent_name', 'Atrazine 4L');
      set(wb, 'Draft Rates', 4, 'recommended', '12');
    });
    await expect(badOutcome).rejects.toThrow('note has a formula');
    await expect(badOutcome).rejects.not.toThrow('type a parent name exactly');
  });

  it('reports every bad row and malformed cell across both sheets before returning an upload', async () => {
    const invalid = roundTrip((wb) => {
      set(wb, 'Rate Outcomes', 2, 'outcome', 'approved');
      set(wb, 'Draft Rates', 2, 'rate_id', R2);
      set(wb, 'Draft Rates', 3, 'low', { formula: '1+1', result: 2 });
      set(wb, 'Draft Rates', 3, 'high', { formula: '2+2', result: 4 });
      set(wb, 'Draft Rates', 4, 'parent_name', 'Nope');
      set(wb, 'Draft Rates', 4, 'low', '1');
    });
    for (const problem of ['Rate Outcomes row 2 (Atrazine 4L): outcome must be', 'Draft Rates row 2 is damaged',
      'Draft Rates row 3, low has a formula', 'Draft Rates row 3, high has a formula', 'Draft Rates row 4: type a parent name exactly']) {
      await expect(invalid).rejects.toThrow(problem);
    }
  });

  it('sends nothing for an untouched download, and keeps the blank add rows', async () => {
    const blob = await generateRateReviewWorkbook(exported);
    expect(blob.size).toBeGreaterThan(0);
    expect(await roundTrip()).toEqual({ rates: [], outcomes: [], recorded: {} });
  });

  it('sends only edited rows, with the downloaded versions and a decimal-equal value left alone', async () => {
    const parsed = await roundTrip((wb) => {
      set(wb, 'Draft Rates', 2, 'decision', 'Approve');
      set(wb, 'Draft Rates', 3, 'low', '1'); // "1" equals the downloaded "1.00": not an edit
      set(wb, 'Draft Rates', 4, 'parent_name', 'atrazine 4l');
      set(wb, 'Draft Rates', 4, 'basis', 'per_100_gal');
      set(wb, 'Draft Rates', 4, 'source', 'label');
      set(wb, 'Draft Rates', 4, 'high', '2');
      set(wb, 'Draft Rates', 4, 'unit', 'fl_oz');
      set(wb, 'Rate Outcomes', 2, 'outcome', 'needs_label_data');
      set(wb, 'Rate Outcomes', 2, 'note', 'waiting on label');
    });
    expect(parsed.rates).toEqual([
      expect.objectContaining({ sheetRow: 2, rate_id: R1, parent_id: P1, expected_row_version: 3, decision: 'approve',
        recommended: '13.5', is_quoting_default: true, unit: 'fl_oz' }),
      expect.objectContaining({ sheetRow: 4, rate_id: null, parent_id: P1, expected_row_version: null, basis: 'per_100_gal',
        source: 'label', high: '2', is_quoting_default: false, decision: null }),
    ]);
    expect(parsed.outcomes).toEqual([{ sheetRow: 2, parent_name: 'Atrazine 4L', parent_id: P1, expected_outcome_version: 2,
      outcome: 'needs_label_data', note: 'waiting on label' }]);
  });

  it('refuses a damaged download record, a formula, an unknown parent name and an unknown outcome', async () => {
    await expect(roundTrip((wb) => set(wb, 'Draft Rates', 2, 'rate_id', R2))).rejects.toThrow('Draft Rates row 2 is damaged');
    await expect(roundTrip((wb) => set(wb, 'Draft Rates', 2, 'low', { formula: '1+1', result: 2 }))).rejects.toThrow('has a formula');
    await expect(roundTrip((wb) => {
      set(wb, 'Draft Rates', 4, 'parent_name', 'Nope');
      set(wb, 'Draft Rates', 4, 'low', '1');
    })).rejects.toThrow('type a parent name exactly');
    await expect(roundTrip((wb) => set(wb, 'Rate Outcomes', 2, 'outcome', 'approved'))).rejects.toThrow('outcome must be');
  });

  it('binds each visible outcome parent name to its hidden download name', async () => {
    await expect(roundTrip((wb) => set(wb, 'Rate Outcomes', 2, 'parent_name', 'Another parent')))
      .rejects.toThrow('Rate Outcomes row 2: the parent name no longer matches the download (expected "Atrazine 4L")');
    const spaced = { ...exported, parents: [{ ...exported.parents[0], parent_name: ' Atrazine 4L ' }] };
    expect(await roundTrip(undefined, spaced)).toEqual({ rates: [], outcomes: [], recorded: {} });
  });

  it('identifies an older CRX workbook separately from an unknown file', async () => {
    await expect(roundTrip((wb) => { wb.getWorksheet('_crx_manifest')!.getCell(1, 2).value = 'crx-rate-review-v1'; }))
      .rejects.toThrow('different version');
    await expect(roundTrip((wb) => { wb.getWorksheet('_crx_manifest')!.getCell(1, 2).value = 'other-file'; }))
      .rejects.toThrow('not a CRX rate review workbook');
  });

  it('reconfirms a recorded outcome with its note only when a rate on that parent was edited', async () => {
    const decided: RateReviewWorkbook = { ...exported, parents: [{ ...exported.parents[0], outcome: 'approved_default', outcome_note: 'reviewed' }] };
    const editRate = (wb: Wb) => set(wb, 'Draft Rates', 2, 'recommended', '14');
    const ordinary = await roundTrip(editRate, decided);
    expect(ordinary.outcomes).toEqual([]);
    expect(ordinary.recorded[P1]).toBe('approved_default');
    const renewed = await roundTrip((wb) => { editRate(wb); set(wb, 'Rate Outcomes', 2, 'reconfirm', 'yes'); }, decided);
    expect(renewed.outcomes).toEqual([{ sheetRow: 2, parent_name: 'Atrazine 4L', parent_id: P1,
      expected_outcome_version: 2, outcome: 'approved_default', note: 'reviewed' }]);
    await expect(roundTrip((wb) => set(wb, 'Rate Outcomes', 2, 'reconfirm', 'yes'), decided))
      .rejects.toThrow('Reconfirm needs an edited Draft Rates row');
  });

  it('refuses conflicting or empty Reconfirm instructions by outcome row', async () => {
    const decided: RateReviewWorkbook = { ...exported, parents: [{ ...exported.parents[0], outcome: 'approved_default', outcome_note: 'reviewed' }] };
    await expect(roundTrip((wb) => {
      set(wb, 'Draft Rates', 2, 'recommended', '14');
      set(wb, 'Rate Outcomes', 2, 'note', 'changed');
      set(wb, 'Rate Outcomes', 2, 'reconfirm', 'yes');
    }, decided)).rejects.toThrow('Rate Outcomes row 2: Reconfirm needs an unchanged recorded outcome and note');
    await expect(roundTrip((wb) => {
      set(wb, 'Draft Rates', 2, 'recommended', '14');
      set(wb, 'Rate Outcomes', 2, 'reconfirm', 'yes');
    })).rejects.toThrow('Rate Outcomes row 2: Reconfirm needs an unchanged recorded outcome and note');
  });

  it('refuses a file with a downloaded row deleted, and a new rate for a name two parents share', async () => {
    await expect(roundTrip((wb) => {
      set(wb, 'Draft Rates', 2, 'decision', 'approve');
      wb.getWorksheet('Draft Rates')!.spliceRows(3, 1);
    })).rejects.toThrow('has 1 downloaded rows; the download had 2');
    await expect(roundTrip((wb) => {
      const ws = wb.getWorksheet('Draft Rates')!;
      ws.getRow(2).eachCell((cell, col) => { ws.getCell(3, col).value = cell.value; });
    })).rejects.toThrow('Draft Rates row 3 repeats another row');
    const P2 = '22222222-1111-4111-8111-111111111111';
    const twin = { ...exported, parents: [...exported.parents, { ...exported.parents[0], parent_id: P2, parent_name: 'ATRAZINE 4L', rates: [] }] };
    await expect(roundTrip((wb) => {
      set(wb, 'Draft Rates', 4, 'parent_name', 'Atrazine 4L');
      set(wb, 'Draft Rates', 4, 'low', '1');
    }, twin)).rejects.toThrow('more than one parent is named');
  });

  it('writes the blank add rows and the reference sheets', async () => {
    const ExcelJS = await loadExcelJs();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await generateRateReviewWorkbook(exported)).arrayBuffer());
    expect(wb.getWorksheet('Draft Rates')!.rowCount).toBe(1 + 2 + BLANK_RATE_ROWS);
    expect(wb.getWorksheet('Units')!.getCell(2, 1).value).toBe('fl_oz');
    expect(String(wb.getWorksheet('Rate Outcomes')!.getCell(2, 7).value)).toBe('basis_from_text: read from label text');
  });

  it('describes label checks in plain words', () => {
    expect(labelCheckText({ status: 'above', above: [{ epa_registration: '1-2', max_label_rate: 1, max_label_rate_unit: 'qt' }], not_checked: [], reason_missing: true }))
      .toBe('ABOVE label: EPA 1-2 max 1 qt (needs a reason)');
    expect(labelCheckText({ status: 'not_checked', why: 'no_registration' })).toBe('label maximum not checked (no registration)');
  });
});
