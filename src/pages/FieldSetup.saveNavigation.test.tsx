/**
 * FieldSetup.saveNavigation.test.tsx — a NEW field whose acreage step fails after the field saved.
 *
 * Bug (seen in the private test app, 2026-11-01): the move to the saved field was stopped by the
 * Unsaved Changes prompt, and Stay left the user on /fields/new, where saving again created a
 * second field. Uses the REAL data router, the REAL hook and the REAL modal.
 */
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';

// Same module copy for the page's useNavigate and the hook's useBlocker.
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockDrawnPolygon, mockFrom, mockHasKey, mockRpc, mockToast } = vi.hoisted(() => ({
  mockDrawnPolygon: {
    drawId: 'draw-1',
    acres: 40,
    label: 'Part 1',
    polygon: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[-89.05, 39.15], [-89.0475, 39.15], [-89.0475, 39.1523], [-89.05, 39.1523], [-89.05, 39.15]]],
      },
    },
  },
  mockFrom: vi.fn(),
  mockHasKey: vi.fn(() => false),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin' }),
}));
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
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'key', resetKey: vi.fn(), getKeyFor: () => 'key', resetKeyFor: vi.fn(), hasKeyFor: mockHasKey }),
}));
vi.mock('../components/customers/CustomerSearchPicker', () => ({
  default: ({ onSelect }: { onSelect: (customer: { id: string; farm_name: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: 'customer-1', farm_name: 'Test Farm' })}>Pick owner</button>
  ),
}));
vi.mock('../components/map/CRXMap', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../components/map/DrawLayer', () => ({
  default: ({ onPolygonsChange }: { onPolygonsChange?: (polygons: unknown[]) => void }) => (
    <>
      <button type="button" onClick={() => onPolygonsChange?.([mockDrawnPolygon])}>Draw boundary</button>
      <button type="button" onClick={() => onPolygonsChange?.([])}>Delete every part</button>
    </>
  ),
}));
vi.mock('../components/map/AddressSearch', () => ({ default: () => null }));
vi.mock('../components/map/FieldBoundaryLayer', () => ({ default: () => null }));
vi.mock('../components/map/FieldObstacleLayer', () => ({ default: () => null }));

import FieldSetup from './FieldSetup';

function chain(row: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'or', 'not', 'order', 'limit', 'ilike']) self[m] = () => self;
  self.maybeSingle = () => Promise.resolve({ data: row, error: null });
  const promise = Promise.resolve({ data: [], error: null });
  self.then = promise.then.bind(promise);
  return self;
}

// The tab-close warning is armed exactly while the page holds unsaved changes (useUnsavedChanges).
function leaveWarningArmed() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function saveFieldCalls() {
  return mockRpc.mock.calls.filter(([name]) => name === 'save_field');
}

