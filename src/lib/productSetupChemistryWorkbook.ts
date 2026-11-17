import type { Workbook, Worksheet } from 'exceljs';
import { CHEMISTRY_SOURCES, parseAmount } from './productChemistry';
import { WEIGHT_SOURCES } from './productWeights';
import {
  cellValueToText, isFormulaValue, PricingWorkbookFormatError,
} from './productPricingWorkbook';

const WEIGHTS_SHEET = 'Weights';
const INGREDIENTS_SHEET = 'Ingredients';
const MAX_INGREDIENT_CHANGES_PER_PARENT = 200;
const MAX_CHEMISTRY_WORKBOOK_ROWS = 10_000;
const STARTER_ROWS_PER_PARENT = 3;
const WEIGHT_HEADERS = [
  'kind', 'subject_id', 'name', 'unit', 'approved_value', 'approved_source', 'approved_note',
  'draft_value', 'draft_source', 'draft_note', 'value', 'source', 'source_note', 'reason', 'evidence', '_row_state',
] as const;
const INGREDIENT_HEADERS = [
  'parent_id', 'parent_name', 'chemistry_version', 'action', 'row_id', 'ingredient_name', 'cas',
  'strength_value', 'strength_unit', 'strength_basis', 'source', 'source_note', '_row_state',
] as const;
const WEIGHT_SOURCE_VALUES = new Set<string>(WEIGHT_SOURCES.map(({ value }) => value));
const STRENGTH_UNITS = new Set(['pct_ww', 'lb_per_gal']);
const STRENGTH_BASES = new Set(['active_ingredient', 'acid_equivalent']);

export interface ChemistryValue {
  value: string;
  source: string;
  source_note: string | null;
}
export interface ChemistryDensityRow {
  parent_id: string;
  parent_name: string;
  version: number;
  approved: ChemistryValue | null;
  draft: ChemistryValue | null;
}
export interface ChemistryNetWeightRow {
  product_id: string;
  product_name: string;
  inventory_unit: string;
  version: number;
  approved: ChemistryValue | null;
  draft: ChemistryValue | null;
}
export interface ChemistryIngredientRow {
  row_id: string;
  name: string;
  cas: string | null;
  strength_value: string | null;
  strength_unit: string;
  strength_basis: string;
  source: string;
  source_note: string | null;
}
export interface ChemistryParentRow {
  parent_id: string;
  parent_name: string;
  chemistry_version: number;
  epa_refusal: string | null;
  ingredients: ChemistryIngredientRow[];
}
export interface SetupWorkbookChemistryExport {
  densities: ChemistryDensityRow[];
  net_weights: ChemistryNetWeightRow[];
  parents: ChemistryParentRow[];
}

export function assertChemistryWorkbookFitsParserLimit(data: SetupWorkbookChemistryExport): void {
  const weightRows = data.densities.length + data.net_weights.length;
  const ingredientRows = data.parents.reduce((total, parent) => total + parent.ingredients.length + STARTER_ROWS_PER_PARENT, 0);
  if (weightRows > MAX_CHEMISTRY_WORKBOOK_ROWS || ingredientRows > MAX_CHEMISTRY_WORKBOOK_ROWS) {
    throw new PricingWorkbookFormatError(`This catalog is too large for one chemistry workbook. Each chemistry tab supports at most ${MAX_CHEMISTRY_WORKBOOK_ROWS.toLocaleString()} rows; ask support to prepare a smaller download.`);
  }
}

export interface WeightWorkbookRow {
  kind: 'density' | 'net_weight';
  subject_id: string;
  name: string;
  expected_version: number;
  value: number;
  unit: 'lb_per_gal' | null;
  source: string;
  source_note: string | null;
  reason: string | null;
  evidence: string | null;
}
export interface IngredientWorkbookRow {
  parent_id: string;
  expected_chemistry_version: number;
  row_id: string | null;
  delete?: boolean;
  name: string;
  cas: string | null;
  strength_value: number | null;
  strength_unit: string | null;
  strength_basis: string | null;
  source: string | null;
  source_note: string | null;
}
export interface ParsedChemistryWorkbook {
  weightRows: WeightWorkbookRow[];
  ingredientRows: IngredientWorkbookRow[];
  issues: string[];
  openProposalParentIds: string[];
}

