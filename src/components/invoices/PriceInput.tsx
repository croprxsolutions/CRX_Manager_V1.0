import { useEffect, useId, useState } from 'react';
import { parseDollarsToCentsSigned } from '../../lib/parseCents';
import { priceProblem } from '../../lib/priceProblem';

/**
 * A price box you can type into freely (the repo's draft-text pattern, as on purchase orders). The typed text stays in
 * the box; a usable amount goes to the line at once; anything else shows a message under the box and the line keeps
 * its last good amount, so nothing wrong is ever stored. Leaving the box tidies a usable amount to two decimals.
 * The box always keeps one fixed helper line under it (DESIGN.md, Inputs), so a message never moves the page.
 * `onProblem` tells the page which boxes hold a bad price, so Save can refuse until they are fixed.
 */
export default function PriceInput({ cents, label, onCents, onProblem, className = '', testProps }: {
  cents: number;
  label: string;
  onCents: (cents: number) => void;
  onProblem: (id: string, problem: { label: string; message: string } | null) => void;
  className?: string;
  testProps?: Record<string, string | number>;
}) {
  const id = useId();
  // The typed text, tied to the line it was typed for (its price and label then). Rows are keyed by position, so after
  // a row is removed or another invoice opens this box can show a different line: then the old text is dropped.
  const [draft, setDraft] = useState<{ text: string; cents: number; label: string } | null>(null);
  const stale = draft !== null && (draft.cents !== cents || draft.label !== label);
  if (stale) setDraft(null);
  const text = stale ? null : draft?.text ?? null;
  const problem = text === null ? null : priceProblem(text);

  useEffect(() => {
    onProblem(id, problem ? { label, message: problem } : null);
  }, [id, label, problem, onProblem]);
  useEffect(() => () => onProblem(id, null), [id, onProblem]);

  return (
    <span className="flex min-w-0 flex-col gap-1 xl:w-fit">
      <input
        {...testProps}
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        value={text ?? (cents / 100).toFixed(2)}
        onChange={(e) => {
          const next = e.target.value;
          // A usable amount goes to the line at once; a bad one leaves the line at its last good price.
          const nextCents = priceProblem(next) ? cents : parseDollarsToCentsSigned(next.trim()) ?? 0;
          setDraft({ text: next, cents: nextCents, label });
          if (nextCents !== cents) onCents(nextCents);
        }}
        onBlur={() => { if (!problem) setDraft(null); }}
        // Swap the border colour instead of stacking a second one: CSS order, not class order, would pick the winner.
        className={`${problem ? className.replace('border-gray-200', 'border-red-500').replace('focus:ring-crx-green/20 focus:border-crx-green', 'focus:ring-red-500/20 focus:border-red-500') : className} text-right tabular-nums`}
      />
      <span id={`${id}-problem`} aria-live="polite" className="min-h-5 whitespace-nowrap text-right text-xs font-medium text-red-600">{problem}</span>
    </span>
  );
}
