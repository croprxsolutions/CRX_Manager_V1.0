import type { Worksheet } from 'exceljs';
import { assertRpcResult, supabase } from './db';
import {
  cellValueToText,
  isFormulaValue,
  loadExcelJs,
  PricingWorkbookFormatError,
  PRICING_WORKBOOK_MIME,
  validatePricingWorkbookArchive,
} from './productPricingWorkbook';
import type { ProductRatePerAcre, UseTimingOption } from '../types';
import type { Json } from '../types/supabase';

/**
 * WP-PM-11a-2: the setup workbook, separate from the price workbook. A Setup tab for product details
 * (never prices, rates or vendor) and a Rates tab whose saves go only through set_product_rates, so
 * the "Lock rates" switch applies. Each tab is previewed and confirmed on its own; the database
 * refuses a row changed since the download, by product name.
 */
export const SETUP_WORKBOOK_SHEET = 'Setup';
export const RATES_WORKBOOK_SHEET = 'Rates';
const MANIFEST_SHEET = '_crx_manifest';
// A later format (for example after products are grouped into parents) changes this, so an older
// download is refused as a whole.
export const SETUP_WORKBOOK_FORMAT_VERSION = 'crx-product-setup-v1';
/** The most rows one tab's save (and set_product_rates) takes at once. */
export const MAX_SETUP_WORKBOOK_SAVE_ROWS = 2000;

const SETUP_TEXT_FIELDS = [
  'product_name', 'sku', 'category', 'manufacturer', 'container_type', 'epa_registration',
  'signal_word', 'max_label_rate_unit', 'notes', 'internal_notes', 'quoting_notes',
] as const;
const SETUP_DECIMAL_FIELDS = ['container_size', 'max_label_rate'] as const;
const SETUP_WHOLE_FIELDS = ['rei_hours', 'phi_days'] as const;
/** Every field the Setup tab may change, in sheet order. */
export const SETUP_EDITABLE_FIELDS = [
  'product_name', 'sku', 'category', 'manufacturer', 'container_size', 'container_type',
  'epa_registration', 'is_rup', 'signal_word', 'rei_hours', 'phi_days', 'max_label_rate',
  'max_label_rate_unit', 'use_timings', 'notes', 'internal_notes', 'quoting_notes',
] as const;
export type SetupField = (typeof SETUP_EDITABLE_FIELDS)[number];

const SETUP_HEADERS = [
  'product_id', 'setup_fingerprint', 'is_active', 'product_form', 'inventory_unit', 'unit_size',
  'container_unit', ...SETUP_EDITABLE_FIELDS,
] as const;
const RATES_HEADERS = [
  'product_id', 'row_state', 'product_name', 'sku', 'product_form', 'inventory_unit', 'unit_size',
  'current_tier1_price_per_acre', 'current_tier2_price_per_acre', 'current_tier3_price_per_acre',
  'rate_per_acre', 'rate_unit', 'suggested_rate',
] as const;
const RATES_EDITABLE = new Set<string>(['rate_per_acre', 'rate_unit', 'suggested_rate']);
const HIDDEN = new Set<string>(['setup_fingerprint', 'row_state']);

/** One product as get_product_setup_workbook returns it. Decimals arrive as exact text. */
export interface SetupWorkbookProduct {
  product_id: string;
  product_name: string;
  sku: string | null;
  is_active: boolean;
  category: string | null;
  manufacturer: string | null;
  product_form: string | null;
  inventory_unit: string | null;
  unit_size: string | null;
  container_unit: string | null;
  container_size: string | null;
  container_type: string | null;
  epa_registration: string | null;
  is_rup: boolean;
  signal_word: string | null;
  rei_hours: number | null;
  phi_days: number | null;
  max_label_rate: string | null;
  max_label_rate_unit: string | null;
  use_timings: string[];
  notes: string | null;
  internal_notes: string | null;
  quoting_notes: string | null;
  setup_fingerprint: string;
  rate_per_acre: string | null;
  rate_unit: string | null;
  suggested_rate: string | null;
  pricing_version: number;
  tier1_price_per_acre: number | null;
  tier2_price_per_acre: number | null;
  tier3_price_per_acre: number | null;
}
export interface SetupWorkbookExport {
  rates_locked: boolean;
  rows: SetupWorkbookProduct[];
}

