/**
 * BulkCustomerImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Fully chainable Supabase query-builder mock
function chainable(resolveWith: unknown = { data: [], error: null }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','like','ilike','is','in','or','not','match',
    'order','limit','range','single','maybeSingle',
    'csv','explain',
  ];
  for (const m of methods) builder[m] = vi.fn(self);
  // Make it thenable so `await supabase.from(...)...` resolves
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
    return builder;
  });
  return builder;
}

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc },
  assertRpcResult: (data: unknown) => { if (data == null) throw new Error('empty'); return data; },
  sanitizeError: (e: { message?: string }) => e?.message ?? String(e),
}));

vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: vi.fn(),
  isCSVFile: vi.fn(() => true),
  isOCRSupported: vi.fn(() => false),
}));

const authValue = vi.hoisted(() => ({ profile: { id: 'admin-1', role: 'admin' } as { id: string; role: string } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authValue }));

const toast = vi.hoisted(() => vi.fn());
vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast }),
}));

vi.mock('../../lib/appSettingDefaults', () => ({ loadDefaultTier: vi.fn(async () => 1) }));

import BulkCustomerImport from './BulkCustomerImport';
import { loadDefaultTier } from '../../lib/appSettingDefaults';

describe('BulkCustomerImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: { status: 'saved', customer_id: 'c-1' }, error: null });
  });

  it('renders when open', () => {
    render(<BulkCustomerImport {...defaultProps} />);
    expect(screen.getByText(/bulk customer/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkCustomerImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/bulk customer/i)).not.toBeInTheDocument();
  });

  // Price tiers are admin-only (Mason 2026-11-01): a rep's import puts every row on the
  // Settings Default Tier (1 here: no setting), whatever tier the file says.
  async function parseTierThreeFile() {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['farm_name,tier\nTier Three Farm,3\n'], 'c.csv', { type: 'text/csv' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    await screen.findByText('Tier Three Farm');
  }

  it('keeps the tier from the file for an admin', async () => {
    authValue.profile = { id: 'admin-1', role: 'admin' };
    await parseTierThreeFile();
    expect(screen.getByText('Tier: 3')).toBeInTheDocument();
  });

  it('puts a sales rep\'s rows on the default tier and says why', async () => {
    authValue.profile = { id: 'rep-1', role: 'sales_rep' };
    try {
      await parseTierThreeFile();
      expect(screen.getByText('Tier: 1')).toBeInTheDocument();
      expect(screen.getAllByText(/only an admin can set a customer.s tier/i).length).toBeGreaterThan(0);
    } finally {
      authValue.profile = { id: 'admin-1', role: 'admin' };
    }
  });

  // KI-145: rows go through save_customer (activity row, server checks), never a direct insert.
  async function importFile(csv: string) {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([csv], 'c.csv', { type: 'text/csv' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Import \d+ Customer/ }));
    await screen.findByText('Import Complete');
  }
  const payloads = () => rpc.mock.calls.filter(([fn]) => fn === 'save_customer').map(([, args]) => args);

  it('saves a sales rep\'s rows through save_customer assigned to that rep', async () => {
    authValue.profile = { id: 'rep-1', role: 'sales_rep' };
    try {
      await importFile('farm_name\nRep Farm\n');
      expect(payloads()).toHaveLength(1);
      const args = payloads()[0];
      expect(args.p_customer_id).toBeNull();
      expect(args.p_performed_by).toBe('rep-1');
      expect(args.p_idempotency_key).toEqual(expect.any(String));
      expect(args.p_customer_payload).toMatchObject({ farm_name: 'Rep Farm', assigned_sales_rep: 'rep-1', assigned_tier: 1 });
      expect(screen.getByText(/Successfully imported 1 customer/)).toBeInTheDocument();
    } finally {
      authValue.profile = { id: 'admin-1', role: 'admin' };
    }
  });

  it('reads "1,200" acres as 1200', async () => {
    await importFile('farm_name,total_acres\nBig Farm,"1,200"\n');
    expect(payloads()[0].p_customer_payload).toMatchObject({ total_acres: 1200 });
  });

  it('counts a row with a blank first cell as invalid, with its file row number', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['farm_name,phone\nGood Farm,1\n,555\n'], 'c.csv', { type: 'text/csv' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    expect(await screen.findByText('Row 3: Missing farm name')).toBeInTheDocument();
  });

  it('shows each refused row\'s error and still imports the others', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'REP_MUST_SELF_ASSIGN' } })
      .mockResolvedValueOnce({ data: { status: 'saved', customer_id: 'c-2' }, error: null });
    await importFile('farm_name\nBad Farm\nGood Farm\n');
    expect(screen.getByText(/Successfully imported 1 customer/)).toBeInTheDocument();
    expect(screen.getByText('Row 2 (Bad Farm): REP_MUST_SELF_ASSIGN')).toBeInTheDocument();
  });

  it('says a row with no server answer may have saved', async () => {
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await importFile('farm_name\nLost Farm\n');
    expect(screen.getByText(/Row 2 \(Lost Farm\): No answer from the server: this customer may have saved/)).toBeInTheDocument();
  });

  it('refuses unquoted thousands and bad acreage instead of saving the wrong number', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([`farm_name,total_acres,notes\nA Farm,1,200,x\nB Farm,12abc\nC Farm,"1,2"\nD Farm,0\nE Farm,0x10\nF Farm,.5\nG Farm,${'9'.repeat(400)}\n`], 'c.csv', { type: 'text/csv' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    expect(await screen.findByText(/Row 2: More values than column headers/)).toBeInTheDocument();
    expect(screen.getByText('Row 3: Invalid total acres: 12abc')).toBeInTheDocument();
    expect(screen.getByText('Row 4: Invalid total acres: 1,2')).toBeInTheDocument();
    expect(screen.getByText('Row 6: Invalid total acres: 0x10')).toBeInTheDocument();
    expect(screen.getByText(/^Row 8: Invalid total acres: 9{400}$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 2 Customer(s)' })).toBeInTheDocument(); // D (0) and F (.5)
  });

  it('makes an admin row with an unclear tier invalid instead of using the default', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['farm_name,tier\nA Farm,Tier 2\nB Farm,2.5\nC Farm,2\nD Farm,\n'], 'c.csv', { type: 'text/csv' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    expect(await screen.findByText('Row 2: Invalid tier: Tier 2')).toBeInTheDocument();
    expect(screen.getByText('Row 3: Invalid tier: 2.5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 2 Customer(s)' })).toBeInTheDocument();
  });

  // #1998: the edge cases left after KI-145.
  function pick(container: HTMLElement, csv: string) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([csv], 'c.csv', { type: 'text/csv' })] } });
  }

  it('refuses an unquoted "1,200" that still fits the columns, but keeps real adjacent numbers', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    pick(container, 'farm_name,total_acres,notes,corn_acres,soybean_acres\nBig Farm,1,200,,\nNote Farm,5,200 bu,,\nQuoted Farm,"1,200",,,\nSplit Farm,,,500,300\n');
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    expect(await screen.findByText('Row 2: Unclear total acres: 1,200 has a comma but no quotes. Put quotes around numbers with commas, like "1,200"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 Customer(s)' }));
    await screen.findByText('Import Complete');
    expect(payloads().map((a) => a.p_customer_payload)).toEqual([
      expect.objectContaining({ farm_name: 'Note Farm', total_acres: 5, notes: '200 bu' }),
      expect.objectContaining({ farm_name: 'Quoted Farm', total_acres: 1200 }),
      expect.objectContaining({ farm_name: 'Split Farm', corn_acres: 500, soybean_acres: 300 }),
    ]);
  });

  it('refuses an unquoted "1,200" split across two acreage columns when the crop comes out above the total', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    pick(container, 'farm_name,total_acres,corn_acres,soybean_acres\nSplit Farm,1,200,\nReal Farm,500,300,200\n');
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    expect(await screen.findByText('Row 2: Unclear acres: corn acres (200) is more than total acres (1). Check the acres, or put quotes around numbers with commas, like "1,200"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 Customer(s)' }));
    await screen.findByText('Import Complete');
    expect(payloads().map((a) => a.p_customer_payload)).toEqual([
      expect.objectContaining({ farm_name: 'Real Farm', total_acres: 500, corn_acres: 300, soybean_acres: 200 }),
    ]);
  });

  it('refuses an unquoted "5,000" that splits into total acres 5 and corn acres 000', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    pick(container, 'farm_name,total_acres,corn_acres\nSmith Farm,5,000\nReal Farm,500,300\n');
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    expect(await screen.findByText('Row 2: Unclear total acres: 5,000 has a comma but no quotes. Put quotes around numbers with commas, like "1,200"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 Customer(s)' }));
    await screen.findByText('Import Complete');
    expect(payloads().map((a) => a.p_customer_payload)).toEqual([
      expect.objectContaining({ farm_name: 'Real Farm', total_acres: 500, corn_acres: 300 }),
    ]);
  });

  it('keeps an inch mark inside a cell as text instead of opening a quote', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    pick(container, 'farm_name,notes\nA Farm,12" tile\nB Farm,6" tile\nC Farm,ok\n');
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 3 Customer(s)' }));
    await screen.findByText('Import Complete');
    expect(payloads().map((a) => a.p_customer_payload)).toEqual([
      expect.objectContaining({ farm_name: 'A Farm', notes: '12" tile' }),
      expect.objectContaining({ farm_name: 'B Farm', notes: '6" tile' }),
      expect.objectContaining({ farm_name: 'C Farm', notes: 'ok' }),
    ]);
  });

  it('keeps a quoted value that spans lines in one record, with later rows on their file line', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    pick(container, 'farm_name,billing_address,notes\r\nLine Farm,"12 Main St\r\nSpringfield, IL","said ""hi"""\r\n,no name\r\n');
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    expect(await screen.findByText('Row 4: Missing farm name')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 Customer(s)' }));
    await screen.findByText('Import Complete');
    expect(payloads()[0].p_customer_payload).toMatchObject({ farm_name: 'Line Farm', billing_address: '12 Main St\nSpringfield, IL', notes: 'said "hi"' });
  });

  it('refuses a file with an unclosed quote instead of swallowing later rows', async () => {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    pick(container, 'farm_name,notes\nA Farm,"oops\nB Farm,fine\n');
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', 'Line 2 opens a quote that is never closed. Fix the quotes in that row and try again.'));
    expect(screen.queryByText('Valid Customers')).not.toBeInTheDocument();
  });

  it('retries an unanswered row with its original key', async () => {
    rpc
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ data: { status: 'saved', customer_id: 'c-2' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'saved', customer_id: 'c-1' }, error: null });
    await importFile('farm_name\nLost Farm\nOk Farm\n');
    fireEvent.click(screen.getByRole('button', { name: 'Retry 1 Unanswered Row(s)' }));
    expect(await screen.findByText(/Successfully imported 2 customer/)).toBeInTheDocument();
    const [first, , retry] = payloads();
    expect(retry.p_idempotency_key).toBe(first.p_idempotency_key);
    expect(retry.p_customer_payload).toEqual(first.p_customer_payload);
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  it('offers no retry for a row the server refused', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'REP_MUST_SELF_ASSIGN' } });
    await importFile('farm_name\nBad Farm\n');
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  it('drops the "No valid data" toast of a parse superseded by a newer file', async () => {
    let releaseTier!: (tier: 1 | 2 | 3) => void;
    vi.mocked(loadDefaultTier).mockReturnValueOnce(new Promise((r) => { releaseTier = r; }));
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    pick(container, 'farm_name\n');
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    pick(container, 'farm_name\nNew Farm\n');
    releaseTier(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows file upload area', () => {
    render(<BulkCustomerImport {...defaultProps} />);
    expect(screen.getByText(/csv/i)).toBeInTheDocument();
  });
});
