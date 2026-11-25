import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FieldView from './FieldView';

const fixtures = vi.hoisted(() => ({
  mapReads: vi.fn(), jobReads: vi.fn(), toast: vi.fn(),
  queued: new Set<string>(),
  jobGate: null as Promise<void> | null,
  locationGate: null as Promise<void> | null,
  geometryError: null as { message: string } | null,
  locationsError: null as { message: string } | null,
  omitGeometry: false,
  omitLocation: false,
  unlinkedLocation: false,
  sharedField: false,
  movedField: false,
  movedWholeField: false,
}));

const jobFields = [
  { id: 'whole-location', job_id: 'whole-job', field_id: 'whole-field' },
  { id: 'my-location', job_id: 'split-job', field_id: 'my-field' },
  { id: 'other-location', job_id: 'split-job', field_id: 'other-field' },
];

const geometry = [
  { id: 'whole-field', field_name: 'Whole-job field' },
  { id: 'my-field', field_name: 'My dispatched field' },
  { id: 'other-field', field_name: 'Other crew field' },
];

function reply(rows: readonly unknown[], error: { message: string } | null = null, gate = fixtures.jobGate) {
  const result = (gate ?? Promise.resolve()).then(() => ({ data: error ? null : rows, error, count: rows.length }));
  return {
    eq: () => reply(rows, error, gate),
    is: () => reply(rows, error, gate),
    or: () => reply(rows, error, gate),
    order: () => reply(rows, error, gate),
    range: () => reply(rows, error, gate),
    then: result.then.bind(result),
  };
}

vi.mock('../lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  supabase: {
    from: (table: string) => ({
      select: () => table === 'jobs' ? reply([{
        id: 'whole-job', job_number: 'J-100', status: 'scheduled', job_date: null, customer: { farm_name: 'Whole job farm' },
      }]) : {
        in: (column: 'id' | 'job_id', ids: string[]) => {
          fixtures.mapReads(column, ids);
          const rows = jobFields.filter((row) => ids.includes(row[column]) && !(fixtures.omitLocation && row.id === 'my-location'));
          return reply(rows.map((row) => {
            if (fixtures.unlinkedLocation && row.id === 'my-location') return { ...row, field_id: null };
            if (row.id !== 'whole-location') return row;
            if (fixtures.movedWholeField) return { ...row, field_id: 'other-field' };
            return fixtures.sharedField ? { ...row, field_id: 'my-field' } : row;
          }), fixtures.locationsError, fixtures.locationGate);
        },
      },
    }),
    rpc: (name: string, args?: { p_field_ids: string[] }) => {
      if (name !== 'get_dispatched_list') {
        const rows = geometry.filter((row) => args?.p_field_ids.includes(row.id) && !(fixtures.omitGeometry && row.id === 'my-field'));
        return reply(rows, fixtures.geometryError, null);
      }
      fixtures.jobReads();
      return reply([{
        dispatch_id: 'dispatch', job_field_id: fixtures.movedField ? 'other-location' : 'my-location', job_id: 'split-job', job_number: 'J-101',
        job_status: 'scheduled', field_id: fixtures.movedField ? 'other-field' : 'my-field', dispatch_status: 'dispatched', assignee_kind: 'applicator',
        applicator_id: 'user-1', field_name: 'My dispatched field', customer_name: 'Split job farm',
      }]);
    },
  },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'applicator', full_name: 'Applicator' }, role: 'applicator', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: fixtures.toast }) }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));
