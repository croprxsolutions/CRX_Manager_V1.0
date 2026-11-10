import { useCallback, useEffect, useRef, useState } from 'react';
import { PaintBucket, Undo2 } from 'lucide-react';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import { LoadFailedState } from '../ui/EmptyState';
import ReasonModal from '../ui/ReasonModal';
import { useToast } from '../ui/Toast';
import ToteFillModal from './ToteFillModal';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { sanitizeError } from '../../lib/db';
import { isDefinitiveRpcRejection } from '../../lib/idempotency';
import { Sentry } from '../../lib/sentry';
import { listToteFills, reverseToteFill, type ToteFillRow } from '../../lib/toteFill';

const qty = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });

/**
 * A fertilizer tote's fills from its Bulk (admins only): fill more, and undo the latest fill. The
 * database allows an undo only while neither product's stock has moved since; this card offers it
 * only on the newest fill, and any other case is refused by the database with "adjust stock instead".
 */
export default function ToteFillCard({ toteProductId, toteName, profileId, onStockChanged }: {
  toteProductId: string;
  toteName: string;
  profileId: string;
  onStockChanged: () => void;
}) {
  const { toast } = useToast();
  const [fills, setFills] = useState<ToteFillRow[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [filling, setFilling] = useState(false);
  const [undoFill, setUndoFill] = useState<ToteFillRow | null>(null);
  const [undoing, setUndoing] = useState(false);
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('reverse_tote_fill', profileId);

  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latestLoad.current; // only the newest load may set the list
    setLoadState('loading');
    try {
      const rows = await listToteFills(toteProductId);
      if (mine !== latestLoad.current) return;
      setFills(rows);
      setLoadState('loaded');
    } catch (error) {
      if (mine !== latestLoad.current) return;
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'tote-fill-card' } });
      setLoadState('failed');
    }
  }, [toteProductId]);
  useEffect(() => { void load(); }, [load]);

  const changed = () => { void load(); onStockChanged(); };
  const reversed = new Set(fills.map((f) => f.reverses_fill_id).filter(Boolean));
  const newest = fills[0];
  const undoable = newest && !newest.reverses_fill_id && !reversed.has(newest.id) ? newest : null;

  const undo = async (reason: string) => {
    if (!undoFill) return;
    const scope = JSON.stringify([undoFill.id, reason.trim()]);
    setUndoing(true);
    try {
      await reverseToteFill(undoFill.id, reason.trim(), getKeyFor(scope));
      resetKeyFor(scope);
      toast('success', 'Fill undone. Bulk and tote counts are back.');
      setUndoFill(null);
      changed();
    } catch (error) {
      toast('error', sanitizeError(error));
      // The undo may have saved before its answer was lost: reload so the counts and Undo are current.
      if (!isDefinitiveRpcRejection(error)) { setUndoFill(null); changed(); }
    } finally {
      setUndoing(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Tote Fill"
        accent="from Bulk"
        action={(
          <Button size="sm" icon={<PaintBucket className="h-4 w-4" />} onClick={() => setFilling(true)}>
            Fill Tote
          </Button>
        )}
      />
      {loadState === 'loading' ? (
        <p className="text-sm text-secondary" role="status">Loading fills…</p>
      ) : loadState === 'failed' ? (
        <LoadFailedState title="Fills could not be loaded" onRetry={() => { void load(); }} />
      ) : fills.length === 0 ? (
        <p className="text-sm text-secondary">No fills recorded for this tote.</p>
      ) : (
        <ul className="divide-y divide-gray-100 text-sm">
          {fills.map((fill) => (
            <li key={fill.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="text-secondary">{new Date(fill.created_at).toLocaleString('en-US', { timeZone: 'America/Chicago' })}</span>
              {fill.reverses_fill_id ? (
                <span className="text-nav-dark">Undo: {fill.totes} tote{fill.totes === 1 ? '' : 's'} back to {qty(fill.bulk_quantity)} {fill.bulk_unit} Bulk ({fill.reason})</span>
              ) : (
                <span className="text-nav-dark">
                  Filled {fill.totes} tote{fill.totes === 1 ? '' : 's'} from {qty(fill.bulk_quantity)} {fill.bulk_unit} Bulk
                  {reversed.has(fill.id) && <span className="text-secondary"> (undone)</span>}
                </span>
              )}
              {Number(fill.shortfall_quantity) > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                  Short {qty(fill.shortfall_quantity)} {fill.bulk_unit}
                </span>
              )}
              {undoable?.id === fill.id && (
                <Button variant="secondary" size="sm" showChevron={false} icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => setUndoFill(fill)} className="ml-auto">
                  Undo
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {filling && (
        <ToteFillModal
          toteProductId={toteProductId}
          toteName={toteName}
          profileId={profileId}
          onClose={() => setFilling(false)}
          onFilled={changed}
        />
      )}
      <ReasonModal
        open={undoFill !== null}
        onClose={() => setUndoFill(null)}
        onConfirm={(reason) => { void undo(reason); }}
        title="Undo tote fill"
        message="Puts the Bulk back and removes the totes. Only allowed while neither product's stock has moved since this fill; otherwise adjust stock instead."
        confirmLabel="Undo Fill"
        variant="warning"
        icon={Undo2}
        loading={undoing}
        placeholder="e.g. entered the wrong number of totes"
        minLength={3}
      />
    </Card>
  );
}