/** The download's own values a rate save must still find (set_product_rates' `expected`). */
export interface RateRowState {
  rate_per_acre: string | null;
  rate_unit: string | null;
  suggested_rate: string | null;
  pricing_version: number;
  unit_size: string | null;
  inventory_unit: string | null;
  product_form: string | null;
}
export interface RateUploadRow {
  product_id: string;
  rate_per_acre: string | null;
  rate_unit: string | null;
  suggested_rate: string | null;
  expected: RateRowState;
}
export type RatePreviewStatus = 'change' | 'unchanged' | 'stale' | 'invalid_rate' | 'invalid_unit' | 'not_found';
export interface RatePreviewRow {
  product_id: string;
  product_name?: string;
  status: RatePreviewStatus;
  before?: { rate_per_acre: string | null; rate_unit: string | null; suggested_rate: string | null } & ProductRatePerAcre;
  after?: { rate_per_acre: string | null; rate_unit: string | null; suggested_rate: string | null } & ProductRatePerAcre;
}
export interface RatePreview {
  rates_locked: boolean;
  rows: RatePreviewRow[];
}

export type SetupValue = string | number | boolean | string[] | null;
export interface SetupChangeRow {
  product_id: string;
  product_name: string;
  setup_fingerprint: string;
  changes: Partial<Record<SetupField, SetupValue>>;
  /** Before and after as the preview shows them. */
  display: Array<{ field: SetupField; before: string; after: string }>;
}
export interface SetupRowProblem {
  product_id: string;
  product_name: string;
  problem: string;
}
export interface SetupPreview {
  changes: SetupChangeRow[];
  stale: SetupRowProblem[];
  invalid: SetupRowProblem[];
}

export interface ParsedSetupWorkbook {
  setupRows: Array<Record<(typeof SETUP_HEADERS)[number], string>>;
  rateRows: RateUploadRow[];
}

export async function loadSetupWorkbookExport(): Promise<SetupWorkbookExport> {
  const { data, error } = await supabase.rpc('get_product_setup_workbook');
  if (error) throw error;
  return assertRpcResult<SetupWorkbookExport>(data, 'get_product_setup_workbook');
}

export async function previewProductRates(rows: RateUploadRow[]): Promise<RatePreview> {
  const { data, error } = await supabase.rpc('preview_product_rates', { p_rows: rows as unknown as Json });
  if (error) throw error;
  return assertRpcResult<RatePreview>(data, 'preview_product_rates');
}

/** Saves the previewed rate changes through the one rate writer; the previewed prices must still hold. */
export async function saveProductRates(input: {
  preview: RatePreview; rows: RateUploadRow[]; performedBy: string; idempotencyKey: string;
}): Promise<{ changed_count: number }> {
  const saveRows = rateSaveRows(input.preview, input.rows);
  const { data, error } = await supabase.rpc('set_product_rates', {
    p_rows: saveRows as unknown as Json,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<{ changed_count: number }>(data, 'set_product_rates');
}

export async function applyProductSetup(input: {
  rows: SetupChangeRow[]; performedBy: string; idempotencyKey: string;
}): Promise<{ changed_count: number; rows: Array<{ product_id: string; product_name: string; fields: string[] }> }> {
  const { data, error } = await supabase.rpc('apply_product_setup', {
    p_rows: input.rows.map(({ product_id, setup_fingerprint, changes }) => ({ product_id, setup_fingerprint, changes })) as unknown as Json,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult(data, 'apply_product_setup');
}

/** set_product_rates rows: only the previewed changes, each carrying the per-acre prices the preview showed. */
export function rateSaveRows(preview: RatePreview, rows: RateUploadRow[]) {
  return rows.flatMap((row) => {
    const shown = preview.rows.find((p) => p.product_id === row.product_id);
    if (shown?.status !== 'change' || !shown.after) return [];
    const { tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre } = shown.after;
    return [{ ...row, expected: { ...row.expected, prices: { tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre } } }];
  });
}

const blankToNull = (value: string | null | undefined) => (value == null || value.trim() === '' ? null : value.trim());
/** "2.50" and "2.5" are the same amount. */
function sameDecimal(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) => (v == null ? null : v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
  return norm(a) === norm(b);
}
const labelOf = (options: readonly UseTimingOption[], code: string) => options.find((o) => o.code === code)?.label ?? code;

function setupCell(product: SetupWorkbookProduct, field: (typeof SETUP_HEADERS)[number], options: readonly UseTimingOption[]): string | number {
  if (field === 'is_rup' || field === 'is_active') return product[field] ? 'yes' : 'no';
  if (field === 'use_timings') return product.use_timings.map((code) => labelOf(options, code)).join('; ');
  const value = product[field];
  return value ?? '';
}

function styleSheet(sheet: Worksheet, headers: readonly string[], editable: (header: string) => boolean): void {
  sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1, showGridLines: false }];
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6B4F' } };
  headers.forEach((name, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = HIDDEN.has(name) ? 10 : Math.max(14, name.length + 4);
    column.hidden = HIDDEN.has(name);
    // Text, so Excel never turns an SKU, EPA number or rate into a date or a rounded float.
    column.numFmt = '@';
    column.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber === 1) return;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: editable(name) ? 'FFEAF7EF' : 'FFF2F4F3' } };
      cell.protection = { locked: !editable(name) };
    });
  });
}

