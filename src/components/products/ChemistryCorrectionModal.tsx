import { useEffect, useRef, useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Modal from '../ui/Modal';
import { LoadFailedState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { sanitizeError } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import {
  BASIS_LABEL, SOURCE_LABEL, EMPTY_NEW_INGREDIENT, fetchParentChemistry, ingredientLine, newIngredientFields, newIngredientProblem,
  nutrientLabel, pendingSaves, plainRefusal, previewChemistryCorrection, startChemistrySave, strengthText,
  type ChemistryChange, type NewIngredientDraft,
} from '../../lib/productChemistry';
import { IngredientSearch, NewIngredientFields } from './IngredientPicker';
import { ChemistryLists, PendingSavesNotice, StrengthFields } from './ChemistryParts';
import { ReasonField } from './ProductParentPanel';
import {
  SOURCE_OPTIONS, amountOf, errorOf, ingredientIdentity, modeKey, previewRefusalText, reportSaveError, typedSource,
  type ReplacePrefill, type SaveOutcome, type StrengthDraft, type TypedSource,
} from './chemistryFormHelpers';
import type {
  ActiveIngredientSummary, FertilizerBasis, ParentChemistry, ParentChemistryFertilizerRow, ParentChemistryIngredientRow,
  ParentChemistryModeRow, ParentChemistryPreview, ParentChemistryValues,
} from '../../types';

type IngredientAction = 'keep' | 'change' | 'retire' | 'swap' | 'consolidate';
interface RowFix extends StrengthDraft {
  action: IngredientAction; swapTo: ActiveIngredientSummary | null; swapCreating: boolean; swapNew: NewIngredientDraft;
  intoRowId: string; keepModes: string[];
}
interface NutrientFix { action: 'keep' | 'change' | 'retire'; amount: string; unknown: boolean; basis: FertilizerBasis; source: TypedSource; note: string }
type Problem = string | null;

const ACTION_LABEL: Record<string, string> = {
  keep: 'Keep as is', change: 'Change strength or source', retire: 'Remove from this product', swap: 'Replace with another ingredient',
  consolidate: 'Merge into another row (duplicate)',
};
const NUTRIENT_ACTION_LABEL: Record<string, string> = { keep: 'Keep as is', change: 'Change percent, basis or source', retire: 'Remove from this product' };

function strengthFrom(row: ParentChemistryIngredientRow): StrengthDraft {
  return {
    amount: row.strength_value == null ? '' : String(row.strength_value), unknown: row.strength_value == null,
    unit: row.strength_unit, basis: row.strength_basis, source: typedSource(row.source), note: row.source_note ?? '',
  };
}

function initialFixes(chem: ParentChemistry, prefill: ReplacePrefill | null): Record<string, RowFix> {
  const fixes: Record<string, RowFix> = {};
  for (const row of chem.chemistry.ingredients) {
    const keepModes = chem.chemistry.modes_of_action.filter((mode) => mode.ingredient_id === row.ingredient_id).map((mode) => modeKey(mode.scheme, mode.group_code));
    fixes[row.row_id] = { action: 'keep', ...strengthFrom(row), swapTo: null, swapCreating: false, swapNew: EMPTY_NEW_INGREDIENT, intoRowId: '', keepModes };
  }
  const target = prefill && chem.chemistry.ingredients.find((row) => row.ingredient_id === prefill.ingredientId);
  if (prefill && target) {
    const into = chem.chemistry.ingredients.find((row) => row.ingredient_id === prefill.withIngredient.id);
    fixes[target.row_id] = into
      ? { ...fixes[target.row_id], action: 'consolidate', intoRowId: into.row_id, ...strengthFrom(into) }
      : { ...fixes[target.row_id], action: 'swap', swapTo: prefill.withIngredient };
  }
  return fixes;
}

const initialNutrientFixes = (rows: ParentChemistryFertilizerRow[]): Record<string, NutrientFix> => Object.fromEntries(rows.map((row) => [row.row_id, {
  action: 'keep' as const, amount: row.percent == null ? '' : String(row.percent), unknown: row.percent == null,
  basis: row.basis, source: typedSource(row.source), note: row.source_note ?? '',
}]));

/** One ingredient row's correction: appends its change and returns the first problem, or null. */
function ingredientFixChange(row: ParentChemistryIngredientRow, fix: RowFix, out: ChemistryChange[], gone: Set<string>): Problem {
  if (fix.action === 'retire') {
    out.push({ kind: 'ingredient', action: 'retire', row_id: row.row_id });
    gone.add(row.ingredient_id);
    return null;
  }
  const value = amountOf(fix.amount, fix.unknown, fix.unit === 'pct_ww' ? 100 : 20, `strength for ${row.name}`);
  if (typeof value === 'string') return value;
  const strength = { strength_value: value, strength_unit: fix.unit, strength_basis: fix.basis, source: fix.source, source_note: fix.note.trim() || null };
  const keptModes = fix.keepModes.map((key) => { const [scheme, group_code] = key.split(':'); return { scheme, group_code }; });
  if (fix.action === 'change') {
    out.push({ kind: 'ingredient', action: 'change', row_id: row.row_id, ...strength });
    return null;
  }
  if (fix.action === 'swap') {
    if (!fix.swapTo && !fix.swapCreating) return `Pick the ingredient that replaces ${row.name}.`;
    const freshProblem = fix.swapCreating ? newIngredientProblem(fix.swapNew) : null;
    if (freshProblem) return freshProblem;
    out.push({ kind: 'ingredient', action: 'swap', row_id: row.row_id, modes_of_action: keptModes,
      ...(fix.swapTo ? { ingredient_id: fix.swapTo.id } : newIngredientFields(fix.swapNew)), ...strength });
  } else {
    if (!fix.intoRowId) return `Pick the row ${row.name} merges into.`;
    out.push({ kind: 'ingredient', action: 'consolidate', row_id: row.row_id, into_row_id: fix.intoRowId, modes_of_action: keptModes, ...strength });
  }
  gone.add(row.ingredient_id);
  return null;
}

function nutrientFixChange(row: ParentChemistryFertilizerRow, fix: NutrientFix, out: ChemistryChange[]): Problem {
  if (fix.action === 'retire') { out.push({ kind: 'fertilizer', action: 'retire', row_id: row.row_id }); return null; }
  const value = amountOf(fix.amount, fix.unknown, 100, `percent of ${row.nutrient}`);
  if (typeof value === 'string') return value;
  out.push({ kind: 'fertilizer', action: 'change', row_id: row.row_id, basis: fix.basis, percent: value, source: fix.source, source_note: fix.note.trim() || null });
  return null;
}

function buildCorrection(values: ParentChemistryValues, fixes: Record<string, RowFix>, modeRetire: string[], nutrientFixes: Record<string, NutrientFix>): { changes: ChemistryChange[]; problem: Problem } {
  const changes: ChemistryChange[] = [];
  const gone = new Set<string>();
  for (const row of values.ingredients) {
    const fix = fixes[row.row_id];
    const problem = fix && fix.action !== 'keep' ? ingredientFixChange(row, fix, changes, gone) : null;
    if (problem) return { changes, problem };
  }
  for (const mode of values.modes_of_action) {
    if (modeRetire.includes(mode.row_id) && !gone.has(mode.ingredient_id)) changes.push({ kind: 'mode_of_action', action: 'retire', row_id: mode.row_id });
  }
  for (const row of values.fertilizer) {
    const fix = nutrientFixes[row.row_id];
    const problem = fix && fix.action !== 'keep' ? nutrientFixChange(row, fix, changes) : null;
    if (problem) return { changes, problem };
  }
  return { changes, problem: changes.length === 0 ? 'Choose what to correct.' : null };
}

function SwapChoice({ row, fix, others, busy, patch }: {
  row: ParentChemistryIngredientRow; fix: RowFix; others: ParentChemistryIngredientRow[]; busy: boolean; patch: (patch: Partial<RowFix>) => void;
}) {
  const { toast } = useToast();
  if (fix.swapTo) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Replace with: {ingredientLine(fix.swapTo)}</span>
        <Button size="sm" variant="secondary" onClick={() => patch({ swapTo: null })}>Change</Button>
      </div>
    );
  }
  if (fix.swapCreating) {
    return (
      <>
        <NewIngredientFields idPrefix={`swap-${row.row_id}`} draft={fix.swapNew} disabled={busy} onChange={(swapNew) => patch({ swapNew })} />
        <Button size="sm" variant="ghost" onClick={() => patch({ swapCreating: false, swapNew: EMPTY_NEW_INGREDIENT })}>Search the list instead</Button>
      </>
    );
  }
  return (
    <>
      <IngredientSearch id={`swap-pick-${row.row_id}`} label="Replace with" excludeIds={[row.ingredient_id]}
        onPick={(swapTo) => {
          const into = others.find((other) => other.ingredient_id === swapTo.id);
          if (into) {
            patch({ action: 'consolidate', intoRowId: into.row_id, ...strengthFrom(into) });
            toast('info', `${swapTo.name} is already on this product, so the two rows are merged instead.`);
          } else patch({ swapTo });
        }} />
      <Button size="sm" variant="secondary" onClick={() => patch({ swapCreating: true })}>It is not listed: add a new ingredient</Button>
    </>
  );
}

