import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { Sentry } from '../../lib/sentry';
import { generateIdempotencyKey, isDefinitiveRpcRejection } from '../../lib/idempotency';
import { plainRefusal } from '../../lib/productChemistry';
import { runRecordedEpaLookup } from '../../lib/epaLookupClient';
import {
  FAILURE_LABEL, fetchParentEpaState, itemName, newEpaProposalDraft, sideText, startEpaLookup, summarizeNumber, type EpaProposalDraft,
  type NumberSummary, type ParentEpaState,
} from '../../lib/epaProposals';
import EpaProposalModal from './EpaProposalModal';

function errorText(error: unknown): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : null;
  return typeof message === 'string' && message ? plainRefusal(message) : 'The EPA lookup failed. Try again.';
}

function LatestText({ summary }: { summary: NumberSummary }) {
  const { latest } = summary;
  if (latest.kind === 'running') return <span>Looking up…</span>;
  if (latest.kind === 'expired') return <span>The last lookup did not finish; run it again</span>;
  if (latest.kind === 'failure') {
    const { failure } = latest;
    return (
      <span>
        {FAILURE_LABEL[failure.reason]}
        {failure.transferred_to ? ` (now ${failure.transferred_to}; change the number on the product, then look up the new one)` : ''}
        {' · '}{new Date(failure.created_at).toLocaleString()}
      </span>
    );
  }
  if (latest.kind === 'proposal') {
    const { proposal } = latest;
    const word = { proposed: 'Proposal waiting', held: 'Proposal on hold', committed: 'Committed', rejected: 'Rejected', superseded: 'Replaced' }[proposal.status];
    return <span>{word} · {new Date(proposal.decided_at ?? proposal.created_at).toLocaleString()}</span>;
  }
  return <span>Not looked up yet</span>;
}

/** D-L: what the newest committed proposal showed and did not write. */
function KeptDifferences({ summary }: { summary: NumberSummary }) {
  const proposal = summary.committed;
  const kept = proposal ? proposal.items.filter((item) => proposal.commit_result?.[item.item_id] === 'kept_difference' && item.epa != null) : [];
  if (kept.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
      {kept.map((item) => (
        <li key={item.item_id}>EPA says {itemName(item)}: {sideText(item, 'epa')} (kept: {sideText(item, 'current')})</li>
      ))}
    </ul>
  );
}

/**
 * DM-4: look up each EPA number on a parent (its own, each size's and each brand's, one by one), and review what EPA
 * proposes. Admin only. The rows are always re-read from the database after a reply; the reply itself is not trusted.
 */
