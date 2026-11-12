import type { Worksheet } from 'exceljs';
import { assertRpcResult, supabaseUntyped } from './db';
import {
  cellValueToText,
  isFormulaValue,
  loadExcelJs,
  PricingWorkbookFormatError,
  PRICING_WORKBOOK_MIME,
  validatePricingWorkbookArchive,
} from './productPricingWorkbook';
import type {
  CommitRateReviewResult,
  ProductRateLabelCheck,
  ProductRateOutcome,
  RateReviewOutcomeRow,
  RateReviewRateRow,
  RateReviewResult,
  RateReviewWorkbook,
} from '../types';

/**
 * RT-3 PR 2: Mason's rate review workbook, separate from the setup workbook (whose Rates tabs write the live
 * rates). Two sheets, one review: Draft Rates (one row per draft or approved rate, plus blank rows to add one)
 * and Rate Outcomes (one row per parent). Only edited rows are sent; the database re-checks every one.
 */
const RATES_SHEET = 'Draft Rates';
const OUTCOMES_SHEET = 'Rate Outcomes';
const UNITS_SHEET = 'Units';
const MANIFEST_SHEET = '_crx_manifest';
const FORMAT_VERSION = 'crx-rate-review-v1';
/** Blank rows under the rates, for adding a rate (any parent, by name). */
export const BLANK_RATE_ROWS = 100;
/** commit_rate_review takes at most this many rows of each kind. */
const MAX_RATE_REVIEW_RATE_ROWS = 3000;
const MAX_RATE_REVIEW_OUTCOME_ROWS = 1000;

const RATE_EDITABLE = [
  'basis', 'source', 'low', 'recommended', 'high', 'unit', 'is_quoting_default', 'over_label_reason', 'decision', 'reason',
] as const;
const RATE_HEADERS = [
  'rate_id', 'row_state', 'parent_name', 'status', 'approved', 'origin', 'source_text', 'basis_confirmed', 'label_check',
  ...RATE_EDITABLE,
] as const;
const OUTCOME_HEADERS = [
  'parent_id', 'row_state', 'parent_name', 'product_form', 'sizes', 'rates', 'derive_notes', 'decided', 'outcome_problem',
  'outcome', 'note',
] as const;
const OUTCOME_EDITABLE = new Set<string>(['outcome', 'note']);
const HIDDEN = new Set<string>(['row_state']);
const OUTCOMES = ['approved_default', 'no_per_acre_default', 'needs_label_data'] as const;

type RateValues = Pick<RateReviewRateRow, 'basis' | 'source' | 'low' | 'recommended' | 'high' | 'unit' | 'is_quoting_default' | 'over_label_reason'>;
/** One Draft Rates row as read back; `sheetRow` is its row number in the file. */
export interface RateUpload extends RateReviewRateRow { sheetRow: number; parent_name: string }
export interface OutcomeUpload extends RateReviewOutcomeRow { sheetRow: number; parent_name: string }
export interface ParsedRateReview { rates: RateUpload[]; outcomes: OutcomeUpload[] }

export async function loadRateReviewWorkbook(): Promise<RateReviewWorkbook> {
  const { data, error } = await supabaseUntyped.rpc('get_rate_review_workbook');
  if (error) throw error;
  return assertRpcResult<RateReviewWorkbook>(data, 'get_rate_review_workbook');
}

const payload = (upload: ParsedRateReview) => ({
  p_rates: upload.rates.map(({ sheetRow: _row, parent_name: _name, ...row }) => row),
  p_outcomes: upload.outcomes.map(({ sheetRow: _row, parent_name: _name, ...row }) => row),
});

/** The whole save, always rolled back on the server. */
export async function previewRateReview(upload: ParsedRateReview): Promise<RateReviewResult> {
  const { data, error } = await supabaseUntyped.rpc('preview_rate_review', payload(upload));
  if (error) throw error;
  return assertRpcResult<RateReviewResult>(data, 'preview_rate_review');
}

