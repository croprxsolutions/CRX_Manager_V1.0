import type { ContainerType } from '../../types';
import { sanitizeError } from '../../lib/errorSanitizer';

/** The import's columns, in template order. Rates are saved through set_product_rates, never the insert. */
export const PRODUCT_IMPORT_COLUMNS = [
  'product_name', 'sku', 'category', 'product_form', 'inventory_unit', 'unit_size', 'container_size', 'container_unit',
  'container_type', 'vendor', 'manufacturer', 'epa_registration', 'is_rup', 'signal_word', 'rei_hours', 'phi_days',
  'max_label_rate', 'max_label_rate_unit', 'use_timing', 'rate_per_acre', 'rate_unit', 'suggested_rate', 'notes',
] as const;
export type ProductImportColumn = typeof PRODUCT_IMPORT_COLUMNS[number];

// No ambiguous aliases: "unit" could be the pack unit or the rate unit, "type" the category or the container.
// The earlier template's other names stay mapped, so an old file never silently drops a column it used to import.
const COLUMN_ALIASES: Record<ProductImportColumn, string[]> = {
  product_name: ['product', 'name', 'productname', 'item', 'item_name'],
  sku: ['item_code', 'product_code', 'code'],
  category: ['product_type'],
  product_form: ['form', 'liquid_or_dry', 'type_liquid_dry'],
  inventory_unit: ['inv_unit', 'stock_unit', 'pricing_unit'],
  unit_size: ['uom', 'units'],
  container_size: ['size', 'package_size', 'container'],
  container_unit: ['pkg_unit', 'package_unit'],
  container_type: ['package_type', 'pkg_type'],
  vendor: ['supplier', 'distributor'],
  manufacturer: ['mfg', 'brand'],
  epa_registration: ['epa_reg', 'epa_number', 'epa', 'registration_number', 'reg_number'],
  is_rup: ['rup', 'restricted_use'],
  signal_word: ['signal'],
  rei_hours: ['rei'],
  phi_days: ['phi'],
  max_label_rate: ['label_rate'],
  max_label_rate_unit: ['label_rate_unit'],
  use_timing: ['timing', 'application_timing', 'use_timings'],
  rate_per_acre: ['acre_rate', 'per_acre', 'application_per_acre'],
  rate_unit: ['rate_uom'],
  suggested_rate: ['rate', 'application_rate', 'use_rate'],
  notes: ['description', 'comments', 'note'],
};

const normalizeProductImportHeader = (header: string) => header
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

export function productImportColumn(header: string): ProductImportColumn | null {
  const h = normalizeProductImportHeader(header);
  return PRODUCT_IMPORT_COLUMNS.find((c) => c === h || COLUMN_ALIASES[c].includes(h)) ?? null;
}

/**
 * Product import is deliberately non-pricing. Reject recognizable pricing
 * columns instead of silently ignoring them, so an old template cannot appear
 * to have updated money when it did not.
 */
export function isRetiredPricingColumn(header: string): boolean {
  const normalized = normalizeProductImportHeader(header);
  if (
    [
      'cost', 'current_cost', 'current_cost_cents', 'unit_cost', 'unit_cost_cents',
      'base_cost', 'base_cost_cents', 'supplier_cost', 'supplier_cost_cents',
      'price', 'price_cents', 'retail_price', 'retail_price_cents',
      'selling_price', 'selling_price_cents', 'list_price', 'list_price_cents',
      'price_per_acre', 'margin', 'margin_percent', 'margin_pct', 'gross_margin',
      'gross_profit', 'markup', 'markup_percent', 'markup_pct', 'pricing_version',
    ].includes(normalized)
  ) {
    return true;
  }

  return /^(?:tier_?[123]|t[123])_(?:price|price_cents|margin|margin_percent|margin_pct|gross_margin|gross_profit|markup|price_per_acre)$/.test(normalized)
    || /^(?:price|margin)_(?:tier_?)?[123]$/.test(normalized);
}

/**
 * RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks. A leading BOM is dropped; an unclosed
 * quote throws. Each record keeps the file line it starts on, so a multi-line note does not shift row numbers.
 */
