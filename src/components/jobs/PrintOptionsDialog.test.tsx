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
  auth,
} = vi.hoisted(() => {
  const mockMaybeSingle = vi.fn();
  const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
  const mockSelect = vi.fn(() => ({ eq: mockEq }));
  const mockUpsertSelect = vi.fn();
  const mockUpsert = vi.fn(() => ({ select: mockUpsertSelect }));
  const mockFrom = vi.fn(() => ({ select: mockSelect, upsert: mockUpsert }));
  const mockToast = vi.fn();
  const mockCheckMutationResult = vi.fn();
  const auth = { role: 'admin' };
  return { mockFrom, mockSelect, mockEq, mockMaybeSingle, mockUpsert, mockUpsertSelect, mockToast, mockCheckMutationResult, auth };
});

vi.mock('../../lib/db', () => ({
  supabase: { from: mockFrom },
  checkMutationResult: mockCheckMutationResult,
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

import PrintOptionsDialog from './PrintOptionsDialog';

describe('PrintOptionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.role = 'admin';
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

  it('lets applicators print with shared defaults without saving changes to them', async () => {
    auth.role = 'applicator';
    const print = vi.fn();
    render(<PrintOptionsDialog open onClose={vi.fn()} onPrint={print} />);
    await waitFor(() => expect(screen.getAllByRole('combobox')[1]).toHaveValue('per-field'));
    expect(screen.queryByRole('button', { name: /save as default/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^print$/i }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
