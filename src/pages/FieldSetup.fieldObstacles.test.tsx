import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkerPlacement } from '../lib/fieldMarkerData';
import FieldSetup from './FieldSetup';

const {
  mockCheckMutationResult,
  mockBeforeMarkerDelete,
  mockUseUnsavedChanges,
  mockDrawLayer,
  mockFrom,
  mockGetSession,
  mockInsert,
  mockUpdate,
  mockUpdateFilter,
  mockRpc,
  mockToast,
  mockUseAuth,
  mockUseParams,
} = vi.hoisted(() => ({
  mockCheckMutationResult: vi.fn(),
  mockBeforeMarkerDelete: vi.fn(async () => {}),
  mockUseUnsavedChanges: vi.fn((_dirty: boolean) => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() })),
  mockDrawLayer: vi.fn(),
  mockFrom: vi.fn(),
  mockGetSession: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateFilter: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseParams: vi.fn(),
}));

// A ~40 ac square near the test field, shaped like DrawLayer's DrawnPolygon.
const mockDrawnPolygon = {
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
};

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => mockUseParams(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

let pendingMarker: MarkerPlacement | null;
vi.mock('../lib/fieldMarkerPending', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/fieldMarkerPending')>(),
  readPendingMarker: async () => pendingMarker,
  reservePendingMarker: async (_actor: string, placement: MarkerPlacement) => pendingMarker ??= placement,
  clearPendingMarker: async () => { pendingMarker = null; },
  startReservedMarkerWrite: async <T,>(_actor: string, pin: MarkerPlacement, current: () => boolean, send: (signal: AbortSignal) => Promise<T>) => {
    if (pendingMarker?.id !== pin.id || !current()) throw new Error('The pending marker is no longer active.');
    return send(new AbortController().signal);
  },
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../lib/db', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    auth: { getSession: mockGetSession },
  },
  assertRpcResult: <T,>(data: unknown): T => data as T,
  checkMutationResult: mockCheckMutationResult,
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../lib/fieldsGeojsonCache', () => ({
  getCachedFieldsGeojson: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/plssLookup', () => ({
  lookupPlss: vi.fn(),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-key', resetKey: vi.fn(), getKeyFor: () => 'test-key', resetKeyFor: vi.fn(), hasKeyFor: () => false }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: mockUseUnsavedChanges,
}));

vi.mock('../components/map/CRXMap', () => ({
  default: ({
    children,
    onMapClick,
  }: {
    children: ReactNode;
    onMapClick?: (longitude: number, latitude: number) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onMapClick?.(-89.04, 39.16)}>Mock map click</button>
      {children}
    </div>
  ),
}));

vi.mock('../components/map/DrawLayer', () => ({
  default: ({
    disabled = false,
    allowRemoveSinglePart = false,
    onDrawingStateChange,
    onPolygonsChange,
  }: {
    disabled?: boolean;
    allowRemoveSinglePart?: boolean;
    onDrawingStateChange?: (isDrawing: boolean) => void;
    onPolygonsChange?: (polygons: unknown[]) => void;
  }) => {
    mockDrawLayer({ disabled, allowRemoveSinglePart, onDrawingStateChange });
    return (
      <>
        <button
          type="button"
          data-testid="mock-draw-layer"
          onClick={() => onDrawingStateChange?.(true)}
        >
          Start mock boundary drawing
        </button>
        <button type="button" onClick={() => onPolygonsChange?.([mockDrawnPolygon])}>
          Commit mock boundary
        </button>
      </>
    );
  },
}));
vi.mock('../components/map/AddressSearch', () => ({ default: () => null }));
vi.mock('../components/map/FieldBoundaryLayer', () => ({ default: () => null }));
vi.mock('../components/map/FieldObstacleLayer', () => ({ default: () => null }));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));
vi.mock('../components/ui/ConfirmModal', () => ({
  default: ({
    open,
    onConfirm,
    confirmLabel = 'Confirm',
  }: {
    open: boolean;
    onConfirm: () => void;
    confirmLabel?: string;
  }) => open ? <button type="button" onClick={onConfirm}>{confirmLabel}</button> : null,
}));