export function parseCsvRecords(text: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else {
        if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line += 1;
        cell += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push({ cells: row, line: start }); row = []; cell = '';
      line += 1;
      start = line;
    } else cell += ch;
  }
  // An unclosed quote would swallow every later line into one cell, dropping those rows unseen.
  if (quoted) throw new Error('A quoted value is never closed (a " is missing). Fix the file and try again.');
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push({ cells: row, line: start }); }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: readonly (readonly string[])[]) => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
export const PRODUCT_IMPORT_TEMPLATE = toCsv([PRODUCT_IMPORT_COLUMNS]);

export interface ColumnMapping {
  byIndex: Record<number, ProductImportColumn>;
  ignored: string[];
  conflicts: string[];
  /** Old headers that could mean two columns; the file is refused until they are renamed. */
  ambiguous: string[];
}

const AMBIGUOUS_HEADERS: Record<string, string> = {
  unit: 'unit_size or rate_unit',
  type: 'category, product_form or container_type',
};

export function mapProductImportHeaders(headers: readonly string[]): ColumnMapping {
  const byIndex: Record<number, ProductImportColumn> = {};
  const seen = new Map<ProductImportColumn, string>();
  const ignored: string[] = [];
  const conflicts: string[] = [];
  const ambiguous: string[] = [];
  headers.forEach((header, i) => {
    const meaning = AMBIGUOUS_HEADERS[normalizeProductImportHeader(header)];
    if (meaning) { ambiguous.push(`"${header.trim()}" (rename it to ${meaning})`); return; }
    const col = productImportColumn(header);
    if (!col) { if (header.trim()) ignored.push(header.trim()); return; }
    const prior = seen.get(col);
    if (prior) conflicts.push(`"${prior}" and "${header.trim()}" both mean ${col}`);
    seen.set(col, header.trim());
    byIndex[i] = col;
  });
  return { byIndex, ignored, conflicts, ambiguous };
}

/** What insert mode of apply_product_setup takes (20261107090000). */
export interface ProductImportInsert {
  product_name: string;
  sku?: string; category?: string; product_form?: string; inventory_unit?: string; unit_size?: string;
  container_size?: string; container_unit?: string; container_type?: string; vendor?: string; manufacturer?: string;
  epa_registration?: string; is_rup?: boolean; signal_word?: string; rei_hours?: number; phi_days?: number;
  max_label_rate?: string; max_label_rate_unit?: string; use_timing?: string; notes?: string;
}
export interface ProductImportRates { rate_per_acre: string | null; rate_unit: string | null; suggested_rate: string | null }
export interface ProductImportRow {
  row: number;
  insert: ProductImportInsert;
  rates?: ProductImportRates;
  /** Value fixes made before saving, shown in the preview ("jug" -> "Jug"). */
  fixes: string[];
  error?: string;
}

const CONTAINER_TYPES: readonly ContainerType[] = ['Jug', 'Drum', 'Pallet', 'Mini-Bulk', 'Shuttle', 'Bag', 'Tote', 'Ea', 'Jar'];
const SIGNAL_WORDS = ['Danger', 'Warning', 'Caution'];
const FORMS = ['liquid', 'dry', 'seed', 'each'];
const DECIMAL = /^[0-9]{1,12}(\.[0-9]{1,6})?$/;

function canonical(value: string, allowed: readonly string[]): string {
  return allowed.find((a) => a.toLowerCase() === value.toLowerCase()) ?? value;
}

/**
 * One CSV row to an insert-mode row. Only spelling is fixed here (case, spaces, yes/no); every rule is
 * the database's, which the preview runs row by row.
 */
