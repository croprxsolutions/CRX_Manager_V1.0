import type { Workbook, Worksheet } from 'exceljs';
import type { BrandDocumentLink } from '../types';
import {
  checkedDocumentUrl, type BrandDocumentChange, type BrandDocumentTarget, type BrandDocumentWorkspaceRow,
} from './brandDocuments';
import { cellValueToText, isFormulaValue, PricingWorkbookFormatError } from './productPricingWorkbook';

const SHEET = 'Brand Links';
const MAX_BRAND_LINK_ROWS = 10_000;
const VISIBLE_HEADERS = ['Product or group', 'Brand', 'Specimen label link', 'SDS link',
  'Supplemental link', 'State', 'Expires (YYYY-MM-DD)'] as const;
const HEADERS = [...VISIBLE_HEADERS, 'Download record'] as const;

type LinkState = Pick<BrandDocumentLink, 'id' | 'row_version' | 'url' | 'state_code' | 'expires_on'>;
interface DownloadRow extends BrandDocumentTarget {
  brand_name: string;
  owner_name: string;
  primary: boolean;
  specimen?: LinkState;
  sds?: LinkState;
  supplemental?: LinkState;
}

export interface BrandDocumentImport {
  target: BrandDocumentTarget;
  brandName: string;
  ownerName: string;
  changes: BrandDocumentChange[];
}

export interface ParsedBrandDocuments {
  rows: BrandDocumentImport[];
  issues: string[];
}

function rowCells(state: DownloadRow): string[] {
  return [state.owner_name, state.brand_name, state.specimen?.url ?? '', state.sds?.url ?? '',
    state.supplemental?.url ?? '', state.supplemental?.state_code ?? '', state.supplemental?.expires_on ?? '',
    JSON.stringify(state)];
}

export function assertBrandWorkbookFitsParserLimit(entries: BrandDocumentWorkspaceRow[]): void {
  const rows = entries.reduce((sum, entry) =>
    sum + 1 + entry.links.filter((link) => link.document_kind === 'supplemental').length, 0);
  if (rows > MAX_BRAND_LINK_ROWS) {
    throw new PricingWorkbookFormatError('There are too many Brand Links rows for one workbook.');
  }
}

export function addBrandDocumentSheet(workbook: Workbook, entries?: BrandDocumentWorkspaceRow[]) {
  if (!entries) return;
  assertBrandWorkbookFitsParserLimit(entries);
  const sheet = workbook.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow([...HEADERS]).font = { bold: true };
  sheet.getCell('C1').note = 'Blank link cells leave saved links as they are.';
  sheet.getCell('E1').note = 'The first row for each brand allows a new supplemental link with state and expiry.';
  for (const entry of entries) {
    const { id, parent_brand, brand_version, brand_name, owner_name, links } = entry;
    const target = { id, parent_brand, brand_version, brand_name, owner_name };
    sheet.addRow(rowCells({
      ...target, primary: true,
      specimen: links.find((link) => link.document_kind === 'specimen'),
      sds: links.find((link) => link.document_kind === 'sds'),
    }));
    for (const link of links.filter((item) => item.document_kind === 'supplemental')) {
      sheet.addRow(rowCells({ ...target, primary: false, supplemental: link }));
    }
  }
  sheet.getColumn(8).hidden = true;
  [34, 26, 52, 52, 52, 9, 25].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
}

function cell(sheet: Worksheet, row: number, col: number): string {
  const value = sheet.getCell(row, col).value;
  if (isFormulaValue(value)) throw new PricingWorkbookFormatError('Brand Links cells cannot contain formulas.');
  if (col === 7 && value instanceof Date) return value.toISOString().slice(0, 10);
  return cellValueToText(value, 'Brand Links row ' + row).trim();
}

