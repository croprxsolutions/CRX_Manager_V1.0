import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/db', () => ({ supabaseUntyped: { rpc: vi.fn(), from: vi.fn() }, assertRpcResult: (d: unknown) => d }));

import ProposalGroupCard from './ProposalGroupCard';
import type { ProposalGroup } from '../../lib/productParentProposals';

const group = (flags: string[]): ProposalGroup => ({
  id: 'g1', proposal_id: 'p', suggested_name: 'Rho', product_form: 'liquid', generic_epa_registration: '524-475',
  identity_basis: 'epa_number', members: [], conflicts: {}, flags, group_fingerprint: 'fp', status: 'held',
  parent_id: null, decided_at: null, reason: null,
});

const props = {
  draft: null, onDraftChange: vi.fn(), selected: false, onSelectedChange: vi.fn(), onHold: vi.fn(),
  onReject: vi.fn(), onApprove: vi.fn(), approveOff: true, busy: false,
};

describe('ProposalGroupCard same-EPA note', () => {
  it('names the other groups with the EPA number when the flag is set', () => {
    render(<ProposalGroupCard {...props} group={group(['same_epa_different_name'])} sameEpaNames={['Rho Max', 'Rho Pro']} />);
    expect(screen.getByText('Also EPA 524-475: Rho Max, Rho Pro')).toBeInTheDocument();
  });

  it('shows no note without the flag', () => {
    render(<ProposalGroupCard {...props} group={group([])} sameEpaNames={['Rho Max']} />);
    expect(screen.queryByText(/Also EPA/)).not.toBeInTheDocument();
  });
});