/** The download: a Setup tab, a Rates tab and a hidden manifest. Grey columns are for reference only. */
export async function generateSetupWorkbook(
  exported: SetupWorkbookExport, options: readonly UseTimingOption[],
): Promise<Blob> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CRX Manager';

  const setup = workbook.addWorksheet(SETUP_WORKBOOK_SHEET);
  setup.addRow([...SETUP_HEADERS]);
  for (const product of exported.rows) setup.addRow(SETUP_HEADERS.map((field) => setupCell(product, field, options)));
  styleSheet(setup, SETUP_HEADERS, (name) => (SETUP_EDITABLE_FIELDS as readonly string[]).includes(name));
  const timingColumn = SETUP_HEADERS.indexOf('use_timings') + 1;
  setup.getCell(1, timingColumn).note = 'Exact use timing labels, separated by a semicolon (;). Only Herbicide and Foliar Fertilizer products take them.';
  setup.getCell(1, SETUP_HEADERS.indexOf('is_rup') + 1).note = 'yes or no';

  const rates = workbook.addWorksheet(RATES_WORKBOOK_SHEET);
  rates.addRow([...RATES_HEADERS]);
  for (const p of exported.rows) {
    const state: RateRowState = {
      rate_per_acre: p.rate_per_acre, rate_unit: p.rate_unit, suggested_rate: p.suggested_rate,
      pricing_version: p.pricing_version, unit_size: p.unit_size, inventory_unit: p.inventory_unit,
      product_form: p.product_form,
    };
    rates.addRow([p.product_id, JSON.stringify(state), p.product_name, p.sku ?? '', p.product_form ?? '',
      p.inventory_unit ?? '', p.unit_size ?? '', p.tier1_price_per_acre ?? '', p.tier2_price_per_acre ?? '',
      p.tier3_price_per_acre ?? '', p.rate_per_acre ?? '', p.rate_unit ?? '', p.suggested_rate ?? '']);
  }
  styleSheet(rates, RATES_HEADERS, (name) => RATES_EDITABLE.has(name));
  if (exported.rates_locked) rates.getCell(1, RATES_HEADERS.indexOf('rate_per_acre') + 1).note = 'Rates are locked: a Rates upload is refused until an admin unlocks them.';

  const manifest = workbook.addWorksheet(MANIFEST_SHEET, { state: 'veryHidden' });
  manifest.addRows([['format_version', SETUP_WORKBOOK_FORMAT_VERSION], ['row_count', String(exported.rows.length)]]);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer as unknown as ArrayBuffer)], { type: PRICING_WORKBOOK_MIME });
}