function downloaded(sheet: Worksheet, row: number): DownloadRow {
  let raw: unknown;
  try {
    raw = JSON.parse(cell(sheet, row, 8));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The download record is missing or damaged. Download a fresh workbook.');
    throw error;
  }
  if (!raw || typeof raw !== 'object') throw new Error('Download a fresh workbook.');
  const state = raw as Partial<DownloadRow>;
  if (typeof state.id !== 'string' || typeof state.parent_brand !== 'boolean'
      || !Number.isInteger(state.brand_version) || typeof state.primary !== 'boolean'
      || state.brand_name !== cell(sheet, row, 2) || state.owner_name !== cell(sheet, row, 1)) {
    throw new Error('Brand or product details changed. Download a fresh workbook.');
  }
  for (const link of [state.specimen, state.sds, state.supplemental]) {
    if (link && (typeof link.id !== 'string' || !Number.isInteger(link.row_version) || typeof link.url !== 'string')) {
      throw new Error('Download a fresh workbook.');
    }
  }
  return state as DownloadRow;
}

function changesAt(sheet: Worksheet, row: number, saved: DownloadRow): BrandDocumentChange[] {
  const changes: BrandDocumentChange[] = [];
  for (const [kind, col] of [['specimen', 3], ['sds', 4], ['supplemental', 5]] as const) {
    const text = cell(sheet, row, col);
    if (!text) continue;
    if (kind !== 'supplemental' && !saved.primary) throw new Error('Edit specimen and SDS on the first row for this brand.');
    const prior = saved[kind];
    const state = kind === 'supplemental' ? cell(sheet, row, 6).toUpperCase() : '';
    const expiry = kind === 'supplemental' ? cell(sheet, row, 7) : '';
    if (text === prior?.url && state === (prior.state_code ?? '') && expiry === (prior.expires_on ?? '')) continue;
    if (kind === 'supplemental' && (!/^[A-Z]{2}$/.test(state) || !isCalendarDate(expiry))) {
      throw new Error('Enter the supplemental state and expiration date.');
    }
    changes.push({
      action: 'save', kind, url: checkedDocumentUrl(text),
      ...(prior ? { id: prior.id, version: prior.row_version } : {}),
      ...(kind === 'supplemental' ? { state, expires_on: expiry } : {}),
    });
  }
  return changes;
}

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function parseBrandDocumentSheet(workbook: Workbook): ParsedBrandDocuments | null {
  const sheet = workbook.getWorksheet(SHEET);
  if (!sheet) return null;
  try {
    if (sheet.rowCount > MAX_BRAND_LINK_ROWS + 1 || HEADERS.some((name, index) => cell(sheet, 1, index + 1) !== name)) {
      return { rows: [], issues: ['The Brand Links tab layout changed or has too many rows. Download a fresh workbook.'] };
    }
  } catch (error) {
    if (error instanceof PricingWorkbookFormatError) return { rows: [], issues: [error.message] };
    throw error;
  }
  const grouped = new Map<string, BrandDocumentImport>();
  const issues: string[] = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    try {
      if (VISIBLE_HEADERS.every((_, col) => !cell(sheet, index, col + 1))) continue;
      const saved = downloaded(sheet, index);
      const changes = changesAt(sheet, index, saved);
      if (changes.length === 0) continue;
      const { id, parent_brand, brand_version, brand_name, owner_name } = saved;
      const key = JSON.stringify([parent_brand, id]);
      const group = grouped.get(key) ?? {
        target: { id, parent_brand, brand_version }, brandName: brand_name, ownerName: owner_name, changes: [],
      };
      if (group.target.brand_version !== brand_version || group.brandName !== brand_name || group.ownerName !== owner_name) {
        throw new Error('This brand has inconsistent download records.');
      }
      const incoming = [...group.changes, ...changes];
      const keys = incoming.map((change) => change.action === 'save'
        ? change.id ?? (change.kind === 'supplemental' ? JSON.stringify([change.kind, change.url, change.state, change.expires_on]) : change.kind)
        : change.id);
      if (new Set(keys).size !== keys.length || incoming.length > 100) {
        throw new Error('This brand has duplicate or more than 100 changes.');
      }
      group.changes = incoming;
      grouped.set(key, group);
    } catch (error) {
      issues.push('Brand Links row ' + index + ' · ' + (error instanceof Error ? error.message : 'Invalid row'));
    }
  }
  return { rows: [...grouped.values()], issues };
}
