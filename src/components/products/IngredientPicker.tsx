import { useEffect, useRef, useState } from 'react';
import Input from '../ui/Input';
import Button from '../ui/Button';
import { sanitizeError } from '../../lib/db';
import {
  casValid, ingredientLine, parseFraction, searchActiveIngredients, type NewIngredientDraft,
} from '../../lib/productChemistry';
import type { ActiveIngredientSummary } from '../../types';

/**
 * Searches active ingredients as the admin types. Only the latest reply is used: an older one arriving late
 * is dropped, and so is any reply after this picker closes (each opening is a new picker).
 */
export function IngredientSearch({ id, label, onPick, acidsOnly = false, disabled = false, excludeIds = [] }: {
  id: string; label: string; onPick: (item: ActiveIngredientSummary) => void; acidsOnly?: boolean; disabled?: boolean; excludeIds?: string[];
}) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<ActiveIngredientSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => () => { seq.current += 1; }, []);
  useEffect(() => {
    const mine = ++seq.current;
    // Old results go as soon as the text changes, so a late click never picks a match for earlier text.
    setResults(null); setFailed(null);
    if (text.trim().length < 2) return;
    const timer = window.setTimeout(() => {
      searchActiveIngredients(text.trim()).then((rows) => {
        if (mine === seq.current) { setResults(rows); setFailed(null); }
      }).catch((error: unknown) => { if (mine === seq.current) { setResults(null); setFailed(sanitizeError(error)); } });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const shown = (results ?? []).filter((item) => (!acidsOnly || item.is_parent_form) && !excludeIds.includes(item.id));
  return (
    <div className="space-y-1">
      <Input id={id} label={label} value={text} maxLength={200} disabled={disabled} placeholder="Type 2 or more letters, or a CAS number"
        onChange={(event) => setText(event.target.value)} />
      {failed && <p className="text-sm text-red-700" role="alert">{failed}</p>}
      {results && shown.length === 0 && <p className="text-sm text-secondary">No {acidsOnly ? 'acid ' : ''}ingredient found.</p>}
      {shown.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-gray-200">
          {shown.map((item) => (
            <li key={item.id}>
              <button type="button" disabled={disabled} className="min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                onClick={() => { onPick(item); setText(''); setResults(null); }}>
                {ingredientLine(item)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NewIngredientFields({ idPrefix, draft, onChange, disabled }: {
  idPrefix: string; draft: NewIngredientDraft; onChange: (draft: NewIngredientDraft) => void; disabled: boolean;
}) {
  const casError = draft.cas.trim() && !casValid(draft.cas) ? 'Not a valid CAS number (format or check digit)' : undefined;
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3">
      <Input id={`${idPrefix}-name`} label="Ingredient name (the specific form, e.g. glyphosate isopropylamine salt)" maxLength={200}
        value={draft.name} disabled={disabled} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      <Input id={`${idPrefix}-cas`} label="CAS number (if known)" maxLength={12} value={draft.cas} disabled={disabled} error={casError}
        onChange={(event) => onChange({ ...draft, cas: event.target.value })} />
      <label className="flex min-h-11 items-center gap-2 text-sm text-nav-dark">
        <input type="checkbox" checked={draft.isAcid} disabled={disabled || draft.acid !== null}
          onChange={(event) => onChange({ ...draft, isAcid: event.target.checked })} />
        This is the acid other forms are measured as
      </label>
      {!draft.isAcid && (draft.acid ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Measured as acid: {draft.acid.name}</span>
          <Button size="sm" variant="secondary" showChevron={false} disabled={disabled}
            onClick={() => onChange({ ...draft, acid: null, fraction: '' })}>Remove acid</Button>
        </div>
      ) : (
        <IngredientSearch id={`${idPrefix}-acid`} label="Acid it is measured as (only if the label states one)" acidsOnly disabled={disabled}
          onPick={(acid) => onChange({ ...draft, acid })} />
      ))}
      {draft.acid && (
        <Input id={`${idPrefix}-fraction`} label="Acid fraction (if the label states one, e.g. 0.741)" inputMode="decimal" maxLength={20}
          value={draft.fraction} disabled={disabled}
          error={parseFraction(draft.fraction) === 'invalid' ? 'Above 0 and at most 1' : undefined}
          onChange={(event) => onChange({ ...draft, fraction: event.target.value })} />
      )}
    </div>
  );
}
