import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// The customer page puts selling first: Quotes and Orders open above the edit form, and the
// header carries full-label sales actions with "Repeat last quote" beside "New quote".

const { mockFrom, mockRpc, mockUntypedRpc } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockUntypedRpc: vi.fn(),
}));

function query(data: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['eq', 'neq', 'is', 'in', 'gt', 'order', 'limit', 'single', 'maybeSingle', 'select', 'range']) chain[name] = () => chain;
  const promise = Promise.resolve({ data, error: null });
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    supabase: { from: mockFrom, rpc: mockRpc },
    supabaseUntyped: { rpc: mockUntypedRpc },
    assertRpcResult: actual.assertRpcResult,
    checkMutationResult: vi.fn(),
    hasRpcCode: actual.hasRpcCode,
    RpcErrorCodes: actual.RpcErrorCodes,
    sanitizeError: actual.sanitizeError,
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'rep-1', role: 'sales_rep', full_name: 'Rep' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }) }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn(async () => true) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/ui/CommissionSplitEditor', () => ({ default: () => <div /> }));
vi.mock('../components/field-app/ApplicationServicePicker', () => ({ default: () => <div /> }));
vi.mock('../components/customers/CustomerSummaryBar', () => ({ default: () => <div /> }));
vi.mock('../components/customers/CustomerContacts', () => ({ default: () => <div />, CustomerInteractionsHistory: () => <div /> }));
vi.mock('../components/customers/CustomerFacts', () => ({ default: () => <div /> }));
vi.mock('../components/customers/CustomerPrepCard', () => ({ default: () => <div /> }));
vi.mock('../components/customers/CustomerDocuments', () => ({ default: () => <div /> }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));

import CustomerDetail from './CustomerDetail';

const customer = {
  id: 'customer-1', farm_name: 'Sales Farm', contact_name: 'Pat', assigned_tier: 1,
  assigned_sales_rep: 'rep-1', is_active: true, default_commission_split: { splits: [] }, crops: [], row_version: 1,
};
const quotes = [
  { id: 'quote-new', quote_number: 'Q-200', status: 'sent', tier: 1, total_price: 500, created_at: '2026-11-01T12:00:00Z', is_planned: false },
  { id: 'quote-old', quote_number: 'Q-100', status: 'accepted', tier: 1, total_price: 300, created_at: '2026-03-01T12:00:00Z', is_planned: false },
];
const orders = [
  { id: 'order-1', order_number: 'ORD-7', status: 'confirmed', total_price: 300, order_date: '2026-03-02' },
];

function Where() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}{location.search}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes><Route path="/customers/:id" element={<CustomerDetail />} /><Route path="*" element={null} /></Routes>
    </MemoryRouter>,
  );
}

describe('CustomerDetail puts sales first', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return query(customer);
      if (table === 'quotes') return query(quotes);
      if (table === 'orders') return query(orders);
      return query([]);
    });
    mockRpc.mockResolvedValue({ data: [], error: null });
    mockUntypedRpc.mockResolvedValue({ data: { quote_id: 'quote-copy' }, error: null });
  });

  it('opens Quotes and Orders on load, above the edit form', async () => {
    renderAt('/customers/customer-1');
    const farmName = await screen.findByDisplayValue('Sales Farm');

    const quotesBand = screen.getByRole('button', { name: 'Quotes', expanded: true });
    const ordersBand = screen.getByRole('button', { name: 'Orders', expanded: true });
    expect(await screen.findByText('Q-200')).toBeInTheDocument();
    expect(await screen.findByText('ORD-7')).toBeInTheDocument();

    expect(quotesBand.compareDocumentPosition(ordersBand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ordersBand.compareDocumentPosition(farmName) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows full-label sales actions and keeps the rarer ones under More', async () => {
    renderAt('/customers/customer-1');
    await screen.findByDisplayValue('Sales Farm');

    for (const label of ['New quote', 'New order', 'Schedule delivery', 'Log call']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Sched. Delivery' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Schedule delivery' }));
    expect(screen.getByRole('status', { name: 'location' })).toHaveTextContent('/deliveries/new?customer_id=customer-1');
  });

  it('lists Sell & deliver now, New job, Create task and Season summary in the More menu', async () => {
    renderAt('/customers/customer-1');
    await screen.findByDisplayValue('Sales Farm');

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    for (const label of ['Sell & deliver now', 'New job', 'Create task', 'Season summary']) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('Repeat last quote sits next to New quote and copies the newest quote', async () => {
    renderAt('/customers/customer-1');
    await screen.findByDisplayValue('Sales Farm');

    const repeat = await screen.findByRole('button', { name: 'Repeat last quote' });
    const newQuote = screen.getByRole('button', { name: 'New quote' });
    expect(newQuote.nextElementSibling).toBe(repeat);

    fireEvent.click(repeat);
    await waitFor(() => expect(mockUntypedRpc).toHaveBeenCalledWith('duplicate_quote', expect.objectContaining({ p_source_quote_id: 'quote-new' })));
    await waitFor(() => expect(screen.getByRole('status', { name: 'location' })).toHaveTextContent('/quotes/quote-copy'));
  });

  it('hides Repeat last quote when the customer has no quotes', async () => {
    mockFrom.mockImplementation((table: string) => (table === 'customers' ? query(customer) : query([])));
    renderAt('/customers/customer-1');
    await screen.findByDisplayValue('Sales Farm');
    expect(await screen.findByText('No quotes for this customer yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Repeat last quote' })).not.toBeInTheDocument();
  });

  it('keeps the new-customer form free of sales actions and sections', async () => {
    renderAt('/customers/new');
    await screen.findByRole('button', { name: 'Create Customer' });
    expect(screen.queryByRole('button', { name: 'New quote' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quotes' })).not.toBeInTheDocument();
    expect(mockFrom).not.toHaveBeenCalledWith('quotes');
    expect(mockFrom).not.toHaveBeenCalledWith('orders');
  });
});
