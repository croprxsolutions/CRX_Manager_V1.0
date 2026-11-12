import { useCallback, useEffect, useRef, useState } from 'react';
import Card, { CardHeader } from '../ui/Card';
import Button from '../ui/Button';
import { LoadFailedState } from '../ui/EmptyState';
import { Sentry } from '../../lib/sentry';
import { fetchIngredientWorklist, fetchParentChemistry, pendingSaves, plainRefusal, type PendingChemistrySave } from '../../lib/productChemistry';
import IngredientReviewModal from './IngredientReviewModal';
import ChemistryEntryModal from './ChemistryEntryModal';
import ChemistryCorrectionModal from './ChemistryCorrectionModal';
import ChemistryActiveCosts from './ChemistryActiveCosts';
import EpaLookupPanel from './EpaLookupPanel';
import { ChemistryLists, PendingSavesNotice } from './ChemistryParts';
import { errorOf, type ReplacePrefill, type SaveOutcome } from './chemistryFormHelpers';
import type { ParentChemistry } from '../../types';

type FormRequest = { kind: 'entry' } | { kind: 'correct'; parentId: string; prefill: ReplacePrefill | null } | { kind: 'review' };
type OpenForm = (FormRequest & { token: number }) | null;

function ChemistryActions({ chem, parentId, locked, waiting, open }: {
  chem: ParentChemistry; parentId: string; locked: boolean; waiting: number | null; open: (next: FormRequest) => void;
}) {
  const gated = chem.epa_refusal != null;
  const recorded = chem.chemistry.ingredients.length + chem.chemistry.fertilizer.length > 0;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {!gated && chem.is_active && <Button size="sm" variant="secondary" disabled={locked} onClick={() => open({ kind: 'entry' })}>Add</Button>}
      {recorded && <Button size="sm" variant="secondary" disabled={locked} onClick={() => open({ kind: 'correct', parentId, prefill: null })}>Correct</Button>}
      <Button size="sm" variant="secondary" disabled={locked} onClick={() => open({ kind: 'review' })}>
        Review ingredients{waiting ? ` (${waiting} waiting)` : ''}
      </Button>
    </div>
  );
}

