import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), captureException: vi.fn() }));
vi.mock('../../lib/db', () => ({ supabaseUntyped: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));

import ProductChangeHistory from './ProductChangeHistory';

const changed = {
  id: 2, product_id: 'p1', change_type: 'updated', field_name: 'signal_word',
  old_value: 'Caution', new_value: 'Warning', changed_by: 'u1', changed_by_name: 'Test Admin',
  changed_at: '2026-11-02T15:00:00Z',
};

function returnRows(data: unknown, error: { message: string; code: string } | null = null) {
  const query = {
    select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockResolvedValue({ data, error });
  mocks.from.mockReturnValue(query);
  return query;
}

describe('ProductChangeHistory', () => {
  beforeEach(() => { mocks.from.mockReset(); mocks.captureException.mockReset(); });

  it('shows the field label, before and after values, actor and date', async () => {
    const query = returnRows([changed]);
    render(<ProductChangeHistory productId="p1" />);
    const item = await screen.findByRole('listitem');
    expect(within(item).getByText('Test Admin')).toBeInTheDocument();
    expect(within(item).getByText('Signal word').parentElement).toHaveTextContent('Signal word: Caution → Warning');
    expect(within(item).getByText(/11\/2\/2026/)).toBeInTheDocument();
    expect(query.select).toHaveBeenCalledWith('id, product_id, change_type, field_name, old_value, new_value, changed_by, changed_by_name, changed_at');
    expect(query.limit).toHaveBeenCalledWith(50);
    expect(query.order).toHaveBeenCalledWith('changed_at', { ascending: false });
    expect(query.order).toHaveBeenCalledWith('id', { ascending: false });
  });

  it('shows a created row by System', async () => {
    returnRows([{ ...changed, id: 1, change_type: 'created', field_name: null, old_value: null,
      new_value: null, changed_by: null, changed_by_name: null }]);
    render(<ProductChangeHistory productId="p1" />);
    const item = await screen.findByRole('listitem');
    expect(within(item).getByText('Created')).toBeInTheDocument();
    expect(within(item).getByText('System')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    returnRows([]);
    render(<ProductChangeHistory productId="p1" />);
    expect(await screen.findByText('No changes recorded yet.')).toBeInTheDocument();
  });

  it('refetches when reloadToken changes', async () => {
    returnRows([]);
    const view = render(<ProductChangeHistory productId="p1" reloadToken={0} />);
    expect(await screen.findByText('No changes recorded yet.')).toBeInTheDocument();
    returnRows([changed]);
    view.rerender(<ProductChangeHistory productId="p1" reloadToken={1} />);
    expect(await screen.findByRole('listitem')).toHaveTextContent('Signal word: Caution → Warning');
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });

  it('shows a field-only description when values are withheld', async () => {
    returnRows([{ ...changed, field_name: 'notes', old_value: null, new_value: null }]);
    render(<ProductChangeHistory productId="p1" />);
    expect(await screen.findByText('Notes changed')).toBeInTheDocument();
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
  });

  it('shows boolean changes as Yes and No', async () => {
    returnRows([{ ...changed, field_name: 'is_active', old_value: 'true', new_value: 'false' }]);
    render(<ProductChangeHistory productId="p1" />);
    expect((await screen.findByText('Active')).parentElement).toHaveTextContent('Active: Yes → No');
  });

  it('explains the 50-row limit', async () => {
    returnRows(Array.from({ length: 50 }, (_, index) => ({ ...changed, id: index + 1 })));
    render(<ProductChangeHistory productId="p1" />);
    expect(await screen.findByText('Showing the newest 50 changes.')).toBeInTheDocument();
  });

  it('reports a failed read without exposing the database error and retries', async () => {
    returnRows(null, { message: 'private database detail', code: '42501' });
    render(<ProductChangeHistory productId="p1" />);
    expect(await screen.findByText('Change history could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('private database detail')).not.toBeInTheDocument();
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.captureException.mock.calls[0][0]).toBeInstanceOf(Error);
    returnRows([changed]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('listitem')).toHaveTextContent('Signal word: Caution → Warning'));
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });
});
