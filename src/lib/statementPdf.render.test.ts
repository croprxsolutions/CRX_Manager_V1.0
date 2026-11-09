import { describe, expect, it, vi } from 'vitest';
import type { DetailedStatementData } from '../types';
import { DEFAULT_COMPANY_INFO } from './companyInfo';
import { generateStatementPdf } from './statementPdf';

const companyInfo = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./companyInfoForPdf', () => ({ loadCompanyInfoForPdf: companyInfo.load }));
companyInfo.load.mockResolvedValue(DEFAULT_COMPANY_INFO);

const renderedStatement: DetailedStatementData = {
  customer: {
    id: 'customer-render',
    farm_name: 'Rendered Example Farms',
    contact_name: null,
    account_number: 'RENDER-1',
    email: null,
    phone: null,
    billing_address: '1 Test Lane',
    city: 'Olney',
    state: 'IL',
    zip: '62450',
    payment_terms: 'Net 30',
  },
  transactions: [
    {
      invoice_number: 'INV-RENDER-1',
      invoice_date: '2026-08-01',
      due_date: '2026-08-31',
      invoice_type: 'chemical_sale',
      status: 'posted',
      days_aged: 2,
      description: 'Chemical Sale',
      crop_type: null,
      field_names: null,
      total_acres: null,
      grower_names: null,
      total_amount_cents: 10_000,
      paid_amount_cents: 0,
      prepay_applied_cents: 0,
      balance_cents: 10_000,
      items: [],
      shares: [],
      finance_charge_cents: 0,
      net_due_cents: 10_000,
      price_per_acre: null,
    },
  ],
  aging: {
    current_cents: 10_000,
    days_30_cents: 0,
    days_60_cents: 0,
    days_90_cents: 0,
    over_120_cents: 0,
  },
  outstanding_balance_cents: 10_000,
  open_credit_cents: 2_500,
  net_account_position_cents: 7_500,
  as_of_date: '2026-08-03',
  mode: 'summary',
};

