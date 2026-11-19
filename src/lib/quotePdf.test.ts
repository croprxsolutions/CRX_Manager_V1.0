/**
 * quotePdf.test.ts — Tests for quote PDF generation
 * Uses the same jsPDF/autoTable mock pattern as pdfGeneration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock jsPDF doc instance ─────────────────────────────────────────────

// Pages are tracked so page breaks, page numbers and per-page drawing can be checked.
const pages = { count: 1, current: 1 };
const mockDoc = {
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
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
  roundedRect: vi.fn(),
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

// A small autoTable stand-in that breaks pages the way the real one does: 18 pt rows,
// head repeated on each new page unless showHead says otherwise (the library default is 'everyPage').
const tableHeadPages: number[][] = [];
vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc: typeof mockDoc, opts: Record<string, unknown>) => {
    const margin = (opts.margin ?? {}) as { top?: number; bottom?: number };
    const bottom = 792 - (margin.bottom ?? 40);
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
  }),
}));

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

// The Settings read: built-in company details unless a test supplies saved ones.
const companyInfo = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./companyInfoForPdf', () => ({ loadCompanyInfoForPdf: companyInfo.load }));

import { DEFAULT_COMPANY_INFO } from './companyInfo';
import { generateQuotePdf, downloadQuotePdf } from './quotePdf';

companyInfo.load.mockResolvedValue(DEFAULT_COMPANY_INFO);

// ── Test Data ───────────────────────────────────────────────────────────

function makeQuoteData(overrides: Record<string, unknown> = {}) {
  return {
    quote_number: 'Q-2026-001',
    customer_name: 'Smith Farm',
    customer_email: 'smith@test.com',
    customer_phone: '555-1234',
    customer_address: '123 Farm Rd',
    sales_rep_name: 'Mason Wells',
    created_at: '2026-03-01',
    expires_at: '2026-04-01',
    tier: 1,
    header_notes: 'Spring application package',
    footer_notes: 'Prices valid for 30 days',
    sections: [
      {
        section_name: 'Corn Pre-Emerge',
        section_notes: 'Apply early March',
        items: [
          {
            product_name: 'Atrazine 4L',
            actual_rate: 2,
            rate_unit: 'QT',
            acres: 100,
            total_units_needed: 6.25,
            inventory_unit: 'Gallon',
            price_per_unit: 18.5,
            total_price: 115.63,
          },
        ],
      },
    ],
    totals: {
      totalPrice: 115.63,
      totalCost: 80.0,
      totalProfit: 35.63,
      avgMargin: 30.81,
    },
    ...overrides,
  };
}

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

/** The fixture's one line repeated, enough to run onto a second page. */
function makeLongQuoteData(lines: number) {
  const base = makeQuoteData();
  return makeQuoteData({ sections: [{ ...base.sections[0], items: Array.from({ length: lines }, () => base.sections[0].items[0]) }] });
}

const ALL_COLUMNS = ['product', 'category', 'notes', 'sug_rate', 'actual_rate', 'rate_unit', 'acres', 'qty', 'unit_size', 'price_unit', 'price_per_acre', 'total_price'];

