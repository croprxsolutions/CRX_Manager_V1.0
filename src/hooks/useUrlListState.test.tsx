import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { listSortParam, oneOf, parseListSort, useUrlListState } from './useUrlListState';

const DEFAULTS = { q: '', status: 'active', sort: '' } as const;

function List() {
  const [list, setList] = useUrlListState(DEFAULTS);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <input aria-label="Search" value={list.q} onChange={(e) => setList({ q: e.target.value })} />
      <span data-testid="status">{list.status}</span>
      <span data-testid="address">{location.search}</span>
      <button type="button" onClick={() => setList({ status: 'all', q: 'farm' })}>Both</button>
      <button type="button" onClick={() => setList({ status: 'active' })}>Default status</button>
      <button type="button" onClick={() => navigate('/record')}>Open record</button>
      <button type="button" onClick={() => navigate(-1)}>Leave list</button>
    </div>
  );
}

function Record() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Back</button>;
}

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={['/start', path]} initialIndex={1}>
    <Routes>
      <Route path="/start" element={<p>Start page</p>} />
      <Route path="/list" element={<List />} />
      <Route path="/record" element={<Record />} />
    </Routes>
  </MemoryRouter>,
);

describe('useUrlListState', () => {
  it('reads the list state from the address and falls back to the defaults', () => {
    renderAt('/list?q=corn');
    expect(screen.getByLabelText('Search')).toHaveValue('corn');
    expect(screen.getByTestId('status')).toHaveTextContent('active');
  });

  it('writes every change of one click together and leaves defaults out of the address', () => {
    renderAt('/list');
    fireEvent.click(screen.getByRole('button', { name: 'Both' }));
    expect(screen.getByTestId('address')).toHaveTextContent('?status=all&q=farm');
    fireEvent.click(screen.getByRole('button', { name: 'Default status' }));
    expect(screen.getByTestId('address')).toHaveTextContent('?q=farm');
  });

  it('typing replaces the history entry, so Back from a record returns to the typed search, and one more Back leaves the list', () => {
    renderAt('/list');
    const search = screen.getByLabelText('Search');
    fireEvent.change(search, { target: { value: 'c' } });
    fireEvent.change(search, { target: { value: 'co' } });
    fireEvent.change(search, { target: { value: 'corn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open record' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Search')).toHaveValue('corn');
    // The keystrokes added no history entries of their own: one more Back leaves the list.
    fireEvent.click(screen.getByRole('button', { name: 'Leave list' }));
    expect(screen.getByText('Start page')).toBeInTheDocument();
  });
});

describe('list sort and choices in the address', () => {
  it('parses a sort the screen offers and drops one it does not', () => {
    expect(parseListSort('total:desc', ['total'])).toEqual({ key: 'total', dir: 'desc' });
    expect(parseListSort('total:sideways', ['total'])).toEqual({ key: 'total', dir: 'asc' });
    expect(parseListSort('secret_cost:asc', ['total'])).toEqual({ key: null, dir: 'asc' });
    expect(parseListSort('', ['total'])).toEqual({ key: null, dir: 'asc' });
  });

  it('writes a sort back as key:dir, and no sort as nothing', () => {
    expect(listSortParam({ key: 'total', dir: 'desc' })).toBe('total:desc');
    expect(listSortParam({ key: null, dir: 'asc' })).toBe('');
  });

  it('keeps a known choice and falls back for anything else', () => {
    expect(oneOf('inactive', ['active', 'inactive'] as const, 'active')).toBe('inactive');
    expect(oneOf('bogus', ['active', 'inactive'] as const, 'active')).toBe('active');
  });
});
