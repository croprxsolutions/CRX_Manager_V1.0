import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockRpc: vi.fn(), mockToast: vi.fn() }));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'user-1', role: 'sales_rep' }, role: 'sales_rep' }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: unknown): T => data as T,
  checkMutationResult: vi.fn(),
  rpcAuthErrorMessage: () => null,
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/fieldsGeojsonCache', () => ({ getCachedFieldsGeojson: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/plssLookup', () => ({ lookupPlss: vi.fn() }));
vi.mock('../lib/dateUtils', async (orig) => ({ ...(await orig<object>()), localToday: () => '2026-11-24' }));
let pickId = 'customer-3';
vi.mock('../components/customers/CustomerSearchPicker', () => ({
  default: ({ onSelect, ariaLabel }: { onSelect: (c: { id: string; farm_name: string }) => void; ariaLabel?: string }) => (
    <button type="button" onClick={() => onSelect({ id: pickId, farm_name: `Farm ${pickId}` })}>{ariaLabel ?? 'Pick'}</button>
  ),
}));
vi.mock('../components/map/CRXMap', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../components/map/DrawLayer', () => ({ default: () => null }));
vi.mock('../components/map/AddressSearch', () => ({ default: () => null }));
vi.mock('../components/map/FieldBoundaryLayer', () => ({ default: () => null }));
vi.mock('../components/map/FieldObstacleLayer', () => ({ default: () => null }));

import FieldSetup from './FieldSetup';

const FIELD = { id: 'field-1', field_name: 'North 80', customer_id: 'customer-1', state: 'IL', irrigation: false, is_active: true };
const payer = (id: string, farm: string, p: number, a = p) => ({
  customer_id: id, product_share_micro_pct: p, application_share_micro_pct: a, customer: { farm_name: farm },
});
const VERSIONS = [
  {
    id: 'version-2', version_number: 2, effective_from: '2026-11-20', history_known: true, created_by: 'rep-9',
    created_at: '2026-11-20T15:00:00Z',
    field_billing_split_payers: [payer('customer-1', 'Owner Farm', 100_000_000), payer('customer-2', 'Landlord Farm', 0)],
  },
  {
    id: 'version-1', version_number: 1, effective_from: '1900-01-01', history_known: false, created_by: null,
    created_at: '2026-11-24T00:00:00Z',
    field_billing_split_payers: [payer('customer-1', 'Owner Farm', 100_000_000)],
  },
];

function result(data: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'ilike', 'in']) self[m] = () => self;
  self.maybeSingle = () => Promise.resolve({ data, error: null });
  const promise = Promise.resolve({ data: Array.isArray(data) ? data : [], error: null });
  self.then = promise.then.bind(promise);
  return self;
}

let notes: unknown[] = [];
function tables(table: string) {
  if (table === 'fields') return result(FIELD);
  if (table === 'field_billing_split_versions') return result(VERSIONS);
  if (table === 'field_payer_notes') return result(notes);
  if (table === 'profile_public_directory') return result([{ id: 'rep-9', full_name: 'Pat Rep' }]);
  return result([]);
}

const calls = (name: string) => mockRpc.mock.calls.filter(([n]) => n === name).map(([, args]) => args);

async function open() {
  render(<RouterProvider router={createMemoryRouter([{ path: '/fields/:id', element: <FieldSetup /> }], { initialEntries: ['/fields/field-1'] })} />);
  await screen.findByText('Split history');
}

