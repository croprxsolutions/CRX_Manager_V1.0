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
const LEGACY_FORMAT_VERSION = 'crx-rate-review-v2';
const FORMAT_VERSION = 'crx-rate-review-v3';
/** Blank rows under the rates, for adding a rate (any parent, by name). */
export const BLANK_RATE_ROWS = 100;
/** commit_rate_review takes at most this many rows of each kind. */
const MAX_RATE_REVIEW_RATE_ROWS = 3000;
const MAX_RATE_REVIEW_OUTCOME_ROWS = 1000;
/** A sheet longer than this is not a rate review download (refused before reading every row). */
const MAX_SHEET_ROWS = 20000;

const RATE_EDITABLE = [
  'basis', 'source', 'low', 'recommended', 'high', 'unit', 'is_quoting_default', 'over_label_reason', 'decision', 'reason',
] as const;
const RATE_HEADERS = [
  'rate_id', 'row_state', 'parent_name', 'status', 'approved', 'origin', 'source_text', 'basis_confirmed', 'label_check',
  ...RATE_EDITABLE,
] as const;
const LEGACY_RATE_HEADERS = RATE_HEADERS;
const V3_RATE_HEADERS = [...RATE_HEADERS, 'parent_activity'] as const;
const OUTCOME_HEADERS = [
  'parent_id', 'row_state', 'parent_name', 'product_form', 'sizes', 'rates', 'derive_notes', 'decided', 'outcome_problem',
  'outcome', 'note', 'reconfirm',
] as const;
const LEGACY_OUTCOME_HEADERS = OUTCOME_HEADERS;
const V3_OUTCOME_HEADERS = [...OUTCOME_HEADERS, 'parent_activity'] as const;
const OUTCOME_EDITABLE = new Set<string>(['outcome', 'note', 'reconfirm']);
const HIDDEN = new Set<string>(['row_state']);
const OUTCOMES = ['approved_default', 'no_per_acre_default', 'needs_label_data'] as const;

type RateValues = Pick<RateReviewRateRow, 'basis' | 'source' | 'low' | 'recommended' | 'high' | 'unit' | 'is_quoting_default' | 'over_label_reason'>;
/** One Draft Rates row as read back; `sheetRow` is its row number in the file. */
export interface RateUpload extends RateReviewRateRow { sheetRow: number; parent_name: string }
export interface OutcomeUpload extends RateReviewOutcomeRow { sheetRow: number; parent_name: string }
/** `recorded`: each parent's outcome as downloaded (parent id to outcome), to warn when a rate change clears it. */
export interface ParsedRateReview {
  rates: RateUpload[]; outcomes: OutcomeUpload[]; recorded: Record<string, string>;
  /** Present only for v3 parents whose activity was verified from the workbook snapshot. */
  inactive_parent_ids?: string[];
}

export async function loadRateReviewWorkbook(): Promise<RateReviewWorkbook> {
  const { data, error } = await supabaseUntyped.rpc('get_rate_review_workbook', { p_include_inactive: true });
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
  const state = { rate_id: r.rate_id, parent_id: parent.parent_id, row_version: r.row_version, status: r.status, is_active: parent.is_active, ...values };
  return [r.rate_id, JSON.stringify(state), parent.parent_name, r.status,
    r.approved_by || r.approved_at ? decidedText(r.approved_by, r.approved_at) : '',
    r.origin, r.source_text ?? '', yesNo(r.basis_confirmed), labelCheckText(r.label_check),
    r.basis, r.source, r.low ?? '', r.recommended ?? '', r.high ?? '', r.unit, yesNo(r.is_quoting_default),
    r.over_label_reason ?? '', '', '', parent.is_active ? 'active' : 'inactive'];
}

/** One Rate Outcomes row. */
function outcomeSheetRow(parent: ExportParent): string[] {
  const drafts = parent.rates.filter((r) => r.status === 'draft').length;
  const state = { parent_id: parent.parent_id, parent_name: parent.parent_name.trim(), outcome_version: parent.outcome_version, outcome: parent.outcome, note: parent.outcome_note, is_active: parent.is_active };
  return [parent.parent_id, JSON.stringify(state), parent.parent_name.trim(), parent.product_form, parent.sizes.join('; '),
    `${parent.rates.length} (${drafts} draft, ${parent.rates.length - drafts} approved)`,
    parent.notes.map(noteText).filter(Boolean).join('; '),
    parent.outcome ? decidedText(parent.outcome_decided_by, parent.outcome_decided_at) : '',
    parent.outcome_problem ?? '', parent.outcome ?? '', parent.outcome_note ?? '', '', parent.is_active ? 'active' : 'inactive'];
}

