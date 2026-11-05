import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockAuth, mockToast, mockCapture } = vi.hoisted(() => ({
  mockAuth: { role: 'admin' as string | null },
  mockToast: vi.fn(),
  mockCapture: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('./ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: mockCapture } }));

import ClearExpiredIntentButton from './ClearExpiredIntentButton';

const LABEL = 'I checked the records — clear this';

function lock(overrides: Partial<{ isIntentLocked: boolean; isRetryExpired: boolean }> = {}) {
  return {
    isIntentLocked: true,
    isRetryExpired: true,
    clearExpiredIntent: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('ClearExpiredIntentButton (KI-27)', () => {
  beforeEach(() => {
    mockAuth.role = 'admin';
    mockToast.mockReset();
    mockCapture.mockReset();
  });

  it('is hidden from non-admins', () => {
    mockAuth.role = 'warehouse';
    render(<ClearExpiredIntentButton intent={lock()} operation="receive_po_items" />);
    expect(screen.queryByText(LABEL)).toBeNull();
  });

  it('is hidden while a safe retry is still possible', () => {
    render(<ClearExpiredIntentButton intent={lock({ isRetryExpired: false })} operation="receive_po_items" />);
    expect(screen.queryByText(LABEL)).toBeNull();
  });

  it('clears only after the admin confirms, and logs it', async () => {
    const intent = lock();
    render(<ClearExpiredIntentButton intent={intent} operation="receive_po_items" />);
    fireEvent.click(screen.getByText(LABEL));
    expect(intent.clearExpiredIntent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /clear it/i }));
    await waitFor(() => expect(intent.clearExpiredIntent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.any(String)));
    expect(mockCapture).toHaveBeenCalledWith(
      'Admin cleared an expired uncertain mutation',
      expect.objectContaining({ tags: { operation: 'receive_po_items' } }),
    );
  });
});
