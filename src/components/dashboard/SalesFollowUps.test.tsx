import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SalesFollowUps from './SalesFollowUps';
import QuickTaskModal from '../team/QuickTaskModal';

const db = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  supabase: { from: db.from, rpc: db.rpc },
  assertRpcResult: (value: unknown) => value,
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'rep', role: 'sales_rep' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: db.toast }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/dateUtils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/dateUtils')>(),
  localToday: () => '2026-11-27',
}));

const profile = { id: 'rep', role: 'sales_rep' } as const;
const names = [{ id: 'rep', full_name: 'Oak Rep' }];
const callback = (id: string, title: string, dueDate: string, entityType = 'customer') => ({
  id, title, due_date: dueDate, assigned_to: 'rep',
  linked_entity_type: entityType, linked_entity_id: entityType === 'quote' ? 'quote-1' : 'farm',
});
const stale = (id: string, quoteNumber: string) => ({
  quote_id: id, quote_number: quoteNumber, farm_name: 'Oak Farm', assigned_sales_rep: 'rep',
  quote_age_days: 23, last_interaction_at: null,
});

function read(data: unknown, error: unknown = null, pending?: Promise<unknown>) {
  const result = pending ?? Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null });
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    not: vi.fn(),
    neq: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    then: result.then.bind(result),
  };
  for (const method of ['select', 'eq', 'is', 'in', 'not', 'neq', 'order', 'range'] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}

beforeEach(() => {
  vi.resetAllMocks();
  db.rpc.mockResolvedValue({ data: { success: true, total_count: 2, rows: [stale('quote-1', 'Q-1'), stale('quote-2', 'Q-2')] }, error: null });
});

