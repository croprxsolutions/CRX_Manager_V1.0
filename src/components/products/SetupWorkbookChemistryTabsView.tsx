import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import type { PendingChemistrySave } from '../../lib/productChemistry';
import { isSetupChemistryRetryExpired, type ChemistryProposalView, type IngredientPreview, type WeightPreview } from '../../lib/productSetupChemistry';
import type { ParsedChemistryWorkbook } from '../../lib/productSetupChemistryWorkbook';
import SetupWorkbookProposalPanel from './SetupWorkbookProposalPanel';
import SetupWorkbookChemistryPreview from './SetupWorkbookChemistryPreview';

export interface PromoteRequest { record: ChemistryProposalView; decision: 'apply' | 'apply_delete' | 'reject' }
export interface SetupWorkbookChemistryTabsViewProps {
  parsed: ParsedChemistryWorkbook | null;
  pending: PendingChemistrySave[];
  busy: boolean;
  confirming: PromoteRequest | null;
  staleKeys: Set<string>;
  completedTabs: { weights: boolean; ingredients: boolean };
  writeErrors: { weights: string | null; ingredients: string | null };
  previews: { weights: WeightPreview | null; ingredients: IngredientPreview | null; weightError: string | null; ingredientError: string | null; weightLoading: boolean; ingredientLoading: boolean };
  proposals: ChemistryProposalView[];
  proposalLoadError: string | null;
  proposalLoading: boolean;
  parentBusy: boolean;
  openParentCounts: Map<string, number>;
  noCasIssue: boolean;
  canSaveIngredients: boolean;
  blocked: boolean;
  onFinish: (record: PendingChemistrySave) => void;
  onApply: (record: ChemistryProposalView) => void;
  onReject: (record: ChemistryProposalView) => void;
  onApplyDelete: (record: ChemistryProposalView) => void;
  onCloseConfirm: () => void;
  onConfirm: (request: PromoteRequest) => void;
  onRetryWeights: () => void;
  onRetryIngredients: () => void;
  onRetryProposals: () => void;
  onSaveWeights: () => void;
  onSaveIngredients: () => void;
}

export default function SetupWorkbookChemistryTabsView(props: SetupWorkbookChemistryTabsViewProps) {
  const { parsed, pending, busy, confirming, staleKeys, completedTabs, writeErrors, previews, proposals, proposalLoadError, proposalLoading, parentBusy,
    openParentCounts, noCasIssue, canSaveIngredients, blocked, onFinish, onApply, onReject, onApplyDelete, onCloseConfirm,
    onConfirm, onRetryWeights, onRetryIngredients, onRetryProposals, onSaveWeights, onSaveIngredients } = props;
  const weightRows = previews.weights?.rows ?? [];
  const ingredientParents = previews.ingredients?.parents ?? [];
  const weightProblems = weightRows.filter((row) => row.status !== 'change' && row.status !== 'unchanged');
  return <div className="space-y-3" data-testid="setup-workbook-chemistry">
    {pending.map((record) => {
      const expired = isSetupChemistryRetryExpired(record.createdAt) || staleKeys.has(record.key);
      return <section key={record.key} className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3" role="alert">
        <p className="font-medium">{expired ? 'This save is too old to retry safely. Check the current drafts/proposals and contact support to reconcile it.'
          : `Finish the ${record.label} you started before starting another workbook chemistry save.`}</p>
        {!expired && <Button size="sm" loading={busy} disabled={busy || parentBusy} onClick={() => onFinish(record)}>Finish save</Button>}
      </section>;
    })}
    {parsed && completedTabs.weights && <p role="status" className="text-green-700">Weight drafts saved. The approved weights did not change.</p>}
    {parsed && completedTabs.ingredients && <p role="status" className="text-green-700">Ingredient proposal saved. It still needs a separate review and Apply decision.</p>}
    {parsed && (!completedTabs.weights || !completedTabs.ingredients) && <SetupWorkbookChemistryPreview parsed={parsed}
      weights={weightRows} weightProblems={weightProblems} ingredientParents={ingredientParents}
      proposalLoadError={proposalLoadError} noCasIssue={noCasIssue}
      hasOpenProposal={parsed.ingredientRows.some((row) => (openParentCounts.get(row.parent_id) ?? 0) > 0)}
      canSaveIngredients={canSaveIngredients} busy={busy} blocked={blocked}
      showWeights={!completedTabs.weights} showIngredients={!completedTabs.ingredients}
      weightError={previews.weightError} ingredientError={previews.ingredientError}
      weightLoading={previews.weightLoading} ingredientLoading={previews.ingredientLoading}
      weightWriteError={writeErrors.weights} ingredientWriteError={writeErrors.ingredients}
      onRetryWeights={onRetryWeights} onRetryIngredients={onRetryIngredients}
      onSaveWeights={onSaveWeights} onSaveIngredients={onSaveIngredients} />}
    <SetupWorkbookProposalPanel proposals={proposals} error={proposalLoadError} loading={proposalLoading} busy={blocked}
      openParentCounts={openParentCounts} onApply={onApply} onReject={onReject} onApplyDelete={onApplyDelete} onRetry={onRetryProposals} />
    <ConfirmModal open={confirming !== null} onClose={onCloseConfirm} loading={busy}
      title="Apply proposal with removal?"
      message={`This will retire an ingredient for ${confirming?.record.parent_name ?? 'this product'} and keep its history. Review every listed change before applying.`}
      confirmLabel="Apply with removal" variant="danger" onConfirm={() => confirming && onConfirm(confirming)} />
  </div>;
}
