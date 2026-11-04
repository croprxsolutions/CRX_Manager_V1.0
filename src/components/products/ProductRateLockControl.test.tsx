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
});