describe('Sales follow-ups', () => {
  it('shows assigned open callbacks with Chicago due labels and respects denied quote access', async () => {
    const tasks = read([
      callback('one', 'Overdue call', '2026-11-26'),
      callback('two', 'Today call', '2026-11-27'),
      callback('three', 'Next call', '2026-11-28'),
    ]);
    db.from.mockImplementation((table) => {
      if (table === 'team_notes') return tasks;
      if (table === 'customers') return read([{ id: 'farm', farm_name: 'Oak Farm' }]);
      return read(names);
    });
    render(<MemoryRouter><SalesFollowUps profile={profile} deniedPages={['quotes']} /></MemoryRouter>);
    const list = await screen.findByRole('region', { name: 'My callbacks' });
    expect(await within(list).findByRole('link', { name: 'Overdue call' })).toHaveAttribute('href', '/team-board?note=one');
    expect(within(list).getByText('Overdue · Nov 26, 2026')).toBeVisible();
    expect(within(list).getByText('Due today')).toBeVisible();
    expect(within(list).getByText('Upcoming · Nov 28, 2026')).toBeVisible();
    expect(tasks.eq).toHaveBeenCalledWith('note_type', 'todo');
    expect(tasks.eq).toHaveBeenCalledWith('is_completed', false);
    expect(tasks.eq).toHaveBeenCalledWith('assigned_to', 'rep');
    expect(tasks.is).toHaveBeenCalledWith('deleted_at', null);
    expect(tasks.in).toHaveBeenCalledWith('linked_entity_type', ['customer']);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Stale quotes' })).not.toBeInTheDocument();
  });

  it('shows other reps’ and unassigned callbacks in the admin team queue', async () => {
    const tasks = read([
      { ...callback('pine-task', 'Pine Rep call', '2026-11-27'), assigned_to: 'pine-rep' },
      { ...callback('unassigned-task', 'Unassigned call', '2026-11-28'), assigned_to: null },
    ]);
    db.from.mockImplementation((table) => {
      if (table === 'team_notes') return tasks;
      if (table === 'customers') return read([{ id: 'farm', farm_name: 'Oak Farm' }]);
      return read([{ id: 'pine-rep', full_name: 'Pine Rep' }]);
    });
    render(<MemoryRouter><SalesFollowUps profile={{ id: 'admin', role: 'admin' }} deniedPages={['quotes']} /></MemoryRouter>);
    const list = screen.getByRole('region', { name: 'Team callbacks' });
    expect(await within(list).findByRole('link', { name: 'Pine Rep call' })).toHaveAttribute('href', '/team-board?note=pine-task');
    expect(within(list).getByRole('link', { name: 'Unassigned call' })).toHaveAttribute('href', '/team-board?note=unassigned-task');
    expect(within(list).getByText(/· Pine Rep/)).toBeVisible();
    expect(within(list).getByText(/· Unassigned/)).toBeVisible();
    expect(tasks.eq).not.toHaveBeenCalledWith('assigned_to', expect.anything());
  });

  it('opens the existing exact callback and offers scheduling for a different quote', async () => {
    const approvedQuoteTasks = read([{ id: 'task-id', linked_entity_id: 'quote-1' }]);
    const myTasks = read([]);
    db.from.mockImplementation((table) => {
      if (table === 'team_notes') return {
        select: (columns: string) => columns.includes('title') ? myTasks : approvedQuoteTasks,
      };
      if (table === 'quotes') return read([{ id: 'quote-1', quote_number: 'Q-1', customer: { farm_name: 'Oak Farm' } }]);
      return read(names);
    });
    render(<MemoryRouter><SalesFollowUps profile={profile} deniedPages={[]} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Open callback for quote Q-1' })).toHaveAttribute('href', '/team-board?note=task-id');
    expect(screen.getByRole('button', { name: 'Schedule callback for quote Q-2' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Schedule callback for quote Q-1' })).not.toBeInTheDocument();
    expect(approvedQuoteTasks.in).toHaveBeenCalledWith('linked_entity_id', ['quote-1', 'quote-2']);
    expect(approvedQuoteTasks.eq).not.toHaveBeenCalledWith('assigned_to', expect.anything());
  });

  it('offers a retry for a failed context lookup while keeping the stale quote list available', async () => {
    let farmError = true;
    db.from.mockImplementation((table) => {
      if (table === 'team_notes') return read([callback('one', 'Existing call', '2026-11-27')]);
      if (table === 'customers') return farmError ? read(null, { message: 'Unavailable' }) : read([{ id: 'farm', farm_name: 'Oak Farm' }]);
      return read(names);
    });
    render(<MemoryRouter><SalesFollowUps profile={profile} deniedPages={[]} /></MemoryRouter>);
    const pane = screen.getByRole('region', { name: 'My callbacks' });
    expect(await within(pane).findByText('Some details could not be loaded.')).toBeVisible();
    expect(within(pane).getByRole('link', { name: 'Existing call' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Oak Farm · #Q-1' })).toBeVisible();
    farmError = false;
    fireEvent.click(within(pane).getByRole('button', { name: 'Retry details' }));
    expect(await within(pane).findByText(/Oak Farm/)).toBeVisible();
    expect(within(pane).queryByText('Some details could not be loaded.')).not.toBeInTheDocument();
  });

  it('keeps scheduling available when only the quote assignee name fails to load', async () => {
    db.from.mockImplementation((table) => table === 'team_notes' ? read([]) : read(null, { message: 'Unavailable' }));
    render(<MemoryRouter><SalesFollowUps profile={profile} deniedPages={[]} /></MemoryRouter>);
    const pane = screen.getByRole('region', { name: 'Stale quotes' });
    expect(await within(pane).findByText('Some details could not be loaded.')).toBeVisible();
    fireEvent.click(within(pane).getByRole('button', { name: 'Schedule callback for quote Q-1' }));
    expect(await screen.findByRole('dialog')).toBeVisible();
  });

  it('keeps quotes visible and disables scheduling if their callback lookup fails', async () => {
    let callbackLookupFailed = true;
    db.from.mockImplementation((table) => {
      if (table !== 'team_notes') return read(names);
      return { select: (columns: string) => columns.includes('title') || !callbackLookupFailed
        ? read([]) : read(null, { message: 'Unavailable' }) };
    });
    render(<MemoryRouter><SalesFollowUps profile={profile} deniedPages={[]} /></MemoryRouter>);
    const pane = screen.getByRole('region', { name: 'Stale quotes' });
    expect(await within(pane).findByRole('link', { name: 'Oak Farm · #Q-1' })).toBeVisible();
    const schedule = within(pane).getByRole('button', { name: 'Schedule callback for quote Q-1' });
    expect(schedule).toBeDisabled();
    callbackLookupFailed = false;
    fireEvent.click(within(pane).getByRole('button', { name: 'Retry details' }));
    await waitFor(() => expect(schedule).toBeEnabled());
  });

  it('rechecks the quote before scheduling and uses a callback added while Today was open', async () => {
    let someoneElseAddedTask = false;
    db.from.mockImplementation((table) => {
      if (table !== 'team_notes') return read(names);
      return {
        select: (columns: string) => read(columns.includes('title') || !someoneElseAddedTask
          ? [] : [{ id: 'new-task', linked_entity_id: 'quote-1' }]),
      };
    });
    render(<MemoryRouter><SalesFollowUps profile={profile} deniedPages={[]} /></MemoryRouter>);
    const schedule = await screen.findByRole('button', { name: 'Schedule callback for quote Q-1' });
    someoneElseAddedTask = true;
    fireEvent.click(schedule);
    expect(await screen.findByRole('link', { name: 'Open callback for quote Q-1' })).toHaveAttribute('href', '/team-board?note=new-task');
    expect(screen.queryByRole('dialog', { name: 'Schedule callback' })).not.toBeInTheDocument();
  });

  it('refreshes both lists when closing after an unconfirmed callback save', async () => {
    let saved = false;
    const task = callback('saved-task', 'Saved callback', '2026-11-27', 'quote');
    const insert = vi.fn().mockImplementation(async () => {
      saved = true;
      return { error: new Error('Lost save response') };
    });
    db.from.mockImplementation((table) => {
      if (table === 'team_notes') return { insert, select: () => read(saved ? [task] : []) };
      if (table === 'quotes') return read([{ id: 'quote-1', quote_number: 'Q-1', customer: { farm_name: 'Oak Farm' } }]);
      return read(names);
    });
    render(<MemoryRouter><SalesFollowUps profile={profile} deniedPages={[]} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule callback for quote Q-1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule callback' });
    const save = within(dialog).getByRole('button', { name: 'Save callback' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(db.toast).toHaveBeenCalledWith('error', 'Lost save response'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('link', { name: 'Saved callback' })).toHaveAttribute('href', '/team-board?note=saved-task');
    expect(await screen.findByRole('link', { name: 'Open callback for quote Q-1' })).toHaveAttribute('href', '/team-board?note=saved-task');
    expect(insert).toHaveBeenCalledOnce();
  });

  it('waits for a prefilled assignee, refuses an inactive selection, and saves an exact quote todo', async () => {
    let finish: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => { finish = resolve; });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const onCreated = vi.fn();
    db.from.mockImplementation((table) => table === 'team_notes' ? { insert } : read(null, null, pending));
    render(<QuickTaskModal open callbackOnly entityType="quote" entityId="quote-1" prefillTitle="Call Oak"
      prefillAssignee="inactive-rep" onClose={vi.fn()} onCreated={onCreated} />);
    const save = screen.getByRole('button', { name: 'Save callback' });
    expect(save).toBeDisabled();
    finish({ data: names, error: null });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(insert).not.toHaveBeenCalled();
    expect(db.toast).toHaveBeenCalledWith('error', 'Choose an active assignee or select Unassigned.');
    fireEvent.change(screen.getByLabelText('Assign To'), { target: { value: 'rep' } });
    fireEvent.click(save);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      note_type: 'todo', assigned_to: 'rep', created_by: 'rep', linked_entity_type: 'quote', linked_entity_id: 'quote-1',
    }));
  });

  it.each([false, true])('reconciles a lost response when the form has been edited: %s', async (edited) => {
    const fields = {
      title: 'Call Oak', content: null, note_type: 'todo', priority: 'medium', assigned_to: null,
      due_date: null, created_by: 'rep', linked_entity_type: 'quote', linked_entity_id: 'quote-1',
    };
    const insert = vi.fn()
      .mockResolvedValueOnce({ error: new Error('Lost save response') })
      .mockResolvedValueOnce({ error: { code: '23505' } });
    const existing = read(fields);
    const select = existing.select.mockReturnValue({ eq: existing.eq });
    existing.eq.mockReturnValue({ eq: existing.eq, maybeSingle: vi.fn().mockResolvedValue({ data: fields, error: null }) });
    db.from.mockImplementation((table) => table === 'team_notes' ? { insert, select } : read(names));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<QuickTaskModal open callbackOnly entityType="quote" entityId="quote-1" prefillTitle="Call Oak"
      onCreated={onCreated} onClose={onClose} />);
    const save = screen.getByRole('button', { name: 'Save callback' });
    fireEvent.click(save);
    await waitFor(() => expect(db.toast).toHaveBeenCalledWith('error', 'Lost save response'));
    if (edited) fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New title' } });
    fireEvent.click(save);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(insert).toHaveBeenCalledTimes(2);
    const first = insert.mock.calls[0][0];
    expect(first).toEqual({ id: expect.any(String), ...fields });
    expect(insert.mock.calls[1][0]).toEqual({ ...first, title: edited ? 'New title' : fields.title });
    if (edited) {
      expect(onClose).not.toHaveBeenCalled();
      expect(db.toast).toHaveBeenCalledWith('error', 'The earlier callback was already saved. Open it on Team Board to make changes.');
    } else {
      expect(onClose).toHaveBeenCalledOnce();
    }
  });
});