/** All or nothing: any stale or invalid row refuses the lot. */
export async function commitRateReview(upload: ParsedRateReview, idempotencyKey: string): Promise<CommitRateReviewResult> {
  const { data, error } = await supabaseUntyped.rpc('commit_rate_review', { ...payload(upload), p_idempotency_key: idempotencyKey });
  if (error) throw error;
  return assertRpcResult<CommitRateReviewResult>(data, 'commit_rate_review');
}

/** One readable line for a label check. */
export function labelCheckText(check: ProductRateLabelCheck | undefined): string {
  if (!check) return '';
  switch (check.status) {
    case 'within': return 'within label';
    case 'not_applicable': return 'label row (not checked)';
    case 'above': return `ABOVE label: ${check.above.map((a) => `EPA ${a.epa_registration} max ${a.max_label_rate ?? '?'} ${a.max_label_rate_unit ?? ''}`.trim()).join('; ')}`
      + (check.reason_missing ? ' (needs a reason)' : '');
    default: return `label maximum not checked (${(check.why ?? '').replace(/_/g, ' ')})`;
  }
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no');
const noteText = (note: Record<string, unknown>) =>
  [note.note_code, note.text].filter((part) => typeof part === 'string' && part !== '').join(': ');

async function styleSheet(sheet: Worksheet, headers: readonly string[], rowCount: number, editable: (header: string, row: number) => boolean) {
  sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1, showGridLines: false }];
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6B4F' } };
  headers.forEach((name, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = HIDDEN.has(name) ? 10 : Math.max(14, name.length + 4);
    column.hidden = HIDDEN.has(name);
    // Text, so Excel never turns a rate into a date or a rounded float, and a typed "=" stays text.
    column.numFmt = '@';
    for (let row = 2; row <= rowCount + 1; row += 1) {
      const cell = sheet.getCell(row, index + 1);
      const open = editable(name, row);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: open ? 'FFEAF7EF' : 'FFF2F4F3' } };
      cell.protection = { locked: !open };
    }
  });
  // A usability guard only (no secret password): the database re-checks every row.
  await sheet.protect('crx-rate-review-layout', { selectLockedCells: true, selectUnlockedCells: true, autoFilter: true, sort: true });
}

type ExportParent = RateReviewWorkbook['parents'][number];
const decidedText = (by: string | null | undefined, at: string | null | undefined) => `${by ?? ''} ${at?.slice(0, 10) ?? ''}`.trim();

/** One Draft Rates row; the hidden row_state keeps the downloaded id, version and values. */
function rateSheetRow(parent: ExportParent, r: ExportParent['rates'][number]): string[] {
  const values: RateValues = {
    basis: r.basis, source: r.source, low: r.low, recommended: r.recommended, high: r.high, unit: r.unit,
    is_quoting_default: r.is_quoting_default, over_label_reason: r.over_label_reason,
  };
  const state = { rate_id: r.rate_id, parent_id: parent.parent_id, row_version: r.row_version, ...values };
  return [r.rate_id, JSON.stringify(state), parent.parent_name, r.status,
    r.approved_by || r.approved_at ? decidedText(r.approved_by, r.approved_at) : '',
    r.origin, r.source_text ?? '', yesNo(r.basis_confirmed), labelCheckText(r.label_check),
    r.basis, r.source, r.low ?? '', r.recommended ?? '', r.high ?? '', r.unit, yesNo(r.is_quoting_default),
    r.over_label_reason ?? '', '', ''];
}

/** One Rate Outcomes row. */
function outcomeSheetRow(parent: ExportParent): string[] {
  const drafts = parent.rates.filter((r) => r.status === 'draft').length;
  const state = { parent_id: parent.parent_id, outcome_version: parent.outcome_version, outcome: parent.outcome, note: parent.outcome_note };
  return [parent.parent_id, JSON.stringify(state), parent.parent_name, parent.product_form, parent.sizes.join('; '),
    `${parent.rates.length} (${drafts} draft, ${parent.rates.length - drafts} approved)`,
    parent.notes.map(noteText).filter(Boolean).join('; '),
    parent.outcome ? decidedText(parent.outcome_decided_by, parent.outcome_decided_at) : '',
    parent.outcome_problem ?? '', parent.outcome ?? '', parent.outcome_note ?? ''];
}

