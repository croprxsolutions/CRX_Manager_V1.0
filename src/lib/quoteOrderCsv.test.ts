import { describe, expect, it } from 'vitest';
import { parseQuoteOrderCsv } from './quoteOrderCsv';

describe('quote and order CSV records', () => {
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