export function buildProductImportRow(
  cells: readonly string[], mapping: ColumnMapping, row: number, categories: readonly string[],
): ProductImportRow {
  const raw: RawImportRow = {};
  Object.entries(mapping.byIndex).forEach(([i, col]) => {
    const v = (cells[Number(i)] ?? '').trim();
    if (v) raw[col] = v;
  });
  const fixes: string[] = [];
  const fix = (col: ProductImportColumn, allowed: readonly string[]) => {
    const v = raw[col];
    if (v === undefined) return undefined;
    const c = canonical(v, allowed);
    if (c !== v) fixes.push(`${col}: "${v}" → "${c}"`);
    return c;
  };
  const insert: ProductImportInsert = { product_name: raw.product_name ?? '' };
  for (const col of ['sku', 'inventory_unit', 'unit_size', 'container_unit', 'vendor', 'manufacturer', 'epa_registration',
    'max_label_rate_unit', 'use_timing', 'notes'] as const) {
    if (raw[col] !== undefined) insert[col] = raw[col];
  }
  // A note keeps its own line breaks and spacing.
  const notesCell = Object.entries(mapping.byIndex).find(([, c]) => c === 'notes');
  if (notesCell && cells[Number(notesCell[0])]?.trim()) insert.notes = cells[Number(notesCell[0])];
  insert.category = fix('category', categories);
  insert.product_form = fix('product_form', FORMS);
  insert.container_type = fix('container_type', CONTAINER_TYPES);
  insert.signal_word = fix('signal_word', SIGNAL_WORDS);
  for (const k of Object.keys(insert) as (keyof ProductImportInsert)[]) if (insert[k] === undefined) delete insert[k];

  // Every parser runs, so a valid field is kept even on a refused row; the first refusal is reported.
  const numberError = parseImportNumbers(raw, insert);
  const rupError = parseImportRup(raw.is_rup, insert);
  const error = (insert.product_name ? undefined : 'Missing product name.') ?? numberError ?? rupError;
  const { rates, error: rateError } = importRates(raw, insert.product_form);
  const firstError = error ?? rateError;
  return { row, insert, ...(rates ? { rates } : {}), fixes, ...(firstError ? { error: firstError } : {}) };
}

type RawImportRow = Partial<Record<ProductImportColumn, string>>;

/** Copies the numeric setup fields onto the insert; returns the first refusal. */
function parseImportNumbers(raw: RawImportRow, insert: ProductImportInsert): string | undefined {
  let error: string | undefined;
  if (raw.container_size !== undefined) {
    if (!DECIMAL.test(raw.container_size) || Number(raw.container_size) <= 0) error ??= 'Container size must be a number greater than 0.';
    else insert.container_size = raw.container_size;
  }
  if (raw.max_label_rate !== undefined) {
    if (!DECIMAL.test(raw.max_label_rate)) error ??= 'Max label rate must be a number of 0 or more.';
    else insert.max_label_rate = raw.max_label_rate;
  }
  for (const col of ['rei_hours', 'phi_days'] as const) {
    const v = raw[col];
    if (v === undefined) continue;
    if (!/^[0-9]{1,9}$/.test(v)) error ??= `${col === 'rei_hours' ? 'REI hours' : 'PHI days'} must be a whole number.`;
    else insert[col] = Number(v);
  }
  return error;
}

function parseImportRup(value: string | undefined, insert: ProductImportInsert): string | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(v)) insert.is_rup = true;
  else if (['no', 'n', 'false', '0'].includes(v)) insert.is_rup = false;
  else return 'RUP must be yes or no.';
  return undefined;
}

function importRates(raw: RawImportRow, productForm: string | undefined): { rates?: ProductImportRates; error?: string } {
  // A seed or each product's rate unit is its stock unit, so a unit alone there is not a rate.
  const seedOrEach = ['seed', 'each'].includes(productForm ?? '');
  if (raw.rate_per_acre === undefined && raw.suggested_rate === undefined && (raw.rate_unit === undefined || seedOrEach)) return {};
  const rates = { rate_per_acre: raw.rate_per_acre ?? null, rate_unit: raw.rate_unit ?? null, suggested_rate: raw.suggested_rate ?? null };
  if (raw.rate_per_acre !== undefined && !DECIMAL.test(raw.rate_per_acre)) {
    return { rates, error: 'Rate per acre must be a number of 0 or more, with at most 6 decimals.' };
  }
  return { rates };
}

/** A refusal from the preview or save, without its code token and the product name it repeats. */
export function importRefusalReason(error: string, productName: string): string {
  let text = error.trim();
  for (;;) {
    const next = text.replace(/^[A-Z][A-Z0-9_]+:\s*/, '');
    const unnamed = productName && next.startsWith(`${productName}: `) ? next.slice(productName.length + 2) : next;
    if (unnamed === text) break;
    text = unnamed;
  }
  // A table check reads as the product page words it; the EPA check's own text is just "EPA number".
  if (/constraint "/.test(text)) return sanitizeError(text);
  if (text === 'EPA number') return 'Enter a valid EPA number, like 524-475 or 100-1234-5905';
  if (productName && text.endsWith(`: ${productName}`)) text = text.slice(0, -productName.length - 2);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
