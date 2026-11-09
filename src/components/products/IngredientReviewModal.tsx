import { useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { LoadFailedState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { sanitizeError } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import {
  ChemistrySaveUncertain, INGREDIENT_SCOPE, casValid, fetchIngredientWorklist, pendingSaves, previewIngredientChange,
  ingredientLine, parseFraction, startChemistrySave, type IngredientFields,
} from '../../lib/productChemistry';
import { IngredientSearch } from './IngredientPicker';
import { PendingSavesNotice } from './ChemistryParts';
import { previewRefusalText, type ReplacePrefill } from './chemistryFormHelpers';
import { ReasonField } from './ProductParentPanel';
import type { ActiveIngredientSummary, ActiveIngredientWithUsers, IngredientChangePreview, IngredientWorklist } from '../../types';

type Acid = { id: string; name: string } | null;

type Tab = 'duplicates' | 'needs_cas' | 'retired' | 'find';
type SubForm =
  | { kind: 'edit'; ingredient: ActiveIngredientSummary; casOnly: boolean }
  | { kind: 'retire' | 'reactivate'; ingredient: ActiveIngredientSummary };

const FIELD_LABEL: Record<string, string> = {
  cas: 'CAS number', is_parent_form: 'acid flag', canonical_ingredient_id: 'acid', canonical_fraction: 'acid fraction',
  fraction_basis: 'fraction basis', status: 'status',
};

function Users({ item }: { item: ActiveIngredientWithUsers }) {
  return (
    <div className="text-xs text-secondary">
      <div>Products: {item.parents.length ? item.parents.map((p) => `${p.name}${p.is_active ? '' : ' (inactive)'}`).join(', ') : 'none'}</div>
      {item.forms.length > 0 && <div>Forms measured as it: {item.forms.map((f) => f.name).join(', ')}</div>}
    </div>
  );
}

/** Only the fields that differ are sent; the database checks the resulting ingredient as a whole. */
function editFields(ingredient: ActiveIngredientSummary, casOnly: boolean, input: { cas: string; isAcid: boolean; acid: Acid; fraction: string }): {
  fields: IngredientFields; problem: string | null;
} {
  const fields: IngredientFields = {};
  let problem: string | null = null;
  const casText = input.cas.trim();
  if (casText !== (ingredient.cas ?? '')) {
    if (casText && !casValid(casText)) problem = 'That CAS number is not valid (format or check digit).';
    fields.cas = casText || null;
  }
  if (!casOnly) problem = acidFields(ingredient, input, fields) ?? problem;
  if (!problem && Object.keys(fields).length === 0) problem = casOnly ? 'Type the CAS number.' : 'Nothing changed yet.';
  return { fields, problem };
}

function acidFields(ingredient: ActiveIngredientSummary, input: { isAcid: boolean; acid: Acid; fraction: string }, fields: IngredientFields): string | null {
  const parsed = parseFraction(input.fraction);
  let problem: string | null = null;
  if (parsed !== null && parsed !== 'invalid' && !input.acid) problem = 'A fraction needs the acid it is measured as.';
  if (parsed === 'invalid') problem = 'The fraction must be above 0 and at most 1, like 0.741.';
  if (input.isAcid !== ingredient.is_parent_form) fields.is_parent_form = input.isAcid;
  if ((input.acid?.id ?? null) !== ingredient.canonical_ingredient_id) fields.canonical_ingredient_id = input.acid?.id ?? null;
  const nextFraction = typeof parsed === 'number' ? parsed : null;
  if (parsed !== 'invalid' && nextFraction !== ingredient.canonical_fraction) {
    fields.canonical_fraction = nextFraction;
    fields.fraction_basis = nextFraction === null ? null : 'acid_equivalent';
  }
  return problem;
}

function EditPreview({ shown }: { shown: IngredientChangePreview }) {
  return (
    <div className="space-y-1 rounded-lg border border-gray-200 p-3 text-sm" aria-live="polite">
      {shown.refusal ? (
        <p className="text-red-700" role="alert">This change would be refused. {previewRefusalText(shown.refusal)}</p>
      ) : (
        <>
          <p>Changes: {(shown.changed_fields ?? []).map((field) => FIELD_LABEL[field] ?? field).join(', ') || 'nothing'}{shown.after ? ` → ${ingredientLine(shown.after)}` : ''}</p>
          <p className="text-secondary">
            Products affected: {shown.affected_parents.length
              ? shown.affected_parents.map((p) => `${p.name} (${p.sizes.length} size${p.sizes.length === 1 ? '' : 's'})${p.epa_refusal ? ', EPA-confirmed' : ''}`).join('; ')
              : 'none'}
          </p>
          {shown.users.forms.length > 0 && <p className="text-secondary">Forms measured as it: {shown.users.forms.map((f) => f.name).join(', ')}</p>}
        </>
      )}
    </div>
  );
}

const initialAcid = (ingredient: ActiveIngredientSummary): Acid =>
  (ingredient.canonical_ingredient_id ? { id: ingredient.canonical_ingredient_id, name: ingredient.canonical_name ?? 'its acid' } : null);

function editReady(problem: string | null, shown: IngredientChangePreview | null, needsReason: boolean, reason: string, evidence: string): boolean {
  if (problem || !shown || shown.refusal !== null) return false;
  return !needsReason || (reason.trim() !== '' && evidence.trim() !== '');
}

function AcidFields({ ingredientId, isAcid, setIsAcid, acid, setAcid, fraction, setFraction }: {
  ingredientId: string; isAcid: boolean; setIsAcid: (value: boolean) => void; acid: Acid; setAcid: (value: Acid) => void;
  fraction: string; setFraction: (value: string) => void;
}) {
  return (
    <>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={isAcid} disabled={acid !== null} onChange={(event) => setIsAcid(event.target.checked)} />
        This is the acid other forms are measured as
      </label>
      {!isAcid && (acid ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Measured as acid: {acid.name}</span>
          <Button size="sm" variant="secondary" onClick={() => { setAcid(null); setFraction(''); }}>Remove acid</Button>
        </div>
      ) : (
        <IngredientSearch id="edit-ing-acid" label="Acid it is measured as" acidsOnly excludeIds={[ingredientId]} onPick={(item) => setAcid(item)} />
      ))}
      {acid && (
        <Input id="edit-ing-fraction" label="Acid fraction (e.g. 0.741)" inputMode="decimal" maxLength={20} value={fraction}
          onChange={(event) => setFraction(event.target.value)} />
      )}
    </>
  );
}

/** Edit one ingredient's CAS, acid flag, acid and fraction, with a database preview of everything it touches. */
function EditIngredient({ ingredient, casOnly, profileId, onDone, onCancel }: {
  ingredient: ActiveIngredientSummary; casOnly: boolean; profileId: string; onDone: (outcome: 'saved' | 'uncertain' | 'stale') => void; onCancel: () => void;
}) {
  const { toast } = useToast();
  const [cas, setCas] = useState(ingredient.cas ?? '');
  const [isAcid, setIsAcid] = useState(ingredient.is_parent_form);
  const [acid, setAcid] = useState<Acid>(() => initialAcid(ingredient));
  const [fraction, setFraction] = useState(() => (ingredient.canonical_fraction == null ? '' : String(ingredient.canonical_fraction)));
  const [preview, setPreview] = useState<{ forFields: string; result: IngredientChangePreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);
  useEffect(() => () => { seq.current += 1; }, []);

  const { fields, problem } = editFields(ingredient, casOnly, { cas, isAcid, acid, fraction });
  const fieldsKey = JSON.stringify(fields);
  const shown = preview?.forFields === fieldsKey ? preview.result : null;
  const needsReason = shown?.needs_reason === true;
  const ready = editReady(problem, shown, needsReason, reason, evidence);

  const runPreview = async () => {
    if (problem) return;
    const mine = ++seq.current;
    setPreviewing(true);
    try {
      const result = await previewIngredientChange(ingredient.id, fields);
      if (mine === seq.current) setPreview({ forFields: fieldsKey, result });
    } catch (error) {
      if (mine === seq.current) toast('error', sanitizeError(error));
    } finally {
      if (mine === seq.current) setPreviewing(false);
    }
  };
  const save = async () => {
    if (!ready || !shown || saving) return;
    setSaving(true);
    try {
      await startChemistrySave(profileId, INGREDIENT_SCOPE, 'save_active_ingredient', {
        p_ingredient_id: ingredient.id, p_expected_row_version: shown.ingredient.row_version,
        p_expected_usage_fingerprint: shown.usage_fingerprint, p_fields: fields,
        p_reason: reason.trim() || null, p_evidence: evidence.trim() || null,
      }, `Ingredient change on ${ingredient.name}`);
      toast('success', `${ingredient.name} saved`);
      onDone('saved');
    } catch (error) {
      if (error instanceof ChemistrySaveUncertain) { toast('warning', error.message); onDone('uncertain'); return; }
      toast('error', sanitizeError(error));
      const message = String((error as { message?: unknown })?.message ?? '');
      if (/^INGREDIENT_(STALE|USAGE_CHANGED)\b/.test(message)) onDone('stale');
    } finally {
      setSaving(false);
    }
  };
  const busy = saving || previewing;

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-nav-dark">{casOnly ? 'Add CAS' : 'Edit ingredient'}: {ingredientLine(ingredient)}</p>
      <p className="text-xs text-secondary">The name cannot change. To use a different name, add that ingredient and replace this one on its products.</p>
      <fieldset disabled={busy} className="space-y-2">
        <Input id="edit-ing-cas" label="CAS number" maxLength={12} value={cas} onChange={(event) => setCas(event.target.value)}
          error={cas.trim() && !casValid(cas) ? 'Not a valid CAS number (format or check digit)' : undefined} />
        {!casOnly && (
          <AcidFields ingredientId={ingredient.id} isAcid={isAcid} setIsAcid={setIsAcid} acid={acid} setAcid={setAcid}
            fraction={fraction} setFraction={setFraction} />
        )}
      </fieldset>
      {problem && <p className="text-sm text-amber-800" role="status">{problem}</p>}
      {shown && <EditPreview shown={shown} />}
      {preview && !shown && <p className="text-sm text-secondary">The fields changed since the preview. Preview again.</p>}
      {needsReason && (
        <fieldset disabled={saving} className="space-y-2">
          <ReasonField id="edit-ing-reason" label="Reason" value={reason} onChange={setReason} />
          <ReasonField id="edit-ing-evidence" label="Evidence (label, SDS or supplier document)" value={evidence} onChange={setEvidence} />
        </fieldset>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Back</Button>
        <Button variant="secondary" onClick={() => void runPreview()} loading={previewing} disabled={problem !== null || saving}>Preview</Button>
        <Button onClick={() => void save()} loading={saving} disabled={!ready || previewing}>Save</Button>
      </div>
    </div>
  );
}

function RetireOrReactivate({ kind, ingredient, profileId, onDone, onCancel }: {
  kind: 'retire' | 'reactivate'; ingredient: ActiveIngredientSummary; profileId: string;
  onDone: (outcome: 'saved' | 'uncertain' | 'stale') => void; onCancel: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!reason.trim() || saving) return;
    setSaving(true);
    try {
      await startChemistrySave(profileId, INGREDIENT_SCOPE, kind === 'retire' ? 'retire_active_ingredient' : 'reactivate_active_ingredient',
        { p_ingredient_id: ingredient.id, p_expected_row_version: ingredient.row_version, p_reason: reason.trim() },
        `${kind === 'retire' ? 'Retire' : 'Reactivate'} ${ingredient.name}`);
      toast('success', `${ingredient.name} ${kind === 'retire' ? 'retired' : 'reactivated'}`);
      onDone('saved');
    } catch (error) {
      if (error instanceof ChemistrySaveUncertain) { toast('warning', error.message); onDone('uncertain'); return; }
      toast('error', sanitizeError(error));
      if (/^INGREDIENT_STALE\b/.test(String((error as { message?: unknown })?.message ?? ''))) onDone('stale');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-nav-dark">{kind === 'retire' ? 'Retire' : 'Reactivate'}: {ingredientLine(ingredient)}</p>
      {kind === 'retire' && <p className="text-xs text-secondary">Only an ingredient no product uses, and no form names as its acid, can be retired.</p>}
      <fieldset disabled={saving}><ReasonField id="ing-status-reason" label="Reason" value={reason} onChange={setReason} /></fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Back</Button>
        <Button variant={kind === 'retire' ? 'danger' : 'primary'} onClick={() => void save()} loading={saving} disabled={!reason.trim()}>
          {kind === 'retire' ? 'Retire ingredient' : 'Reactivate ingredient'}
        </Button>
      </div>
    </div>
  );
}

/** Any active ingredient: edit it, or retire it (the database refuses, in words, while a product or form still uses it). */
function FindTab({ locked, onEdit, onRetire }: {
  locked: boolean; onEdit: (item: ActiveIngredientSummary) => void; onRetire: (item: ActiveIngredientSummary) => void;
}) {
  const [found, setFound] = useState<ActiveIngredientSummary | null>(null);
  if (!found) return <IngredientSearch id="review-find" label="Find an ingredient" disabled={locked} onPick={setFound} />;
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3">
      <p className="text-sm text-nav-dark">{ingredientLine(found)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={locked} onClick={() => onEdit(found)}>Edit</Button>
        <Button size="sm" variant="secondary" disabled={locked} onClick={() => onRetire(found)}>Retire</Button>
        <Button size="sm" variant="secondary" onClick={() => setFound(null)}>Find another</Button>
      </div>
    </div>
  );
}

function DuplicatesTab({ list, locked, actions, onReplace }: {
  list: IngredientWorklist; locked: boolean; actions: (item: ActiveIngredientWithUsers) => React.ReactNode;
  onReplace: (parentId: string, prefill: ReplacePrefill) => void;
}) {
  if (list.possible_duplicates.length === 0) return <p className="text-sm text-secondary">No possible duplicates.</p>;
  return (
    <ul className="space-y-3">
      {list.possible_duplicates.map(({ provisional, other }) => (
        <li key={`${provisional.id}-${other.id}`} className="rounded-lg border border-gray-200 p-3">
          <div className="grid gap-3 md:grid-cols-2">
            {[provisional, other].map((item, index) => (
              <div key={item.id} className="space-y-1">
                <p className="text-xs uppercase text-secondary">{index === 0 ? 'New (provisional)' : 'Already listed'}</p>
                <p className="text-sm font-medium text-nav-dark">{ingredientLine(item)}</p>
                <Users item={item} />
                {actions(item)}
              </div>
            ))}
          </div>
          {provisional.parents.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {provisional.parents.map((parent) => (
                <Button key={parent.parent_id} size="sm" disabled={locked}
                  onClick={() => onReplace(parent.parent_id, { ingredientId: provisional.id, withIngredient: other })}>
                  Replace on {parent.name}
                </Button>
              ))}
            </div>
          )}
          {provisional.forms.length > 0 && (
            <p className="mt-2 text-xs text-secondary">Forms measured as {provisional.name} must be edited to name {other.name} before it can be retired.</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function NeedsCasTab({ list, locked, onAddCas }: { list: IngredientWorklist; locked: boolean; onAddCas: (item: ActiveIngredientWithUsers) => void }) {
  if (list.needs_cas.length === 0) return <p className="text-sm text-secondary">Every ingredient has a CAS number.</p>;
  return (
    <ul className="space-y-2">
      {list.needs_cas.map((item) => (
        <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-gray-200 p-3">
          <div><p className="text-sm font-medium text-nav-dark">{ingredientLine(item)}</p><Users item={item} /></div>
          <Button size="sm" disabled={locked} onClick={() => onAddCas(item)}>Add CAS</Button>
        </li>
      ))}
    </ul>
  );
}

function RetiredTab({ list, locked, onReactivate }: { list: IngredientWorklist; locked: boolean; onReactivate: (item: IngredientWorklist['retired'][number]) => void }) {
  if (list.retired.length === 0) return <p className="text-sm text-secondary">No retired ingredients.</p>;
  return (
    <ul className="space-y-2">
      {list.retired.map((item) => (
        <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-gray-200 p-3">
          <div>
            <p className="text-sm font-medium text-nav-dark">{ingredientLine(item)}</p>
            {item.retire_reason && <p className="text-xs text-secondary">Retired: {item.retire_reason}</p>}
          </div>
          <Button size="sm" variant="secondary" disabled={locked} onClick={() => onReactivate(item)}>Reactivate</Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * DM-1 ingredient list review (admin): possible duplicates side by side, ingredients that need a CAS number, and
 * retired ones. Replace opens the correction of the product using the duplicate, with the swap filled in.
 */
export default function IngredientReviewModal({ profileId, onClose, onReplace }: {
  profileId: string; onClose: () => void; onReplace: (parentId: string, prefill: ReplacePrefill) => void;
}) {
  const [list, setList] = useState<IngredientWorklist | 'loading' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<Tab>('duplicates');
  const [sub, setSub] = useState<SubForm | null>(null);
  const [pendingTick, setPendingTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setList('loading');
    fetchIngredientWorklist().then((loaded) => { if (!cancelled) setList(loaded); }).catch((error: unknown) => {
      Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), { extra: { context: 'get_active_ingredient_worklist' } });
      if (!cancelled) setList('failed');
    });
    return () => { cancelled = true; };
  }, [attempt]);

  void pendingTick;
  const pending = pendingSaves(profileId, INGREDIENT_SCOPE);
  const locked = pending.length > 0;
  const done = (outcome: 'saved' | 'uncertain' | 'stale') => {
    setPendingTick((n) => n + 1);
    setSub(null);
    if (outcome !== 'uncertain') setAttempt((n) => n + 1);
  };
  const tabs: Array<{ key: Tab; label: string }> = typeof list === 'object' ? [
    { key: 'duplicates', label: `Possible duplicates (${list.possible_duplicates.length})` },
    { key: 'needs_cas', label: `Needs CAS (${list.needs_cas.length})` },
    { key: 'retired', label: `Retired (${list.retired.length})` },
    { key: 'find', label: 'Find any ingredient' },
  ] : [];
  const actions = (item: ActiveIngredientSummary & Partial<ActiveIngredientWithUsers>) => (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={locked} onClick={() => setSub({ kind: 'edit', ingredient: item, casOnly: false })}>Edit</Button>
      {item.parents && item.forms && item.parents.length === 0 && item.forms.length === 0 && (
        <Button size="sm" variant="secondary" disabled={locked} onClick={() => setSub({ kind: 'retire', ingredient: item })}>Retire</Button>
      )}
    </div>
  );

  return (
    <Modal open onClose={onClose} title="Review ingredients" size="large">
      <div className="space-y-3">
        <PendingSavesNotice records={pending} onSettled={(outcome) => done(outcome === 'uncertain' ? 'uncertain' : 'saved')} />
        {list === 'loading' && <p className="text-sm text-secondary" role="status">Loading the ingredient list…</p>}
        {list === 'failed' && <LoadFailedState title="The ingredient list could not be loaded" onRetry={() => setAttempt((n) => n + 1)} />}
        {typeof list === 'object' && sub?.kind === 'edit' && (
          <EditIngredient key={sub.ingredient.id + String(sub.casOnly)} ingredient={sub.ingredient} casOnly={sub.casOnly} profileId={profileId}
            onDone={done} onCancel={() => setSub(null)} />
        )}
        {typeof list === 'object' && (sub?.kind === 'retire' || sub?.kind === 'reactivate') && (
          <RetireOrReactivate key={sub.kind + sub.ingredient.id} kind={sub.kind} ingredient={sub.ingredient} profileId={profileId}
            onDone={done} onCancel={() => setSub(null)} />
        )}
        {typeof list === 'object' && !sub && (
          <>
            <div className="flex flex-wrap gap-2" role="tablist">
              {tabs.map((item) => (
                <Button key={item.key} size="sm" variant={tab === item.key ? 'primary' : 'secondary'} role="tab" aria-selected={tab === item.key}
                  onClick={() => setTab(item.key)}>{item.label}</Button>
              ))}
            </div>
            {tab === 'duplicates' && <DuplicatesTab list={list} locked={locked} actions={actions} onReplace={onReplace} />}
            {tab === 'needs_cas' && <NeedsCasTab list={list} locked={locked} onAddCas={(item) => setSub({ kind: 'edit', ingredient: item, casOnly: true })} />}
            {tab === 'retired' && <RetiredTab list={list} locked={locked} onReactivate={(item) => setSub({ kind: 'reactivate', ingredient: item })} />}
            {tab === 'find' && (
              <FindTab locked={locked} onEdit={(item) => setSub({ kind: 'edit', ingredient: item, casOnly: false })}
                onRetire={(item) => setSub({ kind: 'retire', ingredient: item })} />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