describe('statement PDF real renderer', () => {
  it('fails closed when the live RPC has not deployed balance disclosure fields', async () => {
    const legacyPayload = {
      ...renderedStatement,
      open_credit_cents: undefined,
      net_account_position_cents: undefined,
    } as unknown as DetailedStatementData;

    await expect(generateStatementPdf(legacyPayload)).rejects.toThrow(
      'Statement generation is temporarily unavailable because the database balance disclosure is not ready.',
    );
  });

  it('renders a non-empty PDF with separate gross, credit, and net labels', async () => {
    const doc = await generateStatementPdf(renderedStatement);
    const pdfBytes = doc.output('arraybuffer');
    const pageCommands = doc.internal.pages.flat().join('\n');

    expect(pdfBytes.byteLength).toBeGreaterThan(2_000);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    expect(doc.getNumberOfPages()).toBe(1);
    expect(pageCommands).toContain('GROSS OPEN INVOICES');
    expect(pageCommands).toContain('Unapplied Credits:');
    expect(pageCommands).toContain('Net Account Position:');
    expect(pageCommands).toContain('PLEASE MAIL WITH PAYMENT TO:');
    expect(pageCommands).toContain('Amount Paid  $');
    expect(pageCommands).toContain('9100 E 2000th Ave');
    expect(pageCommands).not.toContain('CONTACT CROP RX BEFORE PAYMENT:');
    expect(pageCommands).toContain('CUT HERE');
    expect(pageCommands).toContain('Page 1');
    expect(pageCommands).not.toContain('Page 2');
  });

  it('labels the oldest aging bucket "120+ Days" like the AR Aging page (KI-18 batch 3 ranges)', async () => {
    const doc = await generateStatementPdf(renderedStatement);
    const pageCommands = doc.internal.pages.flat().join('\n');

    expect(pageCommands.split('120+ Days').length - 1).toBe(2);
    expect(pageCommands).not.toContain('Over 120');
  });

  it('prints the Settings address in the letterhead only; the remit-to block keeps its own address', async () => {
    companyInfo.load.mockResolvedValueOnce({
      name: 'Test Ag Co', phone: '555-0199', email: '', address: '4400 Example Rd, Settingstown, IL 62999',
    });
    const doc = await generateStatementPdf(renderedStatement);
    const pageCommands = doc.internal.pages.flat().join('\n');

    expect(pageCommands).toContain('TEST AG CO');
    expect(pageCommands).toContain('4400 Example Rd');
    expect(pageCommands).toContain('PLEASE MAIL WITH PAYMENT TO:');
    expect(pageCommands).toContain('9100 E 2000th Ave');
    expect(pageCommands).not.toContain('CROP RX SOLUTIONS');
  });

  it('renders every wrapped account-name line without covering remittance totals', async () => {
    const longFarmName =
      'Extremely Long Agricultural Partnership Name With Multiple Generations And No Account Number';
    const longNameStatement = {
      ...renderedStatement,
      customer: {
        ...renderedStatement.customer,
        farm_name: longFarmName,
        account_number: null,
      },
    };

    const doc = await generateStatementPdf(longNameStatement);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    const expectedNameLines = doc.splitTextToSize(longFarmName, 190) as string[];
    const pages = doc.internal.pages as unknown as string[][];
    const finalPageCommands = pages[pages.length - 1]?.join('\n') || '';

    expect(expectedNameLines.length).toBeGreaterThan(1);
    for (const line of expectedNameLines) expect(finalPageCommands).toContain(line);
    expect(finalPageCommands).toContain('Gross open:');
    expect(finalPageCommands).toContain('Credits:');
    expect(finalPageCommands).toContain('Net position:');
    expect(finalPageCommands).toContain('Amount Paid  $');
  });

  it('moves the complete account-position block to a new page near the footer boundary', async () => {
    const crowdedStatement = {
      ...renderedStatement,
      transactions: Array.from({ length: 21 }, (_, index) => ({
        ...renderedStatement.transactions[0],
        invoice_number: `INV-RENDER-${index + 1}`,
      })),
    };

    const doc = await generateStatementPdf(crowdedStatement);
    const pages = doc.internal.pages as unknown as string[][];
    const firstPageCommands = pages[1].join('\n');
    const secondPageCommands = pages[2].join('\n');

    expect(doc.getNumberOfPages()).toBe(2);
    expect(firstPageCommands).not.toContain('Net Account Position:');
    expect(secondPageCommands).toContain('Gross Open Invoices:');
    expect(secondPageCommands).toContain('Unapplied Credits:');
    expect(secondPageCommands).toContain('Net Account Position:');
    expect(secondPageCommands).toContain('Page 2');
  });

  it('moves detailed account-position totals off a crowded transaction page', async () => {
    const crowdedDetailedStatement: DetailedStatementData = {
      ...renderedStatement,
      mode: 'detailed',
      transactions: [{
        ...renderedStatement.transactions[0],
        invoice_type: 'chemical_sale',
        items: Array.from({ length: 26 }, (_, index) => ({
          product_name: `Chemical ${index + 1}`,
          epa_registration: null,
          rate_per_acre: null,
          rate_unit: null,
          total_applied: null,
          total_applied_unit: null,
          total_applied_gl_lb: null,
          gl_lb_unit: null,
          unit_price_cents: 1_000,
          total_cost_cents: 1_000,
          is_application_fee: false,
          quantity: 1,
          unit_size: 'gal',
          product_form: 'liquid',
        })),
      }],
    };

    const doc = await generateStatementPdf(crowdedDetailedStatement);
    const pages = doc.internal.pages as unknown as string[][];
    const penultimatePageCommands = pages[pages.length - 2].join('\n');
    const finalPageCommands = pages[pages.length - 1].join('\n');

    expect(doc.getNumberOfPages()).toBe(2);
    expect(penultimatePageCommands).not.toContain('Net Account Position:');
    expect(finalPageCommands).toContain('Gross Open Invoices:');
    expect(finalPageCommands).toContain('Unapplied Credits:');
    expect(finalPageCommands).toContain('Net Account Position:');
    expect(finalPageCommands).toContain('Page 2');
  });

  it('keeps Finance Charges and Net Due above the footer when a product table ends near the page bottom', async () => {
    const statement: DetailedStatementData = {
      ...renderedStatement,
      mode: 'detailed',
      transactions: [{
        ...renderedStatement.transactions[0],
        // 29 lines end the product table about 42pt above the page bottom.
        items: Array.from({ length: 29 }, (_, index) => ({
          product_name: `Chemical ${index + 1}`,
          epa_registration: null,
          rate_per_acre: null,
          rate_unit: null,
          total_applied: null,
          total_applied_unit: null,
          total_applied_gl_lb: null,
          gl_lb_unit: null,
          unit_price_cents: 1_000,
          total_cost_cents: 1_000,
          is_application_fee: false,
          quantity: 1,
          unit_size: 'gal',
          product_form: 'liquid',
        })),
        finance_charge_cents: 500,
        net_due_cents: 10_500,
      }],
    };

    const doc = await generateStatementPdf(statement);
    const pages = doc.internal.pages as unknown as string[][];
    // jsPDF text position is "x y Td" with y measured up from the page bottom (pt).
    const baselineAboveBottom = (label: string) => {
      for (let page = 1; page < pages.length; page++) {
        const match = pages[page].join('\n').match(new RegExp(`(-?[\\d.]+) Td\\n\\(${label}`));
        if (match) return { page, y: Number(match[1]) };
      }
      throw new Error(`${label} not drawn`);
    };
    const finance = baselineAboveBottom('Finance Charges');
    const netDue = baselineAboveBottom('Net Due');

    // The footer rule sits 26pt and its text 20pt above the bottom; 32pt is the safe edge.
    expect(netDue.y).toBeGreaterThanOrEqual(32);
    expect(finance.y).toBeGreaterThanOrEqual(32);
    expect(netDue.page).toBe(finance.page);
    expect(finance.page).toBe(2); // the scenario must force the page break
    // The page that was left keeps its footer (drawn by the product table).
    expect(pages[1].join('\n')).toMatch(/Statement generated .*? Page 1\)/);
  });

  it('replaces remittance instructions when credits cover the gross invoices', async () => {
    const creditCoveredStatement = {
      ...renderedStatement,
      open_credit_cents: 12_500,
      net_account_position_cents: -2_500,
    };

    const doc = await generateStatementPdf(creditCoveredStatement);
    const pageCommands = doc.internal.pages.flat().join('\n');

    expect(pageCommands).not.toContain('PLEASE MAIL WITH PAYMENT TO:');
    expect(pageCommands).not.toContain('Amount Paid  $');
    expect(pageCommands).toContain('CONTACT CROP RX BEFORE PAYMENT:');
    expect(pageCommands).toContain('Credits cover open invoices.');
    expect(pageCommands).toContain('Call before sending payment.');
    expect(pageCommands).toContain('Phone: 618-843-0413');
    expect(pageCommands).toContain('Website: www.croprxsolutions.com');
    expect(pageCommands).not.toContain('9100 E 2000th Ave');
  });

  it('suppresses remittance instructions when credits exactly cover gross invoices', async () => {
    const zeroBalanceStatement = {
      ...renderedStatement,
      open_credit_cents: 10_000,
      net_account_position_cents: 0,
    };

    const doc = await generateStatementPdf(zeroBalanceStatement);
    const pageCommands = doc.internal.pages.flat().join('\n');

    expect(pageCommands).not.toContain('PLEASE MAIL WITH PAYMENT TO:');
    expect(pageCommands).not.toContain('Amount Paid  $');
    expect(pageCommands).not.toContain('9100 E 2000th Ave');
    expect(pageCommands).toContain('CONTACT CROP RX BEFORE PAYMENT:');
    expect(pageCommands).toContain('Phone: 618-843-0413');
    expect(pageCommands).toContain('Website: www.croprxsolutions.com');
  });

  it('draws exactly one footer on every page', async () => {
    const chemicalItem = {
      product_name: 'Chemical',
      epa_registration: null,
      rate_per_acre: null,
      rate_unit: null,
      total_applied: null,
      total_applied_unit: null,
      total_applied_gl_lb: null,
      gl_lb_unit: null,
      unit_price_cents: 1_000,
      total_cost_cents: 1_000,
      is_application_fee: false,
      quantity: 1,
      unit_size: 'gal',
      product_form: 'liquid',
    };
    const manyInvoices = (count: number, items: typeof chemicalItem[]) =>
      Array.from({ length: count }, (_, index) => ({
        ...renderedStatement.transactions[0],
        invoice_number: `INV-FOOTER-${index + 1}`,
        items,
      }));
    const cases: Array<[string, DetailedStatementData, number]> = [
      ['summary, one page', renderedStatement, 1],
      ['summary, no transactions', { ...renderedStatement, transactions: [] }, 1],
      ['summary, stub pushed to new page', { ...renderedStatement, transactions: manyInvoices(16, []) }, 2],
      ['summary, account position pushed to new page', { ...renderedStatement, transactions: manyInvoices(21, []) }, 2],
      ['summary, multi-page', { ...renderedStatement, transactions: manyInvoices(60, []) }, 3],
      ['detailed, one page', { ...renderedStatement, mode: 'detailed' }, 1],
      ['detailed, no transactions', { ...renderedStatement, mode: 'detailed', transactions: [] }, 1],
      [
        'detailed, multi-page',
        { ...renderedStatement, mode: 'detailed', transactions: manyInvoices(12, Array(8).fill(chemicalItem)) },
        3,
      ],
    ];

    for (const [label, statement, minPages] of cases) {
      const doc = await generateStatementPdf(statement);
      const pageCount = doc.getNumberOfPages();
      expect(pageCount, label).toBeGreaterThanOrEqual(minPages);
      const pages = doc.internal.pages as unknown as string[][];
      for (let page = 1; page <= pageCount; page++) {
        const footers = pages[page].join('\n').match(/Statement generated .*? Page \d+/g) ?? [];
        expect(footers, `${label} page ${page}`).toEqual([expect.stringMatching(new RegExp(`Page ${page}$`))]);
      }
    }
  });
});
