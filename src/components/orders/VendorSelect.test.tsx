import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VendorSelect from './VendorSelect';
import { useVendorNames } from '../../lib/useVendorNames';

const mocks = vi.hoisted(() => ({ from: vi.fn(), captureException: vi.fn() }));
vi.mock('../../lib/db', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));

beforeEach(() => vi.clearAllMocks());

describe('VendorSelect', () => {
  it('offers the active vendors, and a vendor no longer on the list stays shown', () => {
    render(<VendorSelect label="Vendor for A" value="Old Supply" vendors={['Acme', 'Bolt']} onChange={vi.fn()} />);
    const select = screen.getByLabelText('Vendor for A') as HTMLSelectElement;
    expect(select.value).toBe('Old Supply');
    expect([...select.options].map((o) => o.value)).toEqual(['Old Supply', 'Acme', 'Bolt']);
  });

  it('reports the picked vendor', () => {
    const onChange = vi.fn();
    render(<VendorSelect label="Vendor for A" value={null} vendors={['Acme']} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Vendor for A'), { target: { value: 'Acme' } });
    expect(onChange).toHaveBeenCalledWith('Acme');
  });

  it('offers No vendor only on a line without one: the database keeps or refills a vendor, so it cannot be cleared', () => {
    const { rerender } = render(<VendorSelect label="Vendor for A" value={null} vendors={['Acme']} onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'No vendor' })).toBeInTheDocument();
    rerender(<VendorSelect label="Vendor for A" value="Acme" vendors={['Acme']} onChange={vi.fn()} />);
    expect(screen.queryByRole('option', { name: 'No vendor' })).toBeNull();
  });
});

function Names() {
  const names = useVendorNames(true);
  return <div>{names.join(',') || 'none'}</div>;
}

function read(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'order', 'range']) q[m] = () => q;
  q.then = (done: (v: unknown) => unknown) => Promise.resolve(result).then(done);
  return q;
}

describe('useVendorNames', () => {
  it('reads every page of vendors', async () => {
    const rows = [...Array.from({ length: 1000 }, (_, i) => ({ id: `v${i}`, name: `V${i}` })), { id: 'last', name: 'Last' }];
    mocks.from.mockImplementation(() => {
      const q = read({ data: rows, error: null, count: rows.length });
      q.range = (from: number, to: number) => read({ data: rows.slice(from, to + 1), error: null, count: rows.length });
      return q;
    });
    render(<Names />);
    await waitFor(() => expect(screen.getByText(/,Last$/)).toBeInTheDocument());
  });

  it('reads the active vendors', async () => {
    mocks.from.mockReturnValue(read({ data: [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'Bolt' }], error: null, count: 2 }));
    render(<Names />);
    await waitFor(() => expect(screen.getByText('Acme,Bolt')).toBeInTheDocument());
    expect(mocks.from).toHaveBeenCalledWith('vendors');
  });

  it('reports a failed read and leaves the list empty, so a line keeps showing its own vendor', async () => {
    mocks.from.mockReturnValue(read({ data: null, error: new Error('down') }));
    render(<Names />);
    await waitFor(() => expect(mocks.captureException).toHaveBeenCalled());
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});
