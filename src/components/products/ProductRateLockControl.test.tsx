import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProductRateLock } from '../../types';

const { mockSet, mockLoad } = vi.hoisted(() => ({ mockSet: vi.fn(), mockLoad: vi.fn() }));
vi.mock('../../lib/productRateLock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/productRateLock')>()),
  setProductRateLock: mockSet,
  loadProductRateLock: mockLoad,
}));

import ProductRateLockControl from './ProductRateLockControl';

const open: ProductRateLock = { is_locked: false, changed_by_name: null, changed_at: '2026-11-03T00:00:00Z', reason: null };
const locked: ProductRateLock = { is_locked: true, changed_by_name: 'Other Admin', changed_at: '2026-11-03T01:00:00Z', reason: 'season' };

describe('rate lock switch failure paths', () => {
  it('offers a retry when the lock could not be read', () => {
    const onRetry = vi.fn();
    render(<ProductRateLockControl lock={null} loadFailed onRetry={onRetry} isAdmin profileId="u1" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('asks for a fresh reason after a cancelled switch', () => {
    render(<ProductRateLockControl lock={open} loadFailed={false} onRetry={vi.fn()} isAdmin profileId="u1" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lock rates' }));
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'season' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock rates' }));
    expect(screen.getByLabelText('Reason (required)')).toHaveValue('');
  });

  it('shows the current state when another admin switched it first', async () => {
    mockSet.mockRejectedValue(new Error('PRODUCT_RATE_LOCK_UNCHANGED: rates are already locked'));
    mockLoad.mockResolvedValue(locked);
    const onChanged = vi.fn();
    render(<ProductRateLockControl lock={open} loadFailed={false} onRetry={vi.fn()} isAdmin profileId="u1" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lock rates' }));
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'season' } });
    const buttons = screen.getAllByRole('button', { name: 'Lock rates' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(locked));
  });

  it('never replays a reconciled lock request when the same switch is made again', async () => {
    const lockAgain = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Lock rates' }));
      fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'season' } });
      const buttons = screen.getAllByRole('button', { name: 'Lock rates' });
      fireEvent.click(buttons[buttons.length - 1]);
      await waitFor(() => expect(mockSet).toHaveBeenCalled());
    };
    mockSet.mockReset().mockRejectedValueOnce(new Error('network lost'));
    mockLoad.mockResolvedValue(locked);
    const { rerender } = render(<ProductRateLockControl lock={open} loadFailed={false} onRetry={vi.fn()} isAdmin profileId="u1" onChanged={vi.fn()} />);
    await lockAgain();
    await waitFor(() => expect(screen.queryByLabelText('Reason (required)')).toBeNull());
    const firstKey = mockSet.mock.calls[0][0].idempotencyKey;

    // Unlocked elsewhere, then locked again here with the same reason.
    rerender(<ProductRateLockControl lock={open} loadFailed={false} onRetry={vi.fn()} isAdmin profileId="u1" onChanged={vi.fn()} />);
    mockSet.mockClear().mockResolvedValueOnce(locked);
    await lockAgain();
    expect(mockSet.mock.calls[0][0].idempotencyKey).not.toBe(firstKey);
  });
});