const savedObstacle = {
  id: 'obstacle-1',
  field_id: 'field-1',
  kind: 'oil_well',
  label: 'West well',
  point_geojson: { type: 'Point', coordinates: [-89.05, 39.15] },
  entrance_number: null,
  created_by: 'user-1',
  created_at: '2026-07-11T12:00:00Z',
  updated_at: '2026-07-11T12:00:00Z',
};

const insertedObstacle = {
  ...savedObstacle,
  id: 'obstacle-2',
  kind: 'windmill',
  label: 'North windmill',
  point_geojson: { type: 'Point', coordinates: [-89.04, 39.16] },
};
const testSession = { data: { session: { user: { id: 'user-1' }, access_token: 'test-token' } }, error: null };
let markerRows = [savedObstacle];
const receipts = new Set<string>();

function listChain(data: unknown, error: unknown = null): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.or = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = (resolve: (result: { data: unknown; error: unknown }) => void) => resolve({ data, error });
  return chain;
}

// One imported (version 1) split, as the FP-1 tables return it.
const leftoverSplit = [{
  id: 'version-1', version_number: 1, effective_from: '1900-01-01', history_known: false, created_by: null,
  created_at: '2026-11-24T00:00:00Z',
  field_billing_split_payers: [{
    customer_id: 'customer-9', product_share_micro_pct: 100_000_000, application_share_micro_pct: 100_000_000,
    customer: { farm_name: 'Leftover Split Farm' },
  }],
}];

// Every customers query the page builds (only the owner/split search pickers read customers).
const customerChains: Array<Record<string, unknown>> = [];

