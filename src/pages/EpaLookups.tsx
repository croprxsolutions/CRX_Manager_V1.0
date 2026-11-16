import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Card from '../components/ui/Card';
import SplitHeading from '../components/ui/SplitHeading';
import EmptyState, { LoadFailedState } from '../components/ui/EmptyState';
import { Sentry } from '../lib/sentry';
import { FAILURE_LABEL, HOLD_LABEL, fetchEpaLookupOverview, type EpaLookupOverview } from '../lib/epaProposals';
import type { EpaLookupFailure } from '../types';

function ProductLink({ overview, parentId }: { overview: EpaLookupOverview; parentId: string }) {
  const parent = overview.parents.get(parentId);
  if (!parent) return <span>Unknown product</span>;
  return parent.productId
    ? <Link to={`/products/${parent.productId}`} className="text-crx-green hover:underline">{parent.name}</Link>
    : <span>{parent.name}</span>;
}

function byNumber(failures: EpaLookupFailure[]): [string, EpaLookupFailure[]][] {
  const groups = new Map<string, EpaLookupFailure[]>();
  for (const failure of failures) groups.set(failure.epa_registration, [...(groups.get(failure.epa_registration) ?? []), failure]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * DM-4: every EPA lookup that produced nothing usable, by number, and the proposals waiting for a decision.
 * Lookups are run and reviewed on each product's Chemistry card. Admin only.
 */
export default function EpaLookups() {
  const [overview, setOverview] = useState<EpaLookupOverview | 'failed' | null>(null);
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setOverview(null);
    fetchEpaLookupOverview().then((next) => { if (seq === loadSeq.current) setOverview(next); }).catch((error: unknown) => {
      Sentry.captureException(error, { extra: { context: 'fetchEpaLookupOverview' } });
      if (seq === loadSeq.current) setOverview('failed');
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <SplitHeading title="EPA" accent="lookups" />
      {overview === null && <Card><p className="text-sm text-secondary" role="status">Loading EPA lookups…</p></Card>}
      {overview === 'failed' && <LoadFailedState title="EPA lookups could not be loaded" onRetry={load} />}
      {overview && overview !== 'failed' && (
        <>
          <Card>
            <h2 className="mb-2 text-base font-semibold text-primary">Waiting for a decision</h2>
            {overview.open.length === 0
              ? <p className="text-sm text-secondary">No EPA proposal is waiting.</p>
              : (
                <ul className="divide-y divide-gray-100 text-sm">
                  {overview.open.map((proposal) => (
                    <li key={proposal.id} className="py-2">
                      <span className="font-medium text-primary">EPA {proposal.epa_registration}</span>
                      {' · '}<ProductLink overview={overview} parentId={proposal.parent_id} />
                      {' · '}{proposal.status === 'held' && proposal.hold_reason ? `On hold: ${HOLD_LABEL[proposal.hold_reason]}` : 'Proposal waiting'}
                    </li>
                  ))}
                </ul>
              )}
          </Card>
          <Card>
            <h2 className="mb-2 text-base font-semibold text-primary">Failed lookups by EPA number</h2>
            {overview.truncated && <p className="mb-2 text-xs text-secondary">Showing the newest {overview.failures.length} failed lookups.</p>}
            {overview.failures.length === 0
              ? <EmptyState title="No failed lookups" description="No EPA lookup has failed." />
              : (
                <ul className="space-y-3 text-sm">
                  {byNumber(overview.failures).map(([epaNumber, failures]) => (
                    <li key={epaNumber}>
                      <p className="font-medium text-primary">EPA {epaNumber}</p>
                      <ul className="ml-4 list-disc text-secondary">
                        {failures.map((failure) => (
                          <li key={failure.id}>
                            {FAILURE_LABEL[failure.reason]}
                            {failure.transferred_to ? ` (now ${failure.transferred_to}; change the number on the product, then look up the new one)` : ''}
                            {failure.detail && failure.reason !== 'not_found' ? `: ${failure.detail}` : ''}
                            {' · '}<ProductLink overview={overview} parentId={failure.parent_id} />
                            {' · '}{new Date(failure.created_at).toLocaleString()}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
        </>
      )}
    </div>
  );
}