describe('Field Setup — FP-1 split versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    notes = [{ customer_id: 'customer-2', notes: 'Landlord, pays nothing' }];
    pickId = 'customer-3';
    mockFrom.mockImplementation(tables);
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === 'save_field' ? 'field-1' : name === 'set_field_billing_split' ? { wrote_version: true } : [],
      error: null,
    }));
  });

  it('shows history: version 1 as imported, later versions with date and who', async () => {
    await open();
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('2');
    expect(rows[1]).toHaveTextContent('2026-11-20');
    expect(rows[1]).toHaveTextContent('Pat Rep');
    expect(rows[1]).toHaveTextContent('Landlord Farm: 0.00% / 0.00%');
    expect(rows[1]).toHaveTextContent('in force');
    expect(within(rows[2]).getAllByText('Imported')).toHaveLength(2);
  });

  it('a name-only save writes no version and keeps the 0% payer and notes', async () => {
    await open();
    expect(screen.getByLabelText('Notes for Landlord Farm')).toHaveValue('Landlord, pays nothing');
    fireEvent.change(screen.getByLabelText(/Field Name/), { target: { value: 'North 80 East' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Field updated'));
    expect(calls('set_field_billing_split')).toHaveLength(0);
    // save_field gets today's split back exactly as loaded, so it writes no version (0% payers are not sent).
    expect(calls('save_field')[0].p_billing_defaults).toEqual([{ customer_id: 'customer-1', split_pct: '100.000000' }]);
  });

  it('a notes-only save sends notes and no split', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Notes for Landlord Farm'), { target: { value: 'Landlord, call first' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(calls('set_field_billing_split')).toHaveLength(1));
    expect(calls('set_field_billing_split')[0]).toMatchObject({
      p_payers: null, p_notes: [{ customer_id: 'customer-2', notes: 'Landlord, call first' }],
    });
    expect(calls('save_field')).toHaveLength(0);
  });

  it('thirds save as exact micro-percents and show 33.33% each', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add customer to billing split' }));
    fireEvent.click(screen.getByRole('button', { name: 'Split Evenly' }));
    expect(screen.getAllByDisplayValue('33.33')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(calls('set_field_billing_split')).toHaveLength(1));
    const sent = calls('set_field_billing_split')[0];
    expect(sent.p_payers.map((p: { product_share_micro_pct: number }) => p.product_share_micro_pct)).toEqual([33_333_334, 33_333_333, 33_333_333]);
    expect(sent.p_payers.map((p: { application_share_micro_pct: number }) => p.application_share_micro_pct)).toEqual([33_333_334, 33_333_333, 33_333_333]);
    expect(sent).toMatchObject({ p_field_id: 'field-1', p_effective_from: '2026-11-24', p_notes: null });
    expect(sent.p_idempotency_key).toMatch(/^set_field_billing_split:user-1:/);
  });

  it('refuses a 90% total with a clear message and sends nothing', async () => {
    await open();
    const [product] = screen.getAllByLabelText('Product share for Owner Farm');
    fireEvent.change(product, { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Product shares must total exactly 100% (now 90%)')));
    expect(calls('set_field_billing_split')).toHaveLength(0);
  });

  it('refuses adding a payer already in the split', async () => {
    pickId = 'customer-2';
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add customer to billing split' }));
    expect(mockToast).toHaveBeenCalledWith('error', 'This customer is already in the billing split');
  });

  it('a 0% application payer is sent as 0, not dropped', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Product share for Owner Farm'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Product share for Landlord Farm'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(calls('set_field_billing_split')).toHaveLength(1));
    expect(calls('set_field_billing_split')[0].p_payers).toEqual([
      { customer_id: 'customer-1', product_share_micro_pct: 60_000_000, application_share_micro_pct: 100_000_000 },
      { customer_id: 'customer-2', product_share_micro_pct: 40_000_000, application_share_micro_pct: 0 },
    ]);
  });

  it('a retry of the same save reuses its key; the database refusal is shown plainly', async () => {
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'set_field_billing_split'
      ? { data: null, error: { message: 'FIELD_SPLIT_PAYER_NOT_ACTIVE: customer(s) x are not active customers' } }
      : { data: [], error: null }));
    await open();
    fireEvent.change(screen.getByLabelText('Notes for Owner Farm'), { target: { value: 'Call before spraying' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'A payer in this split is not an active customer.'));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(calls('set_field_billing_split')).toHaveLength(2));
    const [first, second] = calls('set_field_billing_split');
    expect(second.p_idempotency_key).toBe(first.p_idempotency_key);
  });
});
