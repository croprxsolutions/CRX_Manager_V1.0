import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkloadView from './WorkloadView';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/db')>(),
  supabase: { rpc },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(() => { cleanup(); rpc.mockReset(); });

describe('Workload', () => {
  it.each([
    { data: null, error: null },
    { data: [], error: new Error('Unavailable') },
  ])('separates unavailable data from an empty team and can retry', async failure => {
    rpc.mockResolvedValueOnce(failure).mockResolvedValueOnce({ data: [], error: null });
    render(<WorkloadView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Workload could not load');
    expect(screen.queryByText(/0 team members/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No team members to show')).toBeVisible();
  });

  it('puts overdue work first and shows delivery totals without opening rows', async () => {
    rpc.mockResolvedValue({ data: [
      { id: '1', full_name: null, role: 'applicator', open_tasks: 4, overdue_tasks: 0, today_deliveries: 0, week_deliveries: 0 },
      { id: '2', full_name: 'Office driver', role: 'driver', open_tasks: 2, overdue_tasks: 1, today_deliveries: 1, week_deliveries: 3 },
    ], error: null });
    render(<WorkloadView />);
    expect(await screen.findByText('6 open tasks')).toBeVisible();
    const [driver, unnamed] = screen.getAllByRole('listitem');
    expect(within(driver).getByText('Office driver')).toBeVisible();
    expect(within(driver).getByText('1 delivery today · 3 this week')).toBeVisible();
    expect(within(unnamed).getByText('Unnamed team member')).toBeVisible();
  });
});