/** The download: Draft Rates, Rate Outcomes, a Units list and a hidden manifest. Grey cells are for reference. */
export async function generateRateReviewWorkbook(exported: RateReviewWorkbook): Promise<Blob> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CRX Manager';

  const rates = workbook.addWorksheet(RATES_SHEET);
  rates.addRow([...V3_RATE_HEADERS]);
  let rateCount = 0;
  for (const parent of exported.parents) {
    for (const r of parent.rates) {
      rates.addRow(rateSheetRow(parent, r));
      rateCount += 1;
    }
  }
  for (let i = 0; i < BLANK_RATE_ROWS; i += 1) rates.addRow(V3_RATE_HEADERS.map(() => ''));
  const rateActivity = exported.parents.flatMap((parent) => parent.rates.map(() => parent.is_active));
  await styleSheet(rates, V3_RATE_HEADERS, rateCount + BLANK_RATE_ROWS, (name, row) => {
    const active = rateActivity[row - 2];
    const allowedRateFields = active === false ? ['decision', 'reason'] : RATE_EDITABLE;
    return (allowedRateFields as readonly string[]).includes(name) || (name === 'parent_name' && row > rateCount + 1);
  });
  const note = (header: (typeof RATE_HEADERS)[number], text: string) => { rates.getCell(1, RATE_HEADERS.indexOf(header) + 1).note = text; };
  note('decision', 'Active: approve, reopen (needs a reason) or delete (needs a reason). Inactive history: approved rates may only be reopened and drafts may only be deleted. Blank = keep as is.');
  note('reason', 'Why you reopen or delete this rate.');
  note('basis', 'per_acre, per_100_gal, per_unit, per_cwt_seed or per_seed_unit');
  note('source', 'label or house_standard');
  note('unit', 'A unit code from the Units sheet.');
  note('is_quoting_default', 'yes on the one house_standard per_acre rate that quotes use; no on every other row.');
  note('over_label_reason', 'Needed to approve a rate above the label maximum.');
  note('parent_name', `To add a rate, type the parent name exactly as on the Rate Outcomes sheet in one of the ${BLANK_RATE_ROWS} blank rows at the bottom.`);
  note('label_check', '"label maximum not checked" may still be approved.');
  rates.getCell(1, V3_RATE_HEADERS.indexOf('parent_activity') + 1).note = 'Read-only snapshot: active groups can be reviewed normally; inactive groups are history and cleanup only.';

  const outcomes = workbook.addWorksheet(OUTCOMES_SHEET);
  outcomes.addRow([...V3_OUTCOME_HEADERS]);
  for (const parent of exported.parents) outcomes.addRow(outcomeSheetRow(parent));
  await styleSheet(outcomes, V3_OUTCOME_HEADERS, exported.parents.length, (name, row) =>
    OUTCOME_EDITABLE.has(name) && !(exported.parents[row - 2]?.is_active === false
      && (name === 'reconfirm' || (exported.parents[row - 2]?.outcome === null && (name === 'outcome' || name === 'note')))));
  outcomes.getCell(1, OUTCOME_HEADERS.indexOf('outcome') + 1).note =
    'Active: approved_default (every rate approved, one approved quoting default), no_per_acre_default (every rate approved, no default), needs_label_data (hold back), or blank (undecided). Inactive history: clear an existing outcome or leave it blank; no new outcome or Reconfirm.';
  outcomes.getCell(1, OUTCOME_HEADERS.indexOf('outcome_problem') + 1).note =
    'Set when a recorded outcome no longer holds (the parent or its label changed since). Reopen and fix the rate named.';
  outcomes.getCell(1, OUTCOME_HEADERS.indexOf('reconfirm') + 1).note =
    'Active groups only: type yes to set this same recorded outcome again after editing a rate for this parent in this workbook. Leave blank to let the rate change clear it. Inactive groups cannot be reconfirmed.';
  outcomes.getCell(1, V3_OUTCOME_HEADERS.indexOf('parent_activity') + 1).note = 'Read-only snapshot from the download. Inactive groups cannot receive a new outcome or be reconfirmed.';

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
function collectRowProblem<T>(problems: string[], read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof PricingWorkbookFormatError)) throw error;
    problems.push(error.message);
    return undefined;
  }
}