/** The download: Draft Rates, Rate Outcomes, a Units list and a hidden manifest. Grey cells are for reference. */
export async function generateRateReviewWorkbook(exported: RateReviewWorkbook): Promise<Blob> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CRX Manager';

  const rates = workbook.addWorksheet(RATES_SHEET);
  rates.addRow([...RATE_HEADERS]);
  let rateCount = 0;
  for (const parent of exported.parents) {
    for (const r of parent.rates) {
      rates.addRow(rateSheetRow(parent, r));
      rateCount += 1;
    }
  }
  for (let i = 0; i < BLANK_RATE_ROWS; i += 1) rates.addRow(RATE_HEADERS.map(() => ''));
  await styleSheet(rates, RATE_HEADERS, rateCount + BLANK_RATE_ROWS, (name, row) =>
    (RATE_EDITABLE as readonly string[]).includes(name) || (name === 'parent_name' && row > rateCount + 1));
  const note = (header: (typeof RATE_HEADERS)[number], text: string) => { rates.getCell(1, RATE_HEADERS.indexOf(header) + 1).note = text; };
  note('decision', 'approve, reopen (needs a reason) or delete (needs a reason). Blank = keep as is.');
  note('reason', 'Why you reopen or delete this rate.');
  note('basis', 'per_acre, per_100_gal, per_unit, per_cwt_seed or per_seed_unit');
  note('source', 'label or house_standard');
  note('unit', 'A unit code from the Units sheet.');
  note('is_quoting_default', 'yes on the one house_standard per_acre rate that quotes use; no on every other row.');
  note('over_label_reason', 'Needed to approve a rate above the label maximum.');
  note('parent_name', `To add a rate, type the parent name exactly as on the Rate Outcomes sheet in one of the ${BLANK_RATE_ROWS} blank rows at the bottom.`);
  note('label_check', '"label maximum not checked" may still be approved.');

  const outcomes = workbook.addWorksheet(OUTCOMES_SHEET);
  outcomes.addRow([...OUTCOME_HEADERS]);
  for (const parent of exported.parents) outcomes.addRow(outcomeSheetRow(parent));
  await styleSheet(outcomes, OUTCOME_HEADERS, exported.parents.length, (name) => OUTCOME_EDITABLE.has(name));
  outcomes.getCell(1, OUTCOME_HEADERS.indexOf('outcome') + 1).note =
    'approved_default (every rate approved, one approved quoting default), no_per_acre_default (every rate approved, no default), needs_label_data (hold back), or blank (undecided).';
  outcomes.getCell(1, OUTCOME_HEADERS.indexOf('outcome_problem') + 1).note =
    'Set when a recorded outcome no longer holds (the parent or its label changed since). Reopen and fix the rate named.';

  const units = workbook.addWorksheet(UNITS_SHEET);
  units.addRow(['code', 'label', 'kind']);
  for (const u of exported.units ?? []) units.addRow([u.code, u.label, u.kind]);
  await styleSheet(units, ['code', 'label', 'kind'], exported.units?.length ?? 0, () => false);

  const manifest = workbook.addWorksheet(MANIFEST_SHEET, { state: 'veryHidden' });
  manifest.addRows([['format_version', FORMAT_VERSION], ['rate_row_count', String(rateCount)], ['outcome_row_count', String(exported.parents.length)]]);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer as unknown as ArrayBuffer)], { type: PRICING_WORKBOOK_MIME });
}

