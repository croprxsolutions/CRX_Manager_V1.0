import type { CommissionSplit } from '../../types';

/** Where a new quote's commission split came from (plan 2026-11-18, simplified 19 Nov: Taha option A). */
export type SplitNote =
  | { kind: 'from'; customer: string; split: CommissionSplit }
  | { kind: 'none'; customer: string }
  | null;

function noteText(note: NonNullable<SplitNote>): string {
  if (note.kind === 'none') return `${note.customer} has no split. Pick one.`;
  return note.split.splits.length ? `From ${note.customer}'s split.` : `From ${note.customer}'s split: no commission.`;
}

/** The helper line under the commission split (DESIGN.md Inputs). A long farm name wraps rather than hides (Sol LOW). */
export default function QuoteSplitNote({ note }: { note: SplitNote }) {
  return (
    <p aria-live="polite" className="mt-1 min-h-5 break-words text-xs text-secondary">
      {note && <span className="break-words">{noteText(note)}</span>}
    </p>
  );
}