function readRows<H extends string>(sheet: Worksheet | undefined, name: string, headers: readonly H[], problems: string[]): Array<SheetRow<H>> {
  if (!sheet) throw new PricingWorkbookFormatError(`Missing the ${name} sheet. Download a fresh rate review workbook.`);
  const found = headers.map((_, index) => cellValueToText(sheet.getRow(1).getCell(index + 1).value, `${name} header ${index + 1}`));
  if (sheet.getRow(1).cellCount !== headers.length || headers.some((header, index) => found[index] !== header)) {
    throw new PricingWorkbookFormatError(`The ${name} sheet's columns do not match the CRX rate review workbook. Download a fresh one.`);
  }
  const rows: Array<SheetRow<H>> = [];
  if (sheet.rowCount > MAX_SHEET_ROWS) throw new PricingWorkbookFormatError(`The ${name} sheet has more than ${MAX_SHEET_ROWS} rows. Download a fresh rate review workbook.`);
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = { sheetRow: rowNumber } as SheetRow<H>;
    const problemCount = problems.length;
    headers.forEach((header, index) => {
      collectRowProblem(problems, () => {
        const cell = sheet.getCell(rowNumber, index + 1);
        if (isFormulaValue(cell.value)) throw new PricingWorkbookFormatError(`${name} row ${rowNumber}, ${header} has a formula. Type the value instead.`);
        (row as Record<H, string>)[header] = cellValueToText(cell.value, `${name} row ${rowNumber}, ${header}`).trim();
      });
    });
    if (problems.length === problemCount) rows.push(row);
  }
  return rows;
}

const blankToNull = (value: string) => (value === '' ? null : value);
/** "2.50" and "2.5" are the same amount. */
const decimalKey = (v: string | null) => (v == null ? null : v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
function parseYesNo(text: string, where: string, field = 'is_quoting_default'): boolean {
  if (/^(yes|y|true)$/i.test(text)) return true;
  if (text === '' || /^(no|n|false)$/i.test(text)) return false;
  throw new PricingWorkbookFormatError(`${where}: ${field} must be yes or no.`);
}
function parseDecision(text: string, where: string): RateReviewRateRow['decision'] {
  const value = text.toLowerCase();
  if (value === '') return null;
  if (value === 'approve' || value === 'reopen' || value === 'delete') return value;
  throw new PricingWorkbookFormatError(`${where}: decision must be approve, reopen, delete or blank.`);
}

/** Marks a parent name two parents share, so a new rate is never sent to the wrong one. */
const AMBIGUOUS = '';
/** A deleted or pasted-in row would silently drop or duplicate an edit: the file must keep every downloaded row. */
function checkRowCount(sheet: string, found: number, expected: string | undefined) {
  if (String(found) !== expected) {
    throw new PricingWorkbookFormatError(`The ${sheet} sheet has ${found} downloaded rows; the download had ${expected ?? 'an unknown number'}. Do not delete or copy rows. Download a fresh workbook.`);
  }
}

const parseState = <T>(text: string, damaged: Error): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw damaged;
  }
};

type OutcomeSheetRow = SheetRow<(typeof V3_OUTCOME_HEADERS)[number]>;
type OutcomeDownloadState = { parent_id: string; parent_name: string; outcome_version: number; outcome: ProductRateOutcome | null; note: string | null; is_active?: boolean };

