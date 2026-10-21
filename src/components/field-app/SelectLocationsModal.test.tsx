import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const toast = vi.fn();
let fieldReply: { data: unknown[] | null; error: { message: string } | null; count?: number | null } = {
  data: [], error: null, count: 0,
};
const rangeCalls: Array<[number, number]> = [];
const tables: string[] = [];

function chain() {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  for (const m of ['select', 'eq', 'order', 'or', 'not', 'limit']) builder[m] = vi.fn(self);
  builder.range = vi.fn((from: number, to: number) => {
    rangeCalls.push([from, to]);
    return builder;
  });
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(fieldReply).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      tables.push(table);
      return chain();
    }),
  },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../map/CRXMap', () => ({ default: ({ children }: { children?: ReactNode }) => <div>{children}</div> }));
vi.mock('../map/FieldBoundaryLayer', () => ({ default: () => <div /> }));

import SelectLocationsModal from './SelectLocationsModal';

const field = {
  id: 'field-1',
  field_name: 'North 40',
  customer_id: 'cust-1',
  total_acres: 40,
  crop_type: 'Corn',
  customer: { farm_name: 'Smith Farm' },
  billing_defaults: [],
};

describe('SelectLocationsModal field list', () => {
  beforeEach(() => {
    toast.mockReset();
    rangeCalls.length = 0;
    tables.length = 0;
  });

  it('reads every field page by page and loads no customer list', async () => {
    fieldReply = { data: [field], error: null, count: 1 };
    // A stable list: the modal reloads whenever initialSelectedIds is a new array.
    const initialSelectedIds: string[] = [];
    render(<SelectLocationsModal isOpen onClose={vi.fn()} onSelect={vi.fn()} initialSelectedIds={initialSelectedIds} />);

    expect(await screen.findByText('North 40')).toBeInTheDocument();
    expect(rangeCalls[0]).toEqual([0, 999]);
    expect(tables).not.toContain('customers');
    expect(screen.getByRole('combobox', { name: 'Filter by customer' })).toHaveAttribute('placeholder', 'All Customers');
  });

  it('a failed read after a successful one leaves no stale fields and blocks Select', async () => {
    fieldReply = { data: [field], error: null, count: 1 };
    const props = { onClose: vi.fn(), onSelect: vi.fn(), initialSelectedIds: ['field-1'] };
    const { rerender } = render(<SelectLocationsModal isOpen {...props} />);
    expect(await screen.findByText('North 40')).toBeInTheDocument();

    fieldReply = { data: null, error: { message: 'boom' }, count: null };
    rerender(<SelectLocationsModal isOpen={false} {...props} />);
    rerender(<SelectLocationsModal isOpen {...props} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Fields could not be loaded');
    expect(screen.queryByText('North 40')).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith('error', 'Failed to load fields');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Select/ })).toBeDisabled());
  });
});
