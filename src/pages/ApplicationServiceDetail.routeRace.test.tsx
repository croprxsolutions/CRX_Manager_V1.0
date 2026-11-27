import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router';
import type { ReactNode } from 'react';

// Keep useNavigate (the page) and useBlocker (the hook) in the same router package copy.
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

type ServiceRow = {
  id: string;
  name: string;
  vehicle_id: string | null;
  default_rate_per_acre_cents: number;
  is_active: boolean;
  sort_order: number;
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
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
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({
    getKeyFor: (scope: string) => `retry-key-${scope}`,
    resetKeyFor: vi.fn(),
  }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../components/customers/CustomerSearchPicker', () => ({
  default: ({ disabled }: { disabled?: boolean }) => <button disabled={disabled}>Customer picker</button>,
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
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    if (table === 'customer_application_rates') return overrideReads.get(id)?.promise.then(resolve, reject);
    return Promise.resolve({ data: [], error: null }).then(resolve, reject);
  };
  return builder;
}

function RouteControls() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <output data-testid="route-path">{location.pathname}</output>
      <button onClick={() => navigate('/application-services/service-a')}>Switch to service A</button>
      <button onClick={() => navigate('/application-services/service-b')}>Switch to service B</button>
      <button onClick={() => navigate('/application-services/new')}>Switch to new service</button>
    </>
  );
}

