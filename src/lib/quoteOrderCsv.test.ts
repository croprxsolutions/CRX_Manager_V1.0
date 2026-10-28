import { describe, expect, it } from 'vitest';
import { parseQuoteOrderCsv, parseQuoteOrderCsvNumber } from './quoteOrderCsv';

describe('CSV decimal numbers', () => {
  it.each([
    ['0', 0], ['-0', 0], ['+2', 2], ['02.5000', 2.5], ['.5', 0.5], ['2.', 2],
    ['2e2', 200], ['1.25e-2', 0.0125], ['1e-3', 0.001], ['0.105', 0.105],
  ])('keeps supported decimal %s', (text, expected) => {
    expect(parseQuoteOrderCsvNumber(text) === expected).toBe(true);
  });
  it.each(['', 'NaN', 'Infinity', '-Infinity', '1e309', '1e-999', '9007199254740993',
    '1.0000000000000001', '0.10000000000000001', '0x10', '0b10', '0o10', '1,200', '$20', '2 units'])('rejects ambiguous or lossy %s', (text) => {
    expect(parseQuoteOrderCsvNumber(text)).toBeNaN();
  });
});

describe('quote and order CSV records', () => {
  it('keeps empty quoted cells and whitespace after a closing quote', () => {
    expect(parseQuoteOrderCsv('a,b\n"",x\n"a" ,b').rows).toEqual([['', 'x'], ['a', 'b']]);
  });
  it('identifies both the current and starting lines for a multiline unclosed quote', () => {
    expect(() => parseQuoteOrderCsv('a,b\nx,"first\nsecond')).toThrow('CSV line 3: Unclosed quoted field starting on line 2');
  });
  it.each(['\n', '\r\n', '\r'])('handles quoted cells and %j line endings', (eol) => {
    const parsed = parseQuoteOrderCsv([
      '\uFEFF"customer",product,quantity,price,notes',
      '"Wells, ""Family"" Farms","Mix, A",2,12.50,"First'+eol+'second"',
      '',
      "O'Brien Farm,Plain,3,0,",
    ].join(eol));
    expect(parsed.headers).toEqual(['customer', 'product', 'quantity', 'price', 'notes']);
    expect(parsed.rows).toEqual([
      ['Wells, "Family" Farms', 'Mix, A', '2', '12.50', `First${eol}second`],
      ["O'Brien Farm", 'Plain', '3', '0', ''],
    ]);
    expect(parsed.rowNumbers).toEqual([2, 5]);
  });

  it('keeps whitespace trimming and trailing empty cells', () => {
    expect(parseQuoteOrderCsv('a,b,c\n x , " y, z " ,\n').rows).toEqual([['x', 'y, z', '']]);
  });

  it.each([
    ['a,b\n"open,b', 'Unclosed quoted field'],
    ['a,b\n"closed"text,b', 'Unexpected text after a closing quote'],
    ['a,b\na"b,c', 'A quoted field must start'],
    ['a,b\nx,y,z', 'Expected 2 columns but found 3'],
    ['a,b\nx', 'Expected 2 columns but found 1'],
  ])('rejects malformed input with a line and correction: %j', (csv, reason) => {
    expect(() => parseQuoteOrderCsv(csv)).toThrow(`CSV line 2: ${reason}`);
    expect(() => parseQuoteOrderCsv(csv)).toThrow('Correct the file and parse it again.');
  });

  it('reports physical source lines after blank or multiline records', () => {
    expect(() => parseQuoteOrderCsv('a,b\n\n"line\nbreak",ok\nbad,row,extra')).toThrow('CSV line 5');
  });

  it('does not silently drop a row with an empty first field', () => {
    expect(parseQuoteOrderCsv('a,b\n,value').rows).toEqual([['', 'value']]);
  });
});
