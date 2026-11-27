import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import FieldDashboard from './FieldDashboard';

const { rpc, from, toast } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), toast: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin' }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/db', () => ({ supabase: { rpc, from }, assertRpcResult: (data: unknown) => data }));

it('shows the current field load error even if the previous field answers late, with a retry', async () => {
  let finishPreviousRead!: (result: unknown) => void;
  const previousRead = new Promise((resolve) => { finishPreviousRead = resolve; });
  rpc.mockImplementation((_name: string, args: { p_field_id: string }) =>
    args.p_field_id === 'old' ? previousRead : Promise.resolve({ error: new Error('Network offline') }),
  );
  render(
    <MemoryRouter initialEntries={['/fields/old/dashboard']}>
      <Link to="/fields/new/dashboard">Open the next field</Link>
      <Routes><Route path="/fields/:id/dashboard" element={<FieldDashboard />} /></Routes>
    </MemoryRouter>,
  );

  expect(rpc).toHaveBeenCalledWith('get_field_dashboard', { p_field_id: 'old' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Open the next field' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Field dashboard could not be loaded');
  await act(async () => finishPreviousRead({ data: { field: { id: 'old', field_name: 'Old Field' } } }));
  expect(from).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Field dashboard could not be loaded');

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(rpc.mock.calls.filter(([, args]) => args?.p_field_id === 'new')).toHaveLength(2);
});


it('gives a missing field a way back to the list', async () => {
  rpc.mockResolvedValue({ error: { code: 'P0001', message: 'Field not found: 99999999-9999-4999-8999-999999999999' } });
  render(
    <MemoryRouter initialEntries={['/fields/missing/dashboard']}>
      <Routes>
        <Route path="/fields/:id/dashboard" element={<FieldDashboard />} />
        <Route path="/fields" element={<h1>Fields list</h1>} />
      </Routes>
    </MemoryRouter>,
  );

  expect(await screen.findByText('Field not found')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Fields' }));
  expect(screen.getByRole('heading', { name: 'Fields list' })).toBeInTheDocument();
});
