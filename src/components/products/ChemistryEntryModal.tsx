import { useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import {
  BASIS_LABEL, NUTRIENTS, SCHEMES, SOURCE_LABEL, UNIT_LABEL, EMPTY_NEW_INGREDIENT, ingredientLine, newIngredientFields, newIngredientProblem,
  nutrientLabel, startChemistrySave, type ChemistryChange, type NewIngredientDraft,
} from '../../lib/productChemistry';
import { IngredientSearch, NewIngredientFields } from './IngredientPicker';
import { ModeRows, StrengthFields } from './ChemistryParts';
import {
  SOURCE_OPTIONS, amountOf, nextKey, reportSaveError, type ModeDraft, type SaveOutcome, type StrengthDraft, type TypedSource,
} from './chemistryFormHelpers';
import type {
  ActiveIngredientSummary, FertilizerBasis, FertilizerNutrient, ModeOfActionScheme, ParentChemistry, ParentChemistryFertilizerRow,
  ParentChemistryIngredientRow,
} from '../../types';

interface IngredientDraft extends StrengthDraft {
  key: number; existing: ActiveIngredientSummary | null; creating: boolean; fresh: NewIngredientDraft; modes: ModeDraft[];
}
interface ExtraModeDraft extends ModeDraft { ingredientId: string }
interface NutrientDraft { key: number; nutrient: FertilizerNutrient | ''; basis: FertilizerBasis; amount: string; unknown: boolean; source: TypedSource; note: string }
type Problem = string | null;

const newIngredientDraft = (): IngredientDraft => ({
  key: nextKey(), existing: null, creating: false, fresh: EMPTY_NEW_INGREDIENT, amount: '', unknown: false,
  unit: 'pct_ww', basis: 'active_ingredient', source: 'label', note: '', modes: [],
});
const newNutrientDraft = (): NutrientDraft => ({ key: nextKey(), nutrient: '', basis: 'elemental', amount: '', unknown: false, source: 'label', note: '' });
const strengthMax = (unit: string) => (unit === 'pct_ww' ? 100 : 20);

// Each builder appends to `out` and returns the first problem, or null.

function fillChanges(ingredients: ParentChemistryIngredientRow[], nutrients: ParentChemistryFertilizerRow[], fills: Record<string, string>, out: ChemistryChange[]): Problem {
  for (const row of ingredients) {
    const text = fills[row.row_id]?.trim();
    if (!text) continue;
    const value = amountOf(text, false, strengthMax(row.strength_unit), `strength of ${row.name}`);
    if (typeof value === 'string') return value;
    out.push({ kind: 'ingredient', ingredient_id: row.ingredient_id, strength_value: value, strength_unit: row.strength_unit,
      strength_basis: row.strength_basis, source: row.source, source_note: row.source_note });
  }
  for (const row of nutrients) {
    const text = fills[row.row_id]?.trim();
    if (!text) continue;
    const value = amountOf(text, false, 100, `percent of ${row.nutrient}`);
    if (typeof value === 'string') return value;
    out.push({ kind: 'fertilizer', nutrient: row.nutrient, basis: row.basis, percent: value, source: row.source, source_note: row.source_note });
  }
  return null;
}

function ingredientDraftChange(draft: IngredientDraft, index: number, picked: Set<string>, out: ChemistryChange[], modesOut: ChemistryChange[]): Problem {
  const name = draft.existing?.name ?? (draft.fresh.name.trim() || `ingredient ${index + 1}`);
  if (!draft.existing && !draft.creating) return `Pick or describe ingredient ${index + 1}.`;
  const freshProblem = draft.creating ? newIngredientProblem(draft.fresh) : null;
  if (freshProblem) return `${name}: ${freshProblem}`;
  if (draft.existing && picked.has(draft.existing.id)) return `${name} is listed twice.`;
  if (draft.existing) picked.add(draft.existing.id);
  const value = amountOf(draft.amount, draft.unknown, strengthMax(draft.unit), `strength of ${name}`);
  if (typeof value === 'string') return value;
  const ref = `new-${draft.key}`;
  out.push({
    kind: 'ingredient', ...(draft.existing ? { ingredient_id: draft.existing.id } : { ref, ...newIngredientFields(draft.fresh) }),
    strength_value: value, strength_unit: draft.unit, strength_basis: draft.basis, source: draft.source, source_note: draft.note.trim() || null,
  });
  for (const mode of draft.modes) {
    if (!mode.code.trim()) return `Give the group of each mode of action of ${name}.`;
    modesOut.push({ kind: 'mode_of_action', ...(draft.existing ? { ingredient_id: draft.existing.id } : { ingredient_ref: ref }),
      scheme: mode.scheme, group_code: mode.code.trim() });
  }
  return null;
}

function extraModeChanges(modes: ExtraModeDraft[], modesOut: ChemistryChange[]): Problem {
  for (const mode of modes) {
    if (!mode.ingredientId || !mode.code.trim()) return 'Pick the ingredient and give the group of each mode of action.';
    modesOut.push({ kind: 'mode_of_action', ingredient_id: mode.ingredientId, scheme: mode.scheme, group_code: mode.code.trim() });
  }
  return null;
}

function nutrientDraftChanges(nutrients: NutrientDraft[], out: ChemistryChange[]): Problem {
  const seen = new Set<string>();
  for (const draft of nutrients) {
    if (!draft.nutrient) return 'Pick each nutrient.';
    if (seen.has(draft.nutrient)) return `${draft.nutrient} is listed twice.`;
    seen.add(draft.nutrient);
    const value = amountOf(draft.amount, draft.unknown, 100, `percent of ${draft.nutrient}`);
    if (typeof value === 'string') return value;
    out.push({ kind: 'fertilizer', nutrient: draft.nutrient, basis: draft.basis, percent: value, source: draft.source, source_note: draft.note.trim() || null });
  }
  return null;
}

function buildEntry(input: {
  unknownIngredients: ParentChemistryIngredientRow[]; unknownNutrients: ParentChemistryFertilizerRow[]; fills: Record<string, string>;
  ingredients: IngredientDraft[]; extraModes: ExtraModeDraft[]; nutrients: NutrientDraft[];
}): { changes: ChemistryChange[]; problem: Problem } {
  const changes: ChemistryChange[] = [];
  const modeChanges: ChemistryChange[] = [];
  const picked = new Set<string>();
  const problem = fillChanges(input.unknownIngredients, input.unknownNutrients, input.fills, changes)
    ?? input.ingredients.reduce<Problem>((found, draft, index) => found ?? ingredientDraftChange(draft, index, picked, changes, modeChanges), null)
    ?? extraModeChanges(input.extraModes, modeChanges)
    ?? nutrientDraftChanges(input.nutrients, changes);
  if (problem) return { changes, problem };
  const all = [...changes, ...modeChanges];
  return { changes: all, problem: all.length === 0 ? 'Nothing to save yet.' : null };
}

function FillUnknowns({ ingredients, nutrients, fills, onFill }: {
  ingredients: ParentChemistryIngredientRow[]; nutrients: ParentChemistryFertilizerRow[]; fills: Record<string, string>; onFill: (rowId: string, text: string) => void;
}) {
  if (ingredients.length === 0 && nutrients.length === 0) return null;
  return (
    <section className="space-y-2">
      <h4 className="font-medium text-nav-dark">Fill an unknown amount</h4>
      <p className="text-xs text-secondary">The unit, basis and source stay as recorded; change those with Correct.</p>
      {ingredients.map((row) => (
        <Input key={row.row_id} id={`fill-${row.row_id}`} inputMode="decimal" maxLength={20}
          label={`${row.name} (${UNIT_LABEL[row.strength_unit]} ${BASIS_LABEL[row.strength_basis]}, from ${SOURCE_LABEL[row.source]})`}
          value={fills[row.row_id] ?? ''} onChange={(event) => onFill(row.row_id, event.target.value)} />
      ))}
      {nutrients.map((row) => (
        <Input key={row.row_id} id={`fill-${row.row_id}`} inputMode="decimal" maxLength={20}
          label={`${nutrientLabel(row.nutrient, row.basis)} percent (${BASIS_LABEL[row.basis]}, from ${SOURCE_LABEL[row.source]})`}
          value={fills[row.row_id] ?? ''} onChange={(event) => onFill(row.row_id, event.target.value)} />
      ))}
    </section>
  );
}

function IngredientDraftCard({ draft, index, form, onParent, saving, onPatch, onRemove }: {
  draft: IngredientDraft; index: number; form: string; onParent: string[]; saving: boolean;
  onPatch: (patch: Partial<IngredientDraft>) => void; onRemove: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Ingredient {index + 1}</span>
        <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>
      </div>
      {draft.existing ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{ingredientLine(draft.existing)}</span>
          <Button size="sm" variant="secondary" onClick={() => onPatch({ existing: null })}>Change</Button>
        </div>
      ) : draft.creating ? (
        <>
          <NewIngredientFields idPrefix={`new-${draft.key}`} draft={draft.fresh} disabled={saving} onChange={(fresh) => onPatch({ fresh })} />
          <Button size="sm" variant="ghost" onClick={() => onPatch({ creating: false, fresh: EMPTY_NEW_INGREDIENT })}>Search the list instead</Button>
        </>
      ) : (
        <>
          <IngredientSearch id={`pick-${draft.key}`} label="Find the ingredient" disabled={saving} excludeIds={onParent}
            onPick={(existing) => onPatch({ existing })} />
          <Button size="sm" variant="secondary" onClick={() => onPatch({ creating: true })}>It is not listed: add a new ingredient</Button>
        </>
      )}
      <StrengthFields idPrefix={`ing-${draft.key}`} form={form} draft={draft} disabled={saving} onChange={onPatch} />
      <ModeRows idPrefix={`ing-${draft.key}-moa`} modes={draft.modes} disabled={saving} onChange={(modes) => onPatch({ modes })} />
    </div>
  );
}