function outcomeDownloadState(row: OutcomeSheetRow): OutcomeDownloadState {
  const damaged = new PricingWorkbookFormatError(`Rate Outcomes row ${row.sheetRow} is damaged (its hidden download record or parent id). Download a fresh workbook.`);
  const saved = parseState<{ parent_id?: unknown; parent_name?: unknown; outcome_version?: unknown; outcome?: unknown; note?: unknown; is_active?: unknown } | null>(row.row_state, damaged);
  if (!saved || saved.parent_id !== row.parent_id || typeof saved.parent_name !== 'string' || typeof saved.outcome_version !== 'number') throw damaged;
  if (saved.parent_name !== row.parent_name) {
    throw new PricingWorkbookFormatError(`Rate Outcomes row ${row.sheetRow}: the parent name no longer matches the download (expected "${saved.parent_name}"). Put it back or download a fresh workbook.`);
  }
  if (saved.outcome !== null && typeof saved.outcome !== 'string') throw damaged;
  if (saved.note !== null && typeof saved.note !== 'string') throw damaged;
  if (row.parent_activity !== undefined && row.parent_activity !== '') {
    const expectedActivity = saved.is_active === true ? 'active' : saved.is_active === false ? 'inactive' : null;
    if (expectedActivity === null || row.parent_activity !== expectedActivity) throw damaged;
  } else if (saved.is_active !== undefined) throw damaged;
  return saved as OutcomeDownloadState;
}

function addInactiveOutcomeProblems(problems: string[], check: {
  row: OutcomeSheetRow; saved: OutcomeDownloadState; outcome: string | null; note: string | null;
  downloadedNote: string | null; reconfirm: boolean | undefined;
}) {
  const { row, saved, outcome, note, downloadedNote, reconfirm } = check;
  if (saved.is_active !== false) return;
  const where = `Rate Outcomes row ${row.sheetRow} (${row.parent_name})`;
  if (reconfirm === true || (outcome !== null && outcome !== saved.outcome)) {
    problems.push(`${where}: inactive parents are history only; clear the recorded outcome or leave it unchanged. They cannot be given a new outcome or reconfirmed.`);
  }
  if (saved.outcome !== null && outcome === null && note !== null) {
    problems.push(`${where}: clear the note together with the recorded outcome.`);
  }
  if (outcome === saved.outcome && note !== downloadedNote) {
    problems.push(`${where}: inactive history notes can only be cleared together with their outcome.`);
  }
}

/** An edited Rate Outcomes row, or null when it matches the download. */
function parseOutcomeRow(row: OutcomeSheetRow): { edited: OutcomeUpload | null; reconfirm: boolean; downloaded: string | null; active?: boolean } {
  const saved = outcomeDownloadState(row);
  const problems: string[] = [];
  const outcome = blankToNull(row.outcome.toLowerCase());
  if (outcome != null && !(OUTCOMES as readonly string[]).includes(outcome)) {
    problems.push(`Rate Outcomes row ${row.sheetRow} (${row.parent_name}): outcome must be ${OUTCOMES.join(', ')} or blank.`);
  }
  const note = blankToNull(row.note);
  const downloadedNote = saved.note?.trim() || null;
  const reconfirm = collectRowProblem(problems, () => parseYesNo(row.reconfirm, `Rate Outcomes row ${row.sheetRow}`, 'reconfirm'));
  addInactiveOutcomeProblems(problems, { row, saved, outcome, note, downloadedNote, reconfirm });
  if (problems.length > 0 || reconfirm === undefined) throw new PricingWorkbookFormatError(problems.join('\n'));
  if (reconfirm && (saved.outcome === null || outcome !== saved.outcome || note !== downloadedNote)) {
    throw new PricingWorkbookFormatError(`Rate Outcomes row ${row.sheetRow}: Reconfirm needs an unchanged recorded outcome and note. To change either cell, leave Reconfirm blank.`);
  }
  if (!reconfirm && outcome === saved.outcome && note === downloadedNote) return { edited: null, reconfirm, downloaded: saved.outcome, active: saved.is_active };
  return { edited: { sheetRow: row.sheetRow, parent_name: row.parent_name, parent_id: row.parent_id,
    expected_outcome_version: saved.outcome_version, outcome: outcome as ProductRateOutcome | null, note }, reconfirm, downloaded: saved.outcome, active: saved.is_active };
}

