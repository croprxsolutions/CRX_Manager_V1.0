import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { Sentry } from '../../lib/sentry';
import { BatchDeadlineError, fetchBatchCandidates, runBatchParent, type BatchCandidate, type BatchResult } from '../../lib/epaBatchFill';

const STORAGE_KEY = 'epaBatchFill:lastRun';
const OUTCOME_LABEL: Record<BatchResult['outcome'], string> = {
  saved: 'Saved', needs_person: 'Needs a person', skipped: 'Skipped', failed: 'Failed', unknown: 'Uncertain: reload and check this product',
};

type Runnable = BatchCandidate & { epaNumber: string };

// The run's results, plus the product in progress saved as "uncertain" first, so a reload mid-request still shows it.
function readSaved(): BatchResult[] {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as BatchResult[]; } catch { return []; }
}
function save(results: BatchResult[]) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(results)); } catch { /* storage full or blocked: the list on screen still shows it */ }
}
const IN_PROGRESS = 'In progress when the page closed: open the product to see whether it saved';

/**
 * EPA batch fill (admin): looks up many products' EPA numbers one at a time and saves plain new ingredients only.
 * Anything unusual stays as a proposal for a person. Contract: docs/plans/2026-11-18-epa-batch-fill-CONTRACT.md.
 */
export default function EpaBatchFill({ onRunEnd }: { onRunEnd: () => void }) {
  const [candidates, setCandidates] = useState<BatchCandidate[] | 'failed' | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<BatchResult[]>(readSaved);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const runningRef = useRef(false);
  const stopRef = useRef(false);

  const load = useCallback(() => {
    setCandidates(null);
    fetchBatchCandidates().then(setCandidates).catch((error: unknown) => {
      Sentry.captureException(error, { extra: { context: 'fetchBatchCandidates' } });
      setCandidates('failed');
    });
  }, []);
  useEffect(() => { load(); }, [load]);
  // Leaving the page (or signing out) stops the run after the current product.
  useEffect(() => () => { stopRef.current = true; }, []);

  const runnable = Array.isArray(candidates) ? candidates.filter((c): c is Runnable => c.skip === null && c.epaNumber !== null) : [];
  const skipped = Array.isArray(candidates) ? candidates.filter((c) => c.skip !== null) : [];

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    stopRef.current = false;
    setRunning(true);
    const runId = crypto.randomUUID();
    const queue = runnable.filter((c) => ticked.has(c.parentId));
    let log: BatchResult[] = [];
    let errorsInRow = 0;
    try {
      for (const candidate of queue) {
        if (stopRef.current) break;
        const base = { parentId: candidate.parentId, name: candidate.name, epaNumber: candidate.epaNumber };
        save([...log, { ...base, outcome: 'unknown', detail: IN_PROGRESS }]);
        let result: BatchResult;
        let stop = false;
        try {
          result = await runBatchParent(runId, candidate);
          errorsInRow = 0;
        } catch (error: unknown) {
          Sentry.captureException(error, { extra: { context: 'runBatchParent', parentId: candidate.parentId } });
          const message = error instanceof Error ? error.message : String(error);
          result = { ...base, outcome: 'unknown', detail: `${message}. Open the product to see whether it saved` };
          errorsInRow += 1;
          // A request past its deadline may still be running; two errors in a row means EPA or the app is struggling.
          stop = error instanceof BatchDeadlineError || errorsInRow >= 2;
        }
        log = [...log, result];
        setResults(log);
        save(log);
        if (stop) break;
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      setTicked(new Set());
      load();
      onRunEnd();
    }
  };

  const toggle = (id: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Card>
      <h2 className="mb-1 text-base font-semibold text-primary">Fill ingredients from EPA (batch)</h2>
      <p className="mb-3 text-sm text-secondary">
        Products with no ingredients and exactly one EPA number. Each ticked product is looked up at EPA and only plain new
        ingredients (with a CAS number and percent) are saved. Label facts are never written. Anything else waits above for a person.
      </p>
      {candidates === null && <p className="text-sm text-secondary" role="status">Loading products…</p>}
      {candidates === 'failed' && (
        <p className="text-sm text-red-600">Products could not be loaded. <button type="button" className="underline" onClick={load}>Try again</button></p>
      )}
      {Array.isArray(candidates) && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={running || runnable.length === 0}
              onClick={() => setTicked(new Set(runnable.map((c) => c.parentId)))}>Tick all ({runnable.length})</Button>
            <Button size="sm" variant="ghost" disabled={running || ticked.size === 0} onClick={() => setTicked(new Set())}>Untick all</Button>
            <Button size="sm" icon={<Play className="h-4 w-4" />} disabled={running || ticked.size === 0} loading={running}
              onClick={() => setConfirming(true)}>Start ({ticked.size})</Button>
            {running && (
              <Button size="sm" variant="danger" icon={<Square className="h-4 w-4" />} onClick={() => { stopRef.current = true; }}>
                Stop after this product
              </Button>
            )}
          </div>
          {runnable.length === 0
            ? <p className="text-sm text-secondary">No product is ready for a batch lookup.</p>
            : (
              <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto text-sm">
                {runnable.map((c) => (
                  <li key={c.parentId} className="py-1">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={ticked.has(c.parentId)} disabled={running} onChange={() => toggle(c.parentId)} />
                      <span className="text-primary">{c.name}</span>
                      <span className="text-secondary">EPA {c.epaNumber}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          {skipped.length > 0 && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-secondary">Not offered ({skipped.length})</summary>
              <ul className="ml-4 list-disc text-secondary">
                {skipped.map((c) => <li key={c.parentId}>{c.name}: {c.skip}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
      {results.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-1 text-sm font-semibold text-primary">Last run{running ? ' (running)' : ''}</h3>
          <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto text-sm" aria-live="polite">
            {results.map((r) => (
              <li key={r.parentId} className="py-1">
                <span className="font-medium text-primary">{r.name}</span>
                {' · '}EPA {r.epaNumber}{' · '}{OUTCOME_LABEL[r.outcome]}{r.detail ? `: ${r.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void run(); }}
        title="Fill ingredients from EPA"
        message={`Look up ${ticked.size} product${ticked.size === 1 ? '' : 's'} at EPA and save their plain new ingredients? Label facts are not written. Products are done one at a time; Stop finishes the current one.`}
        confirmLabel="Start"
        variant="info"
      />
    </Card>
  );
}