function readSheet<H extends string>(sheet: Worksheet | undefined, name: string, headers: readonly H[], rowCount: number): Array<Record<H, string>> {
  if (!sheet) throw new PricingWorkbookFormatError(`Missing the ${name} sheet. Download a fresh setup workbook.`);
  const found = headers.map((_, index) => cellValueToText(sheet.getRow(1).getCell(index + 1).value, `${name} header ${index + 1}`));
  if (sheet.getRow(1).cellCount !== headers.length || headers.some((header, index) => found[index] !== header)) {
    throw new PricingWorkbookFormatError(`The ${name} sheet's columns do not match the CRX setup workbook. Download a fresh one.`);
  }
  if (sheet.actualRowCount - 1 !== rowCount) {
    throw new PricingWorkbookFormatError(`The ${name} sheet has added or removed rows. Edit values only; add new products another way.`);
  }
  const rows: Array<Record<H, string>> = [];
  for (let rowNumber = 2; rowNumber <= rowCount + 1; rowNumber += 1) {
    const row = {} as Record<H, string>;
    headers.forEach((header, index) => {
      const cell = sheet.getCell(rowNumber, index + 1);
      if (isFormulaValue(cell.value)) throw new PricingWorkbookFormatError(`${name} row ${rowNumber}, ${header} has a formula. Type the value instead.`);
      row[header] = cellValueToText(cell.value, `${name} row ${rowNumber}, ${header}`);
    });
    rows.push(row);
  }
  return rows;
}

export async function parseSetupWorkbook(arrayBuffer: ArrayBuffer): Promise<ParsedSetupWorkbook> {
  await validatePricingWorkbookArchive(arrayBuffer);
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(arrayBuffer);
  } catch {
    throw new PricingWorkbookFormatError('The uploaded file is not a readable .xlsx workbook.');
  }
  const manifest = workbook.getWorksheet(MANIFEST_SHEET);
  const entries = new Map<string, string>();
  manifest?.eachRow((row, n) => entries.set(cellValueToText(row.getCell(1).value, `Manifest ${n}`), cellValueToText(row.getCell(2).value, `Manifest ${n}`)));
  if (entries.get('format_version') !== SETUP_WORKBOOK_FORMAT_VERSION) {
    throw new PricingWorkbookFormatError('This is not a current CRX setup workbook. Download a fresh one.');
  }
  const rowCountText = entries.get('row_count') ?? '';
  if (!/^(?:0|[1-9]\d{0,5})$/.test(rowCountText)) throw new PricingWorkbookFormatError('The setup workbook manifest is damaged. Download a fresh one.');
  const rowCount = Number(rowCountText);

  const setupRows = readSheet(workbook.getWorksheet(SETUP_WORKBOOK_SHEET), SETUP_WORKBOOK_SHEET, SETUP_HEADERS, rowCount);
  const rateRows = readSheet(workbook.getWorksheet(RATES_WORKBOOK_SHEET), RATES_WORKBOOK_SHEET, RATES_HEADERS, rowCount)
    .map((row, index) => {
      let expected: RateRowState;
      try {
        expected = JSON.parse(row.row_state) as RateRowState;
      } catch {
        throw new PricingWorkbookFormatError(`Rates row ${index + 2} is damaged (its hidden download record). Download a fresh workbook.`);
      }
      return {
        product_id: row.product_id,
        rate_per_acre: blankToNull(row.rate_per_acre),
        rate_unit: blankToNull(row.rate_unit),
        suggested_rate: blankToNull(row.suggested_rate),
        expected,
      };
    });
  return { setupRows, rateRows };
}

/** Rates rows the person edited, compared with what they downloaded. */
export function editedRateRows(rows: RateUploadRow[]): RateUploadRow[] {
  return rows.filter((row) => !sameDecimal(row.rate_per_acre, blankToNull(row.expected.rate_per_acre))
    || row.rate_unit !== blankToNull(row.expected.rate_unit)
    || row.suggested_rate !== blankToNull(row.expected.suggested_rate));
}

