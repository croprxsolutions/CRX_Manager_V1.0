import Button from '../ui/Button';
import type { ChemistryProposalView } from '../../lib/productSetupChemistry';

export default function SetupWorkbookProposalPanel({
  proposals, error, loading, busy, openParentCounts, onApply, onReject, onApplyDelete, onRetry,
}: {
  proposals: ChemistryProposalView[];
  error: string | null;
  loading: boolean;
  busy: boolean;
  openParentCounts: Map<string, number>;
  onApply: (proposal: ChemistryProposalView) => void;
  onReject: (proposal: ChemistryProposalView) => void;
  onApplyDelete: (proposal: ChemistryProposalView) => void;
  onRetry: () => void;
}) {
  return <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Open ingredient proposals">
    <h3 className="font-semibold text-nav-dark">Open ingredient proposals ({proposals.length})</h3>
    {error && <div className="space-y-2">
      <p className="text-red-700">Proposals could not be loaded: {error}</p>
      <Button variant="secondary" size="sm" disabled={busy} onClick={onRetry}>Retry proposals</Button>
    </div>}
    {!error && loading && <p className="text-secondary" role="status">Checking open proposals…</p>}
    {!error && !loading && proposals.length === 0 && <p className="text-secondary">No open proposals.</p>}
    {proposals.map((proposal) => <article key={proposal.id} className="space-y-2 rounded border border-gray-200 p-3">
      <h4 className="font-medium">{proposal.parent_name ?? 'Unknown parent'} · version {proposal.proposal_version}</h4>
      {proposal.items.map((item, index) => <p key={`${proposal.id}:${index}`}>
        {item.action === 'add' ? `Add ${item.display_name ?? 'unknown ingredient'}` : item.action === 'retire' ? `Remove ${item.display_name ?? 'unknown ingredient'}` : `Update ${item.display_name ?? 'unknown ingredient'}`}
        {item.action !== 'add' && item.display_name && ' · Current name'}{item.cas && ` (CAS ${item.cas})`}
        {item.strength_value != null && ` · ${item.strength_value} ${item.strength_unit ?? ''} ${item.strength_basis ?? ''}`}
        {item.action !== 'retire' && item.strength_value == null
          && ` · strength unknown · ${item.strength_unit ?? 'unit missing'} · ${item.strength_basis ?? 'basis missing'}`}
        {item.source_note && ` · ${item.source ?? 'Source'}: ${item.source_note}`}
        {item.action === 'add' && !item.cas && <span className="block text-amber-800">Applying creates a new provisional shared ingredient, even if a similar name already exists. Check its name and source before applying.</span>}
      </p>)}
      {proposal.has_delete && <p className="font-medium text-red-700">This proposal removes an ingredient.</p>}
      {(openParentCounts.get(proposal.parent_id) ?? 0) > 1 && <p className="text-secondary">Several open proposals exist for this parent. Applying one may make another stale.</p>}
      <div className="flex flex-wrap gap-2">
        {proposal.has_delete
          ? <Button disabled={busy || proposal.unresolved} onClick={() => onApplyDelete(proposal)}>Apply with removal…</Button>
          : <Button disabled={busy || proposal.unresolved} onClick={() => onApply(proposal)}>Apply proposal</Button>}
        <Button variant="secondary" disabled={busy || proposal.unresolved} onClick={() => onReject(proposal)}>Reject proposal</Button>
      </div>
      {proposal.unresolved && <p className="text-red-700">A current parent or ingredient name could not be resolved. Reload; decision actions are disabled.</p>}
    </article>)}
  </section>;
}
