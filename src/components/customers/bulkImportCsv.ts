// CSV reading and acreage checks for the bulk customer import (BulkCustomerImport.tsx).

export interface ParsedCustomer {
  farm_name: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  billing_address?: string;
  assigned_tier?: number;
  total_acres?: number;
  corn_acres?: number;
  soybean_acres?: number;
  other_acres?: number;
  payment_terms?: string;
  notes?: string;
}

export type CsvRecord = { line: number; cols: string[]; quoted: boolean[] };

/** Thrown for a file the parser cannot read safely; its message is shown to the user. */
export class CsvError extends Error {}

/**
 * Split CSV text into records. A quoted value may hold commas, "" and line breaks; a record keeps the
 * file line it starts on. An unclosed quote would swallow every later row, so it refuses the file.
 */
export function parseCSVRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cols: string[] = [];
  let quoted: boolean[] = [];
  let current = '';
  let wasQuoted = false;
  let inQuotes = false;
  let line = 1;
  let start = 1;
  let quoteLine = 1;
  const endCell = () => {
    cols.push(current.trim());
    quoted.push(wasQuoted);
    current = '';
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        if (ch === '\n') line++;
        if (ch !== '\r') current += ch;
      }
    } else if (ch === '"' && current.trim() === '') {
      // Only a quote at the start of a cell opens one; a mid-cell inch mark (12" tile) is plain text.
      inQuotes = true;
      wasQuoted = true;
      quoteLine = line;
    } else if (ch === ',') {
      endCell();
    } else if (ch === '\n') {
      endCell();
      records.push({ line: start, cols, quoted });
      cols = [];
      quoted = [];
      start = ++line;
    } else {
      current += ch;
    }
  }
  if (inQuotes) throw new CsvError(`Line ${quoteLine} opens a quote that is never closed. Fix the quotes in that row and try again.`);
  endCell();
  records.push({ line: start, cols, quoted });
  return records;
}

export const ACRE_FIELDS = ['total_acres', 'corn_acres', 'soybean_acres', 'other_acres'] as const;

/** A supplied acreage as a number, or null when it is not a valid one. "1,200" is 1200 (KI-145); "1,2" is not valid. */
function parseAcres(value: string): number | null {
  const cleaned = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value) ? value.replace(/,/g, '') : value;
  // Plain decimals only: Number() would also read "0x10" as 16 or "1e3" as 1000.
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * An unquoted "1,200" that still fits the column count reads as 1 acre plus "200" in the next column.
 * Returns the joined "1,200" for that shape (so the row is refused), else ''.
 * Not checked when the next column is also acres ("500,300" is real total + corn acres) unless that
 * cell starts with 0 ("5,000": no real acreage is written "000"), or it is a total of 1-999 followed
 * by a larger crop ("1,200" = 1 + 200; Mason, 2026-11-19). A total of 0, or a crop above the total
 * in any other shape, imports with the cropAcresOverTotal warning. A split between two crop columns
 * imports with the cropSplitWarning warning.
 */
function unquotedThousands({ cols, quoted }: Pick<CsvRecord, 'cols' | 'quoted'>, idx: number, field: string, nextField: string | undefined): string {
  const next = cols[idx + 1];
  if (quoted[idx] || quoted[idx + 1] || next === undefined) return '';
  if (!/^\d{1,3}$/.test(cols[idx]) || !/^\d{3}(\.\d+)?$/.test(next)) return '';
  const total = Number(cols[idx]);
  const splitTotal = field === 'total_acres' && total > 0 && Number(next) > total;
  return (ACRE_FIELDS as readonly string[]).includes(nextField ?? '') && !next.startsWith('0') && !splitTotal ? '' : `${cols[idx]},${next}`;
}

const CROP_FIELDS: readonly string[] = ['corn_acres', 'soybean_acres', 'other_acres'];

/**
 * A crop of 1-999 followed by a larger 3-digit crop is the shape an unquoted "1,200" leaves between
 * two crop columns, but can be real, so the row imports with this warning (Mason, 2026-11-19); else ''.
 */
export function cropSplitWarning({ cols, quoted }: Pick<CsvRecord, 'cols' | 'quoted'>, idx: number, field: string, nextField: string | undefined): string {
  const next = cols[idx + 1];
  if (!CROP_FIELDS.includes(field) || !CROP_FIELDS.includes(nextField ?? '')) return '';
  if (quoted[idx] || quoted[idx + 1] || next === undefined) return '';
  if (!/^\d{1,3}$/.test(cols[idx]) || !/^\d{3}$/.test(next)) return '';
  const crop = Number(cols[idx]);
  if (crop === 0 || Number(next) <= crop) return '';
  return `Check acres: ${field.replace('_', ' ')} ${cols[idx]} and ${(nextField ?? '').replace('_', ' ')} ${next} might be one number, ${cols[idx]},${next}. Put quotes around numbers with commas, like "1,200"`;
}

/** The acreage in cell idx, or the row's error message when it is not a clear number. */
export function readAcres(record: Pick<CsvRecord, 'cols' | 'quoted'>, idx: number, field: string, nextField: string | undefined): number | string {
  const value = record.cols[idx];
  const label = field.replace('_', ' ');
  const num = parseAcres(value);
  if (num === null) return `Invalid ${label}: ${value}`;
  const split = unquotedThousands(record, idx, field, nextField);
  return split ? `Unclear ${label}: ${split} has a comma but no quotes. Put quotes around numbers with commas, like "1,200"` : num;
}

/**
 * A crop's acres above the farm's total acres: often an unquoted "1,200" split, but can be real
 * (rented ground, total left at 0), so the row imports with this warning (Mason, 2026-11-19); else ''.
 */
export function cropAcresOverTotal(customer: Partial<ParsedCustomer>): string {
  const total = customer.total_acres;
  if (total === undefined) return '';
  const crop = (['corn_acres', 'soybean_acres', 'other_acres'] as const).find((f) => (customer[f] ?? 0) > total);
  return crop ? `Unclear acres: ${crop.replace('_', ' ')} (${customer[crop]}) is more than total acres (${total}). Check the acres, or put quotes around numbers with commas, like "1,200"` : '';
}