function readOutcomeSheet(sheet: Worksheet | undefined, problems: string[], headers: readonly (typeof V3_OUTCOME_HEADERS)[number][], v3: boolean) {
  const activeParentByName = new Map<string, string>();
  const outcomes: OutcomeUpload[] = [];
  const reconfirmed = new Map<string, number>();
  const seenParents = new Set<string>();
  const recorded: Record<string, string> = {};
  const inactiveParentIds: string[] = [];
  const inactiveNames = new Set<string>();
  let outcomeRows = 0;
  const beforeRead = problems.length;
  const rows = readRows(sheet, OUTCOMES_SHEET, headers, problems);
  const parentNamesIncomplete = problems.length > beforeRead;
  for (const row of rows) {
    if (row.parent_id === '' && row.row_state === '') continue;
    const key = row.parent_name.toLowerCase();
    outcomeRows += 1;
    if (v3 && row.parent_activity === 'inactive') inactiveNames.add(key);
    else activeParentByName.set(key, activeParentByName.has(key) && activeParentByName.get(key) !== row.parent_id ? AMBIGUOUS : row.parent_id);
    collectRowProblem(problems, () => {
      if (seenParents.has(row.parent_id)) throw new PricingWorkbookFormatError(`Rate Outcomes row ${row.sheetRow} repeats another row. Do not copy rows. Download a fresh workbook.`);
      seenParents.add(row.parent_id);
      const parsed = parseOutcomeRow(row);
      if (v3 && row.parent_activity !== 'active' && row.parent_activity !== 'inactive') {
        throw new PricingWorkbookFormatError(`Rate Outcomes row ${row.sheetRow} is missing its activity label. Download a fresh workbook.`);
      }
      if (parsed.active === false) { inactiveParentIds.push(row.parent_id); inactiveNames.add(key); }
      if (parsed.edited) outcomes.push(parsed.edited);
      if (parsed.reconfirm) reconfirmed.set(row.parent_id, row.sheetRow);
      if (parsed.downloaded) recorded[row.parent_id] = parsed.downloaded;
    });
  }
  return { parentByName: activeParentByName, outcomes, reconfirmed, recorded, inactiveParentIds, inactiveNames, outcomeRows, parentNamesIncomplete };
}

function rateChoices(row: SheetRow<(typeof RATE_HEADERS)[number]>, where: string, problems: string[]) {
  const decision = collectRowProblem(problems, () => parseDecision(row.decision, where));
  const isDefault = collectRowProblem(problems, () => parseYesNo(row.is_quoting_default, where));
  return { decision, isDefault };
}

function addedRateParent(row: SheetRow<(typeof RATE_HEADERS)[number]>, parentByName: Map<string, string>, inactiveNames: Set<string>, incomplete: boolean): string | null {
  const where = `Draft Rates row ${row.sheetRow}`;
  const parentId = parentByName.get(row.parent_name.toLowerCase());
  if (parentId === AMBIGUOUS) throw new PricingWorkbookFormatError(`${where}: more than one parent is named "${row.parent_name}". Add this rate in the setup workbook, or rename one parent first.`);
  if (!parentId && inactiveNames.has(row.parent_name.toLowerCase())) throw new PricingWorkbookFormatError(`${where}: "${row.parent_name}" is inactive. Inactive groups are history only and cannot receive new rates.`);
  if (!parentId && incomplete) return null; // Its parent may be on an unreadable row; that error already refuses the file.
  if (!parentId) throw new PricingWorkbookFormatError(`${where}: type a parent name exactly as on the Rate Outcomes sheet to add a rate.`);
  return parentId;
}

function rateDownloadState(row: SheetRow<(typeof V3_RATE_HEADERS)[number]>, where: string) {
  const damaged = new PricingWorkbookFormatError(`${where} is damaged (its hidden download record or rate id). Download a fresh workbook.`);
  const saved = parseState<(Partial<RateValues> & { rate_id?: unknown; parent_id?: unknown; row_version?: unknown; is_active?: unknown; status?: unknown }) | null>(row.row_state, damaged);
  if (!saved || saved.rate_id !== row.rate_id || typeof saved.parent_id !== 'string' || typeof saved.row_version !== 'number') throw damaged;
  if (row.parent_activity !== undefined && row.parent_activity !== '') {
    const expectedActivity = saved.is_active === true ? 'active' : saved.is_active === false ? 'inactive' : null;
    if (expectedActivity === null || row.parent_activity !== expectedActivity || row.status !== saved.status
      || !['draft', 'approved'].includes(String(saved.status))) throw damaged;
  } else if (saved.is_active !== undefined || saved.status !== undefined) throw damaged;
  return { ...saved, parent_id: saved.parent_id, row_version: saved.row_version };
}

