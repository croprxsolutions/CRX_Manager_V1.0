import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// #1996: a slow farm-group reply for a customer no longer selected must not set the group.

type Member = { id: string; farm_name: string };
const H = vi.hoisted(() => ({
  groupReplies: new Map<string, (members: Member[]) => void>(),
}));

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => {
      const rows = table === 'customers'
        ? [{ id: 'a', farm_name: 'Alpha Farms' }, { id: 'b', farm_name: 'Beta Farms' }]
        : [];
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'in', 'not', 'limit']) builder[m] = () => builder;
      builder.range = () => Promise.resolve({ data: rows, error: null, count: rows.length });
      return builder;
    },
    rpc: (name: string, args: { p_customer_id?: string }) => {
      if (name === 'get_customer_farm_group') {
        // Held until the test answers it, so replies can land out of order.
        return new Promise((resolve) => {
          H.groupReplies.set(args.p_customer_id as string, (members) => resolve({ data: members, error: null }));
        });
      }
      const paged = {
        order: () => paged,
        range: () => Promise.resolve({ data: [], error: null, count: 0 }),
      };
      return paged;
    },
  },
  assertRpcResult: <T,>(data: T) => data,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin' }) }));
const toast = vi.fn();
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../components/products/ProductSearchPicker', () => ({ default: () => null }));

import SalesReports from './SalesReports';

afterEach(() => { cleanup(); H.groupReplies.clear(); });

const pickCustomer = async (name: string) => {
  fireEvent.change(screen.getByPlaceholderText(/Search customers|selected/), { target: { value: name.slice(0, 4) } });
  fireEvent.click(await screen.findByRole('button', { name }));
};

describe('SalesReports farm group', () => {
  it('ignores a slow reply for a customer who is no longer selected', async () => {
    render(<MemoryRouter><SalesReports /></MemoryRouter>);

    await pickCustomer('Alpha Farms');
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    await pickCustomer('Beta Farms');

    // Beta's reply lands first, then Alpha's stale reply (two linked farms) lands after it.
    await act(async () => {
      H.groupReplies.get('b')!([{ id: 'b', farm_name: 'Beta Farms' }, { id: 'b2', farm_name: 'Beta East' }]);
    });
    expect(await screen.findByText('Include 1 linked farm')).toBeInTheDocument();
    await act(async () => {
      H.groupReplies.get('a')!([
        { id: 'a', farm_name: 'Alpha Farms' }, { id: 'a2', farm_name: 'Alpha North' }, { id: 'a3', farm_name: 'Alpha South' },
      ]);
    });

    expect(screen.getByText('Include 1 linked farm')).toBeInTheDocument();
    expect(screen.queryByText(/Include 2 linked farms/)).not.toBeInTheDocument();
  });
});
