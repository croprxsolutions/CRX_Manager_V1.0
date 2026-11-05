import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockAuth, mockToast, mockCapture, mockFlush, mockReload, mockLog } = vi.hoisted(() => ({
  mockAuth: { role: 'admin' as string | null, profile: { id: 'admin-1' } },
  mockLog: vi.fn(async (_params: unknown) => true),
  mockToast: vi.fn(),
  mockCapture: vi.fn(),
  mockFlush: vi.fn(async () => true),
  mockReload: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('./ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/activityLogger', () => ({ logActivity: mockLog }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: mockCapture, flush: mockFlush } }));

import ClearExpiredIntentButton from './ClearExpiredIntentButton';
import { UncertainClearNotYetError } from '../hooks/useUncertainMutationIntent';

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
    mockLog.mockReset();
    mockLog.mockResolvedValue(true);
    vi.stubGlobal('location', { ...window.location, reload: mockReload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.inert = false;
  });

  it('blocks the whole page from the clear until the reload, even while Sentry is slow', async () => {
    let finishFlush: (ok: boolean) => void = () => {};
    mockFlush.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFlush = resolve; }));
    const intent = lock();
    render(<ClearExpiredIntentButton intent={intent} operation="record_vendor_payment" />);
    fireEvent.click(screen.getByText(LABEL));
    expect(document.body.inert).toBeFalsy();
    fireEvent.click(screen.getByRole('button', { name: /clear it/i }));
    await waitFor(() => expect(mockFlush).toHaveBeenCalled());
    // Recovered form values must not be resubmittable before the reload lands.
    expect(document.body.inert).toBe(true);
    expect(mockReload).not.toHaveBeenCalled();
    finishFlush(true);
    await waitFor(() => expect(mockReload).toHaveBeenCalledTimes(1));
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
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'uncertain_request_clear_approved',
      performedBy: 'admin-1',
      description: expect.stringContaining('receive_po_items:admin:key-1'),
    }));
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

  it('still reloads when logging fails after a successful clear', async () => {
    mockCapture.mockImplementationOnce(() => { throw new Error('sentry down'); });
    const intent = lock();
    render(<ClearExpiredIntentButton intent={intent} operation="receive_po_items" />);
    fireEvent.click(screen.getByText(LABEL));
    fireEvent.click(screen.getByRole('button', { name: /clear it/i }));
    await waitFor(() => expect(mockReload).toHaveBeenCalledTimes(1));
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('clears nothing when the audit row cannot be written', async () => {
    mockLog.mockResolvedValueOnce(false);
    const intent = lock();
    render(<ClearExpiredIntentButton intent={intent} operation="receive_po_items" />);
    fireEvent.click(screen.getByText(LABEL));
    fireEvent.click(screen.getByRole('button', { name: /clear it/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('activity log')));
    expect(intent.clearExpiredIntent).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();
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
    expect(document.body.inert).toBeFalsy();
  });

  it('explains a server refusal as a warning and does not reload (KI-27)', async () => {
    const intent = lock();
    intent.clearExpiredIntent
      .mockRejectedValueOnce(new UncertainClearNotYetError('in_progress', null))
      .mockRejectedValueOnce(new UncertainClearNotYetError('first_check', '2026-11-05T12:15:00Z'));
    render(<ClearExpiredIntentButton intent={intent} operation="receive_po_items" />);
    fireEvent.click(screen.getByText(LABEL));
    fireEvent.click(screen.getByRole('button', { name: /clear it/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('being saved right now')));
    fireEvent.click(screen.getByText(LABEL));
    fireEvent.click(screen.getByRole('button', { name: /clear it/i }));
    await waitFor(() => expect(mockToast).toHaveBeenLastCalledWith('warning', expect.stringContaining('cannot yet confirm')));
    expect(mockReload).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