function rateValuesChanged(values: Omit<RateValues, 'is_quoting_default'>, isDefault: boolean | undefined, saved: Partial<RateValues>) {
  return (isDefault !== undefined && isDefault !== saved.is_quoting_default)
    || (['basis', 'source', 'unit', 'over_label_reason'] as const).some((field) => values[field] !== (saved[field] ?? null))
    || (['low', 'recommended', 'high'] as const).some((field) => decimalKey(values[field]) !== decimalKey(saved[field] ?? null));
}

function addInactiveRateProblems(problems: string[], check: {
  where: string; parentName: string; saved: ReturnType<typeof rateDownloadState>;
  decision: RateReviewRateRow['decision'] | undefined; reason: string | null; valuesChanged: boolean;
}) {
  const { where, parentName, saved, decision, reason, valuesChanged } = check;
  if (saved.is_active !== false) return;
  if (decision === null && reason !== null) {
    problems.push(`${where} (${parentName}): a reason is only accepted with an allowed inactive cleanup decision.`);
  }
  const allowedDecision = (saved.status === 'approved' && decision === 'reopen') || (saved.status === 'draft' && decision === 'delete');
  if (valuesChanged || (decision !== null && !allowedDecision)) {
    problems.push(`${where} (${parentName}): inactive parents are history only. Rate values cannot change; approved rates may only be reopened and draft rates may only be deleted.`);
  }
}

type AddedRateRowInput = {
  row: SheetRow<(typeof V3_RATE_HEADERS)[number]>; parentByName: Map<string, string>; inactiveNames: Set<string>;
  parentNamesIncomplete: boolean; values: Omit<RateValues, 'is_quoting_default'>; decision: RateReviewRateRow['decision'] | undefined;
  isDefault: boolean | undefined; reason: string | null; problems: string[];
};

function parseAddedRateRow(input: AddedRateRowInput): RateUpload | null {
  const { row, parentByName, inactiveNames, parentNamesIncomplete, values, decision, isDefault, reason, problems } = input;
  if (!RATE_EDITABLE.some((field) => row[field] !== '')) return null;
  const parentId = collectRowProblem(problems, () => addedRateParent(row, parentByName, inactiveNames, parentNamesIncomplete));
  if (decision === undefined || isDefault === undefined || parentId === undefined) throw new PricingWorkbookFormatError(problems.join('\n'));
  if (parentId === null) return null;
  return { sheetRow: row.sheetRow, parent_name: row.parent_name, rate_id: null, parent_id: parentId, expected_row_version: null,
    ...values, is_quoting_default: isDefault, decision, reason };
}

