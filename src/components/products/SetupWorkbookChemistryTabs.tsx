import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatestRef } from '../../hooks/useLatestRef';
import { ChemistrySaveUncertain, chemistryAuthorizationMessage, finishChemistrySave, isChemistryAuthorizationRefusal, pendingSaves, startChemistrySave, type PendingChemistrySave } from '../../lib/productChemistry';
import {
  isSetupChemistryRetryExpired, loadOpenChemistryProposals, previewSetupIngredients, previewSetupWeights,
  SETUP_WORKBOOK_CHEMISTRY_SCOPE, weightRowsToRpcRows, type ChemistryProposalView, type IngredientPreview, type WeightPreview,
} from '../../lib/productSetupChemistry';
import type { ParsedChemistryWorkbook } from '../../lib/productSetupChemistryWorkbook';
import type { IngredientWorkbookRow, WeightWorkbookRow } from '../../lib/productSetupChemistryWorkbook';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { useToast } from '../ui/Toast';
import { rewriteIngredientRenameAdvice } from './SetupWorkbookChemistryPreview';
import SetupWorkbookChemistryTabsView, { type PromoteRequest } from './SetupWorkbookChemistryTabsView';

interface PreviewState {
  weights: WeightPreview | null; ingredients: IngredientPreview | null;
  weightError: string | null; ingredientError: string | null;
  weightLoading: boolean; ingredientLoading: boolean;
}
const QUEUE_CHANGE_EVENT = 'crx:setup-workbook-chemistry-pending-change';

function notifyPendingQueueChange(userId: string): void {
  window.dispatchEvent(new CustomEvent(QUEUE_CHANGE_EVENT, { detail: { userId, scope: SETUP_WORKBOOK_CHEMISTRY_SCOPE } }));
}

