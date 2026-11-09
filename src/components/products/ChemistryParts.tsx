import { useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import { useToast } from '../ui/Toast';
import { BASIS_LABEL, SCHEMES, SOURCE_LABEL, finishChemistrySave, nutrientLabel, parseAmount, strengthText, type PendingChemistrySave } from '../../lib/productChemistry';
import {
  BASIS_OPTIONS, SOURCE_OPTIONS, ingredientIdentity, nextKey, reportSaveError, unitOptions,
  type ModeDraft, type StrengthDraft, type TypedSource,
} from './chemistryFormHelpers';
import type { ChemistryStrengthBasis, ChemistryStrengthUnit, ModeOfActionScheme, ParentChemistryValues } from '../../types';

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

export function ModeRows({ idPrefix, modes, onChange, disabled }: { idPrefix: string; modes: ModeDraft[]; onChange: (modes: ModeDraft[]) => void; disabled: boolean }) {
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

export function StrengthFields({ idPrefix, form, draft, onChange, disabled }: {
  idPrefix: string; form: string; disabled: boolean; draft: StrengthDraft; onChange: (patch: Partial<StrengthDraft>) => void;
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
