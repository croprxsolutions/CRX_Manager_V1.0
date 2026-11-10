import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Layers } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EmptyState, { LoadFailedState } from '../components/ui/EmptyState';
import ReasonModal from '../components/ui/ReasonModal';
import { useToast } from '../components/ui/Toast';
import ProposalGroupCard from '../components/products/ProposalGroupCard';
import GroupApprovalReviewModal, { type ApprovalReview } from '../components/products/GroupApprovalReviewModal';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { Sentry } from '../lib/sentry';
import {
  FLAG_LABELS,
  approvalEntry,
  approvalProblems,
  approveGroups,
  buildProposal,
  chosenRates,
  decideGroup,
  initialDraft,
  loadGroupingOpen,
  loadLatestProposal,
  loadProposalGroups,
  previewGroupPrices,
  productParentErrorMessage,
  sameEpaGroupNames,
  type BuildResult,
  type GroupDraft,
  type Proposal,
  type ProposalGroup,
  type ProposalGroupStatus,
} from '../lib/productParentProposals';

type StatusFilter = ProposalGroupStatus | 'all';
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'held', label: 'Held' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'approved', label: 'Approved' },
  { value: 'all', label: 'All' },
];
const PAGE = 50;

function report(err: unknown, action: string) {
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'group_products', action } });
}

