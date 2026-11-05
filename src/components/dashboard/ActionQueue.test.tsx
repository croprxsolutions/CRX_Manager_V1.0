import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ActionQueue from './ActionQueue';

const mockRpc = vi.fn();
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../lib/db', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  assertRpcResult: vi.fn((data: unknown) => data),
}));

function renderQueue() {
  return render(<MemoryRouter><ActionQueue /></MemoryRouter>);
}

describe('ActionQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('shows loading skeleton initially', () => {
    mockRpc.mockReturnValue(new Promise(() => {}));
    renderQueue();
    expect(screen.getByText('Action Queue')).toBeInTheDocument();
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows All Clear when no items', async () => {
    mockRpc.mockResolvedValue({
      data: {
        overdue_invoices: [],
        cancelled_posted: [],
        overdue_deliveries: [],
        low_stock: [],
        expiring_quotes: [],
        unassigned_deliveries: [],
      },
      error: null,
    });

    renderQueue();
    await waitFor(() => {
      expect(screen.getByText(/All Clear/)).toBeInTheDocument();
    });
  });

  it('renders overdue invoices category with items', async () => {
    mockRpc.mockResolvedValue({
      data: {
        overdue_invoices: [
          { id: 'inv-1', primary_text: 'INV-001', secondary_text: 'Farm Alpha', days_overdue: 15, amount_cents: 250000 },
          { id: 'inv-2', primary_text: 'INV-002', secondary_text: 'Farm Beta', days_overdue: 5, amount_cents: 100000 },
        ],
        cancelled_posted: [],
        overdue_deliveries: [],
        low_stock: [],
        expiring_quotes: [],
        unassigned_deliveries: [],
      },
      error: null,
    });

    renderQueue();
    await waitFor(() => {
      expect(screen.getByText('Overdue Invoices (2)')).toBeInTheDocument();
    });
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getByText('INV-002')).toBeInTheDocument();
  });

  it('navigates to entity detail on item click', async () => {
    mockRpc.mockResolvedValue({
      data: {
        overdue_invoices: [
          { id: 'inv-1', primary_text: 'INV-001', secondary_text: 'Farm Alpha', days_overdue: 15, amount_cents: 250000 },
        ],
        cancelled_posted: [],
        overdue_deliveries: [],
        low_stock: [],
        expiring_quotes: [],
        unassigned_deliveries: [],
      },
      error: null,
    });

    renderQueue();
    await waitFor(() => {
      expect(screen.getByText('INV-001')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('INV-001'));
    expect(mockNavigate).toHaveBeenCalledWith('/invoices/inv-1');
  });

  it('renders new delivery safety-net categories and opens their deliveries', async () => {
    mockRpc.mockResolvedValue({
      data: {
        due_today_not_started: [
          { id: 'del-due', primary_text: 'DEL-002', secondary_text: 'Farm Alpha', scheduled_date: '2026-07-09' },
        ],
        unbilled_deliveries: [
          { id: 'del-unbilled', primary_text: 'DEL-003', secondary_text: 'Farm Beta', scheduled_date: '2026-07-08' },
        ],
      },
      error: null,
    });

    renderQueue();
    await waitFor(() => {
      expect(screen.getByText('Due today — not started (1)')).toBeInTheDocument();
      expect(screen.getByText('Delivered, not invoiced (1)')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('DEL-002'));
    fireEvent.click(screen.getByText('DEL-003'));
    expect(mockNavigate).toHaveBeenNthCalledWith(1, '/deliveries/del-due');
    expect(mockNavigate).toHaveBeenNthCalledWith(2, '/deliveries/del-unbilled');
  });

  it('dismiss hides an item', async () => {
    mockRpc.mockResolvedValue({
      data: {
        overdue_invoices: [
          { id: 'inv-1', primary_text: 'INV-001', secondary_text: 'Farm Alpha', days_overdue: 15, amount_cents: 250000 },
        ],
        cancelled_posted: [],
        overdue_deliveries: [],
        low_stock: [],
        expiring_quotes: [],
        unassigned_deliveries: [],
      },
      error: null,
    });

    renderQueue();
    await waitFor(() => {
      expect(screen.getByText('INV-001')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByText('INV-001')).not.toBeInTheDocument();
  });

  it('shows total count in header', async () => {
    mockRpc.mockResolvedValue({
      data: {
        overdue_invoices: [
          { id: 'inv-1', primary_text: 'INV-001', secondary_text: 'Farm Alpha', days_overdue: 15, amount_cents: 250000 },
        ],
        cancelled_posted: [],
        overdue_deliveries: [
          { id: 'del-1', primary_text: 'DEL-001', secondary_text: 'Farm Beta', days_overdue: 3 },
        ],
        low_stock: [],
        expiring_quotes: [],
        unassigned_deliveries: [],
      },
      error: null,
    });

    renderQueue();
    await waitFor(() => {
      expect(screen.getByText('(2)')).toBeInTheDocument();
    });
  });

  it('shows the true group count from the server, not the 10 examples it sent (H36)', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      id: `inv-${i}`, primary_text: `INV-${i}`, secondary_text: 'Farm', days_overdue: 3, amount_cents: 100,
    }));
    mockRpc.mockResolvedValue({ data: { overdue_invoices: ten, counts: { overdue_invoices: 37 } }, error: null });

    renderQueue();
    expect(await screen.findByText('Overdue Invoices (37)')).toBeInTheDocument();
    // 5 rows shown expanded, the rest counted from the true total.
    expect(screen.getByText('+32 more items')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('get_dashboard_action_items', { p_limit: 10 });
  });

  it('a dismissed item comes off the true count', async () => {
    mockRpc.mockResolvedValue({
      data: {
        overdue_invoices: [
          { id: 'inv-1', primary_text: 'INV-001', secondary_text: 'Farm', days_overdue: 3, amount_cents: 100 },
        ],
        counts: { overdue_invoices: 12 },
      },
      error: null,
    });
    renderQueue();
    expect(await screen.findByText('Overdue Invoices (12)')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss for today'));
    // The only loaded example is dismissed, so the group leaves the queue.
    await waitFor(() => expect(screen.queryByText(/Overdue Invoices/)).not.toBeInTheDocument());
  });

  it('without a server count, a full group of 10 is shown as 10+, never as a complete 10', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `d-${i}`, primary_text: `DEL-${i}`, secondary_text: 'Farm' }));
    mockRpc.mockResolvedValue({ data: { overdue_deliveries: ten }, error: null });
    renderQueue();
    expect(await screen.findByText(/Deliveries \(10\+\)$/)).toBeInTheDocument();
    expect(screen.getByText('5+ more items')).toBeInTheDocument();
  });

  it('a failed read says the queue could not be loaded, never All Clear, and Try again reloads', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });
    renderQueue();
    expect(await screen.findByText('The action queue could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/All Clear/)).not.toBeInTheDocument();

    mockRpc.mockResolvedValueOnce({ data: { overdue_invoices: [], counts: { overdue_invoices: 0 } }, error: null });
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText(/All Clear/)).toBeInTheDocument();
  });
});
