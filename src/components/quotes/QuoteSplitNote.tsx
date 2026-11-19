import type { CommissionSplit } from '../../types';
import { describeSplit } from '../../lib/commissionSplitSource';

/** Where the quote's commission split came from, or a choice to take the customer's (plan 2026-11-18). */
export type SplitNote =
  | { kind: 'from'; customer: string; split: CommissionSplit }
  | { kind: 'none'; customer: string }
  | { kind: 'kept'; customer: string }
  | { kind: 'offer'; customer: string; split: CommissionSplit }
  | null;

const LINK = 'shrink-0 font-medium text-crx-green hover:underline focus-visible:underline focus-visible:outline-none disabled:text-gray-400 disabled:no-underline';

function noteText(note: NonNullable<SplitNote>): string {
  if (note.kind === 'none') return `${note.customer} has no split. Pick one.`;
  if (note.kind === 'kept') return `${note.customer} has no split. Yours is kept.`;
  if (note.kind === 'from') return note.split.splits.length ? `From ${note.customer}'s split.` : `From ${note.customer}'s split: no commission.`;
  return `Use ${note.customer}'s split (${describeSplit(note.split)})?`;
}

/**
 * The one fixed helper line under the commission split (DESIGN.md Inputs): one line tall, so nothing below it moves,
 * and a long note is cut with an ellipsis (full text on hover). An offer is the exception: the split must be
 * readable before Use it on touch and keyboard too, so it wraps, long names included (Sol MED, Taha option a, 19 Nov).
 */
export default function QuoteSplitNote({ note, onUse, onKeep, disabled }: { note: SplitNote; onUse: () => void; onKeep: () => void; disabled?: boolean }) {
  const text = note ? noteText(note) : '';
  const offer = note?.kind === 'offer';
  return (
    <p aria-live="polite" className={`mt-1 flex min-w-0 items-center gap-x-2 text-xs text-secondary ${offer ? 'min-h-5 flex-wrap' : 'h-5'}`}>
      {note && <span className={`min-w-0 ${offer ? 'break-words text-nav-dark' : 'truncate'}`} title={text}>{text}</span>}
      {note?.kind === 'offer' && (
        <>
          {/* Locked with the split itself (saving, converting, read-only), so a save can't miss the choice (Luna). */}
          <button type="button" className={LINK} onClick={onUse} disabled={disabled}>Use it</button>
          <span aria-hidden="true" className="shrink-0 text-gray-400">·</span>
          <button type="button" className={LINK} onClick={onKeep} disabled={disabled}>Keep mine</button>
        </>
      )}
    </p>
  );
}
