import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockAuth, mockToast, mockCapture, mockFlush, mockReload } = vi.hoisted(() => ({
  mockAuth: { role: 'admin' as string | null },
  mockToast: vi.fn(),
  mockCapture: vi.fn(),
  mockFlush: vi.fn(async () => true),
  mockReload: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('./ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: mockCapture, flush: mockFlush } }));

import ClearExpiredIntentButton from './ClearExpiredIntentButton';

const LABEL = 'I checked the records — clear this';

const EXPIRED = {
  surface: 'purchase-order-detail',
  scope: 'po-1',
  idempotencyKey: 'receive_po_items:admin:key-1',
  createdAtMs: Date.parse('2026-11-01T12:00:00Z'),
  retryNotAfterMs: Date.parse('2026-11-02T11:00:00Z'),
};

function lock(clearableExpiredRequest: typeof EXPIRED | null = EXPIRED) {
  return { clearableExpiredRequest, clearExpiredIntent: vi.fn(async () => {}) };
}

describe('ClearExpiredIntentButton (KI-27)', () => {
  beforeEach(() => {
    mockAuth.role = 'admin';
    mockToast.mockReset();
    mockCapture.mockReset();
    mockReload.mockReset();
    vi.stubGlobal('location', { ...window.location, reload: mockReload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is hidden from non-admins', () => {
    mockAuth.role = 'warehouse';
    render(<ClearExpiredIntentButton intent={lock()} operation="receive_po_items" />);
    expect(screen.queryByText(LABEL)).toBeNull();
  });

  it('is hidden while a safe retry is still possible', () => {
    render(<ClearExpiredIntentButton intent={lock(null)} operation="receive_po_items" />);
    expect(screen.queryByText(LABEL)).toBeNull();
  });

  it('clears only after the admin confirms, and logs it', async () => {
    const intent = lock();
    render(<ClearExpiredIntentButton intent={intent} operation="receive_po_items" />);
    fireEvent.click(screen.getByText(LABEL));
    expect(screen.getByText(/purchase order detail screen for record po-1/)).toBeTruthy();
    expect(intent.clearExpiredIntent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /clear it/i }));
    await waitFor(() => expect(intent.clearExpiredIntent).toHaveBeenCalledWith('receive_po_items:admin:key-1'));
    // The page reloads so the recovered form values cannot be resubmitted.
    await waitFor(() => expect(mockReload).toHaveBeenCalledTimes(1));
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(
      'Admin cleared an expired uncertain mutation',
      expect.objectContaining({
        tags: { operation: 'receive_po_items', surface: 'purchase-order-detail' },
        extra: expect.objectContaining({ scope: 'po-1', idempotencyKey: 'receive_po_items:admin:key-1' }),
      }),
    );
  });

  it('does not reload when the clear is refused', async () => {
    const intent = lock();
    intent.clearExpiredIntent.mockRejectedValueOnce(new Error('DURABLE_MUTATION_INTENT_CONFLICT'));
    render(<ClearExpiredIntentButton intent={intent} operation="receive_po_items" />);
    fireEvent.click(screen.getByText(LABEL));
    fireEvent.click(screen.getByRole('button', { name: /clear it/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.any(String)));
    expect(mockReload).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