function ModeChecks({ fix, modes, gated, modeRetire, setModeRetire, patch }: {
  fix: RowFix; modes: ParentChemistryModeRow[]; gated: boolean; modeRetire: string[];
  setModeRetire: (update: (current: string[]) => string[]) => void; patch: (patch: Partial<RowFix>) => void;
}) {
  if (modes.length === 0) return null;
  if (fix.action === 'swap' || fix.action === 'consolidate') {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-secondary">Modes of action that stay (on the {fix.action === 'swap' ? 'new ingredient' : 'kept row'}):</p>
        {modes.map((mode) => {
          const key = modeKey(mode.scheme, mode.group_code);
          return (
            <label key={mode.row_id} className="flex min-h-11 items-center gap-2">
              <input type="checkbox" checked={fix.keepModes.includes(key)}
                onChange={(event) => patch({ keepModes: event.target.checked ? [...fix.keepModes, key] : fix.keepModes.filter((item) => item !== key) })} />
              {mode.scheme} {mode.group_code}
            </label>
          );
        })}
      </div>
    );
  }
  if (fix.action === 'retire' || gated) return null;
  return (
    <div className="space-y-1 text-sm">
      {modes.map((mode) => (
        <label key={mode.row_id} className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={modeRetire.includes(mode.row_id)}
            onChange={(event) => setModeRetire((current) => (event.target.checked ? [...current, mode.row_id] : current.filter((id) => id !== mode.row_id)))} />
          Remove mode of action {mode.scheme} {mode.group_code}{mode.source === 'epa_lookup' ? ' (EPA confirmed)' : ''}
        </label>
      ))}
    </div>
  );
}