/** An edited or new Draft Rates row, or null when it matches the download (or is an empty blank row). */
function parseRateRow(row: SheetRow<(typeof V3_RATE_HEADERS)[number]>, parentByName: Map<string, string>, inactiveNames: Set<string>, parentNamesIncomplete: boolean, v3: boolean): RateUpload | null {
  const where = `Draft Rates row ${row.sheetRow}`;
  const values = {
    basis: blankToNull(row.basis), source: blankToNull(row.source), low: blankToNull(row.low),
    recommended: blankToNull(row.recommended), high: blankToNull(row.high), unit: blankToNull(row.unit),
    over_label_reason: blankToNull(row.over_label_reason),
  };
  const problems: string[] = [];
  const { decision, isDefault } = rateChoices(row, where, problems);
  const reason = blankToNull(row.reason);
  if (row.rate_id === '' && row.row_state === '') {
    return parseAddedRateRow({ row, parentByName, inactiveNames, parentNamesIncomplete, values, decision, isDefault, reason, problems });
  }
  if (v3 && row.parent_activity !== 'active' && row.parent_activity !== 'inactive') {
    throw new PricingWorkbookFormatError(`${where} is missing its activity label. Download a fresh workbook.`);
  }
  const saved = collectRowProblem(problems, () => rateDownloadState(row, where));
  if (saved === undefined || (saved.is_active !== false && (decision === undefined || isDefault === undefined))) {
    throw new PricingWorkbookFormatError(problems.join('\n'));
  }
  const valuesChanged = rateValuesChanged(values, isDefault, saved);
  const edited = decision !== null || decision === undefined || reason != null || valuesChanged || problems.length > 0;
  if (!edited) return null;
  addInactiveRateProblems(problems, { where, parentName: row.parent_name, saved, decision, reason, valuesChanged });
  if (decision === undefined || isDefault === undefined || problems.length > 0) throw new PricingWorkbookFormatError(problems.join('\n'));
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
  const formatVersion = entries.get('format_version');
  if (formatVersion?.startsWith('crx-rate-review-v') && formatVersion !== FORMAT_VERSION && formatVersion !== LEGACY_FORMAT_VERSION) {
    throw new PricingWorkbookFormatError('This CRX rate review workbook uses a different version. Download a fresh one and copy your edits into it.');
  }
  if (formatVersion !== FORMAT_VERSION && formatVersion !== LEGACY_FORMAT_VERSION) {
    throw new PricingWorkbookFormatError('This is not a CRX rate review workbook. Download a fresh one from Rate Review.');
  }

  const problems: string[] = [];
  const v3 = formatVersion === FORMAT_VERSION;
  const rateHeaders = v3 ? V3_RATE_HEADERS : LEGACY_RATE_HEADERS;
  const outcomeHeaders = v3 ? V3_OUTCOME_HEADERS : LEGACY_OUTCOME_HEADERS;
  const outcomeSheet = workbook.getWorksheet(OUTCOMES_SHEET);
  const { parentByName, outcomes, reconfirmed, recorded, inactiveParentIds, inactiveNames, outcomeRows, parentNamesIncomplete } = readOutcomeSheet(outcomeSheet, problems, outcomeHeaders, v3);

  const rates: RateUpload[] = [];
  let rateRows = 0;
  const seenRates = new Set<string>();
  const beforeRates = problems.length;
  for (const row of readRows(workbook.getWorksheet(RATES_SHEET), RATES_SHEET, rateHeaders, problems)) {
    collectRowProblem(problems, () => {
      if (row.rate_id !== '' || row.row_state !== '') {
        rateRows += 1;
        if (seenRates.has(row.rate_id)) throw new PricingWorkbookFormatError(`Draft Rates row ${row.sheetRow} repeats another row. Do not copy rows. Download a fresh workbook.`);
        seenRates.add(row.rate_id);
      }
      const edited = parseRateRow(row, parentByName, inactiveNames, parentNamesIncomplete, v3);
      if (edited) rates.push(edited);
    });
  }
  const editedRateParents = new Set(rates.map((rate) => rate.parent_id));
  const ratesReadable = problems.length === beforeRates;
  for (const [parentId, sheetRow] of reconfirmed) {
    if (ratesReadable && !editedRateParents.has(parentId)) {
      problems.push(`Rate Outcomes row ${sheetRow}: Reconfirm needs an edited Draft Rates row for this parent in the same upload.`);
    }
  }

  if (problems.length > 0) throw new PricingWorkbookFormatError(problems.join('\n'));
  checkRowCount(RATES_SHEET, rateRows, entries.get('rate_row_count'));
  checkRowCount(OUTCOMES_SHEET, outcomeRows, entries.get('outcome_row_count'));
  if (rates.length > MAX_RATE_REVIEW_RATE_ROWS || outcomes.length > MAX_RATE_REVIEW_OUTCOME_ROWS) {
    throw new PricingWorkbookFormatError(`Send at most ${MAX_RATE_REVIEW_RATE_ROWS} changed rates and ${MAX_RATE_REVIEW_OUTCOME_ROWS} changed outcomes at a time.`);
  }
  return { rates, outcomes, recorded, ...(inactiveParentIds.length > 0 ? { inactive_parent_ids: inactiveParentIds } : {}) };
}

/** Plain words for a database refusal: drops the error code before the first colon. */
/** The values a rate row saves, so Confirm shows the number being approved. */
export function rateValueText(r: RateUpload | undefined): string {
  if (!r) return '';
  const amount = [r.low, r.recommended, r.high].map((v) => v ?? '-').join(' / ');
  return `${r.basis ?? '?'} ${r.source ?? '?'}: ${amount} ${r.unit ?? ''}${r.is_quoting_default ? ', quoting default' : ''}`;
}

export const problemText = (problem: string | undefined) => (problem ?? '').replace(/^[A-Z_]+:\s*/, '');