vi.mock('../hooks/useQueuedJobCompletions', () => ({ useQueuedJobCompletions: () => ({ queuedJobIds: fixtures.queued, markQueued: vi.fn() }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/map/CrewFieldMarkerMap', () => ({
  default: ({ fields, placementAllowed, refreshKey }: { fields: typeof geometry; placementAllowed: boolean; refreshKey: number }) => (
    <section aria-label="Marker fields" data-refresh-key={refreshKey}>
      {fields.map((field) => <h3 key={field.id}>{field.field_name}</h3>)}
      <input aria-label="Draft marker note" />
      <button disabled={!placementAllowed}>Add marker</button>
    </section>
  ),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  fixtures.queued = new Set();
  fixtures.jobGate = null;
  fixtures.locationGate = null;
  fixtures.geometryError = null;
  fixtures.locationsError = null;
  fixtures.omitGeometry = false;
  fixtures.omitLocation = false;
  fixtures.unlinkedLocation = false;
  fixtures.sharedField = false;
  fixtures.movedField = false;
  fixtures.movedWholeField = false;
});

const fieldView = () => <MemoryRouter><FieldView /></MemoryRouter>;

async function openMap() {
  await screen.findByText('J-100');
  fireEvent.click(screen.getByRole('button', { name: 'Map' }));
  return within(screen.getByRole('region', { name: 'Marker fields' }));
}

it('includes whole-job fields and only the dispatched locations on a split job', async () => {
  render(fieldView());
  const map = await openMap();
  expect(await map.findByRole('heading', { name: 'Whole-job field' })).toBeInTheDocument();
  expect(map.getByRole('heading', { name: 'My dispatched field' })).toBeInTheDocument();
  expect(map.queryByRole('heading', { name: 'Other crew field' })).toBeNull();
  expect(fixtures.mapReads.mock.calls).toEqual([['id', ['my-location']], ['job_id', ['whole-job']]]);
});

it('keeps a shared field on the map when its first job is filtered out', async () => {
  fixtures.sharedField = true;
  render(fieldView());
  await screen.findByText('J-100');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search job number or customer' }), { target: { value: 'J-100' } });
  const map = await openMap();
  expect(await map.findByRole('heading', { name: 'My dispatched field' })).toBeInTheDocument();
});

it('warns when the map fields fail to load and retries the field check', async () => {
  fixtures.geometryError = { message: 'Failed to fetch' };
  render(fieldView());
  const map = await openMap();
  expect(await screen.findByText(/Couldn't check all assigned fields/)).toBeInTheDocument();
  expect(map.queryByRole('heading', { name: 'Whole-job field' })).toBeNull();
  fixtures.geometryError = null;
  let finish = () => {};
  fixtures.jobGate = new Promise<void>((resolve) => { finish = resolve; });
  fireEvent.click(screen.getByRole('button', { name: 'Reload map' }));
  expect(screen.getByRole('button', { name: 'Checking assigned fields…' })).toBeDisabled();
  fixtures.jobGate = null;
  await act(async () => finish());
  expect(await map.findByRole('heading', { name: 'Whole-job field' })).toBeInTheDocument();
  expect(screen.queryByText(/Couldn't check all assigned fields/)).toBeNull();
});

it('keeps a checking map read-only and removes a whole-job field when the new assignment returns', async () => {
  render(fieldView());
  const map = await openMap();
  expect(await map.findByRole('heading', { name: 'Whole-job field' })).toBeInTheDocument();
  expect(map.getByRole('button', { name: 'Add marker' })).toBeEnabled();

  let finish = () => {};
  fixtures.locationGate = new Promise<void>((resolve) => { finish = resolve; });
  fixtures.movedWholeField = true;
  fireEvent.click(screen.getByRole('button', { name: 'List' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reload my jobs' }));
  await waitFor(() => expect(fixtures.mapReads).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole('button', { name: 'Map' }));
  expect(screen.getByText('Checking assigned fields…')).toBeInTheDocument();
  expect(map.getByRole('button', { name: 'Add marker' })).toBeDisabled();

  await act(async () => finish());
  expect(map.getByRole('heading', { name: 'Other crew field' })).toBeInTheDocument();
  expect(map.queryByRole('heading', { name: 'Whole-job field' })).toBeNull();
  expect(map.getByRole('button', { name: 'Add marker' })).toBeEnabled();
});

it.each(['geometry', 'locations'] as const)('hides a field after fresh dispatch moves the job when %s lookup fails', async (failed) => {
  render(fieldView());
  const map = await openMap();
  expect(await map.findByRole('heading', { name: 'My dispatched field' })).toBeInTheDocument();

  fixtures.movedField = true;
  if (failed === 'geometry') fixtures.geometryError = { message: 'Failed to fetch' };
  else fixtures.locationsError = { message: 'Failed to fetch' };
  fireEvent.click(screen.getByRole('button', { name: 'List' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reload my jobs' }));
  await waitFor(() => expect(fixtures.mapReads).toHaveBeenCalledWith('id', ['other-location']));
  fireEvent.click(screen.getByRole('button', { name: 'Map' }));
  expect(await screen.findByText(/Couldn't check all assigned fields/)).toBeInTheDocument();
  expect(map.queryByRole('heading', { name: 'My dispatched field' })).not.toBeInTheDocument();
  if (failed === 'geometry') expect(map.getByRole('heading', { name: 'Whole-job field' })).toBeInTheDocument();
  else expect(map.queryByRole('heading', { name: 'Whole-job field' })).not.toBeInTheDocument();
});

it.each(['omitLocation', 'omitGeometry', 'unlinkedLocation'] as const)('labels a partial response while preserving fields that loaded (%s)', async (missing) => {
  fixtures[missing] = true;
  render(fieldView());
  const map = await openMap();
  expect(await map.findByRole('heading', { name: 'Whole-job field' })).toBeInTheDocument();
  expect(map.queryByRole('heading', { name: 'My dispatched field' })).toBeNull();
  expect(screen.getByText(/Couldn't check all assigned fields/)).toBeInTheDocument();
});

it('keeps the marker draft mounted while a sent completion refreshes the job list', async () => {
  fixtures.queued = new Set(['whole-job']);
  const view = render(fieldView());
  const map = await openMap();
  await map.findByRole('heading', { name: 'Whole-job field' });
  const note = map.getByRole('textbox', { name: 'Draft marker note' });
  fireEvent.change(note, { target: { value: 'Keep this draft' } });
  let finish = () => {};
  fixtures.jobGate = new Promise<void>((resolve) => { finish = resolve; });
  fixtures.queued = new Set();
  view.rerender(fieldView());
  await waitFor(() => expect(fixtures.jobReads).toHaveBeenCalledTimes(2));
  expect(note).toBeInTheDocument();
  expect(note).toHaveValue('Keep this draft');
  fixtures.jobGate = null;
  await act(async () => finish());
  expect(map.getByRole('textbox', { name: 'Draft marker note' })).toHaveValue('Keep this draft');
});

it('keeps the marker draft when going to the job list and back', async () => {
  render(fieldView());
  const map = await openMap();
  await map.findByRole('heading', { name: 'Whole-job field' });
  const note = map.getByRole('textbox', { name: 'Draft marker note' });
  fireEvent.change(note, { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'List' }));
  expect(note).not.toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search job number or customer' }), { target: { value: 'nothing matches' } });
  fireEvent.click(screen.getByRole('button', { name: 'Map' }));
  expect(map.getByRole('textbox', { name: 'Draft marker note' })).toHaveValue('Keep this draft');
  expect(map.getByRole('heading', { name: 'Whole-job field' })).toBeVisible();
});

it('rechecks assignments and marker access on returning from the job list', async () => {
  render(fieldView());
  const map = await openMap();
  await map.findByRole('heading', { name: 'My dispatched field' });
  const mapRegion = screen.getByRole('region', { name: 'Marker fields' });
  expect(mapRegion).toHaveAttribute('data-refresh-key', '1');

  fireEvent.click(screen.getByRole('button', { name: 'List' }));
  fixtures.movedField = true;
  fireEvent.click(screen.getByRole('button', { name: 'Map' }));
  expect(mapRegion).toHaveAttribute('data-refresh-key', '2');
  expect(map.getByRole('button', { name: 'Add marker' })).toBeDisabled();
  expect(await map.findByRole('heading', { name: 'Other crew field' })).toBeInTheDocument();
  expect(map.queryByRole('heading', { name: 'My dispatched field' })).toBeNull();
});

it('rechecks dispatch when the phone resumes with the map still open', async () => {
  render(fieldView());
  const map = await openMap();
  await map.findByRole('heading', { name: 'My dispatched field' });
  fixtures.movedField = true;
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    fireEvent(document, new Event('visibilitychange'));
    expect(map.getByRole('button', { name: 'Add marker' })).toBeDisabled();
    expect(await map.findByRole('heading', { name: 'Other crew field' })).toBeInTheDocument();
    expect(map.queryByRole('heading', { name: 'My dispatched field' })).toBeNull();
  } finally {
    visibility.mockRestore();
  }
});
