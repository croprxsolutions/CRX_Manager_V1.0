import { sanitizeError } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { CHEMISTRY_SOURCES, ChemistrySaveUncertain, ingredientLine, parseAmount, refusalCode } from '../../lib/productChemistry';
import type {
  ActiveIngredientSummary, ChemistrySource, ChemistryStrengthBasis, ChemistryStrengthUnit, ModeOfActionScheme, ParentChemistryIngredientRow,
} from '../../types';

export type TypedSource = Exclude<ChemistrySource, 'epa_lookup'>;
export type SaveOutcome = 'saved' | 'stale' | 'uncertain' | 'refused';
export interface ModeDraft { key: number; scheme: ModeOfActionScheme; code: string }
export interface StrengthDraft { amount: string; unknown: boolean; unit: ChemistryStrengthUnit; basis: ChemistryStrengthBasis; source: TypedSource; note: string }
/** What the review pop-up's Replace asks for: on this parent, put `withIngredient` where `ingredientId` is. */
export interface ReplacePrefill { ingredientId: string; withIngredient: ActiveIngredientSummary }

export const SOURCE_OPTIONS = CHEMISTRY_SOURCES.map((item) => ({ value: item.value, label: item.label }));
export const BASIS_OPTIONS = [{ value: 'active_ingredient', label: 'Active ingredient (a.i.)' }, { value: 'acid_equivalent', label: 'Acid equivalent (a.e.)' }];
export const typedSource = (source: ChemistrySource): TypedSource => (source === 'epa_lookup' ? 'label' : source);
export const unitOptions = (form: string) => [
  { value: 'pct_ww', label: '% w/w' },
  ...(form === 'liquid' ? [{ value: 'lb_per_gal', label: 'lb/gal' }] : []),
];
export const ingredientIdentity = (row: Pick<ParentChemistryIngredientRow, 'name' | 'cas' | 'is_parent_form' | 'canonical_name' | 'canonical_fraction'>) => ingredientLine(row);
export const modeKey = (scheme: string, code: string) => `${scheme}:${code}`;
export const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(sanitizeError(error)));
/** A preview's refusal in plain words, without the "Nothing was saved." a real save would add. */
export const previewRefusalText = (refusal: string) => sanitizeError({ message: refusal }).replace(/^Nothing was saved\.\s*/, '');

let draftKey = 0;
export const nextKey = () => { draftKey += 1; return draftKey; };

/** A save the database refused by name, or one whose outcome is unknown (its record is kept for "finish"). */
export function reportSaveError(error: unknown, toast: (type: 'error' | 'warning', message: string) => void): Exclude<SaveOutcome, 'saved'> {
  if (error instanceof ChemistrySaveUncertain) {
    Sentry.captureException(errorOf(error.cause), { extra: { context: 'chemistry_save_uncertain' } });
    toast('warning', error.message);
    return 'uncertain';
  }
  toast('error', sanitizeError(error));
  const code = refusalCode(error);
  return code === 'CHEMISTRY_STALE' || code === 'CHEMISTRY_PREVIEW_CHANGED' || code === 'COST_REFERENCE_STALE' ? 'stale' : 'refused';
}

/** A strength or percent: a number, null when marked unknown, or the problem. */
export function amountOf(text: string, unknown: boolean, max: number, what: string): number | null | string {
  if (unknown) return null;
  const value = parseAmount(text);
  if (value === null) return `Enter the ${what}, or tick "Label gives none".`;
  if (value === 'invalid' || value > max) return `The ${what} must be above 0 and at most ${max}.`;
  return value;
}