type WeightState = Pick<WeightWorkbookRow, 'kind' | 'subject_id' | 'name' | 'expected_version'> & {
  baseline: { value: string; source: string; source_note: string | null } | null;
};
type IngredientState = {
  parent_id: string;
  parent_name: string;
  chemistry_version: number;
  row_id: string | null;
  name: string;
  cas: string | null;
  strength_value: string | null;
  strength_unit: string | null;
  strength_basis: string | null;
  source: string | null;
  source_note: string | null;
};

function cellText(sheet: Worksheet, row: number, column: number, label: string): string {
  const cell = sheet.getCell(row, column);
  if (isFormulaValue(cell.value)) throw new PricingWorkbookFormatError(`${label} has a formula. Type the value instead.`);
  return cellValueToText(cell.value, label).trim();
}

function styleSheet(sheet: Worksheet, headers: readonly string[], rows: number, editable: ReadonlySet<string>): void {
  sheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6B4F' } };
  headers.forEach((header, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = header.startsWith('_') ? 12 : Math.max(14, header.length + 3);
    column.hidden = header.startsWith('_');
    column.numFmt = '@';
    for (let row = 2; row <= rows + 1; row += 1) {
      const cell = sheet.getCell(row, index + 1);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: editable.has(header) ? 'FFEAF7EF' : 'FFF2F4F3' } };
    }
  });
}

const json = (value: unknown) => JSON.stringify(value);
const bestValue = (draft: ChemistryValue | null, approved: ChemistryValue | null) => draft ?? approved;

