import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const {
  mockFrom,
  mockEq,
  mockMaybeSingle,
  mockUpsert,
  mockUpsertSelect,
  mockToast,
  mockCheckMutationResult,
} = vi.hoisted(() => {
  const mockMaybeSingle = vi.fn();
  const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
  const mockSelect = vi.fn(() => ({ eq: mockEq }));
  const mockUpsertSelect = vi.fn();
  const mockUpsert = vi.fn(() => ({ select: mockUpsertSelect }));
  const mockFrom = vi.fn(() => ({ select: mockSelect, upsert: mockUpsert }));
  const mockToast = vi.fn();
  const mockCheckMutationResult = vi.fn();
  return { mockFrom, mockSelect, mockEq, mockMaybeSingle, mockUpsert, mockUpsertSelect, mockToast, mockCheckMutationResult };
});

vi.mock('../../lib/db', () => ({
  supabase: { from: mockFrom },
  checkMutationResult: mockCheckMutationResult,
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));
const authRole = vi.hoisted(() => ({ current: 'admin' }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ role: authRole.current }) }));

import PrintOptionsDialog from './PrintOptionsDialog';

describe('PrintOptionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({
      data: {
        setting_value: JSON.stringify({
          mapPages: 'per-field',
          includePreviousApplications: true,
          previousApplicationsPerField: 5,
          blankSections: 2,
          includeBillingSplits: false,
          showBanner: false,
        }),
      },
      error: null,
    });
    mockUpsertSelect.mockResolvedValue({ data: [{ setting_key: 'applicator_print_options' }], error: null });
  });

  it('applicators never get the billing-split table and do not see its toggle', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { setting_value: JSON.stringify({ includeBillingSplits: true }) }, error: null });
    authRole.current = 'applicator';
    const onPrint = vi.fn().mockResolvedValue(undefined);
    try {
      render(<PrintOptionsDialog open onClose={vi.fn()} onPrint={onPrint} />);
      await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('app_settings'));
      expect(screen.queryByText('Show billing-split table')).toBeNull();
      expect(screen.queryByRole('button', { name: /save as default/i })).toBeNull();
      const print = await screen.findByRole('button', { name: /^print/i });
      await waitFor(() => expect(print).not.toBeDisabled());
      fireEvent.click(print);
      await waitFor(() => expect(onPrint).toHaveBeenCalledTimes(1));
      expect(onPrint.mock.calls[0][0].options.includeBillingSplits).toBe(false);
    } finally {
      authRole.current = 'admin';
    }
  });

  it.each(['admin', 'sales_rep'])('%s still sees the billing-split toggle', async (role) => {
    authRole.current = role;
    try {
      render(<PrintOptionsDialog open onClose={vi.fn()} onPrint={vi.fn()} />);
      expect(await screen.findByText('Show billing-split table')).toBeInTheDocument();
      // Shared defaults are admin-only in the database, so only admins get the button.
      expect(screen.queryAllByRole('button', { name: /save as default/i })).toHaveLength(role === 'admin' ? 1 : 0);
    } finally {
      authRole.current = 'admin';
    }
  });

  it('loads saved print defaults when opened', async () => {
    render(<PrintOptionsDialog open onClose={vi.fn()} onPrint={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByRole('combobox')[1]).toHaveValue('per-field'));
    const selects = screen.getAllByRole('combobox');
    expect(selects[2]).toHaveValue('2');
    expect(selects[3]).toHaveValue('yes');
    expect(selects[4]).toHaveValue('5');
    expect(selects[5]).toHaveValue('no');
    expect(selects[6]).toHaveValue('no');
    expect(mockFrom).toHaveBeenCalledWith('app_settings');
    expect(mockEq).toHaveBeenCalledWith('setting_key', 'applicator_print_options');
  });

  it('saves only the option set as the shared default', async () => {
    render(<PrintOptionsDialog open onClose={vi.fn()} onPrint={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('combobox')[1]).toHaveValue('per-field'));

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'custom' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'both' } });
    fireEvent.click(screen.getByRole('button', { name: /save as default/i }));

    await waitFor(() => expect(mockUpsert).toHaveBeenCalledTimes(1));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        setting_key: 'applicator_print_options',
        setting_value: expect.any(String),
      }),
      { onConflict: 'setting_key' },
    );
    const firstUpsertArgs = mockUpsert.mock.calls[0] as unknown as [{ setting_value: string }];
    const saved = JSON.parse(firstUpsertArgs[0].setting_value) as Record<string, unknown>;
    expect(saved.mapPages).toBe('both');
    expect(saved).not.toHaveProperty('format');
    expect(mockCheckMutationResult).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ setting_key: 'applicator_print_options' }], error: null }),
      'Save applicator print options',
    );
  });
});