type SheetRow<H extends string> = Record<H, string> & { sheetRow: number };
function readRows<H extends string>(sheet: Worksheet | undefined, name: string, headers: readonly H[]): Array<SheetRow<H>> {
  if (!sheet) throw new PricingWorkbookFormatError(`Missing the ${name} sheet. Download a fresh rate review workbook.`);
  const found = headers.map((_, index) => cellValueToText(sheet.getRow(1).getCell(index + 1).value, `${name} header ${index + 1}`));
  if (sheet.getRow(1).cellCount !== headers.length || headers.some((header, index) => found[index] !== header)) {
    throw new PricingWorkbookFormatError(`The ${name} sheet's columns do not match the CRX rate review workbook. Download a fresh one.`);
  }
  const rows: Array<SheetRow<H>> = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = { sheetRow: rowNumber } as SheetRow<H>;
    headers.forEach((header, index) => {
      const cell = sheet.getCell(rowNumber, index + 1);
      if (isFormulaValue(cell.value)) throw new PricingWorkbookFormatError(`${name} row ${rowNumber}, ${header} has a formula. Type the value instead.`);
      (row as Record<H, string>)[header] = cellValueToText(cell.value, `${name} row ${rowNumber}, ${header}`).trim();
    });
    rows.push(row);
  }
  return rows;
}

const blankToNull = (value: string) => (value === '' ? null : value);
/** "2.50" and "2.5" are the same amount. */
const decimalKey = (v: string | null) => (v == null ? null : v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
function parseYesNo(text: string, where: string): boolean {
  if (/^(yes|y|true)$/i.test(text)) return true;
  if (text === '' || /^(no|n|false)$/i.test(text)) return false;
  throw new PricingWorkbookFormatError(`${where}: is_quoting_default must be yes or no.`);
}
function parseDecision(text: string, where: string): RateReviewRateRow['decision'] {
  const value = text.toLowerCase();
  if (value === '') return null;
  if (value === 'approve' || value === 'reopen' || value === 'delete') return value;
  throw new PricingWorkbookFormatError(`${where}: decision must be approve, reopen, delete or blank.`);
}

const parseState = <T>(text: string, damaged: Error): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw damaged;
  }
};