function IngredientFixCard({ row, fix, chem, actions, busy, modeRetire, setModeRetire, patch }: {
  row: ParentChemistryIngredientRow; fix: RowFix; chem: ParentChemistry; actions: string[]; busy: boolean; modeRetire: string[];
  setModeRetire: (update: (current: string[]) => string[]) => void; patch: (patch: Partial<RowFix>) => void;
}) {
  const values = chem.chemistry;
  const modes = values.modes_of_action.filter((mode) => mode.ingredient_id === row.ingredient_id);
  const editsStrength = fix.action === 'change' || fix.action === 'swap' || fix.action === 'consolidate';
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3">
      <div className="text-sm font-medium text-nav-dark">{ingredientIdentity(row)}</div>
      <div className="text-sm text-secondary">{strengthText(row.strength_value, row.strength_unit, row.strength_basis)} · from {SOURCE_LABEL[row.source]}</div>
      <Select id={`fix-${row.row_id}`} label="Correction" value={fix.action}
        options={actions.map((action) => ({ value: action, label: ACTION_LABEL[action] }))}
        onChange={(event) => patch({ action: event.target.value as IngredientAction })} />
      {fix.action === 'swap' && <SwapChoice row={row} fix={fix} others={values.ingredients} busy={busy} patch={patch} />}
      {fix.action === 'consolidate' && (
        <Select id={`into-${row.row_id}`} label="Merge into" value={fix.intoRowId} placeholder="Pick the row to keep"
          options={values.ingredients.filter((other) => other.row_id !== row.row_id).map((other) => ({ value: other.row_id, label: other.name }))}
          onChange={(event) => {
            const into = values.ingredients.find((other) => other.row_id === event.target.value);
            patch({ intoRowId: event.target.value, ...(into ? strengthFrom(into) : {}) });
          }} />
      )}
      {editsStrength && (
        <>
          {fix.action === 'consolidate' && <p className="text-xs text-secondary">The strength below is saved on the row that is kept.</p>}
          <StrengthFields idPrefix={`fix-${row.row_id}`} form={chem.product_form} draft={fix} disabled={busy} onChange={patch} />
        </>
      )}
      <ModeChecks fix={fix} modes={modes} gated={chem.epa_refusal !== null} modeRetire={modeRetire} setModeRetire={setModeRetire} patch={patch} />
    </div>
  );
}