async function renderNewField() {
  const router = createMemoryRouter(
    [{ path: '/fields/:id', element: <FieldSetup /> }],
    { initialEntries: ['/fields/new'] },
  );
  render(<RouterProvider router={router} />);
  fireEvent.change(await screen.findByLabelText(/Field Name/), { target: { value: 'North 80' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pick owner' }));
  return router;
}

describe('FieldSetup — a new field whose acreage step fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasKey.mockReturnValue(false);
    mockFrom.mockImplementation((table: string) => chain(
      table === 'fields' ? { id: 'field-1', field_name: 'North 80', customer_id: 'customer-1' } : null,
    ));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field') return Promise.resolve({ data: 'field-1', error: null });
      if (name === 'set_field_override_acres' || name === 'set_field_boundary') {
        return Promise.resolve({ data: null, error: new Error('forced failure') });
      }
      return Promise.resolve({ data: [], error: null });
    });
  });

  it('moves to the saved field with no prompt when the acres to bill fail, and keeps the message', async () => {
    const router = await renderNewField();
    fireEvent.change(screen.getByLabelText(/Acres to bill/), { target: { value: '123.4' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/fields/field-1'));
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('123.4 acres to bill could not be applied'));
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();

    await screen.findByRole('button', { name: /Save Changes/ });
    expect(saveFieldCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(saveFieldCalls()).toHaveLength(2));
    expect(saveFieldCalls()[1][1]).toMatchObject({ p_field_id: 'field-1' });
  });

  it('moves to the saved field with no prompt when the boundary fails, and keeps the message', async () => {
    const router = await renderNewField();
    fireEvent.click(await screen.findByRole('button', { name: 'Draw boundary' }));
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/fields/field-1'));
    expect(mockToast).toHaveBeenCalledWith('error', 'Field saved but the boundary could not be measured. Please re-draw and save.');
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
  });

  it('a changed retry after a lost create opens the created field and applies none of the edit', async () => {
    mockRpc.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    const router = await renderNewField();
    fireEvent.change(screen.getByLabelText(/Acres to bill/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));
    await waitFor(() => expect(saveFieldCalls()).toHaveLength(1));

    mockHasKey.mockReturnValue(true); // the lost attempt's key is kept
    fireEvent.change(screen.getByLabelText(/Field Name/), { target: { value: 'South 40' } });
    fireEvent.change(screen.getByLabelText(/Acres to bill/), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/fields/field-1'));
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('An earlier save may already have created this field'));
    expect(mockRpc.mock.calls.some(([name]) => name === 'set_field_override_acres')).toBe(false);
  });

  it('a changed retry whose first attempt never reached the server keeps its acreage', async () => {
    mockRpc.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderNewField();
    fireEvent.change(screen.getByLabelText(/Acres to bill/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));
    await waitFor(() => expect(saveFieldCalls()).toHaveLength(1));

    mockHasKey.mockReturnValue(true);
    // The saved row holds this retry's details, so this retry created it.
    mockFrom.mockImplementation((table: string) => chain(
      table === 'fields' ? { field_name: 'South 40', customer_id: 'customer-1', state: 'IL', irrigation: false, is_active: true } : null,
    ));
    fireEvent.change(screen.getByLabelText(/Field Name/), { target: { value: 'South 40' } });
    fireEvent.change(screen.getByLabelText(/Acres to bill/), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_field_override_acres', expect.objectContaining({ p_field_id: 'field-1', p_override_acres: 35 })));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.anything());
  });

  it('a changed retry is not trusted when the saved billing splits differ from what it sent', async () => {
    mockRpc.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderNewField();
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));
    await waitFor(() => expect(saveFieldCalls()).toHaveLength(1));

    mockHasKey.mockReturnValue(true);
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'field_billing_defaults') {
        return chain(table === 'fields' ? { field_name: 'South 40', customer_id: 'customer-1', state: 'IL', irrigation: false, is_active: true } : null);
      }
      const self = chain(null);
      const splits = Promise.resolve({ data: [{ customer_id: 'customer-9', split_pct: 100, is_primary: true, notes: null, price_override_cents: null, pricing_note: null }], error: null });
      self.then = splits.then.bind(splits);
      return self;
    });
    fireEvent.change(screen.getByLabelText(/Field Name/), { target: { value: 'South 40' } });
    fireEvent.change(screen.getByLabelText(/Acres to bill/), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('An earlier save may already have created this field')));
    expect(mockRpc.mock.calls.some(([name]) => name === 'set_field_override_acres')).toBe(false);
  });

  it('a retry that changes only the acreage saves it on the field', async () => {
    mockRpc.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderNewField();
    fireEvent.change(screen.getByLabelText(/Acres to bill/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));
    await waitFor(() => expect(saveFieldCalls()).toHaveLength(1));

    mockHasKey.mockReturnValue(true);
    fireEvent.change(screen.getByLabelText(/Acres to bill/), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Field/ }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_field_override_acres', expect.objectContaining({ p_field_id: 'field-1', p_override_acres: 35 })));
  });
});

