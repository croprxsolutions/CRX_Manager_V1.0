import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TeamNote } from '../types';
import TeamBoard from './TeamBoard';

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), toast: vi.fn(), realtime: vi.fn<(refresh: () => void) => void>() }));

vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  supabase: { from: db.from, rpc: db.rpc },
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: db.toast }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'office' }, role: 'admin' }) }));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => ({ state: 'unblocked' }) }));
vi.mock('../hooks/useRealtimeSubscription', () => ({ useRealtimeNotes: db.realtime }));
vi.mock('../components/team/TodaysDeliveries', () => ({ default: () => null }));
vi.mock('../components/team/YesterdayRecap', () => ({ default: () => null }));

function task(title: string, overrides: Partial<TeamNote> = {}) {
  return {
    id: title, title, note_type: 'todo', priority: 'low', is_completed: false,
    created_at: '2026-10-18T15:00:00Z', created_by: 'office', assigned_to: 'office',
    ...overrides,
  };
}

function mockQueries(rows: ReturnType<typeof task>[], initialError = false) {
  const readNotes = vi.fn().mockResolvedValue({ data: rows, error: null });
  const insert = vi.fn().mockResolvedValue({ data: [], error: null });
  if (initialError) readNotes.mockResolvedValueOnce({ data: null, error: new Error('Offline') });
  db.from.mockImplementation((table: string) => {
    const chain = {
      select: vi.fn(() => chain), eq: vi.fn(() => chain), is: vi.fn(() => chain), neq: vi.fn(() => chain),
      order: vi.fn(() => chain), in: vi.fn(() => chain),
      insert: vi.fn(() => ({ select: insert })),
      then: (resolve: (reply: unknown) => void) =>
        (table === 'team_notes' ? readNotes() : Promise.resolve({ data: [], error: null })).then(resolve),
    };
    return chain;
  });
  return { insert, readNotes };
}

const mount = () => render(<MemoryRouter><TeamBoard /></MemoryRouter>);
const button = (name: string | RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T01:30:00Z')); // October 20 in Chicago
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Team Board office workflow', () => {
  it('shows only genuinely overdue items from the stats shortcut and can clear it', async () => {
    mockQueries([
      task('Low priority overdue', { due_date: '2026-10-19' }),
      task('Urgent due today', { due_date: '2026-10-20', priority: 'urgent' }),
      task('High priority tomorrow', { due_date: '2026-10-21', priority: 'high' }),
    ]);
    mount();
    await screen.findByRole('textbox', { name: 'Search notes' });
    expect(screen.getAllByText('Due today').length).toBeGreaterThan(0);
    expect(screen.queryByText('Overdue 0d')).not.toBeInTheDocument();
    fireEvent.click(button(/^Overdue 1$/));
    expect(screen.getByRole('heading', { name: 'Low priority overdue' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Urgent due today' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'High priority tomorrow' })).not.toBeInTheDocument();
    fireEvent.click(button('Clear all filters'));
    expect(screen.getAllByRole('heading', { name: 'Urgent due today' }).length).toBeGreaterThan(0);
  });

  it('orders urgent work first and undated tasks after dated tasks of the same priority', async () => {
    mockQueries([
      task('Undated medium', { priority: 'medium' }),
      task('Dated medium', { due_date: '2026-10-22', priority: 'medium' }),
      task('Urgent first', { priority: 'urgent' }),
    ]);
    mount();
    await screen.findByRole('textbox', { name: 'Search notes' });
    fireEvent.click(screen.getAllByRole('button', { name: /^My Tasks/ }).at(-1)!);
    expect(screen.getAllByRole('heading', { level: 4 }).map(title => title.textContent))
      .toEqual(['Urgent first', 'Dated medium', 'Undated medium']);
  });

  it('filters finished tasks by their Chicago date, including the evening before UTC midnight', async () => {
    mockQueries([
      task('Previous Chicago date', { is_completed: true, completed_at: '2026-10-20T04:59:59.999Z' }),
      task('Evening completion', { is_completed: true, completed_at: '2026-10-21T01:15:00Z' }),
    ]);
    mount();
    await screen.findByRole('textbox', { name: 'Search notes' });
    fireEvent.click(screen.getAllByRole('button', { name: /^Completed/ }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Completed from'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('Completed to'), { target: { value: '2026-10-20' } });
    expect(screen.getByRole('heading', { name: 'Evening completion' })).toBeVisible();
    expect(screen.getByText('Oct 20, 2026')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Previous Chicago date' })).not.toBeInTheDocument();
  });

  it('displays a load failure and retries without presenting an empty board', async () => {
    mockQueries([task('Saved task')], true);
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Team Board could not load');
    expect(screen.queryByText('Your team board is empty')).not.toBeInTheDocument();
    fireEvent.click(button('Try again'));
    expect(await screen.findByRole('textbox', { name: 'Search notes' })).toBeVisible();
    expect(screen.getAllByRole('heading', { name: 'Saved task' }).length).toBeGreaterThan(0);
  });

  it('keeps the open draft and existing notes if a background refresh fails', async () => {
    const { readNotes } = mockQueries([task('Existing task')]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Task' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Title'), { target: { value: 'Work in progress' } });
    readNotes.mockResolvedValueOnce({ data: null, error: new Error('Offline') });
    await act(async () => { db.realtime.mock.lastCall?.[0](); });
    expect(screen.getByText('Could not refresh notes. The board may be out of date.')).toBeVisible();
    expect(dialog.getByLabelText('Title')).toHaveValue('Work in progress');
    expect(screen.getAllByRole('heading', { name: 'Existing task', hidden: true })).not.toHaveLength(0);
  });

  it('discards an old refresh failure when a newer refresh has loaded', async () => {
    const { readNotes } = mockQueries([task('Original list')]);
    mount();
    await screen.findByRole('textbox', { name: 'Search notes' });

    let failOlderRead: (reply: { data: null; error: Error }) => void = () => {};
    readNotes
      .mockReturnValueOnce(new Promise(resolve => { failOlderRead = resolve; }))
      .mockResolvedValueOnce({ data: [task('Latest list')], error: null });
    await act(async () => {
      const refresh = db.realtime.mock.lastCall?.[0];
      refresh?.();
      refresh?.();
    });
    await act(async () => { failOlderRead({ data: null, error: new Error('Old failure') }); });
    expect(screen.getAllByRole('heading', { name: 'Latest list' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('locks the submitted fields and keeps the draft available if no saved row is returned', async () => {
    const { insert } = mockQueries([]);
    let finishInsert: (reply: { data: []; error: null }) => void = () => {};
    insert.mockReturnValueOnce(new Promise(resolve => { finishInsert = resolve; }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Task' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText('Type')).toHaveValue('todo');
    fireEvent.change(dialog.getByLabelText('Title'), { target: { value: 'Keep this draft' } });
    const submit = dialog.getByRole('button', { name: 'Add Task' });
    fireEvent.click(submit);
    expect(dialog.getByLabelText('Title')).toBeDisabled();
    await act(async () => { finishInsert({ data: [], error: null }); });
    await vi.waitFor(() => expect(db.toast).toHaveBeenCalledWith('error', expect.any(String)));
    expect(dialog.getByLabelText('Title')).toHaveValue('Keep this draft');
    expect(submit).toBeEnabled();
    expect(insert).toHaveBeenCalledOnce();
  });
});