function renderDetail(children: ReactNode, initialPath = '/application-services/service-a') {
  const router = createMemoryRouter([{
    path: '/',
    element: <><RouteControls /><Outlet /></>,
    children: [
      { path: 'application-services/:id', element: children },
      { path: 'application-services', element: <div>Application services list</div> },
    ],
  }], { initialEntries: [initialPath] });
  return { ...render(<RouterProvider router={router} />), router };
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
  it('shows the loading skeleton between a loaded service and the next service', async () => {
    const serviceReads = new Map([
      ['service-a', deferred<{ data: ServiceRow; error: null }>()],
      ['service-b', deferred<{ data: ServiceRow; error: null }>()],
    ]);
    const overrideReads = new Map([
      ['service-a', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()],
      ['service-b', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()],
    ]);
    const billingB = deferred<{
      available: boolean;
      billsCustomer: boolean;
      outsideVendorId: string | null;
      existingVendor: { id: string; name: string } | null;
      activeVendors: Array<{ id: string; name: string }>;
    }>();
    mocks.from.mockImplementation((table: string) => routeOverrides(table, serviceReads, overrideReads));
    mocks.loadBilling.mockImplementation((serviceId: string) => serviceId === 'service-a'
      ? Promise.resolve({
        available: true,
        billsCustomer: true,
        outsideVendorId: 'vendor-a',
        existingVendor: { id: 'vendor-a', name: 'Vendor A' },
        activeVendors: [{ id: 'vendor-a', name: 'Vendor A' }],
      })
      : billingB.promise);
    mocks.rpc.mockImplementation((name: string, args?: { p_service_id?: string }) => {
      if (name === 'admin_get_application_service_costs') {
        const cost = args?.p_service_id === 'service-a' ? '500' : '700';
        return Promise.resolve({ data: [{ service_id: args?.p_service_id, cost_per_acre_cents: cost }], error: null });
      }
      return Promise.resolve({ data: { success: true, service_id: args?.p_service_id, created: false }, error: null });
    });

    const { default: ApplicationServiceDetail } = await import('./ApplicationServiceDetail');
    const { container } = renderDetail(<ApplicationServiceDetail />);

    await act(async () => {
      serviceReads.get('service-a')?.resolve({ data: routeRow('service-a', 'Service A', 1500, true, 1), error: null });
      overrideReads.get('service-a')?.resolve({
        data: [{ id: 'override-a', customer: { farm_name: 'Farm A' }, rate_per_acre_cents: 900, season: 2026 }],
        error: null,
      });
    });
    expect(await screen.findByLabelText(/Service Name/)).toHaveValue('Service A');
    expect(screen.getByLabelText('Default Rate / Acre ($)')).toHaveValue(15);
    expect(screen.getByLabelText('Cost / Acre ($)')).toHaveValue(5);
    expect(screen.getByText('Farm A')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to service B' }));
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(screen.queryByLabelText(/Service Name/)).toBeNull();

    await act(async () => {
      serviceReads.get('service-b')?.resolve({ data: routeRow('service-b', 'Service B', 2400, false, 7), error: null });
      overrideReads.get('service-b')?.resolve({
        data: [{ id: 'override-b', customer: { farm_name: 'Farm B' }, rate_per_acre_cents: 1200, season: 2026 }],
        error: null,
      });
    });
    await waitFor(() => expect(mocks.loadBilling).toHaveBeenCalledWith('service-b', true));
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();

    await act(async () => {
      billingB.resolve({
        available: true,
        billsCustomer: false,
        outsideVendorId: 'vendor-b',
        existingVendor: { id: 'vendor-b', name: 'Vendor B' },
        activeVendors: [{ id: 'vendor-b', name: 'Vendor B' }],
      });
    });
    expect(await screen.findByLabelText(/Service Name/)).toHaveValue('Service B');
    expect(screen.getByLabelText('Default Rate / Acre ($)')).toHaveValue(24);
    expect(screen.getByLabelText('Cost / Acre ($)')).toHaveValue(7);
    expect(screen.getByLabelText('Sort Order')).toHaveValue(7);
    expect(screen.getByLabelText('Outside company')).toHaveValue('vendor-b');
    expect(screen.getByText('Farm B')).toBeTruthy();
    expect(screen.queryByText('Farm A')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to new service' }));
    expect(await screen.findByLabelText(/Service Name/)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create Service' })).toBeTruthy();
    expect(screen.queryByText('Farm B')).toBeNull();
  });

  it('freezes the service form and blocks navigation until a save finishes', async () => {
    const serviceReads = new Map([
      ['service-a', deferred<{ data: ServiceRow; error: null }>()],
      ['service-b', deferred<{ data: ServiceRow; error: null }>()],
    ]);
    const overrideReads = new Map([
      ['service-a', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()],
      ['service-b', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()],
    ]);
    const pendingSave = deferred<{ success: true; service_id: string; created: false }>();
    mocks.from.mockImplementation((table: string) => routeOverrides(table, serviceReads, overrideReads));
    mocks.loadBilling.mockResolvedValue({
      available: true,
      billsCustomer: true,
      outsideVendorId: '',
      existingVendor: null,
      activeVendors: [],
    });
    mocks.rpc.mockImplementation((name: string, args?: { p_service_id?: string }) => {
      if (name === 'admin_get_application_service_costs') {
        return Promise.resolve({ data: [{ service_id: args?.p_service_id, cost_per_acre_cents: '800' }], error: null });
      }
      return Promise.resolve({ data: { success: true, service_id: args?.p_service_id, created: false }, error: null });
    });
    mocks.save.mockReturnValueOnce(pendingSave.promise);

    const { default: ApplicationServiceDetail } = await import('./ApplicationServiceDetail');
    const { router } = renderDetail(<ApplicationServiceDetail />);

    await act(async () => {
      serviceReads.get('service-a')?.resolve({ data: routeRow('service-a', 'Service A', 1500, true, 1), error: null });
      overrideReads.get('service-a')?.resolve({ data: [], error: null });
    });
    const nameField = await screen.findByLabelText(/Service Name/);
    fireEvent.change(nameField, { target: { value: 'Service A updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));

    expect(nameField).toBeDisabled();
    expect(screen.getByLabelText('Default Rate / Acre ($)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Customer picker' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to service B' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('info', 'Saving — please wait'));
    expect(router.state.location.pathname).toBe('/application-services/service-a');

    await act(async () => {
      pendingSave.resolve({ success: true, service_id: 'service-a', created: false });
    });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'Service saved'));
    expect(screen.getByLabelText(/Service Name/)).toHaveValue('Service A updated');
    expect(screen.getByLabelText(/Service Name/)).not.toBeDisabled();
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ p_name: 'Service A updated', p_service_id: 'service-a' });

    fireEvent.click(screen.getByRole('button', { name: 'Switch to service B' }));
    expect(router.state.location.pathname).toBe('/application-services/service-b');
    await act(async () => {
      serviceReads.get('service-b')?.resolve({ data: routeRow('service-b', 'Service B', 2400, false, 7), error: null });
      overrideReads.get('service-b')?.resolve({ data: [], error: null });
    });
    expect(await screen.findByLabelText(/Service Name/)).toHaveValue('Service B');
  });

  it('finishes a new-service save with its success message and created-service navigation', async () => {
    const serviceReads = new Map([['created-service', deferred<{ data: ServiceRow; error: null }>()]]);
    const overrideReads = new Map([['created-service', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()]]);
    const pendingSave = deferred<{ success: true; service_id: string; created: true }>();
    mocks.from.mockImplementation((table: string) => routeOverrides(table, serviceReads, overrideReads));
    mocks.loadBilling.mockResolvedValue({
      available: true,
      billsCustomer: true,
      outsideVendorId: '',
      existingVendor: null,
      activeVendors: [],
    });
    mocks.rpc.mockImplementation((name: string, args?: { p_service_id?: string }) => {
      if (name === 'admin_get_application_service_costs') {
        return Promise.resolve({ data: [{ service_id: args?.p_service_id, cost_per_acre_cents: '600' }], error: null });
      }
      return Promise.resolve({ data: { success: true, service_id: args?.p_service_id, created: false }, error: null });
    });
    mocks.save.mockReturnValueOnce(pendingSave.promise);

    const { default: ApplicationServiceDetail } = await import('./ApplicationServiceDetail');
    const { router } = renderDetail(<ApplicationServiceDetail />, '/application-services/new');
    fireEvent.change(await screen.findByLabelText(/Service Name/), { target: { value: 'New service' } });
    fireEvent.change(screen.getByLabelText('Default Rate / Acre ($)'), { target: { value: '18.00' } });
    fireEvent.change(screen.getByLabelText('Cost / Acre ($)'), { target: { value: '6.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Service' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));

    expect(screen.getByLabelText(/Service Name/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create Service' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to service B' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('info', 'Saving — please wait'));
    expect(router.state.location.pathname).toBe('/application-services/new');

    await act(async () => {
      pendingSave.resolve({ success: true, service_id: 'created-service', created: true });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/application-services/created-service'));
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Application service created');
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ p_name: 'New service', p_service_id: null });
    await act(async () => {
      serviceReads.get('created-service')?.resolve({ data: routeRow('created-service', 'New service', 1800, true, 0), error: null });
      overrideReads.get('created-service')?.resolve({ data: [], error: null });
    });
    expect(await screen.findByLabelText(/Service Name/)).toHaveValue('New service');
  });

  it('keeps the form loading until the overrides read finishes', async () => {
    const serviceReads = new Map([
      ['service-a', deferred<{ data: ServiceRow; error: null }>()],
    ]);
    const overrideReads = new Map([
      ['service-a', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()],
    ]);
    mocks.from.mockImplementation((table: string) => routeOverrides(table, serviceReads, overrideReads));
    mocks.loadBilling.mockResolvedValue({
      available: true,
      billsCustomer: true,
      outsideVendorId: '',
      existingVendor: null,
      activeVendors: [],
    });
    mocks.rpc.mockResolvedValue({ data: [{ service_id: 'service-a', cost_per_acre_cents: '800' }], error: null });

    const { default: ApplicationServiceDetail } = await import('./ApplicationServiceDetail');
    const { container } = renderDetail(<ApplicationServiceDetail />);

    await act(async () => {
      serviceReads.get('service-a')?.resolve({ data: routeRow('service-a', 'Service A', 1500, true, 1), error: null });
    });
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByLabelText(/Service Name/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();

    await act(async () => {
      overrideReads.get('service-a')?.resolve({
        data: [{ id: 'override-a', customer: { farm_name: 'Farm A' }, rate_per_acre_cents: 900, season: 2026 }],
        error: null,
      });
    });
    expect(await screen.findByLabelText(/Service Name/)).toHaveValue('Service A');
    expect(screen.getByText('Farm A')).toBeTruthy();
  });

  it('reports a rejected overrides read and leaves the detail page without an editable form', async () => {
    const serviceReads = new Map([
      ['service-a', deferred<{ data: ServiceRow; error: null }>()],
    ]);
    const overrideReads = new Map([
      ['service-a', deferred<{ data: Array<{ id: string; customer: { farm_name: string }; rate_per_acre_cents: number; season: number }>; error: null }>()],
    ]);
    mocks.from.mockImplementation((table: string) => routeOverrides(table, serviceReads, overrideReads));
    mocks.loadBilling.mockResolvedValue({
      available: true,
      billsCustomer: true,
      outsideVendorId: '',
      existingVendor: null,
      activeVendors: [],
    });
    mocks.rpc.mockResolvedValue({ data: [{ service_id: 'service-a', cost_per_acre_cents: '800' }], error: null });

    const { default: ApplicationServiceDetail } = await import('./ApplicationServiceDetail');
    const { router } = renderDetail(<ApplicationServiceDetail />);

    await act(async () => {
      serviceReads.get('service-a')?.resolve({ data: routeRow('service-a', 'Service A', 1500, true, 1), error: null });
      overrideReads.get('service-a')?.reject(new Error('override read failed'));
    });

    await waitFor(() => expect(router.state.location.pathname).toBe('/application-services'));
    expect(screen.queryByLabelText(/Service Name/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: { context: 'load_application_service_detail', serviceId: 'service-a' },
    });
    expect(mocks.toast).toHaveBeenCalledWith('error', 'Failed to load application service');
  });

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
    }, 'retry-key-service-b', true));
  });
});