export function addChemistryWorkbookSheets(workbook: Workbook, data: SetupWorkbookChemistryExport): void {
  const weights = workbook.addWorksheet(WEIGHTS_SHEET);
  weights.addRow([...WEIGHT_HEADERS]);
  for (const row of data.densities) addWeightRow(weights, {
    kind: 'density', subject_id: row.parent_id, name: row.parent_name, unit: 'lb/gal', version: row.version,
    approved: row.approved, draft: row.draft,
  });
  for (const row of data.net_weights) addWeightRow(weights, {
    kind: 'net_weight', subject_id: row.product_id, name: row.product_name, unit: row.inventory_unit, version: row.version,
    approved: row.approved, draft: row.draft,
  });
  styleSheet(weights, WEIGHT_HEADERS, weights.rowCount - 1,
    new Set(['value', 'source', 'source_note', 'reason', 'evidence']));
  weights.getCell(1, 11).note = 'Only value, source or source note edits are sent. Reason or evidence alone saves nothing. Values allow at most 4 decimals; density is lb/gal and net weight is lb.';
  weights.getCell(1, 12).note = 'Type one source code: measured, sds, label or supplier.';
  weights.getCell(1, 5).note = 'Approved record (reference).';
  weights.getCell(1, 8).note = 'Draft record (reference). This is the starting editable value when present.';

  const ingredients = workbook.addWorksheet(INGREDIENTS_SHEET);
  ingredients.addRow([...INGREDIENT_HEADERS]);
  for (const parent of data.parents) {
    for (const ingredient of parent.ingredients) addIngredientRow(ingredients, parent, ingredient, false);
    for (let index = 0; index < STARTER_ROWS_PER_PARENT; index += 1) addIngredientRow(ingredients, parent, null, true);
  }
  styleSheet(ingredients, INGREDIENT_HEADERS, ingredients.rowCount - 1,
    new Set(['action', 'strength_value', 'strength_unit', 'strength_basis', 'source', 'source_note']));
  for (let rowNumber = 2; rowNumber <= ingredients.rowCount; rowNumber += 1) {
    const hiddenState = ingredients.getCell(rowNumber, 13).value;
    if (typeof hiddenState === 'string' && (JSON.parse(hiddenState) as IngredientState).row_id === null) {
      for (const column of [6, 7]) {
        ingredients.getCell(rowNumber, column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF7EF' } };
      }
    }
    if (ingredients.getCell(rowNumber, 11).value === 'epa_lookup') {
      for (const column of [4, 6, 7, 8, 9, 10, 11, 12]) {
        ingredients.getCell(rowNumber, column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F3' } };
      }
    }
  }
  ingredients.getRow(1).eachCell((cell) => { cell.note = cell.note ?? 'Reference rows are grey. Copy an existing blank starter row to add more ingredients; keep its hidden download record.'; });
  ingredients.getCell(1, 4).note = 'Leave blank, or enter __delete for a removal proposal. Keep ingredient name and CAS unchanged.';
  ingredients.getCell(1, 5).note = 'Reference only; do not edit.';
  ingredients.getCell(1, 8).note = 'Leave strength value blank when unknown. Strength unit and basis are still required.';
  ingredients.getCell(1, 9).note = 'Required even when strength value is unknown. Use pct_ww or lb_per_gal.';
  ingredients.getCell(1, 10).note = 'Required even when strength value is unknown. Use active_ingredient or acid_equivalent.';
  ingredients.getCell(1, 11).note = 'Type one source code: label, sds, supplier or other.';
}

function addWeightRow(sheet: Worksheet, row: {
  kind: WeightState['kind']; subject_id: string; name: string; unit: string; version: number;
  approved: ChemistryValue | null; draft: ChemistryValue | null;
}): void {
  const baseline = bestValue(row.draft, row.approved);
  sheet.addRow([
    row.kind, row.subject_id, row.name, row.unit,
    row.approved?.value ?? '', row.approved?.source ?? '', row.approved?.source_note ?? '',
    row.draft?.value ?? '', row.draft?.source ?? '', row.draft?.source_note ?? '',
    baseline?.value ?? '', baseline?.source ?? '', baseline?.source_note ?? '', '', '',
    json({ kind: row.kind, subject_id: row.subject_id, name: row.name, expected_version: row.version,
      baseline: baseline ? { value: baseline.value, source: baseline.source, source_note: baseline.source_note } : null } satisfies WeightState),
  ]);
}

function ingredientState(parent: ChemistryParentRow, row: ChemistryIngredientRow | null): IngredientState {
  return {
    parent_id: parent.parent_id, parent_name: parent.parent_name, chemistry_version: parent.chemistry_version,
    row_id: row?.row_id ?? null, name: row?.name ?? '', cas: row?.cas ?? null,
    strength_value: row?.strength_value ?? null, strength_unit: row?.strength_unit ?? null,
    strength_basis: row?.strength_basis ?? null, source: row?.source ?? null, source_note: row?.source_note ?? null,
  };
}

function ingredientWorkbookCells(parent: ChemistryParentRow, row: ChemistryIngredientRow | null, state: IngredientState): unknown[] {
  return [
    parent.parent_id, parent.parent_name, parent.chemistry_version, '', row?.row_id ?? '', row?.name ?? '', row?.cas ?? '',
    row?.strength_value ?? '', row?.strength_unit ?? '', row?.strength_basis ?? '', row?.source ?? '', row?.source_note ?? '', json(state),
  ];
}

function annotateIngredientWorkbookRow(sheet: Worksheet, parent: ChemistryParentRow, row: ChemistryIngredientRow | null, starter: boolean): void {
  if (row?.source === 'epa_lookup') sheet.getCell(sheet.rowCount, 8).note = 'EPA-filled row: reference only. Edit it on the product page.';
  if (starter) sheet.getCell(sheet.rowCount, 1).note = 'Starter for a new ingredient on this parent.';
  if (parent.epa_refusal) sheet.getCell(sheet.rowCount, 2).note = `EPA review: ${parent.epa_refusal}`;
}

function addIngredientRow(sheet: Worksheet, parent: ChemistryParentRow, row: ChemistryIngredientRow | null, starter: boolean): void {
  sheet.addRow(ingredientWorkbookCells(parent, row, ingredientState(parent, row)));
  annotateIngredientWorkbookRow(sheet, parent, row, starter);
}

function readHeaders(sheet: Worksheet, name: string, headers: readonly string[]): void {
  const found = headers.map((header, index) => cellText(sheet, 1, index + 1, `${name} header ${index + 1}`));
  if (sheet.getRow(1).cellCount !== headers.length || found.some((header, index) => header !== headers[index])) {
    throw new PricingWorkbookFormatError(`The ${name} columns do not match the CRX setup workbook. Download a fresh one.`);
  }
}

function stateOf<T>(raw: string, label: string): T {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hidden record shape');
    return value as T;
  } catch {
    throw new PricingWorkbookFormatError(`${label} has a damaged hidden download record. Download a fresh workbook.`);
  }
}

function validWeightState(state: WeightState): boolean {
  const baseline = state.baseline;
  return ['density', 'net_weight'].includes(state.kind) && typeof state.subject_id === 'string' && state.subject_id.length > 0
    && typeof state.name === 'string' && Number.isSafeInteger(state.expected_version)
    && (baseline === null || (typeof baseline === 'object' && typeof baseline.value === 'string' && typeof baseline.source === 'string'
      && (baseline.source_note === null || typeof baseline.source_note === 'string')));
}

function validIngredientState(state: IngredientState): boolean {
  return typeof state.parent_id === 'string' && typeof state.parent_name === 'string' && Number.isSafeInteger(state.chemistry_version)
    && (state.row_id === null || typeof state.row_id === 'string') && typeof state.name === 'string'
    && (state.cas === null || typeof state.cas === 'string') && (state.strength_value === null || typeof state.strength_value === 'string')
    && (state.strength_unit === null || typeof state.strength_unit === 'string')
    && (state.strength_basis === null || typeof state.strength_basis === 'string') && (state.source === null || typeof state.source === 'string')
    && (state.source_note === null || typeof state.source_note === 'string');
}

function changedWeight(row: {
  name: string; value: string; source: string; source_note: string; reason: string; evidence: string; state: WeightState;
}, rowNumber: number): WeightWorkbookRow | null {
  const baseline = row.state.baseline;
  const value = row.value.trim();
  const source = row.source.trim();
  const sourceNote = row.source_note.trim() || null;
  if (value === (baseline?.value ?? '') && source === (baseline?.source ?? '') && sourceNote === (baseline?.source_note ?? null)) return null;
  if (!value) {
    if (baseline?.value != null) throw new PricingWorkbookFormatError(`Weights row ${rowNumber} cannot clear a recorded weight. Download a fresh workbook if this value is no longer needed.`);
    throw new PricingWorkbookFormatError(`Weights row ${rowNumber} needs a value before adding its source or note.`);
  }
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/.test(value) || Number(value) <= 0) {
    throw new PricingWorkbookFormatError(`Weights row ${rowNumber} needs a positive number with no more than 4 decimal places.`);
  }
  if (!WEIGHT_SOURCE_VALUES.has(source)) throw new PricingWorkbookFormatError(`Weights row ${rowNumber} needs a source code: measured, sds, label or supplier.`);
  return {
    kind: row.state.kind, subject_id: row.state.subject_id, name: row.name,
    expected_version: row.state.expected_version, value: Number(value),
    unit: row.state.kind === 'density' ? 'lb_per_gal' : null, source, source_note: sourceNote,
    reason: row.reason.trim() || null, evidence: row.evidence.trim() || null,
  };
}

