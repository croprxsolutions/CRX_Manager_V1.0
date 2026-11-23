import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPreview, mockCommit, mockToast } = vi.hoisted(() => ({ mockPreview: vi.fn(), mockCommit: vi.fn(), mockToast: vi.fn() }));
vi.mock('../../lib/productParents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/productParents')>()),
  previewParentRateCutover: mockPreview,
  commitParentRateCutover: mockCommit,
  loadOpenWork: vi.fn().mockResolvedValue([]),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import ParentRateCutoverModal from './ParentRateCutoverModal';
import type { ProductParent } from '../../lib/productParents';

const parent = {
  id: 'par1', name: 'Smart Test', product_form: 'dry', rate_per_acre: '1.8', rate_unit: 'Dry oz', suggested_rate: '1.8 oz',
  parent_version: 4, is_active: true, sizes: [{ product_id: 's1', product_name: 'Smart Test 10 lb' }],
} as unknown as ProductParent;
const prices = (t1: number) => ({ tier1_price_per_acre: t1, tier2_price_per_acre: null, tier3_price_per_acre: null });
const eligible = {
  parent_id: 'par1', direction: 'promote', eligible: true, name: 'Smart Test', rate_source: 'legacy', changes: true,
  current: { rate_per_acre: '1.8', rate_unit: 'Dry oz' },
  target: { rate_per_acre: '1.8', rate_unit: 'Lb', suggested_rate: '1.8 Lb/acre' },
  expected: { parent_version: 4, sizes: [{ product_id: 's1', product_name: 'Smart Test 10 lb', rate_per_acre: '1.8', rate_unit: 'Dry oz',
    suggested_rate: '1.8 oz', prices: prices(35.37), before_prices: prices(2.21) }] },
};
const open = (rateSource: 'legacy' | 'approved' = 'legacy', onSaved = vi.fn()) => {
  render(<ParentRateCutoverModal parent={parent} profileId="u1" rateSource={rateSource} onClose={vi.fn()} onSaved={onSaved} />);
  return onSaved;
};

beforeEach(() => { mockPreview.mockReset(); mockCommit.mockReset(); mockToast.mockReset(); });

describe('RT-4a rate cut-over modal', () => {
  it('previews old and new per size, needs a reason, then commits the preview unchanged', async () => {
    mockPreview.mockResolvedValue(eligible);
    mockCommit.mockResolvedValue({ parent_id: 'par1', direction: 'promote', rate_source: 'approved' });
    const onSaved = open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByTestId('rate-cutover-table');
    expect(mockPreview).toHaveBeenCalledWith('par1', 'promote');
    expect(screen.getByText('1.8 Lb')).toBeInTheDocument();
    expect(screen.getByText('1.8 Lb/acre')).toBeInTheDocument();
    expect(screen.getByText('$35.37')).toBeInTheDocument();
    expect(screen.getByText(/\$2\.21/)).toBeInTheDocument();
    const go = screen.getByRole('button', { name: 'Switch to approved rate' });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: ' pilot ' } });
    fireEvent.click(go);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mockCommit).toHaveBeenCalledWith(eligible, 'pilot', expect.any(String));
  });

  it('shows a refusal in the server\'s words and offers no switch', async () => {
    mockPreview.mockResolvedValue({ parent_id: 'par1', direction: 'promote', eligible: false,
      refusal: 'PRODUCT_PARENT_CUTOVER_LOCK_OFF: turn the rate lock on first' });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't switch. Turn the rate lock on first");
    expect(screen.queryByRole('button', { name: 'Switch to approved rate' })).toBeNull();
  });

  it('switches back with restore when the group is on its approved rate', async () => {
    mockPreview.mockResolvedValue({ ...eligible, direction: 'restore', rate_source: 'approved' });
    open('approved');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('button', { name: 'Switch back to old rate' })).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledWith('par1', 'restore');
  });

  it('retries a lost reply with the same key, and a stale refusal asks for a new preview', async () => {
    mockPreview.mockResolvedValue(eligible);
    mockCommit.mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockRejectedValueOnce(new Error('PRODUCT_PARENT_CUTOVER_STALE: "Smart Test" changed since the preview; preview again'));
    const onSaved = open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.change(await screen.findByLabelText('Reason (required)'), { target: { value: 'pilot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to approved rate' }));
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to approved rate' }));
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(2));
    expect(mockCommit.mock.calls[1][2]).toBe(mockCommit.mock.calls[0][2]);
    expect(await screen.findByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('reloads when another admin already switched the group', async () => {
    mockPreview.mockResolvedValue(eligible);
    mockCommit.mockRejectedValue(new Error('PRODUCT_PARENT_CUTOVER_ALREADY_APPROVED: "Smart Test" already uses its approved rate'));
    const onSaved = open();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.change(await screen.findByLabelText('Reason (required)'), { target: { value: 'pilot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to approved rate' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
