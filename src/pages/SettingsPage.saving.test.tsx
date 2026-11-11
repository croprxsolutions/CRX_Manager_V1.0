/**
 * SettingsPage.saving.test.tsx — each sub-part's Save, and the Edit User confirm (style D rebuild, 2026-11-02).
 *
 * Save stays off until a value in its sub-part changes, stays on after a failed save, and turns off
 * after a successful one. The customer-notices save writes only the template that changed. A role
 * change is confirmed before admin_update_profile is called. Uses the REAL data router and blocker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';

// Same module copy for the page's useNavigate and the hook's useBlocker.
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockRpc, mockUpsert, mockToast, mockCheck } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockUpsert: vi.fn(),
  mockToast: vi.fn(),
  mockCheck: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'admin-1', role: 'admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: unknown): T => data as T,
  checkMutationResult: mockCheck,
  sanitizeError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'key', resetKey: vi.fn(), getKeyFor: () => 'key', resetKeyFor: vi.fn() }),
}));

import SettingsPage from './SettingsPage';

const USERS = [
  { id: 'rep-1', full_name: 'Sam Rep', email: 'sam@example.test', role: 'sales_rep', phone: null, is_active: true, denied_pages: [] },
];

function chain(data: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'neq', 'order']) self[m] = () => self;
  self.upsert = (row: { setting_key: string }) => {
    mockUpsert(row);
    return { select: () => Promise.resolve({ data: [row], error: null, key: row.setting_key }) };
  };
  const promise = Promise.resolve({ data, error: null });
  self.then = promise.then.bind(promise);
  return self;
}

async function renderPage() {
  const router = createMemoryRouter([{ path: '/settings', element: <SettingsPage /> }], { initialEntries: ['/settings'] });
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: /Billing/ });
}

const saveButton = (name: string) => screen.getByRole('button', { name });

describe('SettingsPage — per-part Save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => chain(table === 'profiles' ? USERS : []));
    mockRpc.mockResolvedValue({ data: {}, error: null });
  });

  it('turns Save on after an edit and off after a successful save', async () => {
    await renderPage();
    expect(saveButton('Save defaults')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Remind when unpaid after'), { target: { value: '45' } });
    expect(saveButton('Save defaults')).toBeEnabled();
    expect(saveButton('Save fuel surcharge')).toBeDisabled();

    fireEvent.click(saveButton('Save defaults'));
    await waitFor(() => expect(saveButton('Save defaults')).toBeDisabled());
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ setting_key: 'ar_reminder_days', setting_value: '45' }));
  });

  it('keeps Save on when the save fails', async () => {
    mockCheck.mockImplementation((result: { key?: string }) => {
      if (result.key === 'ar_reminder_days') throw new Error('forced failure');
    });
    await renderPage();
    fireEvent.change(screen.getByLabelText('Remind when unpaid after'), { target: { value: '45' } });
    fireEvent.click(saveButton('Save defaults'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'forced failure'));
    expect(saveButton('Save defaults')).toBeEnabled();
  });

  it('writes only the notice template that changed', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('After spraying'), { target: { value: 'Done on your fields' } });
    fireEvent.click(saveButton('Save notices'));
    await waitFor(() => expect(saveButton('Save notices')).toBeDisabled());
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].setting_key).toBe('post_application_notice_template');
  });
});

describe('SettingsPage — Edit User', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => chain(table === 'profiles' ? USERS : []));
    mockRpc.mockResolvedValue({ data: {}, error: null });
  });

  it('confirms a role change before calling admin_update_profile', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit Sam Rep' })[0]);
    const dialog = screen.getByRole('dialog', { name: /Edit\s*User/ });
    expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'driver' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    const confirm = await screen.findByRole('dialog', { name: /Confirm User Changes/ });
    expect(confirm).toHaveTextContent('from Sales rep to Driver');
    expect(mockRpc).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('admin_update_profile', expect.objectContaining({
      target_user_id: 'rep-1',
      new_role: 'driver',
    })));
  });
});

describe('SettingsPage — sales tax rate (billing plan M4a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => chain(
      table === 'profiles' ? USERS : table === 'app_settings' ? [{ setting_key: 'sales_tax_rate', setting_value: '6.25' }] : [],
    ));
    mockRpc.mockResolvedValue({ data: {}, error: null });
  });

  it('shows the saved rate and saves a new one', async () => {
    await renderPage();
    const input = screen.getByLabelText('Sales tax rate');
    expect(input).toHaveValue('6.25');
    expect(saveButton('Save sales tax')).toBeDisabled();
    fireEvent.change(input, { target: { value: '7.5' } });
    fireEvent.click(saveButton('Save sales tax'));
    await waitFor(() => expect(saveButton('Save sales tax')).toBeDisabled());
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ setting_key: 'sales_tax_rate', setting_value: '7.5' }));
  });

  it('refuses a rate that is not a plain percentage before saving', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Sales tax rate'), { target: { value: '6.25%' } });
    fireEvent.click(saveButton('Save sales tax'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('0 to 99.999')));
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