function NutrientFixCard({ row, fix, actions, patch }: {
  row: ParentChemistryFertilizerRow; fix: NutrientFix; actions: string[]; patch: (patch: Partial<NutrientFix>) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3">
      <div className="text-sm font-medium text-nav-dark">
        {nutrientLabel(row.nutrient, row.basis)}: {row.percent == null ? 'percent unknown' : `${row.percent}%`} {BASIS_LABEL[row.basis]}
      </div>
      <Select id={`nfix-${row.row_id}`} label="Correction" value={fix.action}
        options={actions.map((action) => ({ value: action, label: NUTRIENT_ACTION_LABEL[action] }))}
        onChange={(event) => patch({ action: event.target.value as NutrientFix['action'] })} />
      {fix.action === 'change' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input id={`nfix-pct-${row.row_id}`} label="Percent" inputMode="decimal" maxLength={20} value={fix.amount} disabled={fix.unknown}
            onChange={(event) => patch({ amount: event.target.value })} />
          <label className="flex min-h-11 items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={fix.unknown} onChange={(event) => patch({ unknown: event.target.checked })} />
            Label gives none
          </label>
          <Select id={`nfix-basis-${row.row_id}`} label="Basis" value={fix.basis}
            options={[{ value: 'elemental', label: 'Elemental' }, ...(row.nutrient === 'P' || row.nutrient === 'K' ? [{ value: 'oxide', label: 'Oxide' }] : [])]}
            onChange={(event) => patch({ basis: event.target.value as FertilizerBasis })} />
          <Select id={`nfix-src-${row.row_id}`} label="Source" value={fix.source} options={SOURCE_OPTIONS}
            onChange={(event) => patch({ source: event.target.value as TypedSource })} />
          <Input id={`nfix-note-${row.row_id}`} label="Source note (optional)" maxLength={1000} value={fix.note}
            onChange={(event) => patch({ note: event.target.value })} />
        </div>
      )}
    </div>
  );
}

function CorrectionPreview({ shown }: { shown: ParentChemistryPreview }) {
  return (
    <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-live="polite">
      <h4 className="font-medium text-nav-dark">Preview</h4>
      {shown.refusal ? (
        <p className="text-sm text-red-700" role="alert">This correction would be refused. {previewRefusalText(shown.refusal)}</p>
      ) : !shown.changed ? (
        <p className="text-sm text-secondary">This correction changes nothing.</p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <div><p className="mb-1 text-sm font-medium">Now</p><ChemistryLists values={shown.before} /></div>
            <div><p className="mb-1 text-sm font-medium">After</p>{shown.after && <ChemistryLists values={shown.after} />}</div>
          </div>
          <p className="text-sm text-secondary">
            Every size changes: {shown.sizes.map((size) => `${size.product_name}${size.is_active ? '' : ' (inactive)'}`).join(', ') || 'no sizes'}.
          </p>
        </>
      )}
    </section>
  );
}

