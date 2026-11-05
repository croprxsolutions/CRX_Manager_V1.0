import type { ContainerType } from '../../types';

/** The import's columns, in template order. Rates are saved through set_product_rates, never the insert. */
export const PRODUCT_IMPORT_COLUMNS = [
  'product_name', 'sku', 'category', 'product_form', 'inventory_unit', 'unit_size', 'container_size', 'container_unit',
  'container_type', 'vendor', 'manufacturer', 'epa_registration', 'is_rup', 'signal_word', 'rei_hours', 'phi_days',
  'max_label_rate', 'max_label_rate_unit', 'use_timing', 'rate_per_acre', 'rate_unit', 'suggested_rate', 'notes',
] as const;
export type ProductImportColumn = typeof PRODUCT_IMPORT_COLUMNS[number];

// No ambiguous aliases: "unit" could be the pack unit or the rate unit, "type" the category or the container.
const COLUMN_ALIASES: Record<ProductImportColumn, string[]> = {
  product_name: ['product', 'name', 'productname', 'item', 'item_name'],
  sku: ['item_code', 'product_code', 'code'],
  category: ['product_type'],
  product_form: ['form', 'liquid_or_dry'],
  inventory_unit: ['inv_unit', 'stock_unit'],
  unit_size: ['uom'],
  container_size: ['size', 'package_size'],
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
  rate_per_acre: ['acre_rate', 'per_acre'],
  rate_unit: ['rate_uom'],
  suggested_rate: ['rate', 'application_rate', 'use_rate'],
  notes: ['description', 'comments', 'note'],
};

export const normalizeProductImportHeader = (header: string) => header
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

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks. A leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: readonly (readonly string[])[]) => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
export const PRODUCT_IMPORT_TEMPLATE = toCsv([PRODUCT_IMPORT_COLUMNS]);

export interface ColumnMapping {
  byIndex: Record<number, ProductImportColumn>;
  ignored: string[];
  conflicts: string[];
}

export function mapProductImportHeaders(headers: readonly string[]): ColumnMapping {
  const byIndex: Record<number, ProductImportColumn> = {};
  const seen = new Map<ProductImportColumn, string>();
  const ignored: string[] = [];
  const conflicts: string[] = [];
  headers.forEach((header, i) => {
    const col = productImportColumn(header);
    if (!col) { if (header.trim()) ignored.push(header.trim()); return; }
    const prior = seen.get(col);
    if (prior) conflicts.push(`"${prior}" and "${header.trim()}" both mean ${col}`);
    seen.set(col, header.trim());
    byIndex[i] = col;
  });
  return { byIndex, ignored, conflicts };
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
  const raw: Partial<Record<ProductImportColumn, string>> = {};
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

  let error: string | undefined;
  if (!insert.product_name) error = 'Missing product name.';
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
  if (raw.is_rup !== undefined) {
    const v = raw.is_rup.toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(v)) insert.is_rup = true;
    else if (['no', 'n', 'false', '0'].includes(v)) insert.is_rup = false;
    else error ??= 'RUP must be yes or no.';
  }
  // A seed or each product's rate unit is its stock unit, so a unit alone there is not a rate.
  const seedOrEach = ['seed', 'each'].includes(insert.product_form ?? '');
  let rates: ProductImportRates | undefined;
  if (raw.rate_per_acre !== undefined || raw.suggested_rate !== undefined || (raw.rate_unit !== undefined && !seedOrEach)) {
    if (raw.rate_per_acre !== undefined && !DECIMAL.test(raw.rate_per_acre)) {
      error ??= 'Rate per acre must be a number of 0 or more, with at most 6 decimals.';
    }
    rates = { rate_per_acre: raw.rate_per_acre ?? null, rate_unit: raw.rate_unit ?? null, suggested_rate: raw.suggested_rate ?? null };
  }
  return { row, insert, ...(rates ? { rates } : {}), fixes, ...(error ? { error } : {}) };
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
  return text.charAt(0).toUpperCase() + text.slice(1);
}
