import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings company details (Company Info) the PDF letterhead and footer print.
const companyInfo = vi.hoisted(() => ({
  load: vi.fn(async () => ({ name: 'Prairie Ag Co', phone: '555-0100', email: '', address: '12 Main St Annapolis, IL 62413' })),
}));
vi.mock('./companyInfoForPdf', () => ({ loadCompanyInfoForPdf: companyInfo.load }));
import type { ApplicatorSheetData } from './applicatorSheetData';

let pageCount = 1;

const mockDoc = {
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
  setFillColor: vi.fn(),
  rect: vi.fn(),
  setFont: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  textWithLink: vi.fn(),
  setDrawColor: vi.fn(),
  line: vi.fn(),
  splitTextToSize: vi.fn((text: string) => [text]),
  getTextWidth: vi.fn((_text: string) => 50),
  getImageProperties: vi.fn(() => ({ width: 1000, height: 700 })),
  addImage: vi.fn(),
  addPage: vi.fn(() => { pageCount += 1; }),
  deletePage: vi.fn(() => { pageCount -= 1; }),
  setPage: vi.fn(),
  getNumberOfPages: vi.fn(() => pageCount),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc: Record<string, unknown>, opts: Record<string, unknown>) => {
    (doc as typeof mockDoc).lastAutoTable = { finalY: ((opts.startY as number) || 0) + 50 };
  }),
}));

import { generateApplicatorSheetPdf, NO_MAP_PAGES_MESSAGE } from './applicatorSheetPdf';

function makeSheetData(overrides: Partial<ApplicatorSheetData> = {}): ApplicatorSheetData {
  return {
    job_number: 'JOB-2026-001',
    customers: [{ customer_name: 'Smith Farm', account_number: '1001' }],
    scheduled_date: '2026-07-11',
    scheduled_time: null,
    applicator_name: 'Avery Applicator',
    vehicle_name: 'Sprayer 1',
    fields: [{ stop: 1, field_name: 'North 40', county: 'Crawford', state: 'IL', acres: 40, crop: null, pest: null }],
    products: [],
    total_acres: 40,
    loader_comment: null,
    ...overrides,
  };
}