/** Which corrections a row offers: EPA-gated parents only remove typed rows; inactive ones never change values. */
function rowActions(chem: ParentChemistry, source: string, full: string[]): string[] {
  if (chem.epa_refusal !== null) return source === 'epa_lookup' ? ['keep'] : ['keep', 'retire'];
  return chem.is_active ? full : full.filter((action) => action !== 'change');
}

function correctionReady(problem: Problem, shown: ParentChemistryPreview | null, reason: string, evidence: string, pendingCount: number): boolean {
  if (problem || pendingCount > 0 || !shown || shown.preview_fingerprint === null || !shown.changed || shown.refusal !== null) return false;
  return reason.trim() !== '' && evidence.trim() !== '';
}

function CorrectionNotices({ chem }: { chem: ParentChemistry }) {
  return (
    <>
      {chem.epa_refusal !== null && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-secondary" role="status">{plainRefusal(chem.epa_refusal)} Only typed ingredient and nutrient rows can be removed here.</p>}
      {!chem.is_active && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-secondary" role="status">This product is inactive: rows can be removed, replaced or merged, not changed.</p>}
    </>
  );
}

function CorrectionStatus({ problem, shown, previewed }: { problem: Problem; shown: ParentChemistryPreview | null; previewed: boolean }) {
  return (
    <>
      {problem && <p className="text-sm text-amber-800" role="status">{problem}</p>}
      {shown && <CorrectionPreview shown={shown} />}
      {previewed && !shown && <p className="text-sm text-secondary">The choices changed since the preview. Preview again.</p>}
    </>
  );
}

/** Correction: change, retire, swap or consolidate recorded rows, with a preview, reason and evidence. */
export default function ChemistryCorrectionModal({ parentId, profileId, prefill, onClose, onFinished }: {
  parentId: string; profileId: string; prefill: ReplacePrefill | null; onClose: () => void; onFinished: (outcome: SaveOutcome) => void;
}) {
  const { toast } = useToast();
  const [chem, setChem] = useState<ParentChemistry | 'loading' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [fixes, setFixes] = useState<Record<string, RowFix>>({});
  const [modeRetire, setModeRetire] = useState<string[]>([]);
  const [nutrientFixes, setNutrientFixes] = useState<Record<string, NutrientFix>>({});
  const [preview, setPreview] = useState<{ forChanges: string; result: ParentChemistryPreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingTick, setPendingTick] = useState(0);
  const previewSeq = useRef(0);
  useEffect(() => () => { previewSeq.current += 1; }, []);

  useEffect(() => {
    let cancelled = false;
    fetchParentChemistry(parentId).then((loaded) => {
      if (cancelled) return;
      setChem(loaded);
      setFixes(initialFixes(loaded, prefill));
      setModeRetire([]);
      setNutrientFixes(initialNutrientFixes(loaded.chemistry.fertilizer));
      setPreview(null);
    }).catch((error: unknown) => {
      Sentry.captureException(errorOf(error), { extra: { context: 'get_parent_chemistry_correction' } });
      if (!cancelled) setChem('failed');
    });
    return () => { cancelled = true; };
  }, [parentId, prefill, attempt]);

  if (chem === 'loading' || chem === 'failed') {
    return (
      <Modal open onClose={onClose} title="Correct chemistry">
        {chem === 'loading' ? <p className="text-sm text-secondary" role="status">Loading chemistry…</p>
          : <LoadFailedState title="Chemistry could not be loaded" onRetry={() => setAttempt((n) => n + 1)} />}
      </Modal>
    );
  }

  const values = chem.chemistry;
  void pendingTick;
  const pending = pendingSaves(profileId, chem.parent_id);
  const { changes, problem } = buildCorrection(values, fixes, modeRetire, nutrientFixes);
  const changesKey = JSON.stringify(changes);
  const shown = preview?.forChanges === changesKey ? preview.result : null;
  const ready = correctionReady(problem, shown, reason, evidence, pending.length);
  const ingredientActionList = ['keep', 'change', 'retire', 'swap', ...(values.ingredients.length > 1 ? ['consolidate'] : [])];

  const runPreview = async () => {
    if (problem) return;
    const mine = ++previewSeq.current;
    setPreviewing(true);
    try {
      const result = await previewChemistryCorrection(chem.parent_id, changes);
      if (mine !== previewSeq.current) return;
      if (result.chemistry_version !== chem.chemistry_version) {
        toast('warning', 'This product’s chemistry changed since this form opened. It was reloaded; choose the correction again.');
        setAttempt((n) => n + 1);
        return;
      }
      setPreview({ forChanges: changesKey, result });
    } catch (error) {
      if (mine === previewSeq.current) toast('error', sanitizeError(error));
    } finally {
      if (mine === previewSeq.current) setPreviewing(false);
    }
  };

  const save = async () => {
    if (!ready || !shown || saving) return;
    setSaving(true);
    try {
      await startChemistrySave(profileId, chem.parent_id, 'correct_parent_chemistry', {
        p_parent_id: chem.parent_id, p_expected_chemistry_version: chem.chemistry_version,
        p_expected_preview_fingerprint: shown.preview_fingerprint, p_changes: changes, p_reason: reason.trim(), p_evidence: evidence.trim(),
      }, `Chemistry correction on ${chem.parent_name}`);
      toast('success', 'Correction saved');
      onFinished('saved');
    } catch (error) {
      const outcome = reportSaveError(error, toast);
      if (outcome !== 'refused') onFinished(outcome);
    } finally {
      setSaving(false);
    }
  };
  const patchFix = (rowId: string, patch: Partial<RowFix>) => setFixes((current) => ({ ...current, [rowId]: { ...current[rowId], ...patch } }));
  const patchNutrientFix = (rowId: string, patch: Partial<NutrientFix>) =>
    setNutrientFixes((current) => ({ ...current, [rowId]: { ...current[rowId], ...patch } }));
  const busy = saving || previewing;

  return (
    <Modal open onClose={onClose} closeDisabled={saving} title={`Correct chemistry: ${chem.parent_name}`} size="large"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="secondary" onClick={() => void runPreview()} loading={previewing} disabled={problem !== null || saving}>Preview</Button>
          <Button onClick={() => void save()} loading={saving} disabled={!ready || previewing}>Save correction</Button>
        </>
      )}>
      <div className="space-y-4">
        <PendingSavesNotice records={pending} onSettled={(outcome) => { setPendingTick((n) => n + 1); if (outcome !== 'uncertain') setAttempt((n) => n + 1); }} />
        <CorrectionNotices chem={chem} />
        <fieldset disabled={busy} className="space-y-3">
          {values.ingredients.map((row) => fixes[row.row_id] && (
            <IngredientFixCard key={row.row_id} row={row} fix={fixes[row.row_id]} chem={chem} busy={busy}
              actions={rowActions(chem, row.source, ingredientActionList)} modeRetire={modeRetire} setModeRetire={setModeRetire}
              patch={(patch) => patchFix(row.row_id, patch)} />
          ))}
          {values.fertilizer.map((row) => nutrientFixes[row.row_id] && (
            <NutrientFixCard key={row.row_id} row={row} fix={nutrientFixes[row.row_id]} actions={rowActions(chem, row.source, ['keep', 'change', 'retire'])}
              patch={(patch) => patchNutrientFix(row.row_id, patch)} />
          ))}
          {values.ingredients.length === 0 && values.fertilizer.length === 0 && <p className="text-sm text-secondary">Nothing is recorded to correct.</p>}
        </fieldset>
        <CorrectionStatus problem={changes.length > 0 ? problem : null} shown={shown} previewed={preview !== null} />
        <fieldset disabled={saving} className="space-y-2">
          <ReasonField id="chem-fix-reason" label="Reason" value={reason} onChange={setReason} />
          <ReasonField id="chem-fix-evidence" label="Evidence (label, SDS or supplier document)" value={evidence} onChange={setEvidence} />
        </fieldset>
      </div>
    </Modal>
  );
}