function ChemistryBody({ chem, isAdmin, busy, profileId, reloadKey, pending, onPendingSettled, onCostSettled }: {
  chem: ParentChemistry; isAdmin: boolean; busy: boolean; profileId: string; reloadKey: string; pending: PendingChemistrySave[];
  onPendingSettled: (outcome: 'saved' | 'refused' | 'uncertain') => void; onCostSettled: () => void;
}) {
  return (
    <>
      <PendingSavesNotice records={pending} onSettled={onPendingSettled} />
      {chem.epa_refusal != null && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-secondary" role="status">{plainRefusal(chem.epa_refusal)}</p>}
      {busy && isAdmin && <p className="text-xs text-secondary">Save or discard the other changes on this page before changing chemistry.</p>}
      <p className="text-xs text-secondary">Shared by every size of {chem.parent_name}.</p>
      <ChemistryLists values={chem.chemistry} />
      {isAdmin && <ChemistryActiveCosts chem={chem} profileId={profileId} reloadKey={reloadKey} pending={pending.length > 0} onSaveSettled={onCostSettled} />}
    </>
  );
}

function ChemistryForms({ form, chem, profileId, onClose, onFinished, onReviewClosed, open }: {
  form: NonNullable<OpenForm>; chem: ParentChemistry | null; profileId: string; onClose: () => void; onFinished: (outcome: SaveOutcome) => void;
  onReviewClosed: () => void; open: (next: FormRequest) => void;
}) {
  if (form.kind === 'entry') return chem ? <ChemistryEntryModal key={form.token} chem={chem} profileId={profileId} onClose={onClose} onFinished={onFinished} /> : null;
  if (form.kind === 'correct') {
    return <ChemistryCorrectionModal key={form.token} parentId={form.parentId} prefill={form.prefill} profileId={profileId} onClose={onClose} onFinished={onFinished} />;
  }
  return (
    <IngredientReviewModal key={form.token} profileId={profileId} onClose={onReviewClosed}
      onReplace={(replaceParentId, prefill) => open({ kind: 'correct', parentId: replaceParentId, prefill })} />
  );
}

/**
 * DM-1: a parent's ingredients, modes of action and fertilizer analysis, shared by every size. Everyone signed in
 * reads it; admins enter, correct, review the ingredient list, see cost per lb of active and run EPA lookups (DM-4).
 */
export default function ProductChemistrySection({ parentId, parentVersion, refreshKey, isAdmin, profileId, busy }: {
  parentId: string; parentVersion: number; isAdmin: boolean; profileId: string;
  /** Changes when this page saves pricing or a weight, so cost per lb of active re-reads. */
  refreshKey: string;
  /** Other unsaved edits on the page: chemistry actions wait for them. */
  busy: boolean;
}) {
  const [loaded, setLoaded] = useState<{ forKey: string; status: 'failed' } | { forKey: string; status: 'loaded'; chem: ParentChemistry } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<OpenForm>(null);
  const [pendingTick, setPendingTick] = useState(0);
  const [waiting, setWaiting] = useState<number | null>(null);
  const tokens = useRef(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const forKey = JSON.stringify([parentId, parentVersion, refreshKey, attempt]);
  const state = loaded?.forKey === forKey ? loaded : null;

  // A new product or parent closes any open form: a form never acts on a product other than the one it opened for.
  useEffect(() => { setForm(null); }, [parentId]);
  useEffect(() => {
    let cancelled = false;
    fetchParentChemistry(parentId).then((chem) => { if (!cancelled) setLoaded({ forKey, status: 'loaded', chem }); }).catch((error: unknown) => {
      Sentry.captureException(errorOf(error), { extra: { context: 'get_parent_chemistry' } });
      if (!cancelled) setLoaded({ forKey, status: 'failed' });
    });
    return () => { cancelled = true; };
  }, [parentId, forKey]);
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetchIngredientWorklist().then((list) => { if (!cancelled) setWaiting(list.needs_cas.length + list.possible_duplicates.length); })
      .catch(() => { if (!cancelled) setWaiting(null); });
    return () => { cancelled = true; };
  }, [isAdmin, attempt]);

  void pendingTick;
  const pending = isAdmin ? pendingSaves(profileId, parentId) : [];
  const open = (next: FormRequest) => { tokens.current += 1; setForm({ ...next, token: tokens.current }); };
  const finished = (outcome: SaveOutcome) => {
    setPendingTick((n) => n + 1);
    if (outcome !== 'refused') { setForm(null); reload(); }
  };
  const chem = state?.status === 'loaded' ? state.chem : null;

  return (
    <Card data-testid="product-chemistry">
      <CardHeader title="Chemistry" action={isAdmin && chem
        ? <ChemistryActions chem={chem} parentId={parentId} locked={busy || pending.length > 0} waiting={waiting} open={open} />
        : undefined} />
      <div className="space-y-3">
        {!state && <p className="text-sm text-secondary" role="status">Loading chemistry…</p>}
        {state?.status === 'failed' && <LoadFailedState title="Chemistry could not be loaded" onRetry={reload} />}
        {chem && (
          <ChemistryBody chem={chem} isAdmin={isAdmin} busy={busy} profileId={profileId} reloadKey={forKey} pending={pending}
            onPendingSettled={(outcome) => finished(outcome === 'uncertain' ? 'uncertain' : 'saved')} onCostSettled={() => setPendingTick((n) => n + 1)} />
        )}
        {chem && isAdmin && (
          <EpaLookupPanel key={parentId} parentId={parentId} profileId={profileId} reloadKey={forKey} epaRefusal={chem.epa_refusal}
            locked={busy || pending.length > 0} onCommitted={reload} />
        )}
      </div>
      {form && <ChemistryForms form={form} chem={chem} profileId={profileId} onClose={() => setForm(null)} onFinished={finished} onReviewClosed={() => { setForm(null); reload(); }} open={open} />}
    </Card>
  );
}
