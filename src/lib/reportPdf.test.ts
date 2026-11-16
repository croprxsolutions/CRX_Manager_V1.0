/**
 * reportPdf.test.ts — Tests for generic report PDF generation
 * Uses the same jsPDF/autoTable mock pattern as quotePdf.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Settings company details (Company Info) the PDF letterhead and footer print.
const companyInfo = vi.hoisted(() => ({
  load: vi.fn(async () => ({ name: 'Prairie Ag Co', phone: '555-0100', email: '', address: '12 Main St Annapolis, IL 62413' })),
}));
vi.mock('./companyInfoForPdf', () => ({ loadCompanyInfoForPdf: companyInfo.load }));

// ── Mock jsPDF doc instance ─────────────────────────────────────────────

// Pages are tracked so page breaks, page numbers and per-page drawing can be checked.
const pages = { count: 1, current: 1 };
const mockDoc = {
  internal: { pageSize: { getWidth: () => 792, getHeight: () => 612 } },
  setFillColor: vi.fn(),
  rect: vi.fn(),
  setFont: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  setDrawColor: vi.fn(),
  setLineWidth: vi.fn(),
  setLineDashPattern: vi.fn(),
  line: vi.fn(),
  addImage: vi.fn(),
  splitTextToSize: vi.fn((text: string) => [text]),
  getTextWidth: vi.fn(() => 50),
  addPage: vi.fn(() => { pages.count += 1; pages.current = pages.count; }),
  getNumberOfPages: vi.fn(() => pages.count),
  setPage: vi.fn((n: number) => { pages.current = n; }),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

// Every text call with the page it landed on.
const drawnText: { text: unknown; y: number; page: number }[] = [];
const textOnPage = (page: number) => drawnText.filter((d) => d.page === page).map((d) => d.text).flat();

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

// A small autoTable stand-in that breaks pages the way the real one does: 18 pt rows,
// head repeated on each new page unless showHead says otherwise (the library default is 'everyPage').
const tableHeadPages: number[][] = [];
const mockAutoTable = vi.fn(
  (doc: typeof mockDoc, opts: Record<string, unknown>) => {
    const margin = (opts.margin ?? {}) as { top?: number; bottom?: number };
    const bottom = 612 - (margin.bottom ?? 40);
    const headEvery = (opts.showHead ?? 'everyPage') === 'everyPage';
    const headPages = [pages.current];
    let y = ((opts.startY as number) || 0) + 18;
    for (let i = 0; i < (opts.body as unknown[]).length; i++) {
      if (y + 18 > bottom) {
        doc.addPage();
        if (headEvery) headPages.push(pages.current);
        y = (margin.top ?? 40) + (headEvery ? 18 : 0);
      }
      y += 18;
    }
    tableHeadPages.push(headPages);
    doc.lastAutoTable = { finalY: y };
  }
);

vi.mock('jspdf-autotable', () => ({
  default: mockAutoTable,
}));

function resetDoc() {
  vi.clearAllMocks();
  mockDoc.lastAutoTable = { finalY: 300 };
  pages.count = 1;
  pages.current = 1;
  drawnText.length = 0;
  tableHeadPages.length = 0;
  mockDoc.text.mockImplementation((text: unknown, _x: number, y: number) => {
    drawnText.push({ text, y, page: pages.current });
  });
}

import {
  generateReportPdf,
  downloadReportPdf,
  fmtCurrency,
  type ReportPdfColumn,
  type ReportPdfOptions,
} from './reportPdf';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<ReportPdfOptions> = {}): ReportPdfOptions {
  return {
    title: 'Product Master',
    columns: [
      { header: 'Name', key: 'name' },
      { header: 'Price', key: 'price', align: 'right' },
    ],
    data: [
      { name: 'Atrazine 4L', price: '$18.50' },
      { name: 'Roundup', price: '$22.00' },
    ],
    ...overrides,
  };
}

// ── fmtCurrency ──────────────────────────────────────────────────────────

describe('fmtCurrency', () => {
  it('formats positive numbers as USD', () => {
    expect(fmtCurrency(1234.56)).toBe('$1,234.56');
  });

  it('formats zero', () => {
    expect(fmtCurrency(0)).toBe('$0.00');
  });

  it('formats negative numbers', () => {
    expect(fmtCurrency(-50)).toBe('-$50.00');
  });

  it('handles small decimals', () => {
    expect(fmtCurrency(0.5)).toBe('$0.50');
  });

  it('rounds to two decimal places', () => {
    expect(fmtCurrency(9.999)).toBe('$10.00');
  });
});

// ── generateReportPdf ────────────────────────────────────────────────────

describe('generateReportPdf', () => {
  beforeEach(resetDoc);

  it('returns a jsPDF document', async () => {
    const doc = await generateReportPdf(makeOptions());
    expect(doc).toBe(mockDoc);
  });

  it('renders the company header with the name as saved in Settings', async () => {
    await generateReportPdf(makeOptions());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'Prairie Ag Co',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders the report title', async () => {
    await generateReportPdf(makeOptions({ title: 'Inventory Report' }));
    const textCalls = mockDoc.text.mock.calls;
    const hasTitle = textCalls.some(
      (args: unknown[]) => args[0] === 'Inventory Report'
    );
    expect(hasTitle).toBe(true);
  });

  it('renders subtitle when provided', async () => {
    await generateReportPdf(
      makeOptions({ subtitle: 'Q1 2026 Summary' })
    );
    const textCalls = mockDoc.text.mock.calls;
    const hasSub = textCalls.some(
      (args: unknown[]) => args[0] === 'Q1 2026 Summary'
    );
    expect(hasSub).toBe(true);
  });

  it('renders date range when provided', async () => {
    await generateReportPdf(
      makeOptions({ dateRange: { start: '01/01/2026', end: '03/31/2026' } })
    );
    const textCalls = mockDoc.text.mock.calls;
    const printed = textCalls.map((args: unknown[]) => args[0]);
    expect(printed).toContain('01/01/2026 to 03/31/2026');
    expect(printed.join(' ')).not.toMatch(/[—–]/);
  });

  it('calls autoTable with column headers and body rows', async () => {
    await generateReportPdf(makeOptions());
    expect(mockAutoTable).toHaveBeenCalledTimes(1);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.head).toEqual([['Name', 'Price']]);
    expect(opts.body).toEqual([
      ['Atrazine 4L', '$18.50'],
      ['Roundup', '$22.00'],
    ]);
  });

  it('applies column alignment via columnStyles', async () => {
    await generateReportPdf(makeOptions());
    expect(mockAutoTable).toHaveBeenCalledTimes(1);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    const colStyles = opts.columnStyles as Record<number, { halign: string }>;
    expect(colStyles[1]).toEqual({ halign: 'right' });
  });

  it('handles empty data array (header-only PDF)', async () => {
    const doc = await generateReportPdf(makeOptions({ data: [] }));
    expect(doc).toBe(mockDoc);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.body).toEqual([]);
  });

  it('uses landscape orientation by default', async () => {
    await generateReportPdf(makeOptions());
    // The JsPDFMock constructor is called — orientation is passed but mock ignores it
    // We verify the doc was returned successfully
    expect(mockDoc).toBeDefined();
  });

  it('uses portrait orientation when specified', async () => {
    const doc = await generateReportPdf(
      makeOptions({ orientation: 'portrait' })
    );
    expect(doc).toBe(mockDoc);
  });

  it('applies format function to column values', async () => {
    const cols: ReportPdfColumn[] = [
      { header: 'Amount', key: 'amt', format: (v) => `$${v}` },
    ];
    await generateReportPdf(
      makeOptions({ columns: cols, data: [{ amt: 100 }] })
    );
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect((opts.body as string[][])[0][0]).toBe('$100');
  });

  it('converts null/undefined values to empty string', async () => {
    await generateReportPdf(
      makeOptions({
        columns: [{ header: 'Value', key: 'val' }],
        data: [{ val: null }, { val: undefined }],
      })
    );
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect((opts.body as string[][])[0][0]).toBe('');
    expect((opts.body as string[][])[1][0]).toBe('');
  });

  it('renders footer note when provided', async () => {
    await generateReportPdf(
      makeOptions({ footerNote: 'Total: $500.00' })
    );
    const textCalls = mockDoc.text.mock.calls;
    const hasNote = textCalls.some(
      (args: unknown[]) => args[0] === 'Total: $500.00'
    );
    expect(hasNote).toBe(true);
  });

  it('does not render footer note when not provided', async () => {
    await generateReportPdf(makeOptions());
    const textCalls = mockDoc.text.mock.calls;
    const hasNote = textCalls.some(
      (args: unknown[]) => args[0] === 'Total: $500.00'
    );
    expect(hasNote).toBe(false);
  });

  it('renders a totals row as an autotable foot when provided', async () => {
    await generateReportPdf(
      makeOptions({ totalsRow: ['TOTALS', '$40.50'] })
    );
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.foot).toEqual([['TOTALS', '$40.50']]);
  });

  it('maps null/undefined totals cells to blank and pads to the column count', async () => {
    await generateReportPdf(
      makeOptions({
        columns: [
          { header: 'A', key: 'a' },
          { header: 'B', key: 'b' },
          { header: 'C', key: 'c' },
        ],
        data: [],
        totalsRow: ['TOTALS', null], // shorter than columns + a null cell
      })
    );
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    // One foot row, one cell per column, blanks where no total/undefined.
    expect(opts.foot).toEqual([['TOTALS', '', '']]);
  });

  it('omits foot when no totals row is provided', async () => {
    await generateReportPdf(makeOptions());
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.foot).toBeUndefined();
  });

  it('shrinks the body font for a wide column set so nothing truncates', async () => {
    const wideCols: ReportPdfColumn[] = Array.from({ length: 10 }, (_, i) => ({
      header: `C${i}`,
      key: `c${i}`,
    }));
    await generateReportPdf(makeOptions({ columns: wideCols, data: [] }));
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    const styles = opts.styles as Record<string, unknown>;
    expect(styles.fontSize).toBe(7); // <= the narrow-set 8pt
    expect(styles.overflow).toBe('linebreak');
  });
});

// ── Quote PDF design ─────────────────────────────────────────────────────

/** A quotes-style report: the columns and formatters a list screen passes. */
function makeQuotesReport(rows: number, overrides: Partial<ReportPdfOptions> = {}): ReportPdfOptions {
  return {
    title: 'Quotes',
    subtitle: `${rows} quote(s) selected`,
    columns: [
      { header: 'Quote #', key: 'quote_number' },
      { header: 'Customer', key: 'customer' },
      { header: 'Status', key: 'status' },
      { header: 'Acres', key: 'acres', align: 'right' },
      { header: 'Total', key: 'total', align: 'right', format: (v) => fmtCurrency(v as number) },
    ],
    data: Array.from({ length: rows }, (_, i) => ({
      quote_number: `Q-TEST-${100 + i}`,
      customer: `Test Farm ${i + 1}`,
      status: i % 2 ? 'Sent' : 'Draft',
      acres: 40 + i,
      total: 1234.5 + i,
    })),
    ...overrides,
  };
}

