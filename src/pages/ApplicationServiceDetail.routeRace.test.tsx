import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';

type ServiceRow = {
  id: string;
  name: string;
  vehicle_id: string | null;
  default_rate_per_acre_cents: number;
  is_active: boolean;
  sort_order: number;
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  loadBilling: vi.fn(),
  save: vi.fn(),
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
  return {
    ...actual,
    APPLICATION_SERVICE_BILLING_DB_READY: true,
    loadApplicationServiceBillingForm: mocks.loadBilling,
    loadActiveApplicationServiceVendors: vi.fn().mockResolvedValue([]),
    saveApplicationService: mocks.save,
  };
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

function routeRow(id: string, name: string, rate: number, isActive: boolean, sortOrder: number): ServiceRow {
  return {
    id,
    name,
    vehicle_id: null,
    default_rate_per_acre_cents: rate,
    is_active: isActive,
    sort_order: sortOrder,
  };
}

function routeOverrides(
  table: string,
  serviceReads: Map<string, Deferred<{ data: ServiceRow; error: null }>>,
  overrideReads: Map<string, Deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>>,
) {
  let id = '';
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (_column: string, value: string) => { id = value; return builder; };
  builder.order = () => builder;
  builder.single = () => serviceReads.get(id)?.promise;
  builder.then = (resolve: (value: unknown) => unknown) => {
    if (table === 'customer_application_rates') return overrideReads.get(id)?.promise.then(resolve);
    return Promise.resolve({ data: [], error: null }).then(resolve);
  };
  return builder;
}

function RouteControls() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/application-services/service-b')}>Switch to service B</button>;
}

function renderDetail(children: ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/application-services/service-a']}>
      <RouteControls />
      <Routes><Route path="/application-services/:id" element={children} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset();
  mocks.loadBilling.mockReset();
  mocks.save.mockReset();
  mocks.toast.mockReset();
  mocks.captureException.mockReset();
});

afterEach(cleanup);

describe('ApplicationServiceDetail route changes', () => {
  it('ignores late service and override reads and saves the current service values', async () => {
    const serviceReads = new Map([
      ['service-a', deferred<{ data: ServiceRow; error: null }>()],
      ['service-b', deferred<{ data: ServiceRow; error: null }>()],
    ]);
    const overrideReads = new Map([
      ['service-a', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()],
      ['service-b', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()],
    ]);
    mocks.from.mockImplementation((table: string) => routeOverrides(table, serviceReads, overrideReads));
    mocks.loadBilling.mockResolvedValue({
      available: true,
      billsCustomer: false,
      outsideVendorId: 'vendor-b',
      existingVendor: { id: 'vendor-b', name: 'Vendor B' },
      activeVendors: [{ id: 'vendor-b', name: 'Vendor B' }],
    });
    mocks.rpc.mockImplementation((name: string, args?: { p_service_id?: string }) => {
      if (name === 'admin_get_application_service_costs') {
        return Promise.resolve({ data: [{ service_id: args?.p_service_id, cost_per_acre_cents: '800' }], error: null });
      }
      return Promise.resolve({ data: { success: true, service_id: 'service-b', created: false }, error: null });
    });
    mocks.save.mockResolvedValue({ success: true, service_id: 'service-b', created: false });

    const { default: ApplicationServiceDetail } = await import('./ApplicationServiceDetail');
    renderDetail(<ApplicationServiceDetail />);

    fireEvent.click(screen.getByRole('button', { name: 'Switch to service B' }));
    await act(async () => {
      serviceReads.get('service-b')?.resolve({ data: routeRow('service-b', 'Service B', 2400, false, 7), error: null });
      overrideReads.get('service-b')?.resolve({
        data: [{ id: 'override-b', customer: { farm_name: 'Farm B' }, rate_per_acre_cents: 1200, season: 2026 }],
        error: null,
      });
    });

    expect(await screen.findByLabelText(/Service Name/)).toHaveValue('Service B');
    expect(screen.getByLabelText('Default Rate / Acre ($)')).toHaveValue(24);
    expect(screen.getByLabelText('Cost / Acre ($)')).toHaveValue(8);
    expect(screen.getByLabelText('Sort Order')).toHaveValue(7);
    expect((screen.getByLabelText('CRX bills the customer for this service') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText('Outside company')).toHaveValue('vendor-b');
    expect(screen.getByText('Farm B')).toBeTruthy();

    await act(async () => {
      serviceReads.get('service-a')?.resolve({ data: routeRow('service-a', 'Service A', 1000, true, 1), error: null });
      overrideReads.get('service-a')?.resolve({
        data: [{ id: 'override-a', customer: { farm_name: 'Farm A' }, rate_per_acre_cents: 900, season: 2026 }],
        error: null,
      });
    });

    expect(screen.getByLabelText(/Service Name/)).toHaveValue('Service B');
    expect(screen.getByText('Farm B')).toBeTruthy();
    expect(screen.queryByText('Farm A')).toBeNull();
    expect(mocks.loadBilling).not.toHaveBeenCalledWith('service-a');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({
      p_name: 'Service B',
      p_default_rate_per_acre_cents: 2400,
      p_is_active: false,
      p_sort_order: 7,
      p_vehicle_id: null,
      p_cost_per_acre_cents: 800,
      p_service_id: 'service-b',
    }, {
      billsCustomer: false,
      outsideVendorId: 'vendor-b',
      clearOutsideVendor: false,
    }, 'retry-key-1'));
  });
});
