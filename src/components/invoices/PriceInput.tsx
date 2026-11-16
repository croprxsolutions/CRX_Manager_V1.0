import { useId } from 'react';
import { parseDollarsToCentsSigned } from '../../lib/parseCents';
import { priceProblem } from '../../lib/priceProblem';

/**
 * A price box you can type into freely (the repo's draft-text pattern, as on purchase orders). The typed text is the
 * line's `draft` (kept on the line by the page, so it goes where the line goes and Save can read it); a usable amount
 * goes to the line at once; anything else shows a short note and the line keeps its last good amount, so nothing
 * wrong is ever stored. Leaving the box tidies a usable amount to two decimals. The box always keeps one fixed helper
 * line under it (DESIGN.md, Inputs), so a note never moves the page.
 */
export default function PriceInput({ cents, draft, label, onCents, onDraft, className = '', testProps }: {
  cents: number;
  draft: string | null | undefined;
  label: string;
  onCents: (cents: number) => void;
  onDraft: (text: string | null) => void;
  className?: string;
  testProps?: Record<string, string | number>;
}) {
  const id = useId();
  const problem = draft == null ? null : priceProblem(draft);

  return (
    <span className="flex min-w-0 flex-col gap-1 xl:w-fit">
      <input
        {...testProps}
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        value={draft ?? (cents / 100).toFixed(2)}
        onChange={(e) => {
          const next = e.target.value;
          onDraft(next);
          if (!priceProblem(next)) onCents(parseDollarsToCentsSigned(next.trim()) ?? 0);
        }}
        onBlur={() => { if (!problem) onDraft(null); }}
        // Swap the border colour instead of stacking a second one: CSS order, not class order, would pick the winner.
        className={`${problem ? className.replace('border-gray-200', 'border-red-500').replace('focus:ring-crx-green/20 focus:border-crx-green', 'focus:ring-red-500/20 focus:border-red-500') : className} text-right tabular-nums`}
      />
      <span id={`${id}-problem`} aria-live="polite" className="min-h-5 whitespace-nowrap text-right text-xs font-medium text-red-600">{problem}</span>
    </span>
  );
}