/** An edited Rate Outcomes row, or null when it matches the download. */
function parseOutcomeRow(row: SheetRow<(typeof OUTCOME_HEADERS)[number]>): OutcomeUpload | null {
  const damaged = new PricingWorkbookFormatError(`Rate Outcomes row ${row.sheetRow} is damaged (its hidden download record or parent id). Download a fresh workbook.`);
  const saved = parseState<{ parent_id?: unknown; outcome_version?: unknown; outcome?: unknown; note?: unknown } | null>(row.row_state, damaged);
  if (!saved || saved.parent_id !== row.parent_id || typeof saved.outcome_version !== 'number') throw damaged;
  const outcome = blankToNull(row.outcome.toLowerCase());
  if (outcome != null && !(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new PricingWorkbookFormatError(`Rate Outcomes row ${row.sheetRow} (${row.parent_name}): outcome must be ${OUTCOMES.join(', ')} or blank.`);
  }
  const note = blankToNull(row.note);
  if (outcome === (saved.outcome ?? null) && note === ((saved.note as string | null)?.trim() || null)) return null;
  return { sheetRow: row.sheetRow, parent_name: row.parent_name, parent_id: row.parent_id,
    expected_outcome_version: saved.outcome_version, outcome: outcome as ProductRateOutcome | null, note };
}

/** An edited or new Draft Rates row, or null when it matches the download (or is an empty blank row). */
function parseRateRow(row: SheetRow<(typeof RATE_HEADERS)[number]>, parentByName: Map<string, string>): RateUpload | null {
  const where = `Draft Rates row ${row.sheetRow}`;
  const values = {
    basis: blankToNull(row.basis), source: blankToNull(row.source), low: blankToNull(row.low),
    recommended: blankToNull(row.recommended), high: blankToNull(row.high), unit: blankToNull(row.unit),
    over_label_reason: blankToNull(row.over_label_reason),
  };
  const decision = parseDecision(row.decision, where);
  const reason = blankToNull(row.reason);
  if (row.rate_id === '' && row.row_state === '') {
    if (!RATE_EDITABLE.some((field) => row[field] !== '')) return null;
    const parentId = parentByName.get(row.parent_name.toLowerCase());
    if (!parentId) throw new PricingWorkbookFormatError(`${where}: type a parent name exactly as on the Rate Outcomes sheet to add a rate.`);
    return { sheetRow: row.sheetRow, parent_name: row.parent_name, rate_id: null, parent_id: parentId, expected_row_version: null,
      ...values, is_quoting_default: parseYesNo(row.is_quoting_default, where), decision, reason };
  }
  const damaged = new PricingWorkbookFormatError(`${where} is damaged (its hidden download record or rate id). Download a fresh workbook.`);
  const saved = parseState<(Partial<RateValues> & { rate_id?: unknown; parent_id?: unknown; row_version?: unknown }) | null>(row.row_state, damaged);
  if (!saved || saved.rate_id !== row.rate_id || typeof saved.parent_id !== 'string' || typeof saved.row_version !== 'number') throw damaged;
  const isDefault = parseYesNo(row.is_quoting_default, where);
  const edited = decision != null || reason != null || isDefault !== saved.is_quoting_default
    || (['basis', 'source', 'unit', 'over_label_reason'] as const).some((f) => values[f] !== (saved[f] ?? null))
    || (['low', 'recommended', 'high'] as const).some((f) => decimalKey(values[f]) !== decimalKey(saved[f] ?? null));
  if (!edited) return null;
  return { sheetRow: row.sheetRow, parent_name: row.parent_name, rate_id: row.rate_id, parent_id: saved.parent_id,
    expected_row_version: saved.row_version, ...values, is_quoting_default: isDefault, decision, reason };
}

/**
 * Reads the upload back. Draft Rates: an existing row is sent only when a value, decision or reason changed;
 * a blank row with anything typed in it is a new rate for the named parent. Rate Outcomes: only edited rows.
 * Hidden download records bind each row to its id; a damaged one refuses the file.
 */
export async function parseRateReviewWorkbook(arrayBuffer: ArrayBuffer): Promise<ParsedRateReview> {
  await validatePricingWorkbookArchive(arrayBuffer);
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(arrayBuffer);
  } catch {
    throw new PricingWorkbookFormatError('The uploaded file is not a readable .xlsx workbook.');
  }
  const entries = new Map<string, string>();
  workbook.getWorksheet(MANIFEST_SHEET)?.eachRow((row, n) =>
    entries.set(cellValueToText(row.getCell(1).value, `Manifest ${n}`), cellValueToText(row.getCell(2).value, `Manifest ${n}`)));
  if (entries.get('format_version') !== FORMAT_VERSION) {
    throw new PricingWorkbookFormatError('This is not a CRX rate review workbook. Download a fresh one from Rate Review.');
  }

  const parentByName = new Map<string, string>();
  const outcomes: OutcomeUpload[] = [];
  for (const row of readRows(workbook.getWorksheet(OUTCOMES_SHEET), OUTCOMES_SHEET, OUTCOME_HEADERS)) {
    if (row.parent_id === '' && row.row_state === '') continue;
    parentByName.set(row.parent_name.toLowerCase(), row.parent_id);
    const edited = parseOutcomeRow(row);
    if (edited) outcomes.push(edited);
  }

  const rates: RateUpload[] = [];
  for (const row of readRows(workbook.getWorksheet(RATES_SHEET), RATES_SHEET, RATE_HEADERS)) {
    const edited = parseRateRow(row, parentByName);
    if (edited) rates.push(edited);
  }

  if (rates.length > MAX_RATE_REVIEW_RATE_ROWS || outcomes.length > MAX_RATE_REVIEW_OUTCOME_ROWS) {
    throw new PricingWorkbookFormatError(`Send at most ${MAX_RATE_REVIEW_RATE_ROWS} changed rates and ${MAX_RATE_REVIEW_OUTCOME_ROWS} changed outcomes at a time.`);
  }
  return { rates, outcomes };
}

/** Plain words for a database refusal: drops the error code before the first colon. */
export const problemText = (problem: string | undefined) => (problem ?? '').replace(/^[A-Z_]+:\s*/, '');