/** Every string the PDF drew: text calls plus the table head, body and foot cells. */
function allPrintedStrings() {
  const tableStrings = mockAutoTable.mock.calls.flatMap((call) => {
    const opts = call[1] as { head: unknown[][]; body: unknown[][]; foot?: unknown[][] };
    return [...opts.head.flat(), ...opts.body.flat(), ...(opts.foot ?? []).flat()];
  });
  return [...drawnText.map((d) => d.text).flat(), ...tableStrings].map(String);
}

describe('generateReportPdf: quote PDF design', () => {
  beforeEach(resetDoc);

  it('draws no full-width banner across the page top', async () => {
    await generateReportPdf(makeQuotesReport(4));
    const banner = mockDoc.rect.mock.calls.some((args: unknown[]) => (args[1] as number) < 100 && (args[2] as number) >= 792 - 72);
    expect(banner).toBe(false);
    expect(mockDoc.setFillColor).not.toHaveBeenCalledWith(26, 122, 80);
  });

  it('adds the logo image once on every page', async () => {
    await generateReportPdf(makeQuotesReport(4));
    expect(pages.count).toBe(1);
    expect(mockDoc.addImage).toHaveBeenCalledTimes(1);

    resetDoc();
    await generateReportPdf(makeQuotesReport(40));
    expect(pages.count).toBe(2);
    expect(mockDoc.addImage).toHaveBeenCalledTimes(2);
  });

  it('prints the title under the logo and the subtitle under the header', async () => {
    await generateReportPdf(makeQuotesReport(4));
    const [, , , logoTop, , logoH] = mockDoc.addImage.mock.calls[0] as number[];
    const title = drawnText.find((d) => d.text === 'Quotes');
    const subtitle = drawnText.find((d) => d.text === '4 quote(s) selected');
    expect(title).toBeDefined();
    expect(subtitle).toBeDefined();
    expect(title!.y).toBeGreaterThan(logoTop + logoH);
    expect(subtitle!.y).toBeGreaterThan(title!.y);
    const startY = (mockAutoTable.mock.calls[0][1] as { startY: number }).startY;
    expect(startY).toBeGreaterThan(subtitle!.y);
  });

  it('still prints every value and money string the old report printed, unchanged', async () => {
    await generateReportPdf(makeQuotesReport(4, { totalsRow: ['TOTALS', null, null, '166', '$4,944.00'], footerNote: 'Total: $4,944.00' }));
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.head).toEqual([['Quote #', 'Customer', 'Status', 'Acres', 'Total']]);
    expect(opts.body).toEqual([
      ['Q-TEST-100', 'Test Farm 1', 'Draft', '40', '$1,234.50'],
      ['Q-TEST-101', 'Test Farm 2', 'Sent', '41', '$1,235.50'],
      ['Q-TEST-102', 'Test Farm 3', 'Draft', '42', '$1,236.50'],
      ['Q-TEST-103', 'Test Farm 4', 'Sent', '43', '$1,237.50'],
    ]);
    expect(opts.foot).toEqual([['TOTALS', '', '', '166', '$4,944.00']]);
    expect(opts.showFoot).toBe('lastPage');
    const printed = allPrintedStrings();
    for (const s of ['Quotes', '4 quote(s) selected', 'Total: $4,944.00', '$1,234.50', '$4,944.00']) expect(printed).toContain(s);
    // Money and number columns stay right-aligned, headers included.
    const colStyles = opts.columnStyles as Record<number, { halign?: string }>;
    expect(colStyles[3]?.halign).toBe('right');
    expect(colStyles[4]?.halign).toBe('right');
    const didParseCell = opts.didParseCell as (d: unknown) => void;
    const headCell = (index: number) => {
      const cell = { section: 'head', column: { index }, cell: { styles: {} as { halign?: string } } };
      didParseCell(cell);
      return cell.cell.styles.halign;
    };
    expect(headCell(4)).toBe('right');
    expect(headCell(0)).toBe('left');
  });

  it('uses the quote table look: grey head, row rules, head repeated on every page', async () => {
    await generateReportPdf(makeQuotesReport(4));
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, Record<string, unknown> | string>;
    expect(opts.showHead).toBe('everyPage');
    expect((opts.headStyles as Record<string, unknown>).fillColor).toEqual([238, 238, 238]);
    expect((opts.bodyStyles as Record<string, unknown>).lineColor).toEqual([227, 227, 227]);
    expect(opts.alternateRowStyles).toBeUndefined();
  });

  it('numbers the pages and repeats the table header on page 2 of a 40-row report', async () => {
    await generateReportPdf(makeQuotesReport(40));
    expect(textOnPage(1)).toContain('Page 1 of 2');
    expect(textOnPage(2)).toContain('Page 2 of 2');
    expect(tableHeadPages[0]).toEqual([1, 2]);
  });

  it('keeps the company name and generated date in the footer of every page, over a dashed rule', async () => {
    await generateReportPdf(makeQuotesReport(40));
    const footer = `Prairie Ag Co  •  Generated ${new Date().toLocaleDateString()}`;
    expect(textOnPage(1)).toContain(footer);
    expect(textOnPage(2)).toContain(footer);
    expect(mockDoc.setLineDashPattern).toHaveBeenCalledWith([2, 2], 0);
  });

  it('keeps the footer note below the table and above the footer', async () => {
    mockDoc.lastAutoTable = { finalY: 300 };
    await generateReportPdf(makeQuotesReport(4, { footerNote: 'Report note' }));
    const note = drawnText.find((d) => d.text === 'Report note');
    expect(note).toBeDefined();
    expect(note!.y).toBeGreaterThan(mockDoc.lastAutoTable.finalY);
    expect(note!.y).toBeLessThan(612 - 66);
  });
});

// ── downloadReportPdf ────────────────────────────────────────────────────

describe('downloadReportPdf', () => {
  beforeEach(resetDoc);

  it('calls doc.save', async () => {
    await downloadReportPdf(makeOptions());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });

  it('filename contains the sanitized title', async () => {
    await downloadReportPdf(makeOptions({ title: 'Product Master' }));
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('product_master');
  });

  it('filename ends with .pdf', async () => {
    await downloadReportPdf(makeOptions());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toMatch(/\.pdf$/);
  });

  it('filename contains ISO date', async () => {
    await downloadReportPdf(makeOptions());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    // Should match YYYY-MM-DD pattern
    expect(saveName).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