function useSetupChemistryPending(profileId: string): [PendingChemistrySave[], () => void] {
  const [pending, setPending] = useState<PendingChemistrySave[]>([]);
  const refreshPending = useCallback(() => setPending(pendingSaves(profileId, SETUP_WORKBOOK_CHEMISTRY_SCOPE)), [profileId]);
  useEffect(() => {
    refreshPending();
    const onStorage = () => refreshPending();
    const onQueueChange = (event: Event) => {
      const detail = (event as CustomEvent<{ scope: string; userId: string }>).detail;
      if (detail?.scope === SETUP_WORKBOOK_CHEMISTRY_SCOPE && detail.userId === profileId) refreshPending();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(QUEUE_CHANGE_EVENT, onQueueChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(QUEUE_CHANGE_EVENT, onQueueChange);
    };
  }, [profileId, refreshPending]);
  return [pending, refreshPending];
}

function useBusyReporter(busy: boolean, busyOwnerKey?: string, onBusyChange?: (ownerKey: string, busy: boolean) => void): void {
  useEffect(() => {
    if (busyOwnerKey && onBusyChange) onBusyChange(busyOwnerKey, busy);
  }, [busy, busyOwnerKey, onBusyChange]);
  useEffect(() => {
    if (!busyOwnerKey || !onBusyChange) return undefined;
    return () => onBusyChange(busyOwnerKey, false);
  }, [busyOwnerKey, onBusyChange]);
}

function useOpenProposalState(currentRequest: (sequence: number) => boolean) {
  const [proposals, setProposals] = useState<ChemistryProposalView[]>([]);
  const [proposalLoadError, setProposalLoadError] = useState<string | null>(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const proposalReadSequence = useRef(0);
  const refreshProposals = useCallback(async (sequence: number) => {
    const read = ++proposalReadSequence.current;
    setProposalLoading(true);
    try {
      const rows = await loadOpenChemistryProposals();
      if (currentRequest(sequence) && read === proposalReadSequence.current) { setProposals(rows); setProposalLoadError(null); }
    } catch (error) {
      if (currentRequest(sequence) && read === proposalReadSequence.current) setProposalLoadError(sanitizeError(error));
    } finally {
      if (currentRequest(sequence) && read === proposalReadSequence.current) setProposalLoading(false);
    }
  }, [currentRequest]);
  const resetProposals = useCallback(() => {
    setProposals([]);
    setProposalLoadError(null);
    setProposalLoading(false);
  }, []);
  return { proposals, proposalLoadError, proposalLoading, refreshProposals, resetProposals };
}

function chemistryTabState(input: {
  pendingCount: number; busy: boolean; parentBusy: boolean; open: boolean; previews: PreviewState; proposals: ChemistryProposalView[];
  parsed: ParsedChemistryWorkbook | null; proposalLoadError: string | null; proposalLoading: boolean;
}) {
  const weightRows = input.previews.weights?.rows ?? [];
  const ingredientParents = input.previews.ingredients?.parents ?? [];
  const weightProblems = weightRows.filter((row) => row.status !== 'change' && row.status !== 'unchanged');
  const ingredientProblems = ingredientParents.filter((row) => row.status !== 'proposal' && row.status !== 'unchanged');
  const openParentCounts = new Map<string, number>();
  input.proposals.forEach(({ parent_id }) => openParentCounts.set(parent_id, (openParentCounts.get(parent_id) ?? 0) + 1));
  const noCasIssue = input.parsed?.ingredientRows.some((row) => !row.row_id && !row.cas) ?? false;
  const canSaveIngredients = ingredientParents.some((row) => row.status === 'proposal') && ingredientProblems.length === 0
    && input.proposalLoadError === null && !input.proposalLoading && !input.previews.ingredientLoading
    && input.previews.ingredients !== null && input.previews.ingredientError === null;
  return { blocked: input.pendingCount > 0 || input.busy || input.parentBusy || !input.open, weightRows, ingredientParents, weightProblems,
    ingredientProblems, openParentCounts, noCasIssue, canSaveIngredients };
}

function rowsForTab(kind: 'weights' | 'ingredients', parsed: ParsedChemistryWorkbook | null,
  weightRows: WeightPreview['rows'], ingredientParents: IngredientPreview['parents']): WeightWorkbookRow[] | IngredientWorkbookRow[] {
  if (kind === 'weights') return weightRows.filter((row) => row.status === 'change')
    .map((row) => parsed?.weightRows.find((item) => item.subject_id === row.subject_id && item.kind === row.kind))
    .filter((row): row is WeightWorkbookRow => row !== undefined);
  return parsed?.ingredientRows.filter((row) => ingredientParents.some((parent) => parent.parent_id === row.parent_id && parent.status === 'proposal')) ?? [];
}

function sendTabSave(profileId: string, kind: 'weights' | 'ingredients', rows: WeightWorkbookRow[] | IngredientWorkbookRow[]) {
  if (kind === 'weights') {
    const weightRows = rows.filter((row): row is WeightWorkbookRow => 'kind' in row);
    return startChemistrySave(profileId, SETUP_WORKBOOK_CHEMISTRY_SCOPE, 'commit_weights_tab',
      { p_rows: weightRowsToRpcRows(weightRows) }, 'Save Weights tab');
  }
  const ingredientRows = rows.filter((row): row is IngredientWorkbookRow => 'parent_id' in row);
  return startChemistrySave(profileId, SETUP_WORKBOOK_CHEMISTRY_SCOPE, 'commit_ingredients_tab',
    { p_rows: ingredientRows }, 'Save Ingredients tab');
}

function isDefinitiveWorkbookTabRefusal(kind: 'weights' | 'ingredients', error: unknown): boolean {
  if (kind === 'weights' && hasRpcCode(error, RpcErrorCodes.WORKBOOK_WEIGHTS_REFUSED)) return true;
  if (kind === 'ingredients' && hasRpcCode(error, RpcErrorCodes.WORKBOOK_INGREDIENTS_REFUSED)) return true;
  return hasRpcCode(error, RpcErrorCodes.WORKBOOK_NOTHING_TO_SAVE);
}

function invalidateTabPreview(current: PreviewState, kind: 'weights' | 'ingredients', message: string): PreviewState {
  return kind === 'weights'
    ? { ...current, weights: null, weightError: message }
    : { ...current, ingredients: null, ingredientError: message };
}

function tabSaveFailureMessage(kind: 'weights' | 'ingredients', error: unknown): string {
  if (error instanceof ChemistrySaveUncertain) return error.authorizationRefusal
    ? error.message : 'We could not confirm this tab save. Use Finish save above to retry the exact request.';
  if (isChemistryAuthorizationRefusal(error)) return chemistryAuthorizationMessage(false);
  const message = sanitizeError(error);
  return kind === 'ingredients' ? rewriteIngredientRenameAdvice(message) : message;
}

async function showFinishFailure(input: {
  record: PendingChemistrySave; error: unknown; parsed: ParsedChemistryWorkbook | null;
  weightRows: WeightPreview['rows']; ingredientParents: IngredientPreview['parents'];
  setPreviews: (update: (current: PreviewState) => PreviewState) => void;
  setWriteErrors: (update: (current: { weights: string | null; ingredients: string | null }) => { weights: string | null; ingredients: string | null }) => void;
  toast: (type: 'error' | 'success' | 'warning', message: string) => void;
  refreshProposals: () => Promise<void>;
}): Promise<void> {
  const { record, error, parsed, weightRows, ingredientParents, setPreviews, setWriteErrors, toast, refreshProposals } = input;
  if (error instanceof ChemistrySaveUncertain) {
    toast('error', error.authorizationRefusal ? error.message : 'The workbook save is still unconfirmed. Finish save keeps the same request.');
    return;
  }
  const matchingTab = matchingPendingTab(record, parsed, weightRows, ingredientParents);
  const refused = matchingTab !== null && isDefinitiveWorkbookTabRefusal(matchingTab, error);
  const rawMessage = sanitizeError(error);
  const message = record.rpc === 'commit_ingredients_tab' ? rewriteIngredientRenameAdvice(rawMessage) : rawMessage;
  if (matchingTab && refused) {
    setPreviews((current) => invalidateTabPreview(current, matchingTab, message));
    setWriteErrors((current) => ({ ...current, [matchingTab]: message }));
  }
  toast('error', isChemistryAuthorizationRefusal(error) ? chemistryAuthorizationMessage(false) : message);
  if (record.rpc === 'promote_chemistry_proposal' && !isChemistryAuthorizationRefusal(error)) await refreshProposals();
}

function matchingPendingTab(record: PendingChemistrySave, parsed: ParsedChemistryWorkbook | null,
  weightRows: WeightPreview['rows'], ingredientParents: IngredientPreview['parents']): 'weights' | 'ingredients' | null {
  if (!parsed) return null;
  const matches = (rpc: PendingChemistrySave['rpc'], rows: unknown[]) => record.rpc === rpc
    && JSON.stringify(record.args) === JSON.stringify({ p_rows: rows });
  if (record.rpc === 'commit_weights_tab') {
    const rows = rowsForTab('weights', parsed, weightRows, ingredientParents)
      .filter((row): row is WeightWorkbookRow => 'kind' in row);
    return matches('commit_weights_tab', weightRowsToRpcRows(rows)) ? 'weights' : null;
  }
  if (record.rpc === 'commit_ingredients_tab') {
    const rows = rowsForTab('ingredients', parsed, weightRows, ingredientParents)
      .filter((row): row is IngredientWorkbookRow => 'parent_id' in row);
    return matches('commit_ingredients_tab', rows) ? 'ingredients' : null;
  }
  return null;
}

export default function SetupWorkbookChemistryTabs({
  open, profileId, fileGeneration, parsed, onSaved, parentBusy = false, busyOwnerKey, onBusyChange,
}: {
  open: boolean; profileId: string; fileGeneration: number; parsed: ParsedChemistryWorkbook | null; onSaved: () => void;
  parentBusy?: boolean;
  busyOwnerKey?: string; onBusyChange?: (ownerKey: string, busy: boolean) => void;
}) {
  const { toast } = useToast();
  const [previews, setPreviews] = useState<PreviewState>({
    weights: null, ingredients: null, weightError: null, ingredientError: null, weightLoading: false, ingredientLoading: false,
  });
  const [pending, refreshPending] = useSetupChemistryPending(profileId);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<PromoteRequest | null>(null);
  const [completedTabs, setCompletedTabs] = useState<{ weights: boolean; ingredients: boolean }>({ weights: false, ingredients: false });
  const [writeErrors, setWriteErrors] = useState<{ weights: string | null; ingredients: string | null }>({ weights: null, ingredients: null });
  const [staleKeys, setStaleKeys] = useState<Set<string>>(new Set());
  const requestSequence = useRef(0);
  const operationSequence = useRef(0);
  const sendLock = useRef<number | null>(null);
  const session = useLatestRef({ open, profileId, fileGeneration });

  useBusyReporter(busy, busyOwnerKey, onBusyChange);

  const currentRequest = useCallback((sequence: number) => sequence === requestSequence.current && session.current.open
    && session.current.profileId === profileId && session.current.fileGeneration === fileGeneration, [fileGeneration, profileId, session]);
  const { proposals, proposalLoadError, proposalLoading, refreshProposals, resetProposals } = useOpenProposalState(currentRequest);

  const loadPreview = useCallback(async (kind: 'weights' | 'ingredients', sequence: number) => {
    setPreviews((current) => kind === 'weights'
      ? { ...current, weights: null, weightLoading: true, weightError: null }
      : { ...current, ingredients: null, ingredientLoading: true, ingredientError: null });
    try {
      if (kind === 'weights') {
        const result = parsed?.weightRows.length ? await previewSetupWeights(parsed.weightRows) : { rows: [] };
        if (currentRequest(sequence)) setPreviews((current) => ({ ...current, weights: result }));
      } else {
        const result = parsed?.ingredientRows.length ? await previewSetupIngredients(parsed.ingredientRows) : { parents: [] };
        if (currentRequest(sequence)) setPreviews((current) => ({ ...current, ingredients: result }));
      }
    } catch (error) {
      if (currentRequest(sequence)) setPreviews((current) => kind === 'weights'
        ? { ...current, weightError: sanitizeError(error) }
        : { ...current, ingredientError: sanitizeError(error) });
    } finally {
      if (currentRequest(sequence)) setPreviews((current) => kind === 'weights'
        ? { ...current, weightLoading: false }
        : { ...current, ingredientLoading: false });
    }
  }, [currentRequest, parsed]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    operationSequence.current += 1;
    sendLock.current = null;
    setBusy(false);
    setPreviews({ weights: null, ingredients: null, weightError: null, ingredientError: null, weightLoading: false, ingredientLoading: false });
    resetProposals();
    setConfirming(null);
    setCompletedTabs({ weights: false, ingredients: false });
    setWriteErrors({ weights: null, ingredients: null });
    setStaleKeys(new Set());
    if (!open) return () => { requestSequence.current += 1; };
    void refreshProposals(sequence);
    if (parsed) {
      void loadPreview('weights', sequence);
      void loadPreview('ingredients', sequence);
    }
    return () => {
      requestSequence.current += 1;
      operationSequence.current += 1;
      sendLock.current = null;
    };
  }, [fileGeneration, loadPreview, open, parsed, profileId, refreshPending, refreshProposals, resetProposals]);

  const latestPending = () => pendingSaves(session.current.profileId, SETUP_WORKBOOK_CHEMISTRY_SCOPE);
  const { blocked, weightRows, ingredientParents, weightProblems, openParentCounts, noCasIssue, canSaveIngredients } = chemistryTabState({
    pendingCount: pending.length, busy, parentBusy, open, previews, proposals, parsed, proposalLoadError, proposalLoading,
  });

  const save = async (kind: 'weights' | 'ingredients') => {
    if (blocked || sendLock.current !== null || (kind === 'ingredients' && !canSaveIngredients)
        || (kind === 'weights' && (!previews.weights || previews.weightError || weightProblems.length > 0))) return;
    if (latestPending().length > 0) { refreshPending(); return; }
    const sequence = requestSequence.current;
    if (!currentRequest(sequence)) return;
    const rows = rowsForTab(kind, parsed, weightRows, ingredientParents);
    if (rows.length === 0) return;
    const operation = ++operationSequence.current;
    sendLock.current = operation;
    setBusy(true);
    setWriteErrors((current) => ({ ...current, [kind]: null }));
    try {
      await sendTabSave(profileId, kind, rows);
      if (!currentRequest(sequence)) return;
      setCompletedTabs((current) => ({ ...current, [kind]: true }));
      refreshPending();
      onSaved();
      await refreshProposals(sequence);
      if (!currentRequest(sequence)) return;
      toast('success', kind === 'weights' ? 'Weight drafts saved.' : 'Ingredient proposals saved.');
    } catch (error) {
      refreshPending();
      if (currentRequest(sequence)) {
        const workbookRefused = isDefinitiveWorkbookTabRefusal(kind, error);
        const message = tabSaveFailureMessage(kind, error);
        setWriteErrors((current) => ({ ...current, [kind]: message }));
        if (workbookRefused) setPreviews((current) => invalidateTabPreview(current, kind, message));
        toast('error', message);
      }
    } finally {
      notifyPendingQueueChange(profileId);
      if (sendLock.current === operation) { sendLock.current = null; setBusy(false); }
    }
  };

  const retryPreview = (kind: 'weights' | 'ingredients') => { void loadPreview(kind, requestSequence.current); };

  const finish = async (record: PendingChemistrySave) => {
    if (sendLock.current !== null || busy || parentBusy) return;
    if (isSetupChemistryRetryExpired(record.createdAt)) {
      setStaleKeys((keys) => new Set(keys).add(record.key));
      return;
    }
    const sequence = requestSequence.current;
    if (!currentRequest(sequence) || record.userId !== session.current.profileId
        || !pendingSaves(session.current.profileId, SETUP_WORKBOOK_CHEMISTRY_SCOPE).some((item) => item.key === record.key)) return;
    const operation = ++operationSequence.current;
    sendLock.current = operation;
    setBusy(true);
    try {
      await finishChemistrySave(record);
      if (!currentRequest(sequence)) return;
      const completedTab = matchingPendingTab(record, parsed, weightRows, ingredientParents);
      if (completedTab) {
        setCompletedTabs((current) => ({ ...current, [completedTab]: true }));
        setWriteErrors((current) => ({ ...current, [completedTab]: null }));
      }
      refreshPending();
      onSaved();
      await refreshProposals(sequence);
      if (!currentRequest(sequence)) return;
      toast('success', 'The pending workbook save finished.');
    } catch (error) {
      if (!currentRequest(sequence)) return;
      refreshPending();
      await showFinishFailure({ record, error, parsed, weightRows, ingredientParents, setPreviews, setWriteErrors, toast,
        refreshProposals: () => refreshProposals(sequence) });
    } finally {
      notifyPendingQueueChange(record.userId);
      if (sendLock.current === operation) { sendLock.current = null; setBusy(false); }
    }
  };

  const decide = async (request: PromoteRequest) => {
    if (blocked || sendLock.current !== null || request.record.unresolved) return;
    if (latestPending().length > 0) { refreshPending(); return; }
    const sequence = requestSequence.current;
    if (!currentRequest(sequence)) return;
    const operation = ++operationSequence.current;
    sendLock.current = operation;
    setBusy(true);
    try {
      await startChemistrySave(profileId, SETUP_WORKBOOK_CHEMISTRY_SCOPE, 'promote_chemistry_proposal', {
        p_proposal_id: request.record.id, p_expected_proposal_version: request.record.proposal_version, p_decision: request.decision,
      }, `${request.decision === 'reject' ? 'Reject' : 'Apply'} proposal for ${request.record.parent_name ?? 'product'}`);
      if (!currentRequest(sequence)) return;
      setConfirming(null);
      refreshPending();
      onSaved();
      await refreshProposals(sequence);
    } catch (error) {
      if (!currentRequest(sequence)) return;
      setConfirming(null);
      refreshPending();
      if (error instanceof ChemistrySaveUncertain) toast('error', error.authorizationRefusal
        ? error.message : 'We could not confirm the proposal decision. Use Finish save above to retry it.');
      else {
        toast('error', isChemistryAuthorizationRefusal(error) ? chemistryAuthorizationMessage(false) : sanitizeError(error));
        await refreshProposals(sequence);
      }
    } finally {
      notifyPendingQueueChange(profileId);
      if (sendLock.current === operation) { sendLock.current = null; setBusy(false); }
    }
  };

  const applyProposal = (record: ChemistryProposalView) => { void decide({ record, decision: 'apply' }); };
  const rejectProposal = (record: ChemistryProposalView) => { void decide({ record, decision: 'reject' }); };
  const requestApplyDelete = (record: ChemistryProposalView) => { setConfirming({ record, decision: 'apply_delete' }); };

  return <SetupWorkbookChemistryTabsView parsed={parsed} pending={pending} busy={busy} confirming={confirming}
    staleKeys={staleKeys} completedTabs={completedTabs} writeErrors={writeErrors} previews={previews}
    proposals={proposals} proposalLoadError={proposalLoadError} proposalLoading={proposalLoading} parentBusy={parentBusy} openParentCounts={openParentCounts}
    noCasIssue={noCasIssue} canSaveIngredients={canSaveIngredients} blocked={blocked}
    onFinish={(record) => { void finish(record); }} onApply={applyProposal} onReject={rejectProposal} onApplyDelete={requestApplyDelete}
    onCloseConfirm={() => setConfirming(null)} onConfirm={(request) => { void decide(request); }}
    onRetryWeights={() => retryPreview('weights')} onRetryIngredients={() => retryPreview('ingredients')}
    onRetryProposals={() => { void refreshProposals(requestSequence.current); }}
    onSaveWeights={() => { void save('weights'); }} onSaveIngredients={() => { void save('ingredients'); }} />;
}

