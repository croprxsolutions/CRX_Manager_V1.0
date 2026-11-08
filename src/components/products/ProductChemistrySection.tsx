import { useCallback, useEffect, useRef, useState } from 'react';
import Card, { CardHeader } from '../ui/Card';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Modal from '../ui/Modal';
import { LoadFailedState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { sanitizeError } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import {
  BASIS_LABEL, CHEMISTRY_SOURCES, ChemistrySaveUncertain, NUTRIENTS, SCHEMES, SOURCE_LABEL, UNIT_LABEL,
  centsText, costReasonText, plainRefusal, fetchCostReferenceVersion, fetchIngredientWorklist, fetchParentActiveCosts, fetchParentChemistry,
  finishChemistrySave, nutrientLabel, parseAmount, pendingSaves, previewChemistryCorrection, refusalCode, startChemistrySave,
  strengthText, EMPTY_NEW_INGREDIENT, ingredientLine, newIngredientFields, newIngredientProblem,
  type ChemistryChange, type NewIngredientDraft, type PendingChemistrySave,
} from '../../lib/productChemistry';
import { IngredientSearch, NewIngredientFields } from './IngredientPicker';
import IngredientReviewModal from './IngredientReviewModal';
import { ReasonField } from './ProductParentPanel';
import type {
  ActiveCostRow, ActiveIngredientSummary, ChemistrySource, ChemistryStrengthBasis, ChemistryStrengthUnit, FertilizerBasis,
  FertilizerNutrient, ModeOfActionScheme, ParentActiveCosts, ParentChemistry, ParentChemistryIngredientRow,
  ParentChemistryPreview, ParentChemistryValues,
} from '../../types';

type TypedSource = Exclude<ChemistrySource, 'epa_lookup'>;
const SOURCE_OPTIONS = CHEMISTRY_SOURCES.map((item) => ({ value: item.value, label: item.label }));
const BASIS_OPTIONS = [{ value: 'active_ingredient', label: 'Active ingredient (a.i.)' }, { value: 'acid_equivalent', label: 'Acid equivalent (a.e.)' }];
const typedSource = (source: ChemistrySource): TypedSource => (source === 'epa_lookup' ? 'label' : source);
const unitOptions = (form: string) => [
  { value: 'pct_ww', label: '% w/w' },
  ...(form === 'liquid' ? [{ value: 'lb_per_gal', label: 'lb/gal' }] : []),
];
const ingredientIdentity = (row: Pick<ParentChemistryIngredientRow, 'name' | 'cas' | 'is_parent_form' | 'canonical_name' | 'canonical_fraction'>) => ingredientLine(row);
const modeKey = (scheme: string, code: string) => `${scheme}:${code}`;
const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(sanitizeError(error)));

/** A save the database refused by name, or one whose outcome is unknown (its record is kept for "finish"). */
function reportSaveError(error: unknown, toast: (type: 'error' | 'warning', message: string) => void): 'uncertain' | 'stale' | 'refused' {
  if (error instanceof ChemistrySaveUncertain) {
    Sentry.captureException(errorOf(error.cause), { extra: { context: 'chemistry_save_uncertain' } });
    toast('warning', error.message);
    return 'uncertain';
  }
  toast('error', sanitizeError(error));
  const code = refusalCode(error);
  return code === 'CHEMISTRY_STALE' || code === 'CHEMISTRY_PREVIEW_CHANGED' || code === 'COST_REFERENCE_STALE' ? 'stale' : 'refused';
}

// ---------------------------------------------------------------------------------------------
// Read view
// ---------------------------------------------------------------------------------------------