function sameIngredient(row: Record<(typeof INGREDIENT_HEADERS)[number], string>, state: IngredientState): boolean {
  return row.action === '' && row.ingredient_name.trim() === state.name && row.cas.trim() === (state.cas ?? '')
    && row.strength_value.trim() === (state.strength_value ?? '') && row.strength_unit.trim() === (state.strength_unit ?? '')
    && row.strength_basis.trim() === (state.strength_basis ?? '') && row.source.trim() === (state.source ?? '')
    && (row.source_note.trim() || null) === state.source_note;
}

function parseStrength(value: string, unit: string, basis: string, rowNumber: number) {
  const parsed = parseAmount(value);
  if (parsed === 'invalid') throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} has an invalid strength.`);
  if (!STRENGTH_UNITS.has(unit) || !STRENGTH_BASES.has(basis)) throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} needs a valid strength unit and basis.`);
  return { strength_value: parsed, strength_unit: unit, strength_basis: basis };
}

type IngredientSheetRow = Record<(typeof INGREDIENT_HEADERS)[number], string>;

function ingredientCells(sheet: Worksheet, rowNumber: number): IngredientSheetRow {
  return Object.fromEntries(INGREDIENT_HEADERS.map((header, index) => [
    header, cellText(sheet, rowNumber, index + 1, `${INGREDIENTS_SHEET} row ${rowNumber}, ${header}`),
  ])) as IngredientSheetRow;
}

