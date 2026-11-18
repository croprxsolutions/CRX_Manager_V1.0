import type { CommissionSplit } from '../../types';

/** Where the quote's commission split came from, or a choice to take the customer's (plan 2026-11-18). */
export type SplitNote =
  | { kind: 'from'; customer: string }
  | { kind: 'none'; customer: string }
  | { kind: 'offer'; customer: string; split: CommissionSplit }
  | null;

const LINK = 'font-medium text-crx-green hover:underline focus-visible:underline focus-visible:outline-none';

/** The one fixed helper line under the commission split (DESIGN.md Inputs), so nothing below it moves. */
export default function QuoteSplitNote({ note, onUse, onKeep }: { note: SplitNote; onUse: () => void; onKeep: () => void }) {
  return (
    <p aria-live="polite" className="mt-1 flex min-h-5 flex-wrap items-center gap-x-2 text-xs text-secondary">
      {note?.kind === 'from' && `From ${note.customer}'s split. You can change it for this quote.`}
      {note?.kind === 'none' && `${note.customer} has no commission split. Pick one here.`}
      {note?.kind === 'offer' && (
        <>
          <span className="text-nav-dark">
            {`Use ${note.customer}'s split (${note.split.splits.map((s) => `${s.recipient} ${s.percentage}%`).join(' · ')})?`}
          </span>
          <button type="button" className={LINK} onClick={onUse}>Use it</button>
          <span aria-hidden="true" className="text-gray-400">·</span>
          <button type="button" className={LINK} onClick={onKeep}>Keep mine</button>
        </>
      )}
    </p>
  );
}