function configureSupabase(obstacleReadError: unknown = null, measuredAcres: number | null = null, loseInsertResponse = false): void {
  customerChains.length = 0;
  markerRows = [savedObstacle];
  receipts.clear();
  mockRpc.mockImplementation((name: string, args?: { p_marker_id?: string }) => {
    if (name === 'get_field_marker_read') {
      const response = Promise.resolve({
        data: obstacleReadError ? null : { available: true, count: markerRows.length, markers: markerRows },
        error: obstacleReadError,
      });
      return { abortSignal: () => Object.assign(response, { setHeader: () => response }) };
    }
    if (name === 'get_field_marker_create_result') {
      const id = args?.p_marker_id ?? '';
      const state = !receipts.has(id) ? 'missing' : markerRows.some((row) => row.id === id) ? 'saved' : 'removed';
      return { setHeader: () => ({ abortSignal: () => Promise.resolve({ data: { state }, error: null }) }) };
    }
    if (name === 'get_field_geojson' || name === 'get_field_polygons') {
      return Promise.resolve({ data: [], error: null });
    }
    if (name === 'set_field_boundary') {
      // Shape of the RPC's v_result (migration 20260623130000).
      return Promise.resolve({
        data: { field_id: 'field-1', measured_acres: 40, billable_acres: 40, acres_source: 'measured' },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === 'fields') {
      return {
        select: () => ({
          eq: (_column: string, value?: string) => ({
            // Duplicate-name check run when an owner is picked.
            ilike: () => ({ neq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
            maybeSingle: () => Promise.resolve({
              data: {
                id: value ?? 'field-1',
                customer_id: 'customer-1',
                field_name: 'North 40',
                state: 'IL',
                total_acres: 40,
                measured_acres: measuredAcres,
                override_acres: null,
                irrigation: false,
                is_active: true,
                customer: { farm_name: 'Smith Farm' },
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'customers') {
      const chain = listChain([{ id: 'customer-2', farm_name: 'Jones Farm', is_active: true }]);
      customerChains.push(chain);
      return chain;
    }
    if (table === 'field_billing_split_versions' || table === 'field_payer_notes') {
      return listChain([]);
    }
    if (table === 'profile_public_view') {
      return { select: () => ({ in: () => ({ abortSignal: () => Promise.resolve({ data: [] }) }) }) };
    }
    if (table === 'field_obstacles') {
      return {
        insert: (payload: { id: string }) => {
          mockInsert(payload);
          return {
            select: () => ({
              setHeader: () => ({
                abortSignal: () => ({
                  single: () => {
                    const row = { ...insertedObstacle, id: payload.id };
                    receipts.add(payload.id);
                    markerRows = [...markerRows, row];
                    if (loseInsertResponse) return Promise.resolve({ data: null, error: new Error('Connection lost') });
                    return Promise.resolve({ data: row, error: null });
                  },
                }),
              }),
            }),
          };
        },
        update: (payload: unknown) => {
          mockUpdate(payload);
          const chain = {
            eq: (column: string, value: string) => { mockUpdateFilter(column, value); return chain; },
            select: () => ({ setHeader: () => ({ abortSignal: () => Promise.resolve({ data: [], error: null }) }) }),
          };
          return chain;
        },
        delete: () => ({
          eq: (_column: string, id: string) => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  setHeader: () => ({
                    abortSignal: async () => {
                      await mockBeforeMarkerDelete();
                      markerRows = markerRows.filter((row) => row.id !== id);
                      return { data: [{ id }], error: null };
                    },
                  }),
                }),
              }),
            }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe('FieldSetup field obstacles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingMarker = null;
    mockUseParams.mockReturnValue({ id: 'field-1' });
    mockUseAuth.mockReturnValue({ profile: { id: 'user-1', role: 'admin' } });
    mockGetSession.mockReset().mockResolvedValue(testSession);
    configureSupabase();
  });

  it('blocks leaving Field Setup until a confirmed marker delete returns', async () => {
    let finish: () => void = () => {};
    mockBeforeMarkerDelete.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<FieldSetup />);
    await screen.findByText(/West well/);
    const blockerFlag = () => mockUseUnsavedChanges.mock.lastCall?.[0];
    expect(blockerFlag()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete marker' }));
    await waitFor(() => expect(mockBeforeMarkerDelete).toHaveBeenCalledTimes(1));
    expect(blockerFlag()).toBe(true);
    await act(async () => finish());
    expect(screen.getByText('Marker deleted.')).toBeInTheDocument();
    expect(blockerFlag()).toBe(false);
  });

  it('loads, adds, and confirms deletion of obstacle pins', async () => {
    render(<FieldSetup />);

    expect(await screen.findByText(/West well/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
    expect(await screen.findByText('Tap the map where the marker belongs.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mock map click' }));
    fireEvent.change(screen.getByLabelText('Marker type'), { target: { value: 'windmill' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'North windmill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save marker' }));

    await waitFor(() => expect(mockInsert).toHaveBeenCalledWith({
      id: expect.any(String),
      field_id: 'field-1',
      kind: 'windmill',
      label: 'North windmill',
      point_geojson: { type: 'Point', coordinates: [-89.04, 39.16] },
    }));
    expect(mockCheckMutationResult).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ label: 'North windmill' }), error: null }),
      'Add field marker',
    );
    expect(await screen.findByText(/North windmill/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete marker' }));

    await waitFor(() => expect(screen.queryByText(/North windmill/)).not.toBeInTheDocument());
    expect(mockCheckMutationResult).toHaveBeenLastCalledWith(
      { data: [{ id: expect.any(String) }], error: null },
      'Delete field marker',
    );
  });

  it('reports unavailable markers without claiming the field is empty', async () => {
    configureSupabase(new Error('read failed'));
    render(<FieldSetup />);

    expect(await screen.findByText('Markers could not be checked for this field. Confirm hazards on site.')).toBeInTheDocument();
    expect(screen.queryByText('None recorded.')).not.toBeInTheDocument();
  });

  it('checks the marker version when editing and preserves a draft after a stale save', async () => {
    const { checkMutationResult } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
    mockCheckMutationResult.mockImplementationOnce(checkMutationResult);
    render(<FieldSetup />);

    await screen.findByText('West well');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'My revised note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save marker' }));

    expect(await screen.findByText(/Cancel and reopen it to check the latest version/)).toBeInTheDocument();
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ label: 'My revised note' }));
    expect(mockUpdateFilter.mock.calls).toEqual([
      ['id', savedObstacle.id], ['field_id', savedObstacle.field_id], ['updated_at', savedObstacle.updated_at],
    ]);
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('My revised note');
    expect(screen.queryByText('Marker updated.')).not.toBeInTheDocument();
  });

  it('confirms the original pin after an interrupted save without inserting a duplicate', async () => {
    configureSupabase(null, null, true);
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
    await screen.findByText('Tap the map where the marker belongs.');
    fireEvent.click(screen.getByRole('button', { name: 'Mock map click' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save marker' }));

    const retry = await screen.findByRole('button', { name: 'Retry save' });
    expect(screen.queryByText('Marker added.')).not.toBeInTheDocument();
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);

    expect(await screen.findByText('Marker added.')).toBeInTheDocument();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(markerRows).toHaveLength(2);
  });

  it.each([true, false])('recovers the same submitted pin without restoring a deleted pin (removed: %s)', async (removed) => {
    configureSupabase(null, null, true);
    const first = render(<FieldSetup />);
    await screen.findByText('West well');
    fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
    await screen.findByText('Tap the map where the marker belongs.');
    fireEvent.click(screen.getByRole('button', { name: 'Mock map click' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save marker' }));
    await screen.findByText(/The save could not be confirmed/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep for later' }));
    expect(screen.getByText('Pending marker kept on this device.')).toBeInTheDocument();
    first.unmount();

    if (removed) markerRows = [savedObstacle];
    render(<FieldSetup />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add marker' }));
    expect(await screen.findByText(removed ? 'This marker was saved and has since been removed.' : 'The pending marker was already saved.')).toBeInTheDocument();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(pendingMarker).toBeNull();
  });

  it('ends a save whose session lookup hangs and refuses to start it after timeout', async () => {
    let finish = (_session: typeof testSession) => {};
    mockGetSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<FieldSetup />);
    await screen.findByText('West well');
    fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
    await screen.findByText('Tap the map where the marker belongs.');
    fireEvent.click(screen.getByRole('button', { name: 'Mock map click' }));
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Save marker' }));
      await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByRole('button', { name: 'Retry save' })).toBeEnabled();
      await act(async () => { finish(testSession); });
      expect(mockInsert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the draw layer mounted and blocks obstacle mode during an active boundary sketch', async () => {
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    expect(screen.getByTestId('mock-draw-layer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
    await screen.findByText('Tap the map where the marker belongs.');
    expect(screen.getByTestId('mock-draw-layer')).toBeInTheDocument();
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start mock boundary drawing' }));
    expect(screen.queryByRole('button', { name: 'Add marker' })).not.toBeInTheDocument();
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: false }));
  });

  it('lets a field without a saved boundary remove its only drawn part', async () => {
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ allowRemoveSinglePart: true }));
  });

  it('keeps a saved measured boundary from being removed down to nothing', async () => {
    // Render state, not a ref read during render, drives this prop (React 19 follow-up, 2026-10-14).
    configureSupabase(null, 38.5);
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    await waitFor(() => expect(mockDrawLayer).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowRemoveSinglePart: false }),
    ));
  });

  it('stops offering single-part removal once a newly drawn boundary is saved', async () => {
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ allowRemoveSinglePart: true }));
    // FieldSetup marks geometry dirty only after its post-load tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Commit mock boundary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_field_boundary', expect.anything()));
    await waitFor(() => expect(mockDrawLayer).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowRemoveSinglePart: false }),
    ));
  });

  it('loads no customer list and finds the owner by searching active customers', async () => {
    render(<FieldSetup />);

    const owner = await screen.findByRole('combobox', { name: 'Owner (Customer)' });
    expect(owner).toHaveValue('Smith Farm');
    expect(customerChains).toHaveLength(0);

    fireEvent.focus(owner);
    fireEvent.change(owner, { target: { value: 'Jon' } });
    fireEvent.click(await screen.findByText('Jones Farm'));

    expect(owner).toHaveValue('Jones Farm');
    expect(customerChains).toHaveLength(1);
    expect(customerChains[0].eq).toHaveBeenCalledWith('is_active', true);
    expect(customerChains[0].limit).toHaveBeenCalled();
  });

  it('keeps obstacle write controls hidden from applicators', async () => {
    mockUseAuth.mockReturnValue({ profile: { id: 'applicator-1', role: 'applicator' } });
    render(<FieldSetup />);

    expect(await screen.findByText(/West well/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add marker' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
  });
});

