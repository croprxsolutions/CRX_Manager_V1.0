import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as unknown,
  filters: [] as string[],
  tables: [] as string[],
}));

function query() {
  const q: Record<string, unknown> = {};
  let range: [number, number] = [0, Infinity];
  q.select = () => q;
  q.eq = (c: string, v: unknown) => { H.filters.push(`eq ${c}=${String(v)}`); return q; };
  q.is = (c: string, v: unknown) => { H.filters.push(`is ${c}=${String(v)}`); return q; };
  q.order = () => q;
  q.range = (from: number, to: number) => { range = [from, to]; return q; };
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(
    H.error
      ? { data: null, error: H.error, count: null }
      : { data: H.rows.slice(range[0], range[1] + 1), error: null, count: H.rows.length },
  ).then(resolve);
  return q;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: (table: string) => { H.tables.push(table); return query(); } },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import UnassignedDeliveriesBanner from './UnassignedDeliveriesBanner';

const renderBanner = () => render(<MemoryRouter><UnassignedDeliveriesBanner /></MemoryRouter>);

describe('UnassignedDeliveriesBanner', () => {
  beforeEach(() => {
    H.rows = [];
    H.error = null;
    H.filters = [];
    H.tables = [];
  });

  it('reads only scheduled, undeleted deliveries with no driver', async () => {
    renderBanner();
    await waitFor(() => expect(H.tables).toEqual(['deliveries']));
    expect(H.filters).toEqual(['eq status=scheduled', 'is assigned_driver=null', 'is deleted_at=null']);
  });

  it('shows nothing when every scheduled delivery has a driver', async () => {
    const { container } = renderBanner();
    await waitFor(() => expect(H.tables).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('warns with the count and lists the deliveries, each linking to its page, when tapped', async () => {
    H.rows = [
      { id: 'd1', delivery_number: 'DEL-001', scheduled_date: '2026-11-25', customer: { farm_name: 'North Farm' } },
      { id: 'd2', delivery_number: 'DEL-002', scheduled_date: '2026-11-26', customer: null },
    ];
    renderBanner();
    expect(await screen.findByText('2 scheduled deliveries have no driver')).toBeInTheDocument();
    expect(screen.queryByText('DEL-001')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    expect(screen.getByRole('link', { name: 'DEL-001' })).toHaveAttribute('href', '/deliveries/d1');
    expect(screen.getByRole('link', { name: 'DEL-002' })).toHaveAttribute('href', '/deliveries/d2');
    expect(screen.getByText('North Farm')).toBeInTheDocument();
  });

  it('uses the singular for one delivery', async () => {
    H.rows = [{ id: 'd1', delivery_number: 'DEL-001', scheduled_date: '2026-11-25', customer: null }];
    renderBanner();
    expect(await screen.findByText('1 scheduled delivery has no driver')).toBeInTheDocument();
  });

  it('pages past the first 25 with Show more', async () => {
    H.rows = Array.from({ length: 30 }, (_, i) => ({
      id: `d${i}`, delivery_number: `DEL-${i}`, scheduled_date: '2026-11-25', customer: null,
    }));
    renderBanner();
    expect(await screen.findByText('30 scheduled deliveries have no driver')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    expect(screen.getAllByRole('link')).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: /Show more \(5 not shown\)/ }));
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(30));
  });

  it('stays hidden when the read fails, so the list below is not blocked', async () => {
    H.error = new Error('boom');
    const { container } = renderBanner();
    await waitFor(() => expect(H.tables).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });
});