export default function EpaLookupPanel({ parentId, profileId, reloadKey, epaRefusal, locked, onCommitted }: {
  parentId: string; profileId: string;
  /** Changes when the chemistry card reloads. */
  reloadKey: string;
  epaRefusal: string | null;
  /** Other unsaved edits on the page: lookups wait for them. */
  locked: boolean;
  onCommitted: () => void;
}) {
  const { toast } = useToast();
  // `at`: when the rows were read, so a running lookup older than 30 minutes shows as expired.
  // `key`: which read they came from; while a newer read is on its way, lookups wait for it.
  const [loaded, setLoaded] = useState<{ state: ParentEpaState; at: number; key: string } | 'failed' | null>(null);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadSeq = useRef(0);
  const inFlight = useRef(new Set<string>());
  // The newest lookup per number: a reply for any other lookup is ignored (sheet 5, request ownership).
  const latestLookup = useRef(new Map<string, string>());
  // A start whose reply was lost keeps its key, so a retry replays it instead of starting a second lookup.
  const startKeys = useRef(new Map<string, string>());
  const mounted = useRef(true);
  // Ticks and unconfirmed-save keys per proposal version, kept across closing and reopening the review.
  const [drafts] = useState(() => new Map<string, EpaProposalDraft>());
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const loadKey = `${parentId}|${reloadKey}|${attempt}`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const seq = ++loadSeq.current;
    fetchParentEpaState(parentId).then((next) => {
      if (seq === loadSeq.current) setLoaded({ state: next, at: Date.now(), key: loadKey });
    }).catch((error: unknown) => {
      Sentry.captureException(error, { extra: { context: 'fetchParentEpaState' } });
      if (seq === loadSeq.current) setLoaded('failed');
    });
  }, [parentId, loadKey]);

  const setBusy = (epaNumber: string, busy: boolean) => {
    if (busy) inFlight.current.add(epaNumber); else inFlight.current.delete(epaNumber);
    setRunning(new Set(inFlight.current));
  };

  const run = async (epaNumber: string) => {
    if (inFlight.current.has(epaNumber)) return;
    setBusy(epaNumber, true);
    let lookupId: string | null = null;
    try {
      const key = startKeys.current.get(epaNumber) ?? generateIdempotencyKey('start_epa_lookup', profileId);
      startKeys.current.set(epaNumber, key);
      const started = await startEpaLookup(parentId, epaNumber, key);
      startKeys.current.delete(epaNumber);
      lookupId = started.lookup_id;
      latestLookup.current.set(epaNumber, lookupId);
      reload();
      const record = await runRecordedEpaLookup(lookupId, () => !mounted.current);
      if (!record || latestLookup.current.get(epaNumber) !== lookupId) return;
      if (record.outcome === 'proposal') toast('success', `EPA answered for ${epaNumber}. Review the proposal.`);
      else toast('warning', `${epaNumber}: ${FAILURE_LABEL[record.reason as keyof typeof FAILURE_LABEL] ?? 'the lookup failed'}.`);
    } catch (error) {
      if (lookupId === null && isDefinitiveRpcRejection(error)) startKeys.current.delete(epaNumber);
      if (lookupId === null || latestLookup.current.get(epaNumber) === lookupId) toast('error', `${epaNumber}: ${errorText(error)}`);
    } finally {
      setBusy(epaNumber, false);
      if (mounted.current) reload();
    }
  };

  const runAll = async (numbers: string[]) => {
    for (const epaNumber of numbers) {
      if (!mounted.current) return;
      await run(epaNumber);
    }
  };

  if (loaded === null) return <p className="text-sm text-secondary" role="status">Loading EPA lookups…</p>;
  if (loaded === 'failed') {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-secondary" role="alert">
        EPA lookups could not be loaded. <Button size="sm" variant="secondary" onClick={reload}>Retry</Button>
      </p>
    );
  }
  const { state, at: now } = loaded;
  const reviewed = reviewing ? state.proposals.find((p) => p.id === reviewing) ?? null : null;
  // One lookup at a time, and none on rows a newer read is replacing.
  const lookupsBlocked = locked || loaded.key !== loadKey || running.size > 0;
  const draftFor = (proposal: { id: string; proposal_version: number }) => {
    const id = `${proposal.id}:${proposal.proposal_version}`;
    if (!drafts.has(id)) drafts.set(id, newEpaProposalDraft());
    return drafts.get(id) as EpaProposalDraft;
  };

  // A number taken off the product keeps its waiting proposal reachable, so it can still be rejected.
  const unlinked = [...new Set(state.proposals.filter((p) => (p.status === 'proposed' || p.status === 'held')
    && !state.numbers.includes(p.epa_registration)).map((p) => p.epa_registration))].sort();

  return (
    <section className="space-y-2 rounded-lg border border-gray-200 px-3 py-2" data-testid="epa-lookup-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-primary">EPA lookup</h3>
        <div className="flex items-center gap-2">
          <Link to="/epa-lookups" className="text-xs text-crx-green hover:underline">All EPA lookups</Link>
          {state.numbers.length > 1 && (
            <Button size="sm" variant="secondary" disabled={lookupsBlocked} onClick={() => { void runAll(state.numbers); }}>
              Look up all
            </Button>
          )}
        </div>
      </div>
      {state.numbers.length === 0 && <p className="text-sm text-secondary">This product has no EPA number to look up.</p>}
      {state.numbers.length > 0 && epaRefusal == null && (
        <p className="text-xs text-secondary">EPA has no record of {state.numbers.length === 1 ? 'this number' : 'these numbers'}, so chemistry can be typed.</p>
      )}
      <ul className="divide-y divide-gray-100">
        {[...state.numbers, ...unlinked].map((epaNumber) => {
          const summary = summarizeNumber(state, epaNumber, now);
          const linked = state.numbers.includes(epaNumber);
          return (
            <li key={epaNumber} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-primary">EPA {epaNumber}</span>
                  <span className="ml-2 text-secondary">{linked ? <LatestText summary={summary} /> : 'No longer on this product'}</span>
                </div>
                <div className="flex gap-2">
                  {summary.open && (
                    <Button size="sm" onClick={() => setReviewing(summary.open?.id ?? null)}>
                      {summary.open.status === 'held' ? 'Review (on hold)' : 'Review proposal'}
                    </Button>
                  )}
                  {linked && (
                    <Button size="sm" variant="secondary" icon={<Search className="h-4 w-4" />} disabled={lookupsBlocked}
                      onClick={() => { void run(epaNumber); }}>
                      {running.has(epaNumber) ? 'Looking up…' : 'Run lookup'}
                    </Button>
                  )}
                </div>
              </div>
              <KeptDifferences summary={summary} />
            </li>
          );
        })}
      </ul>
      {reviewed && (
        <EpaProposalModal key={`${reviewed.id}:${reviewed.proposal_version}`} proposal={reviewed} draft={draftFor(reviewed)} profileId={profileId}
          onClose={() => setReviewing(null)}
          onSettled={() => { setReviewing(null); reload(); onCommitted(); }}
          onRunAgain={state.numbers.includes(reviewed.epa_registration) && !lookupsBlocked ? (epaNumber) => { setReviewing(null); void run(epaNumber); } : undefined} />
      )}
    </section>
  );
}