describe('FieldSetup load failure (To-Do 10.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({ id: 'field-1' });
    mockUseAuth.mockReturnValue({ profile: { id: 'user-1', role: 'admin' } });
    configureSupabase();
  });

  it('a failed split-history read shows the load error, not a form whose Save could overwrite the split', async () => {
    const base = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => (
      table === 'field_billing_split_versions' ? listChain(null, { message: 'unavailable' }) : base(table)
    ));
    render(<FieldSetup />);
    expect(await screen.findByText('This field could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Field not found')).not.toBeInTheDocument();
  });

  it('moving to a field with no billing splits clears the previous field\'s splits (Save sends the whole list)', async () => {
    const base = mockFrom.getMockImplementation()!;
    let splits: unknown[] = leftoverSplit;
    mockFrom.mockImplementation((table: string) => (
      table === 'field_billing_split_versions' ? listChain(splits) : base(table)
    ));
    const { rerender } = render(<FieldSetup />);
    expect((await screen.findAllByText('Leftover Split Farm')).length).toBeGreaterThan(0);

    splits = [];
    mockUseParams.mockReturnValue({ id: 'field-2' });
    rerender(<FieldSetup />);
    // The new field's form must have loaded, so the check is not passing on the loading screen.
    expect(await screen.findByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    expect(screen.queryByText('Leftover Split Farm')).not.toBeInTheDocument();
  });

  it('opening New Field after a field with billing splits starts an empty form', async () => {
    const base = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => (
      table === 'field_billing_split_versions' ? listChain(leftoverSplit) : base(table)
    ));
    const { rerender } = render(<FieldSetup />);
    expect((await screen.findAllByText('Leftover Split Farm')).length).toBeGreaterThan(0);

    mockUseParams.mockReturnValue({ id: 'new' });
    rerender(<FieldSetup />);
    expect(await screen.findByRole('button', { name: 'Create Field' })).toBeInTheDocument();
    expect(screen.queryByText('Leftover Split Farm')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('North 40')).not.toBeInTheDocument();
  });

  it('a read for the field left behind that fails late does not report a failure on the next field', async () => {
    const base = mockFrom.getMockImplementation()!;
    let failFirstRead: (() => void) | null = null;
    mockFrom.mockImplementation((table: string) => {
      const chain = base(table);
      if (table !== 'fields' || failFirstRead) return chain;
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => new Promise((resolve) => {
              failFirstRead = () => resolve({ data: null, error: { message: 'timeout' } });
            }),
          }),
        }),
      };
    });
    const { rerender } = render(<FieldSetup />);
    await waitFor(() => expect(failFirstRead).not.toBeNull());

    mockUseParams.mockReturnValue({ id: 'field-2' });
    rerender(<FieldSetup />);
    expect(await screen.findByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    await act(async () => { failFirstRead!(); });
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Failed to load field');
    expect(screen.queryByText('This field could not be loaded')).not.toBeInTheDocument();
  });
});