function hasUnboundIngredientData(row: IngredientSheetRow): boolean {
  return Boolean(row.parent_id || row.parent_name || row.chemistry_version || row.action || row.row_id
    || row.ingredient_name || row.cas || row.strength_value || row.strength_unit
    || row.strength_basis || row.source || row.source_note);
}

function validateIngredientBinding(row: IngredientSheetRow, rowNumber: number, seen: Set<string>): IngredientState {
  const state = stateOf<IngredientState>(row._row_state, `${INGREDIENTS_SHEET} row ${rowNumber}`);
  if (!validIngredientState(state)) throw new PricingWorkbookFormatError(`${INGREDIENTS_SHEET} row ${rowNumber} has a damaged hidden download record. Download a fresh workbook.`);
  const key = `${state.parent_id}:${state.row_id ?? 'new'}:${state.row_id ? '' : rowNumber}`;
  if (state.parent_id !== row.parent_id || state.parent_name !== row.parent_name || state.chemistry_version !== Number(row.chemistry_version)
      || state.row_id !== (row.row_id || null) || seen.has(key)) {
    throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} no longer matches its downloaded parent and ingredient. Keep reference columns unchanged; download a fresh workbook.`);
  }
  seen.add(key);
  return state;
}

function validateIngredientIdentity(row: IngredientSheetRow, state: IngredientState, rowNumber: number): void {
  if (state.row_id && row.ingredient_name.trim() !== state.name.trim()) {
    throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} changes the ingredient name. Download a fresh workbook and check the current shared ingredient name.`);
  }
  if (state.row_id && row.cas.trim() !== (state.cas ?? '')) {
    throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} changes the ingredient CAS. Download a fresh workbook and correct the CAS in the shared ingredient review screen.`);
  }
}

function validateIngredientAction(row: IngredientSheetRow, state: IngredientState, rowNumber: number): void {
  if (row.action && row.action !== '__delete') throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} action must be blank or __delete.`);
  if (!state.row_id && row.action === '__delete') throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} can only delete an ingredient from the download.`);
  if (!state.row_id && !row.ingredient_name.trim()) throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} needs an ingredient name.`);
}

function ingredientCitation(row: IngredientSheetRow, rowNumber: number): { source: string; source_note: string } {
  const source = row.source.trim();
  if (!CHEMISTRY_SOURCES.some((item) => item.value === source)) throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} needs a source code: label, sds, supplier or other.`);
  const sourceNote = row.source_note.trim();
  if (!sourceNote) throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} needs the source document in source_note.`);
  return { source, source_note: sourceNote };
}

function ingredientChange(row: IngredientSheetRow, state: IngredientState, rowNumber: number): IngredientWorkbookRow | null {
  const hasEntered = Boolean(row.action || row.strength_value || row.strength_unit || row.strength_basis || row.source || row.source_note
    || (!state.row_id && (row.ingredient_name.trim() || row.cas.trim())));
  if (!state.row_id && !hasEntered) return null;
  validateIngredientIdentity(row, state, rowNumber);
  if (state.row_id && sameIngredient(row, state)) return null;
  if (state.source === 'epa_lookup') throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} is EPA-filled reference data and cannot be edited or removed in this workbook. Edit it on the product page.`);
  validateIngredientAction(row, state, rowNumber);
  const citation = ingredientCitation(row, rowNumber);
  return {
    parent_id: state.parent_id, expected_chemistry_version: state.chemistry_version, row_id: state.row_id,
    ...(row.action === '__delete' ? { delete: true } : {}),
    name: state.row_id ? state.name : row.ingredient_name.trim(), cas: state.row_id ? state.cas : row.cas.trim() || null,
    ...parseStrength(row.strength_value.trim(), row.strength_unit.trim(), row.strength_basis.trim(), rowNumber),
    ...citation,
  };
}

function recordIngredientChange(rows: IngredientWorkbookRow[], counts: Map<string, number>, row: IngredientWorkbookRow, rowNumber: number): void {
  rows.push(row);
  if (rows.length > 2000) throw new PricingWorkbookFormatError('Send at most 2,000 changed rows on the Ingredients tab.');
  const count = (counts.get(row.parent_id) ?? 0) + 1;
  counts.set(row.parent_id, count);
  if (count > MAX_INGREDIENT_CHANGES_PER_PARENT) throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} exceeds 200 changes for one parent.`);
}