export function ChemistryLists({ values }: { values: ParentChemistryValues }) {
  if (values.ingredients.length === 0 && values.fertilizer.length === 0) {
    return <p className="text-sm text-secondary">No chemistry recorded yet.</p>;
  }
  return (
    <div className="space-y-3 text-sm">
      {values.ingredients.length > 0 && (
        <ul className="space-y-2">
          {values.ingredients.map((row) => {
            const modes = values.modes_of_action.filter((mode) => mode.ingredient_id === row.ingredient_id);
            return (
              <li key={row.row_id} className="rounded-lg border border-gray-200 px-3 py-2">
                <div className="font-medium text-nav-dark">{ingredientIdentity(row)}</div>
                <div className="text-secondary">
                  {strengthText(row.strength_value, row.strength_unit, row.strength_basis)} · from {SOURCE_LABEL[row.source]}
                  {row.source_note ? ` (${row.source_note})` : ''}
                </div>
                {modes.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {modes.map((mode) => (
                      <span key={mode.row_id} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-nav-dark">
                        {mode.scheme} {mode.group_code}{mode.source === 'epa_lookup' ? ' (EPA confirmed)' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {values.fertilizer.length > 0 && (
        <div>
          <p className="font-medium text-nav-dark">Fertilizer analysis</p>
          <ul className="text-secondary">
            {values.fertilizer.map((row) => (
              <li key={row.row_id}>
                {nutrientLabel(row.nutrient, row.basis)}: {row.percent == null ? 'percent unknown' : `${row.percent}%`} {BASIS_LABEL[row.basis]}
                {' '}· from {SOURCE_LABEL[row.source]}{row.source_note ? ` (${row.source_note})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Unfinished saves of this user for one scope: each is sent again with its own retry key and request. */
export function PendingSavesNotice({ records, onSettled }: { records: PendingChemistrySave[]; onSettled: (outcome: 'saved' | 'refused' | 'uncertain') => void }) {
  const { toast } = useToast();
  const [sending, setSending] = useState<string | null>(null);
  if (records.length === 0) return null;
  const finish = async (record: PendingChemistrySave) => {
    setSending(record.key);
    try {
      await finishChemistrySave(record);
      toast('success', 'The save you started is finished');
      onSettled('saved');
    } catch (error) {
      const outcome = reportSaveError(error, toast);
      onSettled(outcome === 'uncertain' ? 'uncertain' : 'refused');
    } finally {
      setSending(null);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-nav-dark" role="alert">
      <p className="font-medium">Finish the save you started. Nothing new can be saved here until it is finished.</p>
      {records.map((record) => (
        <div key={record.key} className="flex flex-wrap items-center gap-2">
          <span>{record.label} ({new Date(record.createdAt).toLocaleString('en-US')})</span>
          <Button size="sm" loading={sending === record.key} disabled={sending !== null} onClick={() => void finish(record)}>Finish save</Button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Fast entry: add ingredients, modes of action and nutrients, or fill an unknown amount
// ---------------------------------------------------------------------------------------------

interface ModeDraft { key: number; scheme: ModeOfActionScheme; code: string }
interface IngredientDraft {
  key: number; existing: ActiveIngredientSummary | null; creating: boolean; fresh: NewIngredientDraft;
  amount: string; unknown: boolean; unit: ChemistryStrengthUnit; basis: ChemistryStrengthBasis; source: TypedSource; note: string;
  modes: ModeDraft[];
}
interface ExtraModeDraft extends ModeDraft { ingredientId: string }
interface NutrientDraft { key: number; nutrient: FertilizerNutrient | ''; basis: FertilizerBasis; amount: string; unknown: boolean; source: TypedSource; note: string }

let draftKey = 0;
const nextKey = () => { draftKey += 1; return draftKey; };
const newIngredientDraft = (): IngredientDraft => ({
  key: nextKey(), existing: null, creating: false, fresh: EMPTY_NEW_INGREDIENT, amount: '', unknown: false,
  unit: 'pct_ww', basis: 'active_ingredient', source: 'label', note: '', modes: [],
});
const newNutrientDraft = (): NutrientDraft => ({ key: nextKey(), nutrient: '', basis: 'elemental', amount: '', unknown: false, source: 'label', note: '' });

/** A strength or percent: a number, null when marked unknown, or the problem. */
function amountOf(text: string, unknown: boolean, max: number, what: string): number | null | string {
  if (unknown) return null;
  const value = parseAmount(text);
  if (value === null) return `Enter the ${what}, or tick "Label gives none".`;
  if (value === 'invalid' || value > max) return `The ${what} must be above 0 and at most ${max}.`;
  return value;
}

function ModeRows({ idPrefix, modes, onChange, disabled }: { idPrefix: string; modes: ModeDraft[]; onChange: (modes: ModeDraft[]) => void; disabled: boolean }) {
  return (
    <div className="space-y-2">
      {modes.map((mode, index) => (
        <div key={mode.key} className="flex flex-wrap items-end gap-2">
          <div className="w-28">
            <Select id={`${idPrefix}-scheme-${mode.key}`} label="Scheme" value={mode.scheme} disabled={disabled}
              options={SCHEMES.map((scheme) => ({ value: scheme, label: scheme }))}
              onChange={(event) => onChange(modes.map((item, at) => (at === index ? { ...item, scheme: event.target.value as ModeOfActionScheme } : item)))} />
          </div>
          <div className="w-28">
            <Input id={`${idPrefix}-code-${mode.key}`} label="Group" maxLength={10} value={mode.code} disabled={disabled}
              onChange={(event) => onChange(modes.map((item, at) => (at === index ? { ...item, code: event.target.value } : item)))} />
          </div>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(modes.filter((_, at) => at !== index))}>Remove</Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onChange([...modes, { key: nextKey(), scheme: 'HRAC', code: '' }])}>
        Add mode of action
      </Button>
    </div>
  );
}

function StrengthFields({ idPrefix, form, draft, onChange, disabled }: {
  idPrefix: string; form: string; disabled: boolean;
  draft: { amount: string; unknown: boolean; unit: ChemistryStrengthUnit; basis: ChemistryStrengthBasis; source: TypedSource; note: string };
  onChange: (patch: Partial<IngredientDraft>) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Input id={`${idPrefix}-amount`} label="Strength" inputMode="decimal" maxLength={20} value={draft.amount} disabled={disabled || draft.unknown}
        error={!draft.unknown && draft.amount.trim() !== '' && parseAmount(draft.amount) === 'invalid' ? 'Enter a number above 0' : undefined}
        onChange={(event) => onChange({ amount: event.target.value })} />
      <label className="flex min-h-11 items-center gap-2 self-end text-sm text-nav-dark">
        <input type="checkbox" checked={draft.unknown} disabled={disabled} onChange={(event) => onChange({ unknown: event.target.checked })} />
        Label gives none (strength unknown)
      </label>
      <Select id={`${idPrefix}-unit`} label="Unit" value={draft.unit} disabled={disabled} options={unitOptions(form)}
        onChange={(event) => onChange({ unit: event.target.value as ChemistryStrengthUnit })} />
      <Select id={`${idPrefix}-basis`} label="Basis" value={draft.basis} disabled={disabled} options={BASIS_OPTIONS}
        onChange={(event) => onChange({ basis: event.target.value as ChemistryStrengthBasis })} />
      <Select id={`${idPrefix}-source`} label="Source" value={draft.source} disabled={disabled} options={SOURCE_OPTIONS}
        onChange={(event) => onChange({ source: event.target.value as TypedSource })} />
      <Input id={`${idPrefix}-note`} label="Source note (optional)" maxLength={1000} value={draft.note} disabled={disabled}
        onChange={(event) => onChange({ note: event.target.value })} />
    </div>
  );
}

function EntryModal({ chem, profileId, onClose, onFinished }: {
  chem: ParentChemistry; profileId: string; onClose: () => void; onFinished: (outcome: 'saved' | 'stale' | 'uncertain' | 'refused') => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [ingredients, setIngredients] = useState<IngredientDraft[]>([]);
  const [extraModes, setExtraModes] = useState<ExtraModeDraft[]>([]);
  const [nutrients, setNutrients] = useState<NutrientDraft[]>([]);
  const [fills, setFills] = useState<Record<string, string>>({});
  const values = chem.chemistry;
  const unknownIngredients = values.ingredients.filter((row) => row.strength_value == null && row.source !== 'epa_lookup');
  const unknownNutrients = values.fertilizer.filter((row) => row.percent == null && row.source !== 'epa_lookup');
  const onParent = values.ingredients.map((row) => row.ingredient_id);
  const recordedNutrients = values.fertilizer.map((row) => row.nutrient);

  const build = (): { changes: ChemistryChange[]; problem: string | null } => {
    const changes: ChemistryChange[] = [];
    const modeChanges: ChemistryChange[] = [];
    for (const row of unknownIngredients) {
      const text = fills[row.row_id]?.trim();
      if (!text) continue;
      const value = amountOf(text, false, row.strength_unit === 'pct_ww' ? 100 : 20, `strength of ${row.name}`);
      if (typeof value === 'string') return { changes, problem: value };
      changes.push({ kind: 'ingredient', ingredient_id: row.ingredient_id, strength_value: value, strength_unit: row.strength_unit,
        strength_basis: row.strength_basis, source: row.source, source_note: null });
    }
    for (const row of unknownNutrients) {
      const text = fills[row.row_id]?.trim();
      if (!text) continue;
      const value = amountOf(text, false, 100, `percent of ${row.nutrient}`);
      if (typeof value === 'string') return { changes, problem: value };
      changes.push({ kind: 'fertilizer', nutrient: row.nutrient, basis: row.basis, percent: value, source: row.source, source_note: null });
    }
    const picked = new Set<string>();
    for (const [index, draft] of ingredients.entries()) {
      const name = draft.existing?.name ?? (draft.fresh.name.trim() || `ingredient ${index + 1}`);
      if (!draft.existing && !draft.creating) return { changes, problem: `Pick or describe ingredient ${index + 1}.` };
      if (draft.creating) {
        const problem = newIngredientProblem(draft.fresh);
        if (problem) return { changes, problem: `${name}: ${problem}` };
      }
      if (draft.existing) {
        if (picked.has(draft.existing.id)) return { changes, problem: `${name} is listed twice.` };
        picked.add(draft.existing.id);
      }
      const value = amountOf(draft.amount, draft.unknown, draft.unit === 'pct_ww' ? 100 : 20, `strength of ${name}`);
      if (typeof value === 'string') return { changes, problem: value };
      const ref = `new-${draft.key}`;
      changes.push({
        kind: 'ingredient', ...(draft.existing ? { ingredient_id: draft.existing.id } : { ref, ...newIngredientFields(draft.fresh) }),
        strength_value: value, strength_unit: draft.unit, strength_basis: draft.basis, source: draft.source, source_note: draft.note.trim() || null,
      });
      for (const mode of draft.modes) {
        if (!mode.code.trim()) return { changes, problem: `Give the group of each mode of action of ${name}.` };
        modeChanges.push({ kind: 'mode_of_action', ...(draft.existing ? { ingredient_id: draft.existing.id } : { ingredient_ref: ref }),
          scheme: mode.scheme, group_code: mode.code.trim() });
      }
    }
    for (const mode of extraModes) {
      if (!mode.ingredientId || !mode.code.trim()) return { changes, problem: 'Pick the ingredient and give the group of each mode of action.' };
      modeChanges.push({ kind: 'mode_of_action', ingredient_id: mode.ingredientId, scheme: mode.scheme, group_code: mode.code.trim() });
    }
    const nutrientSeen = new Set<string>();
    for (const draft of nutrients) {
      if (!draft.nutrient) return { changes, problem: 'Pick each nutrient.' };
      if (nutrientSeen.has(draft.nutrient)) return { changes, problem: `${draft.nutrient} is listed twice.` };
      nutrientSeen.add(draft.nutrient);
      const value = amountOf(draft.amount, draft.unknown, 100, `percent of ${draft.nutrient}`);
      if (typeof value === 'string') return { changes, problem: value };
      changes.push({ kind: 'fertilizer', nutrient: draft.nutrient, basis: draft.basis, percent: value, source: draft.source,
        source_note: draft.note.trim() || null });
    }
    const all = [...changes, ...modeChanges];
    return { changes: all, problem: all.length === 0 ? 'Nothing to save yet.' : null };
  };
  const { changes, problem } = build();

  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      await startChemistrySave(profileId, chem.parent_id, 'set_parent_chemistry',
        { p_parent_id: chem.parent_id, p_expected_chemistry_version: chem.chemistry_version, p_changes: changes },
        `Chemistry entry on ${chem.parent_name}`);
      toast('success', 'Chemistry saved');
      onFinished('saved');
    } catch (error) {
      const outcome = reportSaveError(error, toast);
      if (outcome !== 'refused') onFinished(outcome);
    } finally {
      setSaving(false);
    }
  };
  const patchIngredient = (key: number, patch: Partial<IngredientDraft>) =>
    setIngredients((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const patchNutrient = (key: number, patch: Partial<NutrientDraft>) =>
    setNutrients((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <Modal open onClose={onClose} closeDisabled={saving} title={`Add chemistry: ${chem.parent_name}`} size="large"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} loading={saving} disabled={problem !== null}>Save chemistry</Button>
        </>
      )}>
      <fieldset disabled={saving} className="space-y-4">
        <p className="text-sm text-secondary">
          Enter what the label states for this product (every size shares it). To change or remove a recorded row, use Correct.
        </p>
        {(unknownIngredients.length > 0 || unknownNutrients.length > 0) && (
          <section className="space-y-2">
            <h4 className="font-medium text-nav-dark">Fill an unknown amount</h4>
            <p className="text-xs text-secondary">The unit, basis and source stay as recorded; change those with Correct.</p>
            {unknownIngredients.map((row) => (
              <Input key={row.row_id} id={`fill-${row.row_id}`} inputMode="decimal" maxLength={20}
                label={`${row.name} (${UNIT_LABEL[row.strength_unit]} ${BASIS_LABEL[row.strength_basis]}, from ${SOURCE_LABEL[row.source]})`}
                value={fills[row.row_id] ?? ''} onChange={(event) => setFills((current) => ({ ...current, [row.row_id]: event.target.value }))} />
            ))}
            {unknownNutrients.map((row) => (
              <Input key={row.row_id} id={`fill-${row.row_id}`} inputMode="decimal" maxLength={20}
                label={`${nutrientLabel(row.nutrient, row.basis)} percent (${BASIS_LABEL[row.basis]}, from ${SOURCE_LABEL[row.source]})`}
                value={fills[row.row_id] ?? ''} onChange={(event) => setFills((current) => ({ ...current, [row.row_id]: event.target.value }))} />
            ))}
          </section>
        )}

        <section className="space-y-3">
          <h4 className="font-medium text-nav-dark">Add ingredients</h4>
          {ingredients.map((draft, index) => (
            <div key={draft.key} className="space-y-2 rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Ingredient {index + 1}</span>
                <Button size="sm" variant="ghost" onClick={() => setIngredients((rows) => rows.filter((row) => row.key !== draft.key))}>Remove</Button>
              </div>
              {draft.existing ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{ingredientLine(draft.existing)}</span>
                  <Button size="sm" variant="secondary" onClick={() => patchIngredient(draft.key, { existing: null })}>Change</Button>
                </div>
              ) : draft.creating ? (
                <>
                  <NewIngredientFields idPrefix={`new-${draft.key}`} draft={draft.fresh} disabled={saving}
                    onChange={(fresh) => patchIngredient(draft.key, { fresh })} />
                  <Button size="sm" variant="ghost" onClick={() => patchIngredient(draft.key, { creating: false, fresh: EMPTY_NEW_INGREDIENT })}>
                    Search the list instead
                  </Button>
                </>
              ) : (
                <>
                  <IngredientSearch id={`pick-${draft.key}`} label="Find the ingredient" disabled={saving} excludeIds={onParent}
                    onPick={(existing) => patchIngredient(draft.key, { existing })} />
                  <Button size="sm" variant="secondary" onClick={() => patchIngredient(draft.key, { creating: true })}>
                    It is not listed: add a new ingredient
                  </Button>
                </>
              )}
              <StrengthFields idPrefix={`ing-${draft.key}`} form={chem.product_form} draft={draft} disabled={saving}
                onChange={(patch) => patchIngredient(draft.key, patch)} />
              <ModeRows idPrefix={`ing-${draft.key}-moa`} modes={draft.modes} disabled={saving}
                onChange={(modes) => patchIngredient(draft.key, { modes })} />
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setIngredients((rows) => [...rows, newIngredientDraft()])}>Add an ingredient</Button>
        </section>

        {values.ingredients.length > 0 && (
          <section className="space-y-2">
            <h4 className="font-medium text-nav-dark">Add a mode of action to a recorded ingredient</h4>
            {extraModes.map((mode, index) => (
              <div key={mode.key} className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <Select id={`moa-ing-${mode.key}`} label="Ingredient" value={mode.ingredientId} placeholder="Pick one"
                    options={values.ingredients.map((row) => ({ value: row.ingredient_id, label: row.name }))}
                    onChange={(event) => setExtraModes((rows) => rows.map((item, at) => (at === index ? { ...item, ingredientId: event.target.value } : item)))} />
                </div>
                <div className="w-28">
                  <Select id={`moa-scheme-${mode.key}`} label="Scheme" value={mode.scheme} options={SCHEMES.map((scheme) => ({ value: scheme, label: scheme }))}
                    onChange={(event) => setExtraModes((rows) => rows.map((item, at) => (at === index ? { ...item, scheme: event.target.value as ModeOfActionScheme } : item)))} />
                </div>
                <div className="w-28">
                  <Input id={`moa-code-${mode.key}`} label="Group" maxLength={10} value={mode.code}
                    onChange={(event) => setExtraModes((rows) => rows.map((item, at) => (at === index ? { ...item, code: event.target.value } : item)))} />
                </div>
                <Button size="sm" variant="ghost" onClick={() => setExtraModes((rows) => rows.filter((_, at) => at !== index))}>Remove</Button>
              </div>
            ))}
            <Button size="sm" variant="secondary"
              onClick={() => setExtraModes((rows) => [...rows, { key: nextKey(), ingredientId: '', scheme: 'HRAC', code: '' }])}>
              Add mode of action
            </Button>
          </section>
        )}

        <section className="space-y-2">
          <h4 className="font-medium text-nav-dark">Fertilizer analysis</h4>
          {nutrients.map((draft) => (
            <div key={draft.key} className="grid gap-2 rounded-lg border border-gray-200 p-3 sm:grid-cols-2">
              <Select id={`nut-${draft.key}`} label="Nutrient" value={draft.nutrient} placeholder="Pick one"
                options={NUTRIENTS.filter((nutrient) => !recordedNutrients.includes(nutrient)).map((nutrient) => ({ value: nutrient, label: nutrient }))}
                onChange={(event) => {
                  const nutrient = event.target.value as FertilizerNutrient;
                  patchNutrient(draft.key, { nutrient, basis: nutrient === 'P' || nutrient === 'K' ? draft.basis : 'elemental' });
                }} />
              <Select id={`nut-basis-${draft.key}`} label="Basis" value={draft.basis}
                options={[{ value: 'elemental', label: 'Elemental' },
                  ...(draft.nutrient === 'P' || draft.nutrient === 'K' ? [{ value: 'oxide', label: draft.nutrient === 'P' ? 'Oxide (P₂O₅)' : 'Oxide (K₂O)' }] : [])]}
                onChange={(event) => patchNutrient(draft.key, { basis: event.target.value as FertilizerBasis })} />
              <Input id={`nut-pct-${draft.key}`} label="Percent" inputMode="decimal" maxLength={20} value={draft.amount} disabled={draft.unknown}
                onChange={(event) => patchNutrient(draft.key, { amount: event.target.value })} />
              <label className="flex min-h-11 items-center gap-2 self-end text-sm text-nav-dark">
                <input type="checkbox" checked={draft.unknown} onChange={(event) => patchNutrient(draft.key, { unknown: event.target.checked })} />
                Label gives none (percent unknown)
              </label>
              <Select id={`nut-src-${draft.key}`} label="Source" value={draft.source} options={SOURCE_OPTIONS}
                onChange={(event) => patchNutrient(draft.key, { source: event.target.value as TypedSource })} />
              <Input id={`nut-note-${draft.key}`} label="Source note (optional)" maxLength={1000} value={draft.note}
                onChange={(event) => patchNutrient(draft.key, { note: event.target.value })} />
              <div className="sm:col-span-2">
                <Button size="sm" variant="ghost" onClick={() => setNutrients((rows) => rows.filter((row) => row.key !== draft.key))}>Remove</Button>
              </div>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setNutrients((rows) => [...rows, newNutrientDraft()])}>Add a nutrient</Button>
        </section>
        {problem && changes.length + ingredients.length + nutrients.length + extraModes.length > 0 && (
          <p className="text-sm text-amber-800" role="status">{problem}</p>
        )}
      </fieldset>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Correction: change, retire, swap or consolidate recorded rows, with a preview, reason and evidence
// ---------------------------------------------------------------------------------------------

type IngredientAction = 'keep' | 'change' | 'retire' | 'swap' | 'consolidate';
interface RowFix {
  action: IngredientAction; amount: string; unknown: boolean; unit: ChemistryStrengthUnit; basis: ChemistryStrengthBasis;
  source: TypedSource; note: string; swapTo: ActiveIngredientSummary | null; swapCreating: boolean; swapNew: NewIngredientDraft;
  intoRowId: string; keepModes: string[];
}
interface NutrientFix { action: 'keep' | 'change' | 'retire'; amount: string; unknown: boolean; basis: FertilizerBasis; source: TypedSource; note: string }

/** What the review pop-up's Replace asks for: on this parent, put `withIngredient` where `ingredientId` is. */
export interface ReplacePrefill { ingredientId: string; withIngredient: ActiveIngredientSummary }

function strengthFrom(row: ParentChemistryIngredientRow) {
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

function CorrectionModal({ parentId, profileId, prefill, onClose, onFinished }: {
  parentId: string; profileId: string; prefill: ReplacePrefill | null; onClose: () => void;
  onFinished: (outcome: 'saved' | 'stale' | 'uncertain' | 'refused') => void;
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
      setNutrientFixes(Object.fromEntries(loaded.chemistry.fertilizer.map((row) => [row.row_id, {
        action: 'keep' as const, amount: row.percent == null ? '' : String(row.percent), unknown: row.percent == null,
        basis: row.basis, source: typedSource(row.source), note: row.source_note ?? '',
      }])));
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

  const gated = chem.epa_refusal !== null;
  const inactive = !chem.is_active;
  const values = chem.chemistry;
  const pending = pendingSaves(profileId, chem.parent_id);
  void pendingTick;
  const ingredientActions = (row: ParentChemistryIngredientRow) => {
    if (gated) return row.source === 'epa_lookup' ? ['keep'] : ['keep', 'retire'];
    return ['keep', ...(inactive ? [] : ['change']), 'retire', 'swap', ...(values.ingredients.length > 1 ? ['consolidate'] : [])];
  };
  const ACTION_LABEL: Record<string, string> = {
    keep: 'Keep as is', change: 'Change strength or source', retire: 'Remove from this product', swap: 'Replace with another ingredient',
    consolidate: 'Merge into another row (duplicate)',
  };

  const build = (): { changes: ChemistryChange[]; problem: string | null } => {
    const changes: ChemistryChange[] = [];
    const goneIngredients = new Set<string>();
    for (const row of values.ingredients) {
      const fix = fixes[row.row_id];
      if (!fix || fix.action === 'keep') continue;
      if (fix.action === 'retire') {
        changes.push({ kind: 'ingredient', action: 'retire', row_id: row.row_id });
        goneIngredients.add(row.ingredient_id);
        continue;
      }
      const value = amountOf(fix.amount, fix.unknown, fix.unit === 'pct_ww' ? 100 : 20, `strength for ${row.name}`);
      if (typeof value === 'string') return { changes, problem: value };
      const strength = { strength_value: value, strength_unit: fix.unit, strength_basis: fix.basis, source: fix.source, source_note: fix.note.trim() || null };
      const keptModes = fix.keepModes.map((key) => { const [scheme, group_code] = key.split(':'); return { scheme, group_code }; });
      if (fix.action === 'change') {
        changes.push({ kind: 'ingredient', action: 'change', row_id: row.row_id, ...strength });
      } else if (fix.action === 'swap') {
        if (!fix.swapTo && !fix.swapCreating) return { changes, problem: `Pick the ingredient that replaces ${row.name}.` };
        if (fix.swapCreating) {
          const problem = newIngredientProblem(fix.swapNew);
          if (problem) return { changes, problem };
        }
        changes.push({ kind: 'ingredient', action: 'swap', row_id: row.row_id, modes_of_action: keptModes,
          ...(fix.swapTo ? { ingredient_id: fix.swapTo.id } : newIngredientFields(fix.swapNew)), ...strength });
        goneIngredients.add(row.ingredient_id);
      } else {
        if (!fix.intoRowId) return { changes, problem: `Pick the row ${row.name} merges into.` };
        changes.push({ kind: 'ingredient', action: 'consolidate', row_id: row.row_id, into_row_id: fix.intoRowId, modes_of_action: keptModes, ...strength });
        goneIngredients.add(row.ingredient_id);
      }
    }
    for (const mode of values.modes_of_action) {
      if (modeRetire.includes(mode.row_id) && !goneIngredients.has(mode.ingredient_id)) {
        changes.push({ kind: 'mode_of_action', action: 'retire', row_id: mode.row_id });
      }
    }
    for (const row of values.fertilizer) {
      const fix = nutrientFixes[row.row_id];
      if (!fix || fix.action === 'keep') continue;
      if (fix.action === 'retire') { changes.push({ kind: 'fertilizer', action: 'retire', row_id: row.row_id }); continue; }
      const value = amountOf(fix.amount, fix.unknown, 100, `percent of ${row.nutrient}`);
      if (typeof value === 'string') return { changes, problem: value };
      changes.push({ kind: 'fertilizer', action: 'change', row_id: row.row_id, basis: fix.basis, percent: value, source: fix.source,
        source_note: fix.note.trim() || null });
    }
    return { changes, problem: changes.length === 0 ? 'Choose what to correct.' : null };
  };
  const { changes, problem } = build();
  const changesKey = JSON.stringify(changes);
  const shown = preview && preview.forChanges === changesKey ? preview.result : null;
  const ready = !problem && shown !== null && shown.preview_fingerprint !== null && shown.changed && shown.refusal === null
    && reason.trim() !== '' && evidence.trim() !== '' && pending.length === 0;

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
        {gated && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-secondary" role="status">{plainRefusal(chem.epa_refusal ?? '')} Only typed ingredient and nutrient rows can be removed here.</p>}
        {inactive && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-secondary" role="status">This product is inactive: rows can be removed, replaced or merged, not changed.</p>}
        <fieldset disabled={busy} className="space-y-3">
          {values.ingredients.map((row) => {
            const fix = fixes[row.row_id];
            if (!fix) return null;
            const modes = values.modes_of_action.filter((mode) => mode.ingredient_id === row.ingredient_id);
            return (
              <div key={row.row_id} className="space-y-2 rounded-lg border border-gray-200 p-3">
                <div className="text-sm font-medium text-nav-dark">{ingredientIdentity(row)}</div>
                <div className="text-sm text-secondary">{strengthText(row.strength_value, row.strength_unit, row.strength_basis)} · from {SOURCE_LABEL[row.source]}</div>
                <Select id={`fix-${row.row_id}`} label="Correction" value={fix.action}
                  options={ingredientActions(row).map((action) => ({ value: action, label: ACTION_LABEL[action] }))}
                  onChange={(event) => patchFix(row.row_id, { action: event.target.value as IngredientAction })} />
                {fix.action === 'swap' && (fix.swapTo ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span>Replace with: {ingredientLine(fix.swapTo)}</span>
                    <Button size="sm" variant="secondary" onClick={() => patchFix(row.row_id, { swapTo: null })}>Change</Button>
                  </div>
                ) : fix.swapCreating ? (
                  <>
                    <NewIngredientFields idPrefix={`swap-${row.row_id}`} draft={fix.swapNew} disabled={busy}
                      onChange={(swapNew) => patchFix(row.row_id, { swapNew })} />
                    <Button size="sm" variant="ghost" onClick={() => patchFix(row.row_id, { swapCreating: false, swapNew: EMPTY_NEW_INGREDIENT })}>Search the list instead</Button>
                  </>
                ) : (
                  <>
                    <IngredientSearch id={`swap-pick-${row.row_id}`} label="Replace with" excludeIds={[row.ingredient_id]}
                      onPick={(swapTo) => {
                        const into = values.ingredients.find((other) => other.ingredient_id === swapTo.id);
                        if (into) {
                          patchFix(row.row_id, { action: 'consolidate', intoRowId: into.row_id, ...strengthFrom(into) });
                          toast('info', `${swapTo.name} is already on this product, so the two rows are merged instead.`);
                        } else patchFix(row.row_id, { swapTo });
                      }} />
                    <Button size="sm" variant="secondary" onClick={() => patchFix(row.row_id, { swapCreating: true })}>It is not listed: add a new ingredient</Button>
                  </>
                ))}
                {fix.action === 'consolidate' && (
                  <Select id={`into-${row.row_id}`} label="Merge into" value={fix.intoRowId} placeholder="Pick the row to keep"
                    options={values.ingredients.filter((other) => other.row_id !== row.row_id).map((other) => ({ value: other.row_id, label: other.name }))}
                    onChange={(event) => {
                      const into = values.ingredients.find((other) => other.row_id === event.target.value);
                      patchFix(row.row_id, { intoRowId: event.target.value, ...(into ? strengthFrom(into) : {}) });
                    }} />
                )}
                {(fix.action === 'change' || fix.action === 'swap' || fix.action === 'consolidate') && (
                  <>
                    {fix.action === 'consolidate' && <p className="text-xs text-secondary">The strength below is saved on the row that is kept.</p>}
                    <StrengthFields idPrefix={`fix-${row.row_id}`} form={chem.product_form} draft={fix} disabled={busy}
                      onChange={(patch) => patchFix(row.row_id, patch as Partial<RowFix>)} />
                  </>
                )}
                {(fix.action === 'swap' || fix.action === 'consolidate') && modes.length > 0 && (
                  <div className="space-y-1 text-sm">
                    <p className="text-secondary">Modes of action that stay (on the {fix.action === 'swap' ? 'new ingredient' : 'kept row'}):</p>
                    {modes.map((mode) => {
                      const key = modeKey(mode.scheme, mode.group_code);
                      return (
                        <label key={mode.row_id} className="flex min-h-11 items-center gap-2">
                          <input type="checkbox" checked={fix.keepModes.includes(key)}
                            onChange={(event) => patchFix(row.row_id, { keepModes: event.target.checked ? [...fix.keepModes, key] : fix.keepModes.filter((item) => item !== key) })} />
                          {mode.scheme} {mode.group_code}
                        </label>
                      );
                    })}
                  </div>
                )}
                {(fix.action === 'keep' || fix.action === 'change') && !gated && modes.length > 0 && (
                  <div className="space-y-1 text-sm">
                    {modes.map((mode) => (
                      <label key={mode.row_id} className="flex min-h-11 items-center gap-2">
                        <input type="checkbox" checked={modeRetire.includes(mode.row_id)}
                          onChange={(event) => setModeRetire((current) => (event.target.checked ? [...current, mode.row_id] : current.filter((id) => id !== mode.row_id)))} />
                        Remove mode of action {mode.scheme} {mode.group_code}{mode.source === 'epa_lookup' ? ' (EPA confirmed)' : ''}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {values.fertilizer.map((row) => {
            const fix = nutrientFixes[row.row_id];
            if (!fix) return null;
            const actions = gated ? (row.source === 'epa_lookup' ? ['keep'] : ['keep', 'retire']) : ['keep', ...(inactive ? [] : ['change']), 'retire'];
            return (
              <div key={row.row_id} className="space-y-2 rounded-lg border border-gray-200 p-3">
                <div className="text-sm font-medium text-nav-dark">
                  {nutrientLabel(row.nutrient, row.basis)}: {row.percent == null ? 'percent unknown' : `${row.percent}%`} {BASIS_LABEL[row.basis]}
                </div>
                <Select id={`nfix-${row.row_id}`} label="Correction" value={fix.action}
                  options={actions.map((action) => ({ value: action, label: action === 'keep' ? 'Keep as is' : action === 'change' ? 'Change percent, basis or source' : 'Remove from this product' }))}
                  onChange={(event) => patchNutrientFix(row.row_id, { action: event.target.value as NutrientFix['action'] })} />
                {fix.action === 'change' && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input id={`nfix-pct-${row.row_id}`} label="Percent" inputMode="decimal" maxLength={20} value={fix.amount} disabled={fix.unknown}
                      onChange={(event) => patchNutrientFix(row.row_id, { amount: event.target.value })} />
                    <label className="flex min-h-11 items-center gap-2 self-end text-sm">
                      <input type="checkbox" checked={fix.unknown} onChange={(event) => patchNutrientFix(row.row_id, { unknown: event.target.checked })} />
                      Label gives none
                    </label>
                    <Select id={`nfix-basis-${row.row_id}`} label="Basis" value={fix.basis}
                      options={[{ value: 'elemental', label: 'Elemental' }, ...(row.nutrient === 'P' || row.nutrient === 'K' ? [{ value: 'oxide', label: 'Oxide' }] : [])]}
                      onChange={(event) => patchNutrientFix(row.row_id, { basis: event.target.value as FertilizerBasis })} />
                    <Select id={`nfix-src-${row.row_id}`} label="Source" value={fix.source} options={SOURCE_OPTIONS}
                      onChange={(event) => patchNutrientFix(row.row_id, { source: event.target.value as TypedSource })} />
                    <Input id={`nfix-note-${row.row_id}`} label="Source note (optional)" maxLength={1000} value={fix.note}
                      onChange={(event) => patchNutrientFix(row.row_id, { note: event.target.value })} />
                  </div>
                )}
              </div>
            );
          })}
          {values.ingredients.length === 0 && values.fertilizer.length === 0 && <p className="text-sm text-secondary">Nothing is recorded to correct.</p>}
        </fieldset>

        {problem && changes.length > 0 && <p className="text-sm text-amber-800" role="status">{problem}</p>}
        {shown && (
          <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-live="polite">
            <h4 className="font-medium text-nav-dark">Preview</h4>
            {shown.refusal ? (
              <p className="text-sm text-red-700" role="alert">This correction would be refused. {sanitizeError({ message: shown.refusal }).replace(/^Nothing was saved\.\s*/, '')}</p>
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
        )}
        {preview && !shown && <p className="text-sm text-secondary">The choices changed since the preview. Preview again.</p>}
        <fieldset disabled={saving} className="space-y-2">
          <ReasonField id="chem-fix-reason" label="Reason" value={reason} onChange={setReason} />
          <ReasonField id="chem-fix-evidence" label="Evidence (label, SDS or supplier document)" value={evidence} onChange={setEvidence} />
        </fieldset>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Cost per lb of active (admin only; computed by the database, display only)
// ---------------------------------------------------------------------------------------------

function FigureLine({ row, pricedUnit }: { row: ActiveCostRow; pricedUnit: string | null }) {
  const name = row.kind === 'fertilizer' && row.nutrient ? nutrientLabel(row.nutrient, row.figure.basis) : row.name;
  const text = (figure: ActiveCostRow['figure']) => ('cents' in figure
    ? `${centsText(figure.cents)} per lb ${BASIS_LABEL[figure.basis]}`
    : `${BASIS_LABEL[figure.basis]}: ${costReasonText(figure.reason, pricedUnit)}`);
  return (
    <li>
      <span className="text-nav-dark">{name}:</span> {text(row.figure)}
      {row.converted && <span className="text-secondary"> · {text(row.converted)}</span>}
    </li>
  );
}

function ActiveCostsPanel({ chem, profileId, reloadKey, pending, onSaveSettled }: {
  chem: ParentChemistry; profileId: string; reloadKey: string; pending: boolean;
  onSaveSettled: (outcome: 'saved' | 'stale' | 'uncertain' | 'refused') => void;
}) {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState<{ forKey: string; status: 'failed' } | { forKey: string; status: 'loaded'; costs: ParentActiveCosts; refVersion: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);
  const forKey = JSON.stringify([chem.parent_id, reloadKey, attempt]);
  const state = loaded?.forKey === forKey ? loaded : null;
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchParentActiveCosts(chem.parent_id), fetchCostReferenceVersion(chem.parent_id)]).then(([costs, refVersion]) => {
      if (cancelled) return;
      setLoaded({ forKey, status: 'loaded', costs, refVersion });
      setPicked(costs.reference.source === 'picked' ? costs.reference.product_id ?? '' : '');
    }).catch((error: unknown) => {
      Sentry.captureException(errorOf(error), { extra: { context: 'get_parent_active_costs' } });
      if (!cancelled) setLoaded({ forKey, status: 'failed' });
    });
    return () => { cancelled = true; };
  }, [chem.parent_id, forKey]);

  if (!state) return <p className="text-sm text-secondary" role="status">Loading cost per lb of active…</p>;
  if (state.status === 'failed') return <LoadFailedState title="Cost per lb of active could not be loaded" onRetry={() => setAttempt((n) => n + 1)} />;
  const { costs, refVersion } = state;
  const refSize = costs.sizes.find((size) => size.product_id === costs.reference.product_id);
  const current = costs.reference.source === 'picked' ? costs.reference.product_id ?? '' : '';

  const saveReference = async () => {
    setSaving(true);
    try {
      await startChemistrySave(profileId, chem.parent_id, 'set_parent_cost_reference', {
        p_parent_id: chem.parent_id, p_reference_product_id: picked || null, p_expected_row_version: refVersion,
      }, `Cost reference size on ${chem.parent_name}`);
      toast('success', 'Reference size saved');
      setAttempt((n) => n + 1);
      onSaveSettled('saved');
    } catch (error) {
      const outcome = reportSaveError(error, toast);
      if (outcome === 'stale') setAttempt((n) => n + 1);
      onSaveSettled(outcome);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-2 border-t border-gray-200 pt-3 text-sm" data-testid="active-costs">
      <h4 className="font-medium text-nav-dark">Cost per lb of active <span className="font-normal text-secondary">({costs.label})</span></h4>
      {chem.product_form === 'liquid' && (
        <p className="text-secondary">
          Weight per gallon: {'lb_per_gal' in costs.density ? `${costs.density.lb_per_gal} lb/gal (approved)` : costReasonText(costs.density.reason)}
        </p>
      )}
      <p className="text-secondary">
        {costs.reference.source === 'bulk' && refSize ? `Figures use the bulk size, ${refSize.product_name}.`
          : costs.reference.source === 'picked' && refSize ? `Figures use the picked size, ${refSize.product_name}.`
            : `No figures for the product: ${costReasonText(costs.reference.reason ?? 'REFERENCE_UNSET')}.`}
      </p>
      {costs.reference.source !== 'bulk' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Select id="cost-reference" label="Reference size (no active bulk size)" value={picked} disabled={saving || pending}
              options={[{ value: '', label: 'None' }, ...costs.sizes.filter((size) => size.is_active).map((size) => ({ value: size.product_id, label: size.product_name }))]}
              onChange={(event) => setPicked(event.target.value)} />
          </div>
          <Button size="sm" onClick={() => void saveReference()} loading={saving} disabled={pending || picked === current}>Save reference</Button>
        </div>
      )}
      {costs.parent_figures && (costs.parent_figures.length > 0
        ? <ul className="space-y-0.5">{costs.parent_figures.map((row) => <FigureLine key={row.row_id} row={row} pricedUnit={refSize?.priced_unit ?? null} />)}</ul>
        : <p className="text-secondary">No ingredients or nutrients recorded.</p>)}
      {costs.sizes.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-nav-dark">Each size</summary>
          <ul className="space-y-2">
            {costs.sizes.map((size) => (
              <li key={size.product_id} className="rounded-lg border border-gray-200 px-3 py-2">
                <div className="font-medium text-nav-dark">
                  {size.product_name}{size.is_active ? '' : ' (inactive)'}
                  <span className="font-normal text-secondary">
                    {' '}· {size.cost_per_base ? `${centsText(size.cost_per_base.cents)} per ${size.cost_per_base.base}` : costReasonText(size.cost_reason ?? '', size.priced_unit)}
                  </span>
                </div>
                {size.figures.length > 0 && <ul className="space-y-0.5">{size.figures.map((row) => <FigureLine key={row.row_id} row={row} pricedUnit={size.priced_unit} />)}</ul>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------------------------

type FormRequest = { kind: 'entry' } | { kind: 'correct'; parentId: string; prefill: ReplacePrefill | null } | { kind: 'review' };
type OpenForm = (FormRequest & { token: number }) | null;

/**
 * DM-1: a parent's ingredients, modes of action and fertilizer analysis, shared by every size. Everyone signed in
 * reads it; admins enter, correct, review the ingredient list and see cost per lb of active (admin only).
 */
export default function ProductChemistrySection({ parentId, parentVersion, isAdmin, profileId, busy }: {
  parentId: string; parentVersion: number; isAdmin: boolean; profileId: string;
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
  const forKey = JSON.stringify([parentId, parentVersion, attempt]);
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
  const finished = (outcome: 'saved' | 'stale' | 'uncertain' | 'refused') => {
    setPendingTick((n) => n + 1);
    if (outcome !== 'refused') { setForm(null); reload(); }
  };

  const chem = state?.status === 'loaded' ? state.chem : null;
  const gated = chem?.epa_refusal != null;
  const locked = busy || pending.length > 0;
  const recorded = chem ? chem.chemistry.ingredients.length + chem.chemistry.fertilizer.length > 0 : false;
  return (
    <Card data-testid="product-chemistry">
      <CardHeader title="Chemistry" action={isAdmin && chem ? (
        <div className="flex flex-wrap justify-end gap-2">
          {!gated && chem.is_active && <Button size="sm" variant="secondary" disabled={locked} onClick={() => open({ kind: 'entry' })}>Add</Button>}
          {recorded && <Button size="sm" variant="secondary" disabled={locked} onClick={() => open({ kind: 'correct', parentId, prefill: null })}>Correct</Button>}
          <Button size="sm" variant="secondary" onClick={() => open({ kind: 'review' })}>
            Review ingredients{waiting ? ` (${waiting} waiting)` : ''}
          </Button>
        </div>
      ) : undefined} />
      <div className="space-y-3">
        {!state && <p className="text-sm text-secondary" role="status">Loading chemistry…</p>}
        {state?.status === 'failed' && <LoadFailedState title="Chemistry could not be loaded" onRetry={reload} />}
        {chem && (
          <>
            <PendingSavesNotice records={pending} onSettled={(outcome) => finished(outcome === 'uncertain' ? 'uncertain' : 'saved')} />
            {gated && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-secondary" role="status">{plainRefusal(chem.epa_refusal ?? '')}</p>}
            {busy && isAdmin && <p className="text-xs text-secondary">Save or discard the other changes on this page before changing chemistry.</p>}
            <p className="text-xs text-secondary">Shared by every size of {chem.parent_name}.</p>
            <ChemistryLists values={chem.chemistry} />
            {isAdmin && <ActiveCostsPanel chem={chem} profileId={profileId} reloadKey={forKey} pending={pending.length > 0} onSaveSettled={() => setPendingTick((n) => n + 1)} />}
          </>
        )}
      </div>
      {form?.kind === 'entry' && chem && (
        <EntryModal key={form.token} chem={chem} profileId={profileId} onClose={() => setForm(null)} onFinished={finished} />
      )}
      {form?.kind === 'correct' && (
        <CorrectionModal key={form.token} parentId={form.parentId} prefill={form.prefill} profileId={profileId} onClose={() => setForm(null)} onFinished={finished} />
      )}
      {form?.kind === 'review' && (
        <IngredientReviewModal key={form.token} profileId={profileId}
          onClose={() => { setForm(null); reload(); }}
          onReplace={(replaceParentId, prefill) => open({ kind: 'correct', parentId: replaceParentId, prefill })} />
      )}
    </Card>
  );
}
