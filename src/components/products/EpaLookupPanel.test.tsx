import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchState: vi.fn(), start: vi.fn(), record: vi.fn(), toast: vi.fn() }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/epaLookupClient', () => ({ runRecordedEpaLookup: mocks.record }));
vi.mock('../../lib/epaProposals', async () => {
  const actual = await vi.importActual<typeof import('../../lib/epaProposals')>('../../lib/epaProposals');
  return { ...actual, fetchParentEpaState: mocks.fetchState, startEpaLookup: mocks.start };
});

import EpaLookupPanel from './EpaLookupPanel';

const empty = { numbers: ['100-1', '100-1-200'], lookups: [], proposals: [], failures: [] };
const panel = (epaRefusal: string | null = 'CHEMISTRY_FROM_EPA_ONLY: x') => render(
  <MemoryRouter>
    <EpaLookupPanel parentId="par1" profileId="u1" reloadKey="k" epaRefusal={epaRefusal} locked={false} onCommitted={vi.fn()} />
  </MemoryRouter>,
);

describe('EpaLookupPanel', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchState.mockResolvedValue(empty);
  });

  it('lists each EPA number on the parent with its own lookup button', async () => {
    panel();
    expect(await screen.findByText('EPA 100-1')).toBeInTheDocument();
    expect(screen.getByText('EPA 100-1-200')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Run lookup' })).toHaveLength(2);
    expect(screen.queryByText(/chemistry can be typed/)).toBeNull();
  });

  it('starts a lookup, lets the server record it, then re-reads the rows', async () => {
    mocks.start.mockResolvedValueOnce({ lookup_id: 'l1', epa_registration: '100-1' });
    mocks.record.mockResolvedValueOnce({ lookup_id: 'l1', outcome: 'proposal', proposal_id: 'p1' });
    panel();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Run lookup' }))[0]);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledWith('l1', expect.any(Function)));
    expect(mocks.start).toHaveBeenCalledWith('par1', '100-1', expect.any(String));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'EPA answered for 100-1. Review the proposal.'));
    await waitFor(() => expect(mocks.fetchState.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('retries a start whose reply was lost with the same key', async () => {
    mocks.start.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ lookup_id: 'l1' });
    mocks.record.mockResolvedValueOnce({ lookup_id: 'l1', outcome: 'failure', reason: 'not_found' });
    panel();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Run lookup' }))[0]);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('100-1')));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Run lookup' })[0]).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole('button', { name: 'Run lookup' })[0]);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(mocks.start.mock.calls[1][2]).toBe(mocks.start.mock.calls[0][2]);
    await waitFor(() => expect(mocks.toast).toHaveBeenLastCalledWith('warning', expect.stringContaining('100-1:')));
  });

  it('keeps a held proposal for a number taken off the product reachable, with Reject but no new lookup', async () => {
    const held = { id: 'p9', lookup_id: 'l9', parent_id: 'par1', epa_registration: '999-9', status: 'held', proposal_version: 2, hold_reason: 'chemistry_changed',
      epa_summary: { productname: 'OLD', manufacturer: 'X', isCancelled: false, base_label_note: false }, items: [] };
    mocks.fetchState.mockResolvedValue({ ...empty, proposals: [held] });
    panel();
    expect(await screen.findByText('EPA 999-9')).toBeInTheDocument();
    expect(screen.getByText('No longer on this product')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Run lookup' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Review (on hold)' }));
    expect(await screen.findByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run lookup again' })).toBeNull();
  });

  it('says chemistry can be typed only when the database gate allows it', async () => {
    panel(null);
    expect(await screen.findByText('EPA has no record of these numbers, so chemistry can be typed.')).toBeInTheDocument();
  });
});
