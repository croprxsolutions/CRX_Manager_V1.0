import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ commit: vi.fn(), reject: vi.fn(), toast: vi.fn() }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/epaProposals', async () => {
  const actual = await vi.importActual<typeof import('../../lib/epaProposals')>('../../lib/epaProposals');
  return { ...actual, commitEpaProposal: mocks.commit, rejectEpaProposal: mocks.reject };
});

import EpaProposalModal from './EpaProposalModal';
import { newEpaProposalDraft, type EpaProposalDraft } from '../../lib/epaProposals';
import type { EpaChemistryProposal } from '../../types';

const proposal = {
  id: 'p1', lookup_id: 'l1', parent_id: 'par1', epa_registration: '100-1', status: 'proposed', proposal_version: 1, hold_reason: null,
  epa_summary: { productname: 'TEST ATRAZINE 4L', manufacturer: 'Test Co', isCancelled: true, base_label_note: false },
  items: [
    { item_id: 'ing:cas:1912-24-9', kind: 'ingredient', class: 'add', accept_default: true, epa: { name: 'Atrazine', cas: '1912-24-9', strength: 42.6 }, current: null },
    { item_id: 'ing:name:safener x', kind: 'ingredient', class: 'add_name_only', accept_default: false, epa: { name: 'Safener X', cas: null, strength: null }, current: null },
    {
      item_id: 'ing:cas:51218-45-2', kind: 'ingredient', class: 'differs_typed', accept_default: false,
      epa: { name: 'Metolachlor', cas: '51218-45-2', strength: 30 },
      current: { name: 'Metolachlor', cas: '51218-45-2', strength_value: 28, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'typed' },
    },
    { item_id: 'label:signal_word', kind: 'label', class: 'fill', accept_default: true, epa: 'Caution', current: null },
  ],
} as unknown as EpaChemistryProposal;

const view = (draft: EpaProposalDraft = newEpaProposalDraft()) =>
  render(<EpaProposalModal proposal={proposal} draft={draft} profileId="u1" onClose={vi.fn()} onSettled={vi.fn()} onRunAgain={vi.fn()} />);
const commitAndConfirm = async () => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Commit' })[0]);
  const buttons = await screen.findAllByRole('button', { name: 'Commit' });
  fireEvent.click(buttons[buttons.length - 1]);
};

describe('EpaProposalModal', () => {
  beforeEach(() => { Object.values(mocks).forEach((mock) => mock.mockReset()); });

  it('ticks writable items by default, leaves name-only unticked, and gives differences no tick box', () => {
    view();
    expect(screen.getByRole('checkbox', { name: 'Accept Atrazine' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Accept Safener X' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Accept Metolachlor' })).toBeNull();
    expect(screen.getByText(/EPA lists this registration as cancelled/)).toBeInTheDocument();
  });

  it('commits the ticks the admin chose', async () => {
    mocks.commit.mockResolvedValueOnce({ status: 'committed', proposal_id: 'p1', posted_sales_to_record: [], counts: {}, commit_result: {} });
    view();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept Safener X' }));
    await commitAndConfirm();
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    const [id, version, decisions] = mocks.commit.mock.calls[0];
    expect([id, version]).toEqual(['p1', 1]);
    expect(decisions).toEqual(expect.arrayContaining([
      { item_id: 'ing:cas:1912-24-9', accept: true }, { item_id: 'ing:name:safener x', accept: true }, { item_id: 'label:signal_word', accept: true },
    ]));
    expect(decisions).toHaveLength(3);
  });

  it('keeps the ticks when a commit fails, and retries a lost reply with the same key', async () => {
    mocks.commit.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce({ code: 'P0001', message: 'EPA_PROPOSAL_STALE: changed' })
      .mockResolvedValueOnce({ status: 'held', proposal_id: 'p1', hold_reason: 'chemistry_changed', proposal_version: 2 });
    view();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept Atrazine' }));
    await commitAndConfirm();
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('checkbox', { name: 'Accept Atrazine' })).not.toBeChecked();
    await commitAndConfirm();
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(2));
    // An unknown outcome keeps the key, so the retry replays instead of committing twice.
    expect(mocks.commit.mock.calls[1][3]).toBe(mocks.commit.mock.calls[0][3]);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('checkbox', { name: 'Accept Atrazine' })).not.toBeChecked();
    await commitAndConfirm();
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(3));
    // A definite refusal frees the key.
    expect(mocks.commit.mock.calls[2][3]).not.toBe(mocks.commit.mock.calls[1][3]);
    await waitFor(() => expect(mocks.toast).toHaveBeenLastCalledWith('warning', expect.stringContaining('Not committed')));
  });

  it('keeps the ticks and the unconfirmed key when the dialog is closed and reopened', async () => {
    mocks.commit.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ status: 'held', proposal_id: 'p1', hold_reason: 'chemistry_changed', proposal_version: 2 });
    const draft = newEpaProposalDraft();
    const first = view(draft);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept Atrazine' }));
    await commitAndConfirm();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    first.unmount();
    view(draft);
    expect(screen.getByRole('checkbox', { name: 'Accept Atrazine' })).not.toBeChecked();
    await commitAndConfirm();
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(2));
    expect(mocks.commit.mock.calls[1][2]).toEqual(mocks.commit.mock.calls[0][2]);
    expect(mocks.commit.mock.calls[1][3]).toBe(mocks.commit.mock.calls[0][3]);
  });

  it('shows both label links so two links with the same date can be told apart, and never links an unsafe address', () => {
    const withLinks = { ...proposal, items: [
      { item_id: 'label:label_document', kind: 'label', class: 'differs', accept_default: false,
        epa: { label_accepted_on: '2025-12-12', label_url: 'https://www3.epa.gov/new.pdf' },
        current: { label_accepted_on: '2025-12-12', label_url: 'javascript:alert(1)' } },
    ] } as unknown as EpaChemistryProposal;
    render(<EpaProposalModal proposal={withLinks} draft={newEpaProposalDraft()} profileId="u1" onClose={vi.fn()} onSettled={vi.fn()} onRunAgain={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'https://www3.epa.gov/new.pdf' })).toHaveAttribute('href', 'https://www3.epa.gov/new.pdf');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('needs a reason to reject', async () => {
    mocks.reject.mockResolvedValueOnce(undefined);
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Wrong label' } });
    const buttons = screen.getAllByRole('button', { name: 'Reject' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(mocks.reject).toHaveBeenCalledWith('p1', 1, 'Wrong label', expect.any(String)));
  });
});
