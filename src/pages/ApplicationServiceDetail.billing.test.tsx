import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

const SERVICE_ROW = {
  id: 'service-1',
  name: 'Y-Drop Nitrogen',
  vehicle_id: null,
  default_rate_per_acre_cents: 1200,
  is_active: true,
  sort_order: 0,
};

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    supabase: { from: mocks.from, rpc: mocks.rpc },
    supabaseUntyped: { from: mocks.from, rpc: mocks.rpc },
  };
});

vi.mock('../lib/applicationServiceBilling', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, APPLICATION_SERVICE_BILLING_DB_READY: true };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'user-1', full_name: 'Test Admin', role: 'admin', is_active: true },
    user: { id: 'user-1' },
    loading: false,
  }),
}));

vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'retry-key-1', resetKey: vi.fn() }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../components/customers/CustomerSearchPicker', () => ({
  default: () => <div>Customer picker</div>,
}));

function queryFor(table: string) {
  let selected = '';
  const builder: Record<string, unknown> = {};
  builder.select = (columns: string) => { selected = columns; return builder; };
  for (const method of ['eq', 'order', 'is', 'in']) builder[method] = () => builder;
  builder.single = () => Promise.resolve({ data: SERVICE_ROW, error: null });
  builder.then = (resolve: (value: unknown) => unknown) => {
    const result = table === 'application_services' && selected.includes('bills_customer')
      ? { data: null, error: { message: 'network unavailable' } }
      : { data: [], error: null };
    return Promise.resolve(result).then(resolve);
  };
  return builder;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/application-services/service-1']}>
    <Routes><Route path="/application-services/:id" element={children} /></Routes>
  </MemoryRouter>
);

beforeEach(() => {
  mocks.from.mockImplementation((table: string) => queryFor(table));
  mocks.rpc.mockImplementation((name: string) => {
    if (name === 'admin_get_application_service_costs') {
      return Promise.resolve({ data: [{ service_id: 'service-1', cost_per_acre_cents: '650' }], error: null });
    }
    return Promise.resolve({
      data: { success: true, service_id: 'service-1', created: false },
      error: null,
    });
  });
  mocks.toast.mockReset();
  mocks.captureException.mockReset();
});

afterEach(cleanup);

describe('ApplicationServiceDetail billing fields', () => {
  it('omits all billing arguments when a ready database billing read fails for an existing service', async () => {
    const { default: ApplicationServiceDetail } = await import('./ApplicationServiceDetail');
    render(<ApplicationServiceDetail />, { wrapper });

    const billedCheckbox = await screen.findByLabelText('CRX bills the customer for this service') as HTMLInputElement;
    const outsideCompany = screen.getByLabelText('Outside company') as HTMLSelectElement;
    expect(billedCheckbox.checked).toBe(true);
    expect(billedCheckbox.disabled).toBe(true);
    expect(outsideCompany.disabled).toBe(true);
    expect(screen.getAllByText('Not available yet')).toHaveLength(2);
    expect(screen.getByText('Acres are always logged. When CRX does not bill this service, invoices carry products only, no service line.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Sort Order'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'admin_save_application_service',
      expect.objectContaining({ p_sort_order: 42 }),
    ));
    const saveCall = mocks.rpc.mock.calls.find((call) => call[0] === 'admin_save_application_service');
    expect(saveCall?.[1]).toEqual({
      p_name: 'Y-Drop Nitrogen',
      p_default_rate_per_acre_cents: 1200,
      p_is_active: true,
      p_sort_order: 42,
      p_vehicle_id: null,
      p_cost_per_acre_cents: 650,
      p_service_id: 'service-1',
      p_idempotency_key: 'retry-key-1',
    });
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Service saved');
  });
});
