import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeliveryBrands } from '../../lib/deliveryBrands';
import CorrectBrandsModal from './CorrectBrandsModal';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1' } }) }));
const toast = vi.fn();
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));
let signal: () => Promise<boolean> = async () => true;
vi.mock('../../lib/connectivity', () => ({ hasSignal: () => signal() }));

const getDeliveryBrands = vi.fn();
const correctDeliveryBrands = vi.fn();
vi.mock('../../lib/deliveryBrands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/deliveryBrands')>()),
  getDeliveryBrands: (id: string) => getDeliveryBrands(id),
  correctDeliveryBrands: (...args: unknown[]) => correctDeliveryBrands(...args),
}));

const brands: DeliveryBrands = {
  delivery_id: 'D1', status: 'completed', event_seq: 7,
  lines: [
    {
      delivery_item_id: 'L1', product_id: 'P1', product_name: 'Glyphosate', quantity: 10, quantity_delivered: 10, unit_size: 'gal',
      brand_list: [{ source: 'size', parent_id: null, brand_id: 'b1', brand_name: 'Roundup', epa_registration: null, manufacturer: null, is_currently_sourced: true }],
      picks: [{ id: 'k1', delivery_item_id: 'L1', source: 'size', parent_brand_id: null, legacy_brand_id: 'b1', brand_name: 'Roundup', epa_registration: null, manufacturer: null, quantity: 10, review_state: null }],
    },
    {
      delivery_item_id: 'L2', product_id: 'P2', product_name: 'Atrazine', quantity: 5, quantity_delivered: 5, unit_size: 'gal',
      brand_list: [{ source: 'size', parent_id: null, brand_id: 'b2', brand_name: 'AAtrex', epa_registration: null, manufacturer: null, is_currently_sourced: true }],
      picks: [],
    },
  ],
};

describe('CorrectBrandsModal', () => {
  it('saving with no edits confirms the existing picks, so an unconfirmed completion can be cleared', async () => {
    getDeliveryBrands.mockResolvedValue(brands);
    correctDeliveryBrands.mockResolvedValue({ event_seq: 8, picks: [], invoice_ids: [] });
    const onClose = vi.fn();
    render(<CorrectBrandsModal open deliveryId="D1" onClose={onClose} />);
    await screen.findByLabelText('Brand for Glyphosate');

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Checked the jugs; picks were right' } });
    fireEvent.click(screen.getByText('Save correction'));

    await waitFor(() => expect(correctDeliveryBrands).toHaveBeenCalledTimes(1));
    const [, lines, reason, seq] = correctDeliveryBrands.mock.calls[0];
    // Only the line that has picks is confirmed; a line with none stays on the missing list.
    expect(lines).toEqual([{ delivery_item_id: 'L1', picks: [expect.objectContaining({ quantity: 10 })] }]);
    expect(reason).toBe('Checked the jugs; picks were right');
    expect(seq).toBe(7);
    expect(toast).toHaveBeenCalledWith('success', 'Brands confirmed as they are.');
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    ['the dialog closes', 'close'],
    ['another delivery loads', 'switch'],
  ])('sends nothing when %s during the signal check', async (_label, how) => {
    getDeliveryBrands.mockImplementation(async (id: string) => ({ ...brands, delivery_id: id }));
    correctDeliveryBrands.mockReset();
    let answer!: (v: boolean) => void;
    signal = () => new Promise((resolve) => { answer = resolve; });
    const view = render(<CorrectBrandsModal open deliveryId="D1" onClose={() => undefined} />);
    await screen.findByLabelText('Brand for Glyphosate');
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Checked' } });
    fireEvent.click(screen.getByText('Save correction'));
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    if (how === 'close') view.rerender(<CorrectBrandsModal open={false} deliveryId="D1" onClose={() => undefined} />);
    else view.rerender(<CorrectBrandsModal open deliveryId="D2" onClose={() => undefined} />);
    await act(async () => { answer(true); });
    expect(correctDeliveryBrands).not.toHaveBeenCalled();
    signal = async () => true;
  });

  it('tells the page an edited correction is unsaved, so leaving asks first', async () => {
    getDeliveryBrands.mockImplementation(async () => brands);
    const onDirtyChange = vi.fn();
    const view = render(<CorrectBrandsModal open deliveryId="D1" onClose={() => undefined} onDirtyChange={onDirtyChange} />);
    await screen.findByLabelText('Brand for Glyphosate');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Wrong jug' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    view.rerender(<CorrectBrandsModal open={false} deliveryId="D1" onClose={() => undefined} onDirtyChange={onDirtyChange} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it('refuses a single brand amount above what was delivered before sending', async () => {
    getDeliveryBrands.mockImplementation(async () => ({ ...brands, lines: [{ ...brands.lines[0], quantity: 10, quantity_delivered: 5 }] }));
    correctDeliveryBrands.mockReset();
    render(<CorrectBrandsModal open deliveryId="D1" onClose={() => undefined} />);
    await screen.findByLabelText('Brand for Glyphosate');
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Fix' } });
    fireEvent.click(screen.getByText('Save correction'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', expect.stringContaining('do not add up to the 5 delivered')));
    expect(correctDeliveryBrands).not.toHaveBeenCalled();
  });
  it('confirming as they are never re-sends a typed brand that was already reviewed', async () => {
    const typed = { ...brands.lines[0].picks[0], id: 'k9', source: 'typed' as const, legacy_brand_id: null, brand_name: 'Credit', review_state: 'added' as const };
    getDeliveryBrands.mockImplementation(async () => ({ ...brands, lines: [{ ...brands.lines[0], picks: [typed] }] }));
    correctDeliveryBrands.mockReset();
    toast.mockReset();
    render(<CorrectBrandsModal open deliveryId="D1" onClose={() => undefined} />);
    await screen.findByLabelText('Brand for Glyphosate');
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Checked' } });
    fireEvent.click(screen.getByText('Save correction'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('info', expect.stringContaining('already reviewed')));
    expect(correctDeliveryBrands).not.toHaveBeenCalled();
  });
});
