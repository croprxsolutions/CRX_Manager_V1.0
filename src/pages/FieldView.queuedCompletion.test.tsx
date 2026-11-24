/**
 * FieldView.queuedCompletion.test.tsx — a job completion saved on the phone while offline
 * cannot be sent twice.
 *
 * A second tap on Complete Job used to queue a second completion for the same job. While a
 * completion for the job waits in the offline queue, the card shows "Completion saved on this
 * phone — will send when signal returns" instead of Complete Job, and no confirm can queue
 * another one. Once the queue no longer holds it (sent, needs attention, or discarded), the
 * card goes back to normal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  online: false,
  queued: new Set<string>(),
  queueAction: vi.fn(),
}));

const SAVED_TEXT = 'Completion saved on this phone — will send when signal returns';

const DISPATCHED = [{
  dispatch_id: 'd1', job_field_id: 'jf1', job_id: 'job-1', job_number: 'J-100', job_status: 'in_progress',
  job_date: null, field_id: 'f1', dispatch_status: 'dispatched', assignee_kind: 'applicator', applicator_id: 'user-1',
  crew_id: null, assignee_name: 'Applicator', field_name: 'North 40', customer_name: 'Big Farm',
  location_acres: 40, job_applied_acres: 0, job_total_acres: 40,
}];

// Every query chain answers with its rows (none unless given).
const reply = (rows: unknown[] = []) => {
  const chain: object = new Proxy({}, {
    get: (_target, prop) => (prop === 'then'
      ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject)
      : () => chain),
  });
  return chain;
};

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: () => reply(),
      rpc: (name: string) => reply(name === 'get_dispatched_list' ? DISPATCHED : []),
    },
  };
});
vi.mock('../lib/offlineQueue', async () => {
  const actual = await vi.importActual<typeof import('../lib/offlineQueue')>('../lib/offlineQueue');
  return {
    ...actual,
    queueAction: H.queueAction,
    getQueuedJobCompletionIds: async () => new Set(H.queued),
  };
});
vi.mock('../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => H.online }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'applicator', full_name: 'Applicator' }, role: 'applicator', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../components/map/CRXMap', () => ({ default: () => <div /> }));
vi.mock('../components/map/FieldBoundaryLayer', () => ({ default: () => <div /> }));

import FieldView from './FieldView';

beforeEach(() => {
  vi.clearAllMocks();
  H.online = false;
  H.queued = new Set();
  H.queueAction.mockImplementation(async () => {
    H.queued.add('job-1');
    return 1;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function renderFieldView() {
  render(<MemoryRouter><FieldView /></MemoryRouter>);
  await screen.findByText('J-100');
}

/** Open the Complete form from the card and press its Complete Job button, which opens the confirm. */
async function openCompleteConfirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Complete Job' }));
  await screen.findByRole('heading', { name: 'Complete Job' });
  const buttons = screen.getAllByRole('button', { name: 'Complete Job' });
  fireEvent.click(buttons[buttons.length - 1]);
  return screen.findByRole('alertdialog', { name: 'Complete this job?' });
}

describe('FieldView: a completion saved offline', () => {
  it('shows the saved status instead of Complete Job while the completion waits to send', async () => {
    H.queued = new Set(['job-1']);
    await renderFieldView();

    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_TEXT);
    expect(screen.queryByRole('button', { name: 'Complete Job' })).toBeNull();
  });

  it('after saving one offline, Complete Job is gone and no second completion can be queued', async () => {
    await renderFieldView();
    const confirm = await openCompleteConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Complete' }));

    await waitFor(() => expect(H.queueAction).toHaveBeenCalledTimes(1));
    expect(H.queueAction.mock.calls[0][0]).toMatchObject({ operation: 'complete_job', entityId: 'job-1' });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_TEXT);
    // Neither the card's button nor the form's is left to tap again.
    expect(screen.queryByRole('button', { name: 'Complete Job' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Complete Job' })).toBeNull();
    expect(H.queueAction).toHaveBeenCalledTimes(1);
  });

  it('a confirm still open when the queue reports the job saved does not queue it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderFieldView();
    const confirm = await openCompleteConfirm();

    // The same job's completion was saved meanwhile (another tab of the app): the next queue check sees it.
    H.queued = new Set(['job-1']);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_TEXT);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Complete' }));
    await act(async () => { await Promise.resolve(); });
    expect(H.queueAction).not.toHaveBeenCalled();
  });

  it('goes back to Complete Job once the queue no longer holds the completion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    H.queued = new Set(['job-1']);
    await renderFieldView();
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_TEXT);

    // Sent, needs attention, or discarded: the next queue check no longer lists it.
    H.queued = new Set();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByRole('button', { name: 'Complete Job' })).toBeTruthy();
    expect(screen.queryByText(SAVED_TEXT)).toBeNull();
  });
});