describe('generateApplicatorSheetPdf map pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pageCount = 1;
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('keeps the existing page count when maps are absent', async () => {
    await generateApplicatorSheetPdf(makeSheetData(), 'original', null);

    expect(pageCount).toBe(1);
    expect(mockDoc.addImage).not.toHaveBeenCalled();
  });

  it('appends one overview and one page for each successfully fetched field map', async () => {
    await generateApplicatorSheetPdf(makeSheetData({
      maps: {
        overview: 'data:image/png;base64,b3ZlcnZpZXc=',
        perField: [
          {
            fieldId: 'field-1',
            sprayNumber: 1,
            fieldName: 'North 40',
            customerName: 'Smith Farm',
            acres: 40,
            centroidLat: 39.15,
            centroidLng: -89.05,
            dataUrl: 'data:image/png;base64,ZmllbGQtMQ==',
          },
          {
            fieldId: 'field-2',
            fieldName: 'South 80',
            customerName: null,
            acres: 80,
            centroidLat: null,
            centroidLng: null,
            dataUrl: 'data:image/png;base64,ZmllbGQtMg==',
          },
        ],
      },
    }), 'enhanced', null);

    expect(pageCount).toBe(4);
    expect(mockDoc.addImage).toHaveBeenCalledTimes(3);
    const renderedText = mockDoc.text.mock.calls.flat(Infinity).filter((value: unknown): value is string => typeof value === 'string');
    expect(renderedText).toContain('Job Field Map — Overview');
    expect(renderedText).toContain('Job Field Map — Stop 1');
    expect(renderedText).toContain('Job Field Map');
    expect(renderedText.some((value) => value.includes('North 40 · Smith Farm · 40 acres · Lat: 39.150000, Lng: -89.050000'))).toBe(true);
    expect(renderedText).toContain('South 80 · 80 acres');
    expect(renderedText.some((value) => value.includes('South 80 · Smith Farm'))).toBe(false);
  });

  it('expands the map header before placing the image and caps wrapped details at three lines', async () => {
    mockDoc.splitTextToSize.mockImplementation((text: string) => text.includes('Long Header Field')
      ? ['Long Header Field', 'Smith Farm · 40 acres', 'Lat: 39.150000, Lng: -89.050000', 'unused fourth line']
      : [text]);

    await generateApplicatorSheetPdf(makeSheetData({
      maps: {
        overview: null,
        perField: [{
          fieldId: 'field-1',
          fieldName: 'Long Header Field',
          customerName: 'Smith Farm',
          acres: 40,
          centroidLat: 39.15,
          centroidLng: -89.05,
          dataUrl: 'data:image/png;base64,ZmllbGQtMQ==',
        }],
      },
    }), 'original', null);

    expect(mockDoc.rect.mock.calls).toContainEqual([0, 0, 612, 78.5, 'F']);
    expect(mockDoc.addImage.mock.calls[0][3]).toBe(98.5);
    expect(mockDoc.text.mock.calls.some((call) => Array.isArray(call[0])
      && call[0][2] === 'Lat: 39.150000, Lng: -89.050000…')).toBe(true);
  });

  it('falls back to the Settings company details when Custom leaves them blank', async () => {
    await generateApplicatorSheetPdf(makeSheetData(), 'custom', null);
    const renderedText = mockDoc.text.mock.calls.flat(Infinity).filter((value: unknown): value is string => typeof value === 'string');
    expect(renderedText).toEqual(expect.arrayContaining([
      'Prairie Ag Co',
      '12 Main St Annapolis, IL 62413',
      'Prairie Ag Co  •  12 Main St Annapolis, IL 62413  •  Internal Use Only',
    ]));
  });

  it('renders enabled billing, history, and extra hand-fill sections', async () => {
    await generateApplicatorSheetPdf(makeSheetData({
      billingSplits: [{ customerName: 'Smith Farm', acres: 40, percentOfJob: 100, phone: '555-0100' }],
      previousApplications: [{
        fieldId: 'field-1',
        fieldName: 'North 40',
        records: [{ date: '2026-07-01', summary: 'Atrazine (1 qt/ac)', applicator: 'Casey Crew' }],
      }],
    }), 'enhanced', null, {
      includeBillingSplits: true,
      includePreviousApplications: true,
      blankSections: 2,
      showBanner: true,
    });

    const renderedText = mockDoc.text.mock.calls.flat(Infinity).filter((value: unknown): value is string => typeof value === 'string');
    expect(renderedText).toContain('Billing Splits');
    expect(renderedText).toContain('Previous applications — North 40');
    expect(renderedText).toContain('Additional Application Record 1');
    expect(renderedText).toContain('Additional Application Record 2');
    expect(mockDoc.rect).toHaveBeenCalledWith(0, 0, 612, 56, 'F');
  });

  it('omits disabled optional sections and the company header band', async () => {
    await generateApplicatorSheetPdf(makeSheetData({
      billingSplits: [{ customerName: 'Smith Farm', acres: 40, percentOfJob: 100, phone: '555-0100' }],
      previousApplications: [{
        fieldId: 'field-1',
        fieldName: 'North 40',
        records: [{ date: '2026-07-01', summary: 'Atrazine (1 qt/ac)', applicator: 'Casey Crew' }],
      }],
    }), 'original', null, {
      includeBillingSplits: false,
      includePreviousApplications: false,
      blankSections: 0,
      showBanner: false,
    });

    const renderedText = mockDoc.text.mock.calls.flat(Infinity).filter((value: unknown): value is string => typeof value === 'string');
    expect(renderedText).not.toContain('Billing Splits');
    expect(renderedText).not.toContain('Previous applications — North 40');
    expect(renderedText).not.toContain('Additional Application Record 1');
    expect(renderedText).toContain('Job JOB-2026-001 — Original Applicator Report');
    expect(mockDoc.rect).not.toHaveBeenCalled();
  });
});

describe('generateApplicatorSheetPdf EPA column (KI-195)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pageCount = 1;
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('prints the EPA Reg. No. the sheet data carries in every format, and a dash when there is none', async () => {
    const product = (name: string, epa: string | null) => ({
      product_name: name, rate_per_acre: 1, rate_unit: 'pt', total_applied: 40, total_unit: 'pt', total_gl_lb: '5 gal',
      product_form: null, rei_hours: 12, phi_days: 30, epa_registration: epa,
    });
    const autoTable = (await import('jspdf-autotable')).default as unknown as ReturnType<typeof vi.fn>;
    for (const format of ['original', 'enhanced', 'custom'] as const) {
      autoTable.mockClear();
      await generateApplicatorSheetPdf(makeSheetData({ products: [
        product('Kept', '100-1'), product('NoNumber', '—'), product('Old', 'Not recorded'), product('Blank', null),
      ] }), format, null);
      const chem = autoTable.mock.calls
        .map((c) => c[1] as { head: string[][]; body: string[][] })
        .find((o) => o.head?.[0]?.includes('Rate / Acre'));
      expect(chem).toBeDefined();
      expect(chem!.head[0].slice(0, 3)).toEqual(['Product', 'EPA Reg. No.', 'Rate / Acre']);
      expect(chem!.body.map((r) => r[1])).toEqual(['100-1', '—', 'Not recorded', '—']);
      expect(chem!.body.every((r) => r.length === chem!.head[0].length)).toBe(true);
    }
  });
});

