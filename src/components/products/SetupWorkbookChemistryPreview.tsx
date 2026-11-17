/* eslint-disable react-refresh/only-export-components -- the shared refusal formatter belongs with this preview copy. */
import Button from '../ui/Button';
import type { IngredientWorkbookRow, ParsedChemistryWorkbook } from '../../lib/productSetupChemistryWorkbook';
import type { IngredientPreviewParent, WeightPreviewRow } from '../../lib/productSetupChemistry';

export function rewriteIngredientRenameAdvice(problem: string): string {
  return problem.split('cannot be renamed here; mark the row __delete and add the new ingredient as a new row')
    .join('does not match the current shared ingredient identity. Download a fresh workbook and review it');
}

function ingredientParentProblem(problem: string | null | undefined): string {
  return problem ? rewriteIngredientRenameAdvice(problem) : 'could not preview this parent';
}

export default function SetupWorkbookChemistryPreview({
  parsed, weights, weightProblems, ingredientParents, proposalLoadError, noCasIssue,
  hasOpenProposal, canSaveIngredients, busy, blocked, showWeights, showIngredients,
  weightError, ingredientError, weightLoading, ingredientLoading, weightWriteError, ingredientWriteError,
  onRetryWeights, onRetryIngredients, onSaveWeights, onSaveIngredients,
}: {
  parsed: ParsedChemistryWorkbook;
  weights: WeightPreviewRow[];
  weightProblems: WeightPreviewRow[];
  ingredientParents: IngredientPreviewParent[];
  proposalLoadError: string | null;
  noCasIssue: boolean;
  hasOpenProposal: boolean;
  canSaveIngredients: boolean;
  busy: boolean;
  blocked: boolean;
  showWeights: boolean;
  showIngredients: boolean;
  weightError: string | null;
  ingredientError: string | null;
  weightLoading: boolean;
  ingredientLoading: boolean;
  weightWriteError: string | null;
  ingredientWriteError: string | null;
  onRetryWeights: () => void;
  onRetryIngredients: () => void;
  onSaveWeights: () => void;
  onSaveIngredients: () => void;
}) {
  const weightChanges = weights.filter((row) => row.status === 'change').length;
  const ingredientChanges = ingredientParents.filter((parent) => parent.status === 'proposal').length;
  return <>
    {showWeights && <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Weights tab preview">
      <h3 className="font-semibold text-nav-dark">Weights tab: {weightChanges} changes</h3>
      {weights.filter((row) => row.status === 'change' || row.status === 'unchanged').map((row) => {
        const input = parsed.weightRows.find((item) => item.subject_id === row.subject_id && item.kind === row.kind);
        return <div key={`${row.kind}:${row.subject_id}`} className="text-nav-dark">
          <p>{row.name}: {weightValueText(row.before, row.kind)} → {weightValueText(row.after, row.kind)} {row.status === 'change' ? '(draft)' : row.problem ?? row.status}</p>
          {input && <p className="text-secondary">New reason: {input.reason || 'not provided'} · Evidence: {input.evidence || 'not provided'}</p>}
        </div>;
      })}
      {weightProblems.map((row) => <p key={`problem:${row.kind}:${row.subject_id}`} className="text-red-700">{row.name}: {row.problem ?? row.status}</p>)}
      {parsed.weightRows.length === 0 && <p className="text-secondary">No weight edits in this file.</p>}
      {weightError && <p className="text-red-700">Weights preview needs attention: {weightError}</p>}
      {weightWriteError && <p className="text-red-700">Weights save: {weightWriteError}</p>}
      {weightError && <Button variant="secondary" disabled={busy} onClick={onRetryWeights} loading={weightLoading}>Retry Weights preview</Button>}
      <Button onClick={onSaveWeights} loading={busy} disabled={blocked || weightLoading || weightError !== null || weightChanges === 0 || weightProblems.length > 0}>Confirm Weights tab</Button>
    </section>}
    {showIngredients && <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Ingredients tab preview">
      <h3 className="font-semibold text-nav-dark">Ingredients tab: {ingredientChanges} parent proposals</h3>
      {ingredientParents.map((parent) => <p key={parent.parent_id} className={parent.status === 'proposal' ? 'text-nav-dark' : 'text-red-700'}>
        {parent.parent_name ?? parent.parent_id}: {parent.status === 'proposal' ? `${parent.items?.length ?? 0} changes` : ingredientParentProblem(parent.problem ?? parent.status)}
      </p>)}
      {proposalLoadError && <p className="text-red-700">Open proposals could not be checked: {proposalLoadError}. Retry proposals before saving ingredients.</p>}
      {noCasIssue && <p className="text-amber-800">Applying a new ingredient without a CAS creates a provisional shared ingredient, even if a similar name already exists. Check its name and source before confirming.</p>}
      {hasOpenProposal && <p className="text-amber-800">One or more parents already have an open proposal. Saving adds a separate proposal; the older one remains open.</p>}
      {parsed.ingredientRows.map((row, index) => <p key={`${row.parent_id}:${row.row_id ?? `new-${index}`}`} className="text-secondary">
        {ingredientParents.find((parent) => parent.parent_id === row.parent_id)?.parent_name ?? row.parent_id} · {ingredientActionText(row)}: {row.name || 'unnamed ingredient'}{row.cas ? ` (CAS ${row.cas})` : ' (CAS unknown)'} · {row.strength_value == null ? 'strength unknown' : `${row.strength_value} ${row.strength_unit ?? ''} ${row.strength_basis ?? ''}`}
        {row.source_note && ` · ${row.source ?? 'Source'}: ${row.source_note}`}
      </p>)}
      {parsed.ingredientRows.length === 0 && <p className="text-secondary">No ingredient edits in this file.</p>}
      {ingredientError && <p className="text-red-700">Ingredients preview needs attention: {ingredientError}</p>}
      {ingredientWriteError && <p className="text-red-700">Ingredients save: {ingredientWriteError}</p>}
      {ingredientError && <Button variant="secondary" disabled={busy} onClick={onRetryIngredients} loading={ingredientLoading}>Retry Ingredients preview</Button>}
      <Button onClick={onSaveIngredients} loading={busy} disabled={blocked || !canSaveIngredients}>
        Confirm Ingredients tab
      </Button>
    </section>}
  </>;
}

function weightValueText(value: WeightPreviewRow['before'] | undefined, kind: 'density' | 'net_weight'): string {
  if (!value) return 'blank';
  return `${value.value} ${kind === 'density' ? 'lb/gal' : 'lb'} · ${value.source}${value.source_note ? `: ${value.source_note}` : ''}`;
}

function ingredientActionText(row: IngredientWorkbookRow): string {
  return row.delete ? 'Remove' : row.row_id ? 'Change' : 'Add';
}
