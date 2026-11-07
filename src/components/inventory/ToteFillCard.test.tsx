import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToteFillRow } from '../../lib/toteFill';

const { mockList, mockReverse, mockToast } = vi.hoisted(() => ({ mockList: vi.fn(), mockReverse: vi.fn(), mockToast: vi.fn() }));
vi.mock('../../lib/toteFill', () => ({ listToteFills: mockList, reverseToteFill: mockReverse, fillToteFromBulk: vi.fn(), previewToteFill: vi.fn(), TOTE_FILL_LOCATION: 'Main Warehouse' }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import ToteFillCard from './ToteFillCard';

const row = (id: string, over: Partial<ToteFillRow> = {}): ToteFillRow => ({
  id, totes: 1, bulk_unit: 'Gal', bulk_quantity: 265, shortfall_quantity: 0, reverses_fill_id: null, reason: null,
  created_at: '2026-11-07T15:00:00Z', ...over,
});

describe('tote fill history', () => {
  beforeEach(() => { mockList.mockReset(); mockReverse.mockReset(); mockToast.mockReset(); });

  it('offers Undo only on the newest fill, and undoes it with a reason', async () => {
    mockList.mockResolvedValue([row('f2', { shortfall_quantity: 65 }), row('f1')]);
    mockReverse.mockResolvedValue(undefined);
    const onStockChanged = vi.fn();
    render(<ToteFillCard toteProductId="tote" toteName="UAN 265 Tote" profileId="u1" onStockChanged={onStockChanged} />);
    expect(await screen.findByText('Short 65 Gal')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wrong count' } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo Fill' }));
    await waitFor(() => expect(onStockChanged).toHaveBeenCalled());
    expect(mockReverse).toHaveBeenCalledWith('f2', 'wrong count', expect.stringMatching(/^reverse_tote_fill:u1:/));
  });

  it('offers no Undo when the newest row is an undo, and marks the undone fill', async () => {
    mockList.mockResolvedValue([row('u1', { reverses_fill_id: 'f1', reason: 'wrong count' }), row('f1')]);
    render(<ToteFillCard toteProductId="tote" toteName="UAN 265 Tote" profileId="u1" onStockChanged={vi.fn()} />);
    expect(await screen.findByText(/\(undone\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('shows the database refusal when stock moved since the fill', async () => {
    mockList.mockResolvedValue([row('f1')]);
    mockReverse.mockRejectedValue({ code: 'P0001', message: 'TOTE_FILL_STOCK_MOVED: stock of the tote or its bulk has moved since this fill; adjust stock instead' });
    const onStockChanged = vi.fn();
    render(<ToteFillCard toteProductId="tote" toteName="UAN 265 Tote" profileId="u1" onStockChanged={onStockChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wrong count' } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo Fill' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('adjust stock instead')));
    expect(onStockChanged).not.toHaveBeenCalled();
  });

  it('when the undo answer is lost, reloads the history and counts in case it saved', async () => {
    mockList.mockResolvedValueOnce([row('f1')]).mockResolvedValueOnce([row('u1', { reverses_fill_id: 'f1', reason: 'wrong count' }), row('f1')]);
    mockReverse.mockRejectedValue(new TypeError('Failed to fetch'));
    const onStockChanged = vi.fn();
    render(<ToteFillCard toteProductId="tote" toteName="UAN 265 Tote" profileId="u1" onStockChanged={onStockChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wrong count' } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo Fill' }));
    expect(await screen.findByText(/\(undone\)/)).toBeInTheDocument();
    expect(onStockChanged).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