describe('FieldSetup — an attribute-only save after a boundary save (KI-31)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasKey.mockReturnValue(false);
    mockFrom.mockImplementation((table: string) => chain(
      table === 'fields' ? { id: 'field-1', field_name: 'North 80', customer_id: 'customer-1', total_acres: 12 } : null,
    ));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field') return Promise.resolve({ data: true, error: null });
      if (name === 'set_field_boundary') return Promise.resolve({ data: { measured_acres: 40, billable_acres: 40 }, error: null });
      return Promise.resolve({ data: [], error: null });
    });
  });

  it('sends the acres the boundary save stored, not the acres loaded at the start', async () => {
    const router = createMemoryRouter([{ path: '/fields/:id', element: <FieldSetup /> }], { initialEntries: ['/fields/field-1'] });
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draw boundary' }));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Field updated'));
    expect(saveFieldCalls()[0][1].p_field_payload).toMatchObject({ total_acres: 12 });

    fireEvent.change(screen.getByDisplayValue('Select crop...'), { target: { value: 'corn' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(saveFieldCalls()).toHaveLength(2));
    expect(saveFieldCalls()[1][1].p_field_payload).toMatchObject({ crop_type: 'corn', total_acres: 40 });
    expect(mockRpc.mock.calls.filter(([name]) => name === 'set_field_boundary')).toHaveLength(1);
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
  });

  it('sends the acres an override save stored', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field') return Promise.resolve({ data: true, error: null });
      if (name === 'set_field_override_acres') return Promise.resolve({ data: { override_acres: 55, billable_acres: 55 }, error: null });
      return Promise.resolve({ data: [], error: null });
    });
    const router = createMemoryRouter([{ path: '/fields/:id', element: <FieldSetup /> }], { initialEntries: ['/fields/field-1'] });
    render(<RouterProvider router={router} />);
    fireEvent.change(await screen.findByLabelText(/Acres to bill/), { target: { value: '55' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Field updated'));

    fireEvent.change(screen.getByDisplayValue('Select crop...'), { target: { value: 'corn' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(saveFieldCalls()).toHaveLength(2));
    expect(saveFieldCalls()[1][1].p_field_payload).toMatchObject({ crop_type: 'corn', total_acres: 55 });
    expect(mockRpc.mock.calls.filter(([name]) => name === 'set_field_override_acres')).toHaveLength(1);
  });

  it('leaves with no prompt after a save that synced acres and changed a billing split', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'field_billing_defaults') {
        return chain(table === 'fields' ? { id: 'field-1', field_name: 'North 80', customer_id: 'customer-1', total_acres: 12 } : null);
      }
      const self = chain(null);
      const splits = Promise.resolve({ data: [{ customer_id: 'customer-1', customer: { farm_name: 'Test Farm' }, split_pct: 100, is_primary: true, notes: null, price_override_cents: null, pricing_note: null }], error: null });
      self.then = splits.then.bind(splits);
      return self;
    });
    const router = createMemoryRouter(
      [{ path: '/fields/:id', element: <FieldSetup /> }, { path: '/other', element: <div>Other page</div> }],
      { initialEntries: ['/fields/field-1'] },
    );
    render(<RouterProvider router={router} />);
    fireEvent.change(await screen.findByPlaceholderText('e.g. Prepaid rate, Landlord rate'), { target: { value: 'Landlord rate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draw boundary' }));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Field updated'));
    expect(saveFieldCalls()[0][1].p_billing_defaults).toMatchObject([{ pricing_note: 'Landlord rate' }]);

    await waitFor(() => expect(leaveWarningArmed()).toBe(false)); // the post-save dirty check has settled clean
    await router.navigate('/other');
    expect(router.state.location.pathname).toBe('/other');
    expect(await screen.findByText('Other page')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
  });

  it('keeps an edit made while the save was in flight unsaved', async () => {
    let finishBoundary: (value: unknown) => void = () => {};
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field') return Promise.resolve({ data: true, error: null });
      if (name === 'set_field_boundary') return new Promise((resolve) => { finishBoundary = resolve; });
      return Promise.resolve({ data: [], error: null });
    });
    const router = createMemoryRouter(
      [{ path: '/fields/:id', element: <FieldSetup /> }, { path: '/other', element: <div>Other page</div> }],
      { initialEntries: ['/fields/field-1'] },
    );
    render(<RouterProvider router={router} />);
    const removeListener = vi.spyOn(window, 'removeEventListener');
    fireEvent.click(await screen.findByRole('button', { name: 'Draw boundary' }));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_field_boundary', expect.anything()));
    fireEvent.change(screen.getByDisplayValue('Select crop...'), { target: { value: 'corn' } });
    finishBoundary({ data: { measured_acres: 40, billable_acres: 40 }, error: null });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Field updated'));

    // The save cleared the warning, then the mid-save edit re-armed it: that re-render is committed.
    await waitFor(() => {
      expect(removeListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
      expect(leaveWarningArmed()).toBe(true);
    });
    removeListener.mockRestore();
    await router.navigate('/other');
    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/fields/field-1');
  });
});

describe('FieldSetup — deleting every part of a saved multi-part boundary (KI-31)', () => {
  const part = (id: string, west: number) => ({
    id,
    polygon_geojson: { type: 'Polygon', coordinates: [[[west, 39.15], [west + 0.0025, 39.15], [west + 0.0025, 39.1523], [west, 39.1523], [west, 39.15]]] },
    label: null,
    acres: 40,
    sort_order: 0,
  });
  const parts = [part('poly-1', -89.05), part('poly-2', -89.04)];

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasKey.mockReturnValue(false);
    mockFrom.mockImplementation((table: string) => chain(
      table === 'fields' ? { id: 'field-1', field_name: 'North 80', customer_id: 'customer-1', total_acres: 80, measured_acres: 80 } : null,
    ));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field') return Promise.resolve({ data: true, error: null });
      if (name === 'get_field_geojson') {
        const boundary = { type: 'MultiPolygon', coordinates: parts.map((p) => p.polygon_geojson.coordinates) };
        return Promise.resolve({ data: [{ boundary_geojson: JSON.stringify(boundary) }], error: null });
      }
      if (name === 'get_field_polygons') return Promise.resolve({ data: parts, error: null });
      if (name === 'set_field_boundary') return Promise.resolve({ data: { measured_acres: 40, billable_acres: 40 }, error: null });
      return Promise.resolve({ data: [], error: null });
    });
  });

  it('never re-saves the old boundary, and says a measured boundary cannot be removed here', async () => {
    const router = createMemoryRouter([{ path: '/fields/:id', element: <FieldSetup /> }], { initialEntries: ['/fields/field-1'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText(/Part 2 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete every part' }));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'A measured boundary cannot be removed here — draw a replacement boundary and save.'));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'set_field_boundary')).toHaveLength(0);
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
  });
});
