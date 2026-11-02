import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RupIncompleteNotice from './RupIncompleteNotice';

const H = vi.hoisted(() => ({
  registerRows: { current: [{ id: 'sale-1', compliance_status: 'compliant' }] },
  registerError: { current: false },
  exportToCSV: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/db', () => {
  function createQuery(result: { data: unknown; error: unknown }) {
    const query = new Proxy({}, {
      get(_target, property: string | symbol) {
        if (property === 'then') {
          return (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return () => query;
      },
    }) as Record<string, unknown>;
    return query;
  }

  return {
    supabase: {
      from: () => createQuery({ data: [], error: null }),
      rpc: () => createQuery({
        data: H.registerError.current ? null : H.registerRows.current,
        error: H.registerError.current ? { message: 'test load failure' } : null,
      }),
    },
    assertRpcResult: vi.fn((data: unknown) => data),
    checkMutationResult: vi.fn(),
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'admin-1', role: 'admin', is_active: true } }),
}));
vi.mock('../../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../lib/csvExport', () => ({ exportToCSV: H.exportToCSV, fmtCSV: vi.fn() }));
vi.mock('../../components/ui/DataTable', () => ({ default: () => <div data-testid="data-table" /> }));

import Compliance from '../../pages/Compliance';

describe('RupIncompleteNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.registerRows.current = [{ id: 'sale-1', compliance_status: 'compliant' }];
    H.registerError.current = false;
  });

  it('renders the incomplete notice with note semantics', () => {
    render(<RupIncompleteNotice />);

    expect(screen.getByRole('note')).toHaveTextContent(
      'Known incomplete. Restricted Use flags on products have not all been reviewed, so this list and its counts may be missing products.',
    );
  });

  it('shows the notice on the RUP Products tab', async () => {
    render(<MemoryRouter><Compliance /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /RUP Products/ }));

    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(screen.getByTestId('data-table')).toBeInTheDocument();
  });

  it('shows the notice above the register filters and exports with the incomplete filename', async () => {
    render(<MemoryRouter><Compliance /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /RUP Sales Register/ }));

    const notice = await screen.findByRole('note');
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    expect(notice.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => {
      expect(H.exportToCSV).toHaveBeenCalledWith(
        H.registerRows.current,
        expect.any(Array),
        'rup_sales_register_known_incomplete',
      );
    });
  });

  it('keeps the notice visible when the register fails to load', async () => {
    H.registerError.current = true;
    render(<MemoryRouter><Compliance /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /RUP Sales Register/ }));

    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(await screen.findByText('The RUP sales register could not be loaded')).toBeInTheDocument();
  });
});
