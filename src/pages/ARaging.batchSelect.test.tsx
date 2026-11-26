/**
 * ARaging.batchSelect.test.tsx — batch statements act only on the customers the table shows.
 *
 * Select All used to pick every customer on the list even when the search box hid most of
 * them, so Email Statements reached customers nobody could see. Now Select All picks the rows
 * the search leaves on screen. A ticked customer the search hides keeps the tick but is never
 * printed, emailed or counted while hidden, and the send button and confirm say how many
 * statements will go. The Last emailed column reads the
 * email log's sent statements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  emailLog: [] as Row[],
  emailLogFails: false,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  emailLogFilters: [] as unknown[][],
  sendEmail: vi.fn(),
}));

const reply = (rows: unknown[] = [], error: { message: string } | null = null, eqCalls?: unknown[][]) => {
  const chain: object = new Proxy({}, {
    get: (_target, prop) => (prop === 'then'
      ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(error ? { data: null, error, count: null } : { data: rows, error: null, count: rows.length })
          .then(resolve, reject)
      : (...args: unknown[]) => {
        if (prop === 'eq') eqCalls?.push(args);
        return chain;
      }),
  });
  return chain;
};

const amounts = (n: number) => ({
  current_amount: n, days_30: 0, days_60: 0, days_90: 0, over_90: 0, total_outstanding: n,
  prepay_balance_cents: 0, open_credit_cents: 0, unavailable_reason: null,
});
const AGING = [
  { customer_id: 'c1', farm_name: 'Big Farm', ...amounts(300) },
  { customer_id: 'c2', farm_name: 'Bigger Acres', ...amounts(200) },
  { customer_id: 'c3', farm_name: 'Small Farm', ...amounts(100) },
];

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (table === 'email_log'
        ? reply(H.emailLog, H.emailLogFails ? { message: 'denied' } : null, H.emailLogFilters)
        : reply()),
      rpc: (name: string, args: Record<string, unknown>) => {
        H.rpcCalls.push({ name, args });
        if (name === 'get_ar_aging') return reply(AGING);
        // Each customer's statement carries that customer's own email and one transaction.
        if (name === 'get_detailed_statement_data') {
          const id = String(args.p_customer_id);
          return reply({
            customer: { farm_name: `Farm ${id}`, email: `${id}@example.com` },
            transactions: [{ id: `t-${id}` }],
            outstanding_balance_cents: 100, open_credit_cents: 0, net_account_position_cents: 100,
          } as unknown as unknown[]);
        }
        return reply();
      },
    },
  };
});
vi.mock('../lib/statementPdf', () => ({
  generateStatementPdf: vi.fn(async () => ({})),
  downloadStatementPdf: vi.fn(),
  downloadBatchStatements: vi.fn(async () => undefined),
}));
vi.mock('../lib/emailService', async () => {
  const actual = await vi.importActual<typeof import('../lib/emailService')>('../lib/emailService');
  return { ...actual, sendEmail: H.sendEmail, pdfToBase64: () => 'pdf', buildEmailHtml: () => '<p></p>' };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import ARaging from './ARaging';

beforeEach(() => {
  vi.clearAllMocks();
  H.emailLog = [];
  H.emailLogFails = false;
  H.rpcCalls = [];
  H.emailLogFilters = [];
  H.sendEmail.mockResolvedValue({ success: true });
});
afterEach(() => cleanup());

const box = (farm: string) => screen.getByRole('checkbox', { name: `Select ${farm}` }) as HTMLInputElement;
const search = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Search customers...' }), { target: { value: text } });

async function renderAging() {
  render(<MemoryRouter><ARaging /></MemoryRouter>);
  await screen.findByRole('checkbox', { name: 'Select Small Farm' });
}

describe('AR Aging batch statements: Select All with a search', () => {
  it('selects only the customers the search shows', async () => {
    await renderAging();
    search('Big');
    expect(screen.queryByRole('checkbox', { name: 'Select Small Farm' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Select All 2 Shown' }));
    expect(box('Big Farm').checked).toBe(true);
    expect(box('Bigger Acres').checked).toBe(true);
    expect(screen.getByRole('button', { name: /Email 2 statements/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Batch Print \(2\)/ })).toBeTruthy();

    // Clearing the search shows the hidden customer was never selected.
    search('');
    expect(box('Small Farm').checked).toBe(false);
    expect(screen.getByRole('button', { name: /Email 2 statements/ })).toBeTruthy();
  });

  it('keeps a tick the search hides, but counts and sends only the shown customers', async () => {
    await renderAging();
    fireEvent.click(box('Big Farm'));
    fireEvent.click(box('Bigger Acres'));

    search('Bigger');
    expect(screen.getByRole('button', { name: /Email 1 statement$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Batch Print \(1\)/ })).toBeTruthy();
    expect(screen.getByText('1 more ticked, hidden by your search')).toBeTruthy();

    search('');
    expect(box('Big Farm').checked).toBe(true);
    expect(box('Bigger Acres').checked).toBe(true);
    expect(screen.queryByText(/hidden by your search/)).toBeNull();
  });

  it('Select All with a search adds the shown customers and keeps hidden ticks', async () => {
    await renderAging();
    fireEvent.click(box('Small Farm'));
    search('Big');
    fireEvent.click(screen.getByRole('button', { name: 'Select All 2 Shown' }));
    search('');
    expect(box('Small Farm').checked).toBe(true);
    expect(box('Big Farm').checked).toBe(true);
    expect(box('Bigger Acres').checked).toBe(true);
  });

  it('Deselect All with a search clears only the shown customers', async () => {
    await renderAging();
    fireEvent.click(box('Big Farm'));
    search('Small');
    fireEvent.click(screen.getByRole('button', { name: 'Select All 1 Shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deselect 1 Shown' }));
    search('');
    expect(box('Big Farm').checked).toBe(true);
    expect(box('Small Farm').checked).toBe(false);
  });

  it('the confirm names the count and only the shown, selected customers are emailed', async () => {
    await renderAging();
    search('Big');
    fireEvent.click(screen.getByRole('button', { name: 'Select All 2 Shown' }));
    fireEvent.click(screen.getByRole('button', { name: /Email 2 statements/ }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Email Statements' });
    expect(dialog.textContent).toContain('each of the 2 selected customers');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email 2 statements' }));

    await waitFor(() => expect(H.rpcCalls.filter((c) => c.name === 'get_detailed_statement_data')).toHaveLength(2));
    const asked = H.rpcCalls.filter((c) => c.name === 'get_detailed_statement_data').map((c) => c.args.p_customer_id);
    expect(asked.sort()).toEqual(['c1', 'c2']);
    // Each email goes to that customer's own address, logged against that customer.
    await waitFor(() => expect(H.sendEmail).toHaveBeenCalledTimes(2));
    const sent = H.sendEmail.mock.calls.map(([arg]) => [arg.to, arg.customer_id]);
    expect(sent.sort()).toEqual([['c1@example.com', 'c1'], ['c2@example.com', 'c2']]);
  });

  it('a ticked customer the search hides is never emailed or printed', async () => {
    await renderAging();
    fireEvent.click(box('Small Farm'));
    search('Big');
    fireEvent.click(screen.getByRole('button', { name: 'Select All 2 Shown' }));
    const statementCalls = () => H.rpcCalls.filter((c) => c.name === 'get_detailed_statement_data').map((c) => c.args.p_customer_id);

    fireEvent.click(screen.getByRole('button', { name: /Email 2 statements/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Email Statements' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email 2 statements' }));
    await waitFor(() => expect(H.sendEmail).toHaveBeenCalledTimes(2));
    expect(H.sendEmail.mock.calls.map(([arg]) => arg.customer_id).sort()).toEqual(['c1', 'c2']);
    expect(statementCalls().sort()).toEqual(['c1', 'c2']);

    H.rpcCalls = [];
    fireEvent.click(screen.getByRole('button', { name: /Batch Print \(2\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Generate .* Statement/ }));
    await waitFor(() => expect(statementCalls()).toHaveLength(2));
    expect(statementCalls().sort()).toEqual(['c1', 'c2']);
  });

  it('Deselect All clears the selection when every shown customer is selected', async () => {
    await renderAging();
    search('Small');
    fireEvent.click(screen.getByRole('button', { name: 'Select All 1 Shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deselect 1 Shown' }));
    expect(box('Small Farm').checked).toBe(false);
    expect(screen.queryByRole('button', { name: /Email \d+ statement/ })).toBeNull();
  });
});

describe('AR Aging Last emailed column', () => {
  it('shows each customer\'s newest sent statement, and none on record for the rest', async () => {
    H.emailLog = [
      { id: 'e1', customer_id: 'c1', created_at: '2026-10-01T15:00:00Z' },
      { id: 'e2', customer_id: 'c1', created_at: '2026-11-03T15:00:00Z' },
      { id: 'e3', customer_id: 'c2', created_at: '2026-09-15T15:00:00Z' },
    ];
    await renderAging();
    const rowOf = (farm: string) => box(farm).closest('tr')!;
    await waitFor(() => expect(rowOf('Big Farm').textContent).toContain('Nov 3, 2026'));
    expect(rowOf('Bigger Acres').textContent).toContain('Sep 15, 2026');
    expect(rowOf('Small Farm').textContent).toContain('None on record');
    // Only statements that actually went out count.
    expect(H.emailLogFilters).toEqual(expect.arrayContaining([['email_type', 'statement'], ['status', 'sent']]));
  });

  it('says the dates could not be loaded instead of showing never emailed', async () => {
    H.emailLogFails = true;
    await renderAging();
    await waitFor(() => expect(screen.getAllByText('Could not load')).toHaveLength(3));
    expect(screen.queryByText('None on record')).toBeNull();
  });
});