/** Every string the PDF drew: text calls plus the table head and body cells. */
async function allPrintedStrings() {
  const autoTable = (await import('jspdf-autotable')).default as unknown as ReturnType<typeof vi.fn>;
  const cell = (c: unknown) => (c && typeof c === 'object' && 'content' in c ? (c as { content: unknown }).content : c);
  const tableStrings = autoTable.mock.calls.flatMap((call) => {
    const opts = call[1] as { head: unknown[][]; body: unknown[][] };
    return [...opts.head.flat(), ...opts.body.flat()].map(cell);
  });
  return [...drawnText.map((d) => d.text).flat(), ...tableStrings].map(String);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('generateQuotePdf', () => {
  beforeEach(resetDoc);

  it('returns a jsPDF document', async () => {
    const doc = await generateQuotePdf(makeQuoteData());
    expect(doc).toBe(mockDoc);
  });

  it('renders the company header', async () => {
    await generateQuotePdf(makeQuoteData());
    // The company block prints the name as saved in Settings (no longer upper-cased).
    expect(mockDoc.text).toHaveBeenCalledWith(
      'Crop RX Solutions',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('prints the company details saved in Settings', async () => {
    companyInfo.load.mockResolvedValueOnce({
      name: 'Test Ag Co', phone: '555-0199', email: 'office@testag.test', address: '1 Main St, Town, IL',
    });
    await generateQuotePdf(makeQuoteData());
    const printed = mockDoc.text.mock.calls.map((c) => c[0]).flat();
    // Company block: name as saved, then the tagline, address and phone on their own lines.
    expect(printed).toContain('Test Ag Co');
    for (const line of ['Agricultural Input Solutions', '1 Main St, Town, IL', '555-0199']) expect(printed).toContain(line);
    expect(printed.some((t) => typeof t === 'string' && t.includes('office@testag.test'))).toBe(true);
    expect(printed).not.toContain('Crop RX Solutions');
  });

  it('never prints the price tier on the customer quote', async () => {
    await generateQuotePdf(makeQuoteData({ tier: 2 }));
    expect(JSON.stringify(mockDoc.text.mock.calls)).not.toMatch(/tier/i);
  });

  it('renders the quote number', async () => {
    await generateQuotePdf(makeQuoteData());
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasQuoteNum = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Q-2026-001')
    );
    expect(hasQuoteNum).toBe(true);
  });

  it('renders customer name', async () => {
    await generateQuotePdf(makeQuoteData());
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasCustomer = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Smith Farm')
    );
    expect(hasCustomer).toBe(true);
  });

  it('handles empty sections', async () => {
    const doc = await generateQuotePdf(makeQuoteData({ sections: [] }));
    expect(doc).toBe(mockDoc);
  });

  it('handles missing optional fields', async () => {
    const doc = await generateQuotePdf(makeQuoteData({
      customer_email: undefined,
      customer_phone: undefined,
      customer_address: undefined,
      header_notes: undefined,
      footer_notes: undefined,
      expires_at: undefined,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles multiple sections', async () => {
    const data = makeQuoteData({
      sections: [
        {
          section_name: 'Section 1',
          items: [{
            product_name: 'Product A',
            actual_rate: 1, rate_unit: 'QT', acres: 50,
            total_units_needed: 3, price_per_unit: 10, total_price: 30,
          }],
        },
        {
          section_name: 'Section 2',
          items: [{
            product_name: 'Product B',
            actual_rate: 2, rate_unit: 'GL', acres: 100,
            total_units_needed: 2, price_per_unit: 25, total_price: 50,
          }],
        },
      ],
    });
    const doc = await generateQuotePdf(data);
    expect(doc).toBe(mockDoc);
  });

  it('wraps a long section note onto its own lines and a new page, never into the footer', async () => {
    const noteLines = Array.from({ length: 60 }, (_, i) => `note line ${i}`);
    mockDoc.splitTextToSize.mockImplementation((text: string) =>
      text === 'LONG NOTE' ? noteLines : [text]);
    try {
      await generateQuotePdf(makeQuoteData({
        sections: [{ ...makeQuoteData().sections[0], section_notes: 'LONG NOTE' }],
      }));
    } finally {
      mockDoc.splitTextToSize.mockImplementation((text: string) => [text]);
    }

    const drawn = mockDoc.text.mock.calls.filter((c) => noteLines.includes(c[0] as string));
    expect(drawn.map((c) => c[0])).toEqual(noteLines);
    expect(drawn.every((c) => (c[2] as number) < 792 - 50)).toBe(true);
    expect(mockDoc.addPage).toHaveBeenCalled();
    // Lines go down the page, restarting near the top only after the page break
    const ys = drawn.map((c) => c[2] as number);
    expect(ys.filter((y, i) => i > 0 && y < ys[i - 1])).toHaveLength(1);
  });

  it('spaces section header note lines a full line apart and starts the table below them', async () => {
    const autoTable = (await import('jspdf-autotable')).default as unknown as ReturnType<typeof vi.fn>;
    mockDoc.splitTextToSize.mockImplementation((text: string) =>
      text === 'LONG HDR' ? ['hdr 1', 'hdr 2', 'hdr 3'] : [text]);
    try {
      await generateQuotePdf(makeQuoteData({
        sections: [{ ...makeQuoteData().sections[0], section_header_notes: 'LONG HDR' }],
      }));
    } finally {
      mockDoc.splitTextToSize.mockImplementation((text: string) => [text]);
    }
    const ys = mockDoc.text.mock.calls.filter((c) => String(c[0]).startsWith('hdr ')).map((c) => c[2] as number);
    expect(ys).toHaveLength(3);
    expect([ys[1] - ys[0], ys[2] - ys[1]]).toEqual([11, 11]);
    expect(autoTable.mock.calls[0][1].startY).toBeGreaterThan(ys[2]);
  });

  describe('header wrapping and totals', () => {
    // Wraps on spaces and, for an unbroken word, by character, at 4 pt per character.
    const wrap = (text: string, width: number) => {
      const max = Math.max(1, Math.floor(width / 4));
      const lines: string[] = [];
      let line = '';
      for (const word of text.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (next.length <= max) { line = next; continue; }
        if (line) lines.push(line);
        line = word;
        while (line.length > max) { lines.push(line.slice(0, max)); line = line.slice(max); }
      }
      return [...lines, line];
    };

    it('wraps a long company name and a long rep name inside their columns', async () => {
      const companyName = 'Northern Plains Agricultural Inputs and Crop Service Company';
      expect(companyName).toHaveLength(60);
      const repName = 'Alexandria Montgomery-Featherstonehaugh III';
      companyInfo.load.mockResolvedValueOnce({ ...DEFAULT_COMPANY_INFO, name: companyName });
      mockDoc.splitTextToSize.mockImplementation(wrap as never);
      mockDoc.getTextWidth.mockImplementation(((t: string) => t.length * 4) as never);
      const calls: { text: string; x: number }[] = [];
      mockDoc.text.mockImplementation(((text: unknown, x: number) => {
        calls.push(...[text].flat().map((t) => ({ text: String(t), x })));
      }) as never);
      await generateQuotePdf(makeQuoteData({ sales_rep_name: repName.slice(0, 40) }));

      const pageW = 612;
      const margin = 42;
      const colW = (pageW - margin * 2 - 32) / 3;
      const logoRight = pageW / 2 + 142.5 / 2;
      const nameLines = calls.filter((c) => c.x === margin && companyName.includes(c.text) && c.text.length > 1);
      expect(nameLines.length).toBeGreaterThan(1);
      expect(nameLines.map((c) => c.text).join(' ').replace(/\s+/g, ' ')).toBe(companyName);
      for (const c of nameLines) expect(c.x + c.text.length * 4).toBeLessThanOrEqual(margin + colW);

      const repLines = calls.filter((c) => repName.slice(0, 40).includes(c.text) && c.text.length > 1);
      expect(repLines.length).toBeGreaterThan(1);
      for (const c of repLines) {
        expect(c.x).toBeGreaterThan(logoRight);
        expect(c.x + c.text.length * 4).toBeLessThanOrEqual(pageW - margin);
      }
      mockDoc.splitTextToSize.mockImplementation(((t: string) => [t]) as never);
      mockDoc.getTextWidth.mockImplementation((() => 50) as never);
    });

    it('prints section rows that add up, in cents, to the printed quote total', async () => {
      const item = (total_price: number) => ({ ...makeQuoteData().sections[0].items[0], total_price });
      const fixtures = [
        makeQuoteData(),
        makeQuoteData({
          sections: [
            { section_name: 'North', section_notes: '', items: [item(33.33), item(33.33), item(33.34)] },
            { section_name: 'South', section_notes: '', items: [item(0.1), item(0.2)] },
          ],
          totals: { totalPrice: 100.3, totalCost: 0, totalProfit: 0, avgMargin: 0 },
        }),
      ];
      const cents = (money: string) => Math.round(Number(money.replace(/[$,]/g, '')) * 100);
      for (const data of fixtures) {
        resetDoc();
        await generateQuotePdf(data);
        const amounts = drawnText.map((d) => d.text).filter((t): t is string => typeof t === 'string' && /^\$[\d,]+\.\d\d$/.test(t));
        const total = amounts[amounts.length - 1];
        const rows = amounts.slice(0, -1);
        expect(rows).toHaveLength(data.sections.length);
        expect(rows.reduce((sum, a) => sum + cents(a), 0)).toBe(cents(total));
      }
    });

    it('keeps every totals row and the quote total above the footer when the totals are taller than a page', async () => {
      const line = makeQuoteData().sections[0].items[0];
      const sections = Array.from({ length: 60 }, (_, i) => ({ section_name: `Block ${i + 1}`, section_notes: '', items: [line] }));
      await generateQuotePdf(makeQuoteData({ sections, footer_notes: '' }));
      const pageBottom = 792 - 66;
      const totals = drawnText.filter((d) => (Array.isArray(d.text) && String(d.text[0]).startsWith('Block ')) || d.text === 'Quote total');
      expect(totals).toHaveLength(61);
      for (const d of totals) expect(d.y).toBeLessThanOrEqual(pageBottom);
      // The totals run over more than one page, in order, ending with the quote total.
      expect(new Set(totals.map((d) => d.page)).size).toBeGreaterThan(1);
      expect(totals[totals.length - 1].text).toBe('Quote total');
    });
  });

  describe('layout', () => {
    it('still prints every money string the old PDF printed, unchanged', async () => {
      const base = makeQuoteData();
      await generateQuotePdf(makeQuoteData({
        sections: [{ ...base.sections[0], items: [{ ...base.sections[0].items[0], price_per_acre: 1.1563, unit_size: '2.5 gal', category: 'Herbicide', suggested_rate: '1-2 QT', notes: 'Pre-plant' }] }],
      }), ALL_COLUMNS);
      const printed = await allPrintedStrings();
      // Price/Unit, $/Acre, line Total and the quote total, formatted exactly as before.
      for (const money of ['$18.50/Gallon', '$1.16', '$115.63']) expect(printed).toContain(money);
      // Same column labels and non-money cells as before.
      for (const label of ['Product', 'Category', 'Notes', 'Sug. Rate', 'Rate', 'Unit', 'Acres', 'Qty', 'Container', 'Price/Unit', '$/Acre', 'Total']) {
        expect(printed).toContain(label);
      }
      for (const value of ['Atrazine 4L', 'Herbicide', 'Pre-plant', '1-2 QT', '2 QT', 'QT', '100', '6.25 Gallon', '2.5 gal']) {
        expect(printed).toContain(value);
      }
      // The quote total is still the totals the caller passed, not a recount.
      await generateQuotePdf(makeQuoteData({ totals: { ...base.totals, totalPrice: 999.99 } }));
      expect(await allPrintedStrings()).toContain('$999.99');
    });

    it('adds the logo image once on every page', async () => {
      await generateQuotePdf(makeQuoteData());
      expect(mockDoc.addImage).toHaveBeenCalledTimes(1);

      resetDoc();
      await generateQuotePdf(makeLongQuoteData(40));
      expect(pages.count).toBe(2);
      expect(mockDoc.addImage).toHaveBeenCalledTimes(2);
    });

    it('prints the billing address in the Prepared for block when given', async () => {
      await generateQuotePdf(makeQuoteData());
      const label = drawnText.find((d) => d.text === 'PREPARED FOR');
      const address = drawnText.find((d) => d.text === '123 Farm Rd');
      expect(label).toBeDefined();
      expect(address).toBeDefined();
      expect(address!.y).toBeGreaterThan(label!.y);

      resetDoc();
      await generateQuotePdf(makeQuoteData({ customer_address: undefined }));
      expect(drawnText.some((d) => d.text === '123 Farm Rd')).toBe(false);
    });

    it('numbers the pages and repeats the table headers on page 2 of a 40-line quote', async () => {
      await generateQuotePdf(makeLongQuoteData(40));
      expect(textOnPage(1)).toContain('Page 1 of 2');
      expect(textOnPage(2)).toContain('Page 2 of 2');
      expect(tableHeadPages[0]).toEqual([1, 2]);
    });

    it('prints the bottom note after the totals', async () => {
      await generateQuotePdf(makeQuoteData());
      const total = drawnText.findIndex((d) => d.text === 'Quote total');
      const note = drawnText.findIndex((d) => d.text === 'Prices valid for 30 days');
      expect(total).toBeGreaterThanOrEqual(0);
      expect(note).toBeGreaterThan(total);
      expect(drawnText[note].page > drawnText[total].page || drawnText[note].y > drawnText[total].y).toBe(true);
    });

    it('keeps the company name, website and email in the footer of every page', async () => {
      companyInfo.load.mockResolvedValueOnce({
        name: 'Test Ag Co', phone: '555-0199', email: 'office@testag.test', address: '1 Main St, Town, IL',
      });
      await generateQuotePdf(makeLongQuoteData(40));
      // The footer joins its parts with '  •  ', so the website is a whole word; an exact word match also keeps
      // CodeQL's URL-substring rule (js/incomplete-url-substring-sanitization) quiet on this test.
      const site = 'www.croprxsolutions.com';
      for (const page of [1, 2]) {
        const footer = textOnPage(page).filter((t) => typeof t === 'string' && t.split(/\s+/).some((w) => w === site)).join(' ');
        expect(footer).toContain('Test Ag Co');
        expect(footer).toContain('office@testag.test');
        expect(footer).toContain('Prices valid for the period shown above. Subject to product availability.');
      }
    });
  });
});

describe('downloadQuotePdf', () => {
  beforeEach(resetDoc);

  it('calls doc.save with the quote number', async () => {
    await downloadQuotePdf(makeQuoteData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('Q-2026-001');
  });
});
