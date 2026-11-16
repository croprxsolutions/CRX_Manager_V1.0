import { useEffect, useId, useState } from 'react';
import { parseDollarsToCentsSigned } from '../../lib/parseCents';
import { priceProblem } from '../../lib/priceProblem';

/**
 * A price box you can type into freely (the repo's draft-text pattern, as on purchase orders). The typed text stays in
 * the box; a usable amount goes to the line at once; anything else shows a message under the box and the line keeps
 * its last good amount, so nothing wrong is ever stored. Leaving the box tidies a usable amount to two decimals.
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
  const [text, setText] = useState<string | null>(null);
  const problem = text === null ? null : priceProblem(text);

  useEffect(() => {
    onProblem(id, problem ? { label, message: problem } : null);
  }, [id, label, problem, onProblem]);
  useEffect(() => () => onProblem(id, null), [id, onProblem]);

  return (
    <span className="flex min-w-0 flex-col gap-1">
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
          setText(next);
          if (!priceProblem(next)) onCents(parseDollarsToCentsSigned(next.trim()) ?? 0);
        }}
        onBlur={() => { if (!problem) setText(null); }}
        className={`${className} text-right tabular-nums${problem ? ' border-red-600 focus:border-red-600 focus:ring-red-600/20' : ''}`}
      />
      {problem && <span id={`${id}-problem`} className="text-xs text-red-700">{problem}</span>}
    </span>
  );
}