function ExtraModes({ recorded, modes, onChange }: { recorded: ParentChemistryIngredientRow[]; modes: ExtraModeDraft[]; onChange: (modes: ExtraModeDraft[]) => void }) {
  if (recorded.length === 0) return null;
  const patch = (index: number, change: Partial<ExtraModeDraft>) => onChange(modes.map((item, at) => (at === index ? { ...item, ...change } : item)));
  return (
    <section className="space-y-2">
      <h4 className="font-medium text-nav-dark">Add a mode of action to a recorded ingredient</h4>
      {modes.map((mode, index) => (
        <div key={mode.key} className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Select id={`moa-ing-${mode.key}`} label="Ingredient" value={mode.ingredientId} placeholder="Pick one"
              options={recorded.map((row) => ({ value: row.ingredient_id, label: row.name }))}
              onChange={(event) => patch(index, { ingredientId: event.target.value })} />
          </div>
          <div className="w-28">
            <Select id={`moa-scheme-${mode.key}`} label="Scheme" value={mode.scheme} options={SCHEMES.map((scheme) => ({ value: scheme, label: scheme }))}
              onChange={(event) => patch(index, { scheme: event.target.value as ModeOfActionScheme })} />
          </div>
          <div className="w-28">
            <Input id={`moa-code-${mode.key}`} label="Group" maxLength={10} value={mode.code} onChange={(event) => patch(index, { code: event.target.value })} />
          </div>
          <Button size="sm" variant="ghost" onClick={() => onChange(modes.filter((_, at) => at !== index))}>Remove</Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...modes, { key: nextKey(), ingredientId: '', scheme: 'HRAC', code: '' }])}>
        Add mode of action
      </Button>
    </section>
  );
}

