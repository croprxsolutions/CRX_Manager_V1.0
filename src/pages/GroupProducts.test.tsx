import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalGroup, ProposalMember } from '../lib/productParentProposals';

const M = vi.hoisted(() => ({
  toast: vi.fn(),
  loadLatestProposal: vi.fn(),
  loadGroupingOpen: vi.fn(),
  loadProposalGroups: vi.fn(),
  buildProposal: vi.fn(),
  decideGroup: vi.fn(),
  approveGroups: vi.fn(),
  previewProductRateCorrection: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin', profile: { id: 'admin-1' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: M.toast }) }));
vi.mock('../lib/productRateLock', () => ({ previewProductRateCorrection: M.previewProductRateCorrection }));
vi.mock('../lib/productParentProposals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/productParentProposals')>();
  return {
    ...actual,
    loadLatestProposal: M.loadLatestProposal,
    loadGroupingOpen: M.loadGroupingOpen,
    loadProposalGroups: M.loadProposalGroups,
    buildProposal: M.buildProposal,
    decideGroup: M.decideGroup,
    approveGroups: M.approveGroups,
  };
});

import GroupProducts from './GroupProducts';

const proposal = { id: 'prop-1', proposal_version: 3, status: 'open', built_at: '2026-11-06T22:00:00Z' };

function member(id: string, name: string, patch: Partial<ProposalMember> = {}): ProposalMember {
  return {
    product_id: id, product_name: name, sku: null, product_form: 'liquid', container_size: '2.5', container_unit: 'Gal',
    inventory_unit: 'Gal', is_active: true, category: 'Herbicide', use_timings: null, rate_per_acre: '1', rate_unit: 'qt',
    suggested_rate: null, epa_registration: '524-475', manufacturer: 'Bayer', suggested_size_role: 'package', brands: [], ...patch,
  };
}

function group(id: string, patch: Partial<ProposalGroup>): ProposalGroup {
  return {
    id, proposal_id: 'prop-1', suggested_name: 'Rho', product_form: 'liquid', generic_epa_registration: '524-475',
    identity_basis: 'epa_number', members: [member(`${id}-a`, 'Rho 2.5 gal'), member(`${id}-b`, 'Rho 30 gal', { container_size: '30' })],
    conflicts: {}, flags: [], group_fingerprint: `fp-${id}`, status: 'proposed', parent_id: null, decided_at: null, reason: null,
    ...patch,
  };
}

const rateConflict = group('g-rates', {
  suggested_name: 'Rho',
  members: [member('a', 'Rho 2.5 gal'), member('b', 'Rho 30 gal', { container_size: '30', rate_per_acre: '2' })],
  conflicts: { rates: [
    { rate_per_acre: '1', rate_unit: 'qt', suggested_rate: null },
    { rate_per_acre: '2', rate_unit: 'qt', suggested_rate: null },
  ] },
});
const heldEpa = group('g-held', {
  suggested_name: 'Callisto', status: 'held', identity_basis: null, generic_epa_registration: null,
  flags: ['owner_confirmation_needed', 'rejected_before'],
  reason: 'parent "Callisto" already has EPA number none, this form and this name; a second parent is never made for one product; rejected on 2026-11-02 (two strengths)',
});

describe('GroupProducts', () => {
  beforeEach(() => {
    Object.values(M).forEach((m) => m.mockReset());
    M.loadLatestProposal.mockResolvedValue(proposal);
    M.loadGroupingOpen.mockResolvedValue(true);
    M.loadProposalGroups.mockResolvedValue([rateConflict, heldEpa]);
  });

  it('shows held groups with their reason, including a carried rejection', async () => {
    render(<GroupProducts />);
    await screen.findByText('Rho');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'held' } });
    expect(screen.getByText('Callisto')).toBeInTheDocument();
    expect(screen.getByText(/already has EPA number none/)).toBeInTheDocument();
    expect(screen.getByText(/rejected on 2026-11-02 \(two strengths\)/)).toBeInTheDocument();
    expect(screen.queryByText('Rho')).not.toBeInTheDocument();
  });

  it('shows the build result: carried rejections and duplicate parents to fix by hand', async () => {
    M.buildProposal.mockResolvedValue({
      proposal_id: 'prop-1', proposal_version: 3, group_count: 2, held_count: 1, rejected_count: 1,
      duplicate_parents: [{ generic_epa_registration: '524-475', product_form: 'liquid', names: ['Rho', 'Rho (EPA 524-475)'] }],
    });
    render(<GroupProducts />);
    await screen.findByText('Rho');
    // On a revisit there is no build reply, so the page says where the duplicate check shows.
    expect(screen.getByText(/listed here after you press Build/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Build a new proposal' }));
    expect(await screen.findByText(/1 rejection carried from an earlier proposal/)).toBeInTheDocument();
    expect(screen.queryByText(/listed here after you press Build/)).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('fix these by hand');
    expect(alert).toHaveTextContent('Rho, Rho (EPA 524-475) (EPA 524-475, liquid)');
    expect(M.buildProposal).toHaveBeenCalledWith(expect.any(String));
  });

  it('locks the status filter while a build runs, so the build reply cannot overwrite a newer choice', async () => {
    let finish: (v: unknown) => void = () => {};
    M.buildProposal.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<GroupProducts />);
    await screen.findByText('Rho');
    fireEvent.click(screen.getByRole('button', { name: 'Build a new proposal' }));
    expect(screen.getByLabelText('Status')).toBeDisabled();
    finish({ proposal_id: 'prop-1', proposal_version: 3, group_count: 2, held_count: 0, rejected_count: 0, duplicate_parents: [] });
    await waitFor(() => expect(screen.getByLabelText('Status')).not.toBeDisabled());
  });

  it('approves a group as shown, with the previewed per-acre prices of the size whose rate changes', async () => {
    M.previewProductRateCorrection.mockResolvedValue({
      before: { tier1_price_per_acre: 5, tier2_price_per_acre: 4.5, tier3_price_per_acre: 4 },
      after: { tier1_price_per_acre: 10, tier2_price_per_acre: 9, tier3_price_per_acre: 8 },
    });
    M.approveGroups.mockRejectedValueOnce({ message: 'PRODUCT_PARENT_GROUPING_NOT_OPEN: grouping opens when the new product screens are live' });
    render(<GroupProducts />);
    fireEvent.click(await screen.findByRole('button', { name: /Rho/ }));
    expect(screen.getByRole('button', { name: 'Approve this group' })).toBeDisabled();
    expect(screen.getByText('Pick the rate.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('2 qt'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve this group' }));

    const dialog = await screen.findByRole('dialog');
    expect(M.previewProductRateCorrection).toHaveBeenCalledWith({ productId: 'a', ratePerAcre: 2, rateUnit: 'qt' });
    expect(within(dialog).getByText(/\$10 \/ \$9 \/ \$8/)).toBeInTheDocument();
    expect(within(dialog).getByText('Rate per acre:', { exact: false })).toHaveTextContent('Rate per acre: 2 qt');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve as shown' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Grouping is not switched on yet');

    M.approveGroups.mockResolvedValueOnce({ groups: [] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve as shown' }));
    await waitFor(() => expect(M.approveGroups).toHaveBeenCalledTimes(2));
    const [first, retry] = M.approveGroups.mock.calls.map((c) => c[0]);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.entries).toEqual([expect.objectContaining({
      group_id: 'g-rates',
      choices: { rates: { rate_per_acre: '2', rate_unit: 'qt', suggested_rate: null } },
      prices: { a: { tier1_price_per_acre: 10, tier2_price_per_acre: 9, tier3_price_per_acre: 8 } },
    })]);
    await waitFor(() => expect(M.toast).toHaveBeenCalledWith('success', '1 group approved'));
  });

  it('holds a group with a reason', async () => {
    M.decideGroup.mockResolvedValue(undefined);
    render(<GroupProducts />);
    fireEvent.click(await screen.findByRole('button', { name: /Rho/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Hold…' }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'check the label first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(M.decideGroup).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'hold', proposalVersion: 3, reason: 'check the label first', group: expect.objectContaining({ id: 'g-rates' }),
    })));
  });

  it('does not offer approval while grouping is switched off, but still holds and rejects', async () => {
    M.loadGroupingOpen.mockResolvedValue(false);
    M.loadProposalGroups.mockResolvedValue([group('g-ok', {})]);
    render(<GroupProducts />);
    expect(await screen.findByRole('status')).toHaveTextContent('Grouping is not switched on yet');
    expect(screen.queryByLabelText(/for batch approval/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Rho/ }));
    expect(screen.getByRole('button', { name: 'Approve this group' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Hold…' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject…' })).toBeEnabled();
  });

  it('clears batch selections when a filter changes, so a hidden group cannot be approved', async () => {
    M.loadProposalGroups.mockResolvedValue([group('g-ok', {})]);
    render(<GroupProducts />);
    fireEvent.click(await screen.findByLabelText(/for batch approval/));
    expect(screen.getByRole('button', { name: 'Approve 1 selected' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'zzz' } });
    expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument();
  });

  it('turns the EPA-has-parent refusal into plain English', async () => {
    M.approveGroups.mockRejectedValue({ message: 'PRODUCT_PARENT_EPA_HAS_PARENT: parent "Rho" already has EPA number 524-475 and this name; build a new proposal' });
    M.loadProposalGroups.mockResolvedValue([group('g-ok', {})]);
    render(<GroupProducts />);
    fireEvent.click(await screen.findByRole('button', { name: /Rho/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve this group' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve as shown' }));
    expect(await screen.findByText(/Build a new proposal; the group will then show as held/)).toBeInTheDocument();
  });
});