function BuildSummary({ proposal, groups, build }: { proposal: Proposal; groups: ProposalGroup[]; build: BuildResult | null }) {
  const count = (s: ProposalGroupStatus) => groups.filter((g) => g.status === s).length;
  return (
    <Card>
      <div className="space-y-3 text-sm">
        <p className="text-gray-800">
          Proposal {proposal.proposal_version} ({proposal.status}), built {new Date(proposal.built_at).toLocaleString()}:{' '}
          {groups.length} groups. {count('proposed')} proposed, {count('held')} held, {count('rejected')} rejected,{' '}
          {count('approved')} approved.
        </p>
        {build && build.proposal_id === proposal.id && (
          <p className="text-gray-800">
            This build: {build.group_count} groups, {build.held_count} held, {build.rejected_count} rejection
            {build.rejected_count === 1 ? '' : 's'} carried from an earlier proposal.
          </p>
        )}
        {build && build.proposal_id === proposal.id && build.duplicate_parents.length > 0 && (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
            <p className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" /> Parents that already duplicate one another: fix these by hand
            </p>
            <ul className="mt-1 list-disc pl-5">
              {build.duplicate_parents.map((d) => (
                <li key={d.names.join('|')}>
                  {d.names.join(', ')} (EPA {d.generic_epa_registration ?? 'none'}, {d.product_form ?? 'no form'})
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* shortcut: duplicate parents come only from a build reply, not stored; store them if admins miss the warning. */}
        {!(build && build.proposal_id === proposal.id) && (
          <p className="text-gray-600">Parents that already duplicate one another are listed here after you press Build.</p>
        )}
      </div>
    </Card>
  );
}

function useProposalData() {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [groupingOpen, setGroupingOpen] = useState(false);
  const [groups, setGroups] = useState<ProposalGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, GroupDraft>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    (async () => {
      try {
        const [latest, open] = await Promise.all([loadLatestProposal(), loadGroupingOpen()]);
        const rows = latest ? await loadProposalGroups(latest.id) : [];
        if (!active) return;
        setGroupingOpen(open);
        const proposed = rows.filter((g) => g.status === 'proposed');
        const proposedIds = new Set(proposed.map((g) => g.id));
        setProposal(latest);
        setGroups(rows);
        // Keep answers already typed for a group still proposed; start the rest from the suggestions.
        setDrafts((current) => Object.fromEntries(proposed.map((g) => [g.id, current[g.id] ?? initialDraft(g)])));
        setSelected((current) => new Set([...current].filter((id) => proposedIds.has(id))));
      } catch (err) {
        if (!active) return;
        report(err, 'load');
        setLoadFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [reloadToken]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);
  return { proposal, groupingOpen, groups, loading, loadFailed, reload, drafts, setDrafts, selected, setSelected };
}

interface FilterBarProps {
  statusFilter: StatusFilter;
  flagFilter: string;
  search: string;
  flagsInUse: string[];
  shownCount: number;
  selectedCount: number;
  busy: boolean;
  onStatus: (v: StatusFilter) => void;
  onFlag: (v: string) => void;
  onSearch: (v: string) => void;
  onApproveSelected: () => void;
}

function FilterBar(p: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm text-gray-700">
        Status
        <select aria-label="Status" className="ml-2 rounded-md border border-gray-300 px-2 py-1" value={p.statusFilter}
          disabled={p.busy} onChange={(e) => p.onStatus(e.target.value as StatusFilter)}>
          {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
      <label className="text-sm text-gray-700">
        Flag
        <select aria-label="Flag" className="ml-2 rounded-md border border-gray-300 px-2 py-1" value={p.flagFilter}
          onChange={(e) => p.onFlag(e.target.value)}>
          <option value="">Any</option>
          {p.flagsInUse.map((f) => <option key={f} value={f}>{FLAG_LABELS[f] ?? f}</option>)}
        </select>
      </label>
      <input aria-label="Search groups" placeholder="Search a name…" className="rounded-md border border-gray-300 px-2 py-1 text-sm placeholder:text-gray-500"
        value={p.search} onChange={(e) => p.onSearch(e.target.value)} />
      <span className="text-sm text-gray-600">{p.shownCount} shown</span>
      {p.selectedCount > 0 && (
        <Button size="sm" disabled={p.busy} onClick={p.onApproveSelected}>
          Approve {p.selectedCount} selected
        </Button>
      )}
    </div>
  );
}

function DecisionModal({ decision, busy, onClose, onConfirm }: {
  decision: { kind: 'hold' | 'reject'; group: ProposalGroup } | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const hold = decision?.kind === 'hold';
  const name = decision?.group.suggested_name ?? '';
  return (
    <ReasonModal
      open={decision !== null}
      onClose={onClose}
      onConfirm={onConfirm}
      title={hold ? 'Hold this group' : 'Reject this group'}
      message={hold
        ? `Keep "${name}" out of grouping for now. Its sizes work exactly as today.`
        : `Reject "${name}". A new proposal keeps it rejected until one of its sizes changes.`}
      confirmLabel={hold ? 'Hold' : 'Reject'}
      variant="warning"
      loading={busy}
    />
  );
}

export default function GroupProducts() {
  const { profile } = useAuth();
  const userId = profile?.id ?? '';
  const { toast } = useToast();
  const { proposal, groupingOpen, groups, loading, loadFailed, reload, drafts, setDrafts, selected, setSelected } = useProposalData();
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('proposed');
  const [flagFilter, setFlagFilter] = useState('');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<{ kind: 'hold' | 'reject'; group: ProposalGroup } | null>(null);
  const [review, setReview] = useState<ApprovalReview | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const buildKey = useIdempotencyKey('build_product_parent_proposal', userId);
  const decideKey = useIdempotencyKey('decide_product_parent_group', userId);
  const approveKey = useIdempotencyKey('approve_product_parent_groups', userId);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return groups.filter((g) => (statusFilter === 'all' || g.status === statusFilter)
      && (!flagFilter || g.flags.includes(flagFilter))
      && (!term || g.suggested_name.toLowerCase().includes(term)
        || g.members.some((m) => m.product_name.toLowerCase().includes(term))));
  }, [groups, statusFilter, flagFilter, search]);

  const toggleSelected = (id: string, on: boolean) =>
    setSelected((current) => new Set(on ? [...current, id] : [...current].filter((x) => x !== id)));

  const flagsInUse = useMemo(() => [...new Set(groups.flatMap((g) => g.flags))].sort(), [groups]);

  const handleBuild = async () => {
    setBusy(true);
    try {
      const result = await buildProposal(buildKey.getKey());
      buildKey.resetKey();
      setBuild(result);
      setStatusFilter('proposed');
      toast('success', `Proposal ${result.proposal_version} built: ${result.group_count} groups`);
      reload();
    } catch (err) {
      report(err, 'build');
      toast('error', productParentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDecide = async (reason: string) => {
    if (!decision || !proposal) return;
    const { kind, group } = decision;
    const scope = JSON.stringify([kind, group.id, group.group_fingerprint, reason]);
    setBusy(true);
    try {
      await decideGroup({ decision: kind, group, proposalVersion: proposal.proposal_version, reason, idempotencyKey: decideKey.getKeyFor(scope) });
      decideKey.resetKeyFor(scope);
      toast('success', `${group.suggested_name} ${kind === 'hold' ? 'held' : 'rejected'}`);
      setDecision(null);
      reload();
    } catch (err) {
      report(err, kind);
      toast('error', productParentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startApproval = async (ids: string[]) => {
    if (!groupingOpen) return;
    const chosen = groups.filter((g) => ids.includes(g.id));
    // A selected group may have been edited into an unready state since it was ticked.
    const notReady = chosen.filter((g) => !drafts[g.id] || approvalProblems(g, drafts[g.id]).length > 0);
    if (notReady.length > 0) {
      toast('error', `Not ready to approve: ${notReady.map((g) => g.suggested_name).join(', ')}. Open it and answer what it asks.`);
      return;
    }
    setBusy(true);
    try {
      const entries = [];
      const changes = [];
      for (const group of chosen) {
        const draft = drafts[group.id];
        const rates = chosenRates(group, draft);
        const groupChanges = rates ? await previewGroupPrices(group, rates) : [];
        changes.push(...groupChanges);
        entries.push(approvalEntry(group, draft, Object.fromEntries(groupChanges.map((c) => [c.productId, c.after]))));
      }
      setReviewError(null);
      setReview({ groups: chosen, entries, changes });
    } catch (err) {
      report(err, 'preview');
      toast('error', productParentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmApproval = async () => {
    if (!review || !proposal) return;
    // One key per exact payload: a retry of the same approval replays, a changed one is a new request.
    const scope = JSON.stringify([proposal.id, proposal.proposal_version, review.entries]);
    setBusy(true);
    try {
      await approveGroups({ proposal, entries: review.entries, idempotencyKey: approveKey.getKeyFor(scope) });
      approveKey.resetKeyFor(scope);
      toast('success', `${review.entries.length} group${review.entries.length === 1 ? '' : 's'} approved`);
      setReview(null);
      setSelected(new Set());
      reload();
    } catch (err) {
      report(err, 'approve');
      setReviewError(productParentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Group"
        accent="Products"
        subtitle="Group the sizes of one product under a parent. Nothing changes until a group is approved."
        actions={<Button loading={busy && !review && !decision} disabled={busy} onClick={handleBuild}>Build a new proposal</Button>}
      />
      {loading && <p className="text-sm text-gray-600">Loading proposal…</p>}
      {!loading && loadFailed && <LoadFailedState title="The proposal could not be loaded" onRetry={reload} />}
      {!loading && !loadFailed && !proposal && (
        <EmptyState
          icon={<Layers className="h-6 w-6 text-gray-500" />}
          title="No proposal yet"
          description="Build a proposal to see which product sizes can be grouped."
        />
      )}
      {!loading && !loadFailed && proposal && (
        <>
          <BuildSummary proposal={proposal} groups={groups} build={build} />
          {!groupingOpen && (
            <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              Grouping is not switched on yet, so groups cannot be approved. You can build proposals and hold or
              reject groups now; approving opens once the new product screens are live and grouping is switched on.
            </div>
          )}
          <FilterBar
            statusFilter={statusFilter}
            flagFilter={flagFilter}
            search={search}
            flagsInUse={flagsInUse}
            shownCount={visible.length}
            selectedCount={selected.size}
            busy={busy}
            onStatus={(v) => { setStatusFilter(v); setShown(PAGE); setSelected(new Set()); }}
            onFlag={(v) => { setFlagFilter(v); setShown(PAGE); setSelected(new Set()); }}
            onSearch={(v) => { setSearch(v); setShown(PAGE); setSelected(new Set()); }}
            onApproveSelected={() => void startApproval([...selected])}
          />
          <div className="space-y-2">
            {visible.length === 0 && <p className="text-sm text-gray-600">No groups match.</p>}
            {visible.slice(0, shown).map((group) => (
              <ProposalGroupCard
                key={group.id}
                group={group}
                draft={drafts[group.id] ?? null}
                onDraftChange={(d) => setDrafts((current) => ({ ...current, [group.id]: d }))}
                selected={selected.has(group.id)}
                onSelectedChange={(on) => toggleSelected(group.id, on)}
                onHold={() => setDecision({ kind: 'hold', group })}
                onReject={() => setDecision({ kind: 'reject', group })}
                onApprove={() => void startApproval([group.id])}
                approveOff={!groupingOpen}
                busy={busy}
                sameEpaNames={sameEpaGroupNames(group, groups)}
              />
            ))}
            {visible.length > shown && (
              <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, visible.length - shown)} more</Button>
            )}
          </div>
        </>
      )}
      <DecisionModal decision={decision} busy={busy} onClose={() => setDecision(null)} onConfirm={(reason) => void handleDecide(reason)} />
      <GroupApprovalReviewModal
        review={review}
        error={reviewError}
        saving={busy}
        onClose={() => setReview(null)}
        onConfirm={() => void confirmApproval()}
      />
    </div>
  );
}