function NutrientDraftCard({ draft, recordedNutrients, onPatch, onRemove }: {
  draft: NutrientDraft; recordedNutrients: string[]; onPatch: (patch: Partial<NutrientDraft>) => void; onRemove: () => void;
}) {
  const hasOxide = draft.nutrient === 'P' || draft.nutrient === 'K';
  return (
    <div className="grid gap-2 rounded-lg border border-gray-200 p-3 sm:grid-cols-2">
      <Select id={`nut-${draft.key}`} label="Nutrient" value={draft.nutrient} placeholder="Pick one"
        options={NUTRIENTS.filter((nutrient) => !recordedNutrients.includes(nutrient)).map((nutrient) => ({ value: nutrient, label: nutrient }))}
        onChange={(event) => {
          const nutrient = event.target.value as FertilizerNutrient;
          onPatch({ nutrient, basis: nutrient === 'P' || nutrient === 'K' ? draft.basis : 'elemental' });
        }} />
      <Select id={`nut-basis-${draft.key}`} label="Basis" value={draft.basis}
        options={[{ value: 'elemental', label: 'Elemental' }, ...(hasOxide ? [{ value: 'oxide', label: draft.nutrient === 'P' ? 'Oxide (P₂O₅)' : 'Oxide (K₂O)' }] : [])]}
        onChange={(event) => onPatch({ basis: event.target.value as FertilizerBasis })} />
      <Input id={`nut-pct-${draft.key}`} label="Percent" inputMode="decimal" maxLength={20} value={draft.amount} disabled={draft.unknown}
        onChange={(event) => onPatch({ amount: event.target.value })} />
      <label className="flex min-h-11 items-center gap-2 self-end text-sm text-nav-dark">
        <input type="checkbox" checked={draft.unknown} onChange={(event) => onPatch({ unknown: event.target.checked })} />
        Label gives none (percent unknown)
      </label>
      <Select id={`nut-src-${draft.key}`} label="Source" value={draft.source} options={SOURCE_OPTIONS}
        onChange={(event) => onPatch({ source: event.target.value as TypedSource })} />
      <Input id={`nut-note-${draft.key}`} label="Source note (optional)" maxLength={1000} value={draft.note}
        onChange={(event) => onPatch({ note: event.target.value })} />
      <div className="sm:col-span-2">
        <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>
      </div>
    </div>
  );
}