describe('generateApplicatorSheetPdf directions links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pageCount = 1;
    mockDoc.lastAutoTable = { finalY: 300 };
    mockDoc.splitTextToSize.mockImplementation((text: string) => [text]);
  });

  it('prints one directions link per mapped field in stop order and skips unmapped fields', async () => {
    await generateApplicatorSheetPdf(makeSheetData({
      fields: [
        { stop: 1, field_name: 'North 40', county: null, state: null, acres: 40, crop: null, pest: null, location: { lat: 39.15, lng: -89.05 } },
        { stop: 2, field_name: 'No Pin', county: null, state: null, acres: 10, crop: null, pest: null, location: null },
        { stop: 3, field_name: 'South 80', county: null, state: null, acres: 80, crop: null, pest: null, location: { lat: 39.2, lng: -89.1 } },
      ],
    }), 'original', null);
    expect(mockDoc.textWithLink.mock.calls.map((call) => (call[3] as { url: string }).url)).toEqual([
      'https://www.google.com/maps/dir/?api=1&destination=39.150000,-89.050000',
      'https://www.google.com/maps/dir/?api=1&destination=39.200000,-89.100000',
    ]);
    const text = mockDoc.text.mock.calls.map((call) => call[0]).filter((value): value is string => typeof value === 'string');
    expect(text.some((value) => value.startsWith('Stop 3 · South 80'))).toBe(true);
    expect(text.some((value) => value.includes('No Pin ·'))).toBe(false);
  });

  it('shortens a long field name so the link stays on the page', async () => {
    mockDoc.getTextWidth.mockImplementation((text: string) => text.length * 5);
    const longName = 'A'.repeat(200);
    await generateApplicatorSheetPdf(makeSheetData({
      fields: [{ stop: 1, field_name: longName, county: null, state: null, acres: 1, crop: null, pest: null, location: { lat: 1, lng: 2 } }],
    }), 'original', null);
    const [, linkX] = mockDoc.textWithLink.mock.calls[0] as [string, number];
    expect(linkX + 'Open directions'.length * 5).toBeLessThanOrEqual(612 - 40);
    mockDoc.getTextWidth.mockImplementation(() => 50);
  });

  it('prints no directions block when no field has a map pin', async () => {
    await generateApplicatorSheetPdf(makeSheetData(), 'original', null);
    expect(mockDoc.textWithLink).not.toHaveBeenCalled();
  });
});

describe('map pages only print', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pageCount = 1;
    mockDoc.lastAutoTable = { finalY: 300 };
    mockDoc.splitTextToSize.mockImplementation((text: string) => [text]);
  });
  const maps = {
    overview: 'data:image/png;base64,b3ZlcnZpZXc=',
    perField: [{ fieldId: 'field-1', sprayNumber: 1, fieldName: 'North 40', customerName: null, acres: 40,
      centroidLat: null, centroidLng: null, dataUrl: 'data:image/png;base64,ZmllbGQtMQ==' }],
  };

  it('prints only the map pages, no job order, and drops the blank first page', async () => {
    const { default: autoTable } = await import('jspdf-autotable');
    await generateApplicatorSheetPdf(makeSheetData({ maps }),
      'enhanced', null, { mapsOnly: true });
    expect(autoTable).not.toHaveBeenCalled(); // no sheet tables on a maps-only print
    expect(mockDoc.deletePage).toHaveBeenCalledWith(1);
    expect(pageCount).toBe(2);
    expect(mockDoc.save).toHaveBeenCalledWith(expect.stringMatching(/^field-maps-/));
  });

  it('refuses a maps-only print with no maps instead of saving a blank page', async () => {
    await expect(generateApplicatorSheetPdf(makeSheetData({ maps: null }), 'original', null, { mapsOnly: true }))
      .rejects.toThrow(NO_MAP_PAGES_MESSAGE);
    expect(mockDoc.save).not.toHaveBeenCalled();
  });

  it('keeps the full sheet (tank contents) when maps-only is not asked for', async () => {
    const { default: autoTable } = await import('jspdf-autotable');
    await generateApplicatorSheetPdf(makeSheetData({ maps }), 'enhanced', null, {});
    expect(autoTable).toHaveBeenCalled();
    expect(mockDoc.deletePage).not.toHaveBeenCalled();
    expect(pageCount).toBe(3);
  });
});
