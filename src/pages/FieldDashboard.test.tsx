import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import FieldDashboard from './FieldDashboard';

const { rpc, toast } = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin' }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/db', () => ({ supabase: { rpc }, assertRpcResult: (data: unknown) => data }));

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

  fireEvent.click(screen.getByRole('link', { name: 'Open the next field' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Field dashboard could not be loaded');
  await act(async () => finishPreviousRead({ data: { field: { id: 'old', field_name: 'Old Field' } } }));
  expect(screen.getByRole('alert')).toHaveTextContent('Field dashboard could not be loaded');

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(rpc.mock.calls.filter(([, args]) => args?.p_field_id === 'new')).toHaveLength(2);
});

