/**
 * FieldView.savedCopy.test.tsx: the applicator's My Day keeps today's job list on the phone, and a failed
 * load in a dead spot shows that copy read-only (no Start or Complete) instead of an empty error screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { state, mockToast } = vi.hoisted(() => ({
  state: { fail: false },
  mockToast: vi.fn(),
}));

const dispatchedRow = {
  job_id: 'job-1', job_number: 'J-100', job_status: 'in_progress', job_date: null, customer_name: 'Wells Farm',
  job_applied_acres: null, job_total_acres: 40, job_field_id: 'jf-1', field_id: 'f-1', field_name: 'North 40', location_acres: 40,
};

function chain(result: () => { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'or', 'in', 'order', 'range']) self[m] = () => self;
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: {
    rpc: () => chain(() => (state.fail ? { data: null, error: new Error('Failed to fetch') } : { data: [dispatchedRow], error: null })),
    from: () => chain(() => ({ data: [], error: null })),
  },
  assertRpcResult: (d: unknown) => d,
  sanitizeError: (e: unknown) => String(e),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'app-1', role: 'applicator' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: () => undefined }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/offlineQueue', () => ({ queueAction: vi.fn(), getOfflineStorageErrorMessage: () => null }));
vi.mock('../components/map/CRXMap', () => ({ default: () => null }));
vi.mock('../components/map/FieldBoundaryLayer', () => ({ default: () => null }));

import FieldView from './FieldView';

beforeEach(() => {
  window.localStorage.clear();
  state.fail = false;
  mockToast.mockReset();
});

describe('FieldView: saved copy in a dead spot', () => {
  it('shows today’s saved jobs read-only when a later load fails', async () => {
    const first = render(<MemoryRouter><FieldView /></MemoryRouter>);
    expect(await screen.findByText('J-100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Complete Job/ })).toBeInTheDocument();
    first.unmount();

    state.fail = true;
    render(<MemoryRouter><FieldView /></MemoryRouter>);
    expect(await screen.findByText(/^No signal — showing your jobs as of /)).toBeInTheDocument();
    expect(screen.getByText("You can't start or complete jobs until signal returns.")).toBeInTheDocument();
    expect(screen.getByText('J-100')).toBeInTheDocument();
    expect(screen.getByText('Wells Farm')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Complete Job/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start Job/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your jobs")).not.toBeInTheDocument();

    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: /Complete Job/ })).toBeInTheDocument();
    expect(screen.queryByText(/^No signal — showing your jobs/)).not.toBeInTheDocument();
  });

  it('still says it could not load when there is no saved copy for today', async () => {
    state.fail = true;
    render(<MemoryRouter><FieldView /></MemoryRouter>);
    expect(await screen.findByText("Couldn't load your jobs")).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load your jobs');
  });
});