function parseIngredientRows(sheet: Worksheet): { rows: IngredientWorkbookRow[]; issues: string[] } {
  readHeaders(sheet, INGREDIENTS_SHEET, INGREDIENT_HEADERS);
  if (sheet.rowCount > MAX_CHEMISTRY_WORKBOOK_ROWS + 1) throw new PricingWorkbookFormatError(`Ingredients can contain at most ${MAX_CHEMISTRY_WORKBOOK_ROWS} physical workbook rows.`);
  const rows: IngredientWorkbookRow[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = ingredientCells(sheet, rowNumber);
    if (!row._row_state) {
      if (hasUnboundIngredientData(row)) throw new PricingWorkbookFormatError(`Ingredients row ${rowNumber} has data but no parent/version record. Copy a blank starter row.`);
      continue;
    }
    const state = validateIngredientBinding(row, rowNumber, seen);
    const change = ingredientChange(row, state, rowNumber);
    if (!change) continue;
    recordIngredientChange(rows, counts, change, rowNumber);
    if (!change.row_id && !change.cas) issues.push('A new ingredient without a CAS may create a separate provisional shared entry when applied. Confirm the product identity before proceeding.');
  }
  return { rows, issues: [...new Set(issues)] };
}

function parseWeightRows(sheet: Worksheet): WeightWorkbookRow[] {
  readHeaders(sheet, WEIGHTS_SHEET, WEIGHT_HEADERS);
  if (sheet.rowCount > MAX_CHEMISTRY_WORKBOOK_ROWS + 1) throw new PricingWorkbookFormatError(`Weights can contain at most ${MAX_CHEMISTRY_WORKBOOK_ROWS} physical workbook rows.`);
  const rows: WeightWorkbookRow[] = [];
  const seen = new Set<string>();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = WEIGHT_HEADERS.map((header, index) => cellText(sheet, rowNumber, index + 1, `Weights row ${rowNumber}, ${header}`));
    if (values.every((value) => value === '')) continue;
    const state = stateOf<WeightState>(values[15], `Weights row ${rowNumber}`);
    if (!validWeightState(state)) throw new PricingWorkbookFormatError(`Weights row ${rowNumber} has a damaged hidden download record. Download a fresh workbook.`);
    const key = `${state.kind}:${state.subject_id}`;
    if (seen.has(key)
        || cellText(sheet, rowNumber, 1, `Weights row ${rowNumber}, kind`) !== state.kind
        || cellText(sheet, rowNumber, 2, `Weights row ${rowNumber}, subject_id`) !== state.subject_id
      || cellText(sheet, rowNumber, 3, `Weights row ${rowNumber}, name`) !== state.name.trim()) {
      throw new PricingWorkbookFormatError(`Weights row ${rowNumber} no longer matches its downloaded subject and name. Keep reference columns unchanged and download a fresh workbook.`);
    }
    seen.add(key);
    const row = Object.fromEntries(WEIGHT_HEADERS.map((header, index) => [header, cellText(sheet, rowNumber, index + 1, `Weights row ${rowNumber}, ${header}`)])) as Record<(typeof WEIGHT_HEADERS)[number], string>;
    const parsed = changedWeight({ ...row, state }, rowNumber);
    if (parsed) rows.push(parsed);
  }
  if (rows.length > 2000) throw new PricingWorkbookFormatError('Send at most 2,000 changed rows on the Weights tab.');
  return rows;
}

export function parseChemistryWorkbook(workbook: Workbook): ParsedChemistryWorkbook {
  const ingredients = workbook.getWorksheet(INGREDIENTS_SHEET);
  const weights = workbook.getWorksheet(WEIGHTS_SHEET);
  if (!ingredients && !weights) return { weightRows: [], ingredientRows: [], issues: [], openProposalParentIds: [] };
  const weightRows = weights ? parseWeightRows(weights) : [];
  const parsedIngredients = ingredients ? parseIngredientRows(ingredients) : { rows: [], issues: [] };
  return { weightRows, ingredientRows: parsedIngredients.rows, issues: parsedIngredients.issues, openProposalParentIds: [] };
}
