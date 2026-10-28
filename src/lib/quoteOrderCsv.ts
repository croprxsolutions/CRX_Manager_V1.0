export class QuoteOrderCsvError extends Error {}

function decimalIdentity(text: string): string {
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/, '');
  const significant = digits.replace(/0+$/, '');
  if (!significant) return '0';
  const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return `${mantissa.startsWith('-') ? '-' : ''}${significant}e${scale}`;
}

/** Refuse nondecimal syntax, overflow, underflow, and loss of decimal digits in Number conversion. */
export function parseQuoteOrderCsvNumber(text: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return NaN;
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return NaN;
  return decimalIdentity(text) === decimalIdentity(String(value)) ? value : NaN;
}

function readQuotedCharacter(source: string, index: number) {
  const char = source[index];
  if (char === '"') {
    const escaped = source[index + 1] === '"';
    return { value: escaped ? '"' : '', index: index + Number(escaped), closed: !escaped, lines: 0 };
  }
  const crlf = char === '\r' && source[index + 1] === '\n';
  return {
    value: crlf ? '\r\n' : char,
    index: index + Number(crlf),
    closed: false,
    lines: Number(char === '\r' || char === '\n'),
  };
}

/** CSV records, including Excel's doubled quotes and line breaks inside quoted cells. */
export function parseQuoteOrderCsv(text: string): {
  headers: string[];
  rows: string[][];
  rowNumbers: number[];
} {
  const records: string[][] = [];
  const recordLines: number[] = [];
  let cells: string[] = [];
  let cell = '';
  let state: 'plain' | 'quoted' | 'closed' = 'plain';
  let line = 1;
  let recordLine = 1;
  const source = text.replace(/^\uFEFF/, '');

  const fail = (reason: string): never => {
    throw new QuoteOrderCsvError(`CSV line ${line}: ${reason} Correct the file and parse it again.`);
  };
  const finishCell = () => {
    cells.push(cell.trim());
    cell = '';
    state = 'plain';
  };
  const finishRecord = () => {
    finishCell();
    if (cells.some((value) => value !== '')) {
      records.push(cells);
      recordLines.push(recordLine);
    }
    cells = [];
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const newline = char === '\r' || char === '\n';
    const crlf = char === '\r' && source[index + 1] === '\n';
    if (state === 'quoted') {
      const quoted = readQuotedCharacter(source, index);
      cell += quoted.value;
      index = quoted.index;
      line += quoted.lines;
      if (quoted.closed) state = 'closed';
      continue;
    }

    if (char === ',') {
      finishCell();
    } else if (newline) {
      finishRecord();
      if (crlf) index++;
      line++;
      recordLine = line;
    } else if (state === 'closed') {
      if (char !== ' ' && char !== '\t') fail('Unexpected text after a closing quote.');
    } else if (char === '"') {
      if (cell.trim()) fail('A quoted field must start with a double quote; escape quotes inside it as "".');
      cell = '';
      state = 'quoted';
    } else {
      cell += char;
    }
  }
  if (state === 'quoted') fail(`Unclosed quoted field starting on line ${recordLine}.`);
  finishRecord();

  const [headers = [], ...rows] = records;
  const rowNumbers = recordLines.slice(1);
  rows.forEach((row, index) => {
    if (row.length !== headers.length) {
      throw new QuoteOrderCsvError(
        `CSV line ${rowNumbers[index]}: Expected ${headers.length} columns but found ${row.length}. `
        + 'Put fields containing commas inside double quotes, and check for missing or extra cells. Correct the file and parse it again.'
      );
    }
  });
  return { headers, rows, rowNumbers };
}
