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

const { mockDrawnPolygon, mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
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
  useIdempotencyKey: () => ({ getKey: () => 'key', resetKey: vi.fn() }),
}));
vi.mock('../components/customers/CustomerSearchPicker', () => ({
  default: ({ onSelect }: { onSelect: (customer: { id: string; farm_name: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: 'customer-1', farm_name: 'Test Farm' })}>Pick owner</button>
  ),
}));
vi.mock('../components/map/CRXMap', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../components/map/DrawLayer', () => ({
  default: ({ onPolygonsChange }: { onPolygonsChange?: (polygons: unknown[]) => void }) => (
    <button type="button" onClick={() => onPolygonsChange?.([mockDrawnPolygon])}>Draw boundary</button>
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
});
