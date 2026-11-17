import { normalizeEpaRegistration, type LookupState, type RegistrationRows } from '../../lib/epaRegistrationStatus';
import { LabelAdjuvantLines } from '../products/LabelAdjuvants';

/**
 * What the label of a quote line's product says about adjuvants (USE-2 sheet 3.4). A live reminder:
 * never blocks, never saved, never printed. Reads the product's own EPA number and names it.
 */
export default function QuoteLineAdjuvants({ epaRegistration, rows, lookup }: {
  epaRegistration: string | null | undefined;
  rows: RegistrationRows;
  lookup: LookupState;
}) {
  const number = normalizeEpaRegistration(epaRegistration);
  if (!number) return null;
  if (lookup === 'checking') return <p className="mt-1 text-xs text-secondary">Checking label…</p>;
  if (lookup === 'failed') return <p className="mt-1 text-xs text-amber-700">Couldn&apos;t check the label</p>;
  const list = rows.get(number)?.label_adjuvants ?? null;
  if (list === null) return <p className="mt-1 text-xs text-secondary">Label {number}: adjuvants not reviewed</p>;
  if (list.length === 0) return <p className="mt-1 text-xs text-secondary">Label {number}: no adjuvants on the label</p>;
  return (
    <div className="mt-1 text-xs" role="note" aria-label={`Label ${number} adjuvants`}>
      <p className="font-medium text-secondary">Label {number}:</p>
      <LabelAdjuvantLines list={list} />
    </div>
  );
}