function parseSetupValue(
  field: SetupField, text: string, options: readonly UseTimingOption[],
): { value: SetupValue } | { problem: string } {
  const trimmed = text.trim();
  if ((SETUP_TEXT_FIELDS as readonly string[]).includes(field)) return { value: trimmed === '' ? null : trimmed };
  if ((SETUP_DECIMAL_FIELDS as readonly string[]).includes(field)) {
    if (trimmed === '') return { value: null };
    return /^\d{1,12}(\.\d{1,6})?$/.test(trimmed) ? { value: trimmed } : { problem: `${field} must be a number of 0 or more, up to 6 decimals` };
  }
  if ((SETUP_WHOLE_FIELDS as readonly string[]).includes(field)) {
    if (trimmed === '') return { value: null };
    return /^\d{1,9}$/.test(trimmed) ? { value: Number(trimmed) } : { problem: `${field} must be a whole number of 0 or more` };
  }
  if (field === 'is_rup') {
    const yes = /^(yes|y|true)$/i.test(trimmed);
    return yes || /^(no|n|false)$/i.test(trimmed) ? { value: yes } : { problem: 'is_rup must be yes or no' };
  }
  // use_timings: exact labels (or codes), separated by semicolons.
  const codes: string[] = [];
  for (const part of trimmed.split(';').map((p) => p.trim()).filter(Boolean)) {
    const option = options.find((o) => o.label.toLowerCase() === part.toLowerCase() || o.code === part);
    if (!option) return { problem: `unknown use timing "${part}"` };
    if (!codes.includes(option.code)) codes.push(option.code);
  }
  return { value: codes };
}

function sameSetupValue(field: SetupField, current: SetupWorkbookProduct, value: SetupValue): boolean {
  if (field === 'use_timings') {
    return [...current.use_timings].sort().join('\u0000') === [...(value as string[])].sort().join('\u0000');
  }
  if ((SETUP_DECIMAL_FIELDS as readonly string[]).includes(field)) return sameDecimal(current[field as 'container_size'], value as string | null);
  return (current[field] ?? null) === value;
}

const shown = (field: SetupField, value: SetupValue | undefined, options: readonly UseTimingOption[]): string => {
  if (value == null || value === '') return '(blank)';
  if (field === 'is_rup') return value ? 'yes' : 'no';
  if (field === 'use_timings') return (value as string[]).map((code) => labelOf(options, code)).join('; ') || '(none)';
  return String(value);
};

/**
 * The Setup tab's preview: compares each uploaded row with the product as it is now. A row whose
 * values differ and whose download fingerprint no longer matches is stale (someone changed it since);
 * the database refuses it too.
 */
export function buildSetupPreview(
  rows: ParsedSetupWorkbook['setupRows'], current: SetupWorkbookExport, options: readonly UseTimingOption[],
): SetupPreview {
  const byId = new Map(current.rows.map((row) => [row.product_id, row]));
  const preview: SetupPreview = { changes: [], stale: [], invalid: [] };
  for (const row of rows) {
    const product = byId.get(row.product_id);
    if (!product) {
      preview.invalid.push({ product_id: row.product_id, product_name: row.product_name || row.product_id, problem: 'product not found' });
      continue;
    }
    const changes: SetupChangeRow['changes'] = {};
    const display: SetupChangeRow['display'] = [];
    const problems: string[] = [];
    for (const field of SETUP_EDITABLE_FIELDS) {
      const parsed = parseSetupValue(field, row[field], options);
      if ('problem' in parsed) { problems.push(parsed.problem); continue; }
      if (sameSetupValue(field, product, parsed.value)) continue;
      changes[field] = parsed.value;
      display.push({ field, before: shown(field, product[field], options), after: shown(field, parsed.value, options) });
    }
    if (problems.length > 0) {
      preview.invalid.push({ product_id: product.product_id, product_name: product.product_name, problem: problems.join('; ') });
    } else if (display.length > 0 && row.setup_fingerprint !== product.setup_fingerprint) {
      preview.stale.push({ product_id: product.product_id, product_name: product.product_name, problem: 'changed by someone else since you downloaded it' });
    } else if (display.length > 0) {
      preview.changes.push({ product_id: product.product_id, product_name: product.product_name, setup_fingerprint: row.setup_fingerprint, changes, display });
    }
  }
  return preview;
}
