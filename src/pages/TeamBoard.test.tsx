import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TeamNote } from '../types';
import TeamBoard from './TeamBoard';

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), toast: vi.fn() }));

vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  supabase: { from: db.from, rpc: db.rpc },
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: db.toast }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'office' }, role: 'admin' }) }));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => ({ state: 'unblocked' }) }));
vi.mock('../hooks/useRealtimeSubscription', () => ({ useRealtimeNotes: vi.fn() }));
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
  const result = { data: rows, error: null };
  const insert = vi.fn().mockResolvedValue({ data: [], error: null });
  let failNextRead = initialError;
  db.from.mockImplementation((table: string) => {
    const reply = {
      data: table === 'team_notes' ? result.data : [],
      error: table === 'team_notes' && failNextRead ? new Error('Offline') : null,
    };
    if (table === 'team_notes') failNextRead = false;
    const chain = {
      select: vi.fn(() => chain), eq: vi.fn(() => chain), is: vi.fn(() => chain), neq: vi.fn(() => chain),
      order: vi.fn(() => chain), in: vi.fn(() => chain),
      insert: vi.fn(() => ({ select: insert })),
      then: (resolve: (data: typeof reply) => void) => Promise.resolve(reply).then(resolve),
    };
    return chain;
  });
  return insert;
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

  it('keeps the draft and enables retry if creating a task returns no saved row', async () => {
    const insert = mockQueries([]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Task' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText('Type')).toHaveValue('todo');
    fireEvent.change(dialog.getByLabelText('Title'), { target: { value: 'Keep this draft' } });
    const submit = dialog.getByRole('button', { name: 'Add Task' });
    fireEvent.click(submit);
    await vi.waitFor(() => expect(db.toast).toHaveBeenCalledWith('error', expect.any(String)));
    expect(dialog.getByLabelText('Title')).toHaveValue('Keep this draft');
    expect(submit).toBeEnabled();
    expect(insert).toHaveBeenCalledOnce();
  });
});