/** Fast entry: add ingredients, modes of action and nutrients, or fill an unknown amount. */
export default function ChemistryEntryModal({ chem, profileId, onClose, onFinished }: {
  chem: ParentChemistry; profileId: string; onClose: () => void; onFinished: (outcome: SaveOutcome) => void;
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
  const { changes, problem } = buildEntry({ unknownIngredients, unknownNutrients, fills, ingredients, extraModes, nutrients });

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
  const started = changes.length + ingredients.length + nutrients.length + extraModes.length > 0;

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
        <FillUnknowns ingredients={unknownIngredients} nutrients={unknownNutrients} fills={fills}
          onFill={(rowId, text) => setFills((current) => ({ ...current, [rowId]: text }))} />
        <section className="space-y-3">
          <h4 className="font-medium text-nav-dark">Add ingredients</h4>
          {ingredients.map((draft, index) => (
            <IngredientDraftCard key={draft.key} draft={draft} index={index} form={chem.product_form} saving={saving}
              onParent={values.ingredients.map((row) => row.ingredient_id)} onPatch={(patch) => patchIngredient(draft.key, patch)}
              onRemove={() => setIngredients((rows) => rows.filter((row) => row.key !== draft.key))} />
          ))}
          <Button size="sm" variant="secondary" onClick={() => setIngredients((rows) => [...rows, newIngredientDraft()])}>Add an ingredient</Button>
        </section>
        <ExtraModes recorded={values.ingredients} modes={extraModes} onChange={setExtraModes} />
        <section className="space-y-2">
          <h4 className="font-medium text-nav-dark">Fertilizer analysis</h4>
          {nutrients.map((draft) => (
            <NutrientDraftCard key={draft.key} draft={draft} recordedNutrients={values.fertilizer.map((row) => row.nutrient)}
              onPatch={(patch) => patchNutrient(draft.key, patch)} onRemove={() => setNutrients((rows) => rows.filter((row) => row.key !== draft.key))} />
          ))}
          <Button size="sm" variant="secondary" onClick={() => setNutrients((rows) => [...rows, newNutrientDraft()])}>Add a nutrient</Button>
        </section>
        {problem && started && <p className="text-sm text-amber-800" role="status">{problem}</p>}
      </fieldset>
    </Modal>
  );
}
