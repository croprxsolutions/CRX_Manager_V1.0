import { useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { assertRpcResult, sanitizeError, supabaseUntyped } from '../../lib/db';
import { getRegistrations, type LabelAdjuvant, type RegistrationRow } from '../../lib/epaRegistrationStatus';
import { LabelAdjuvantLines } from './LabelAdjuvants';

const ADJUVANT_TYPES = ['NIS', 'COC', 'HSOC', 'MSO', 'HS-MSO', 'Vegetable oil', 'AMS', 'UAN',
  'Water conditioner', 'Drift reduction', 'Deposition aid', 'Defoamer'];
const KINDS: Array<{ value: LabelAdjuvant['kind']; label: string }> = [
  { value: 'required', label: 'Required' }, { value: 'recommended', label: 'Recommended' }, { value: 'do_not_use', label: 'Do not use' },
];
const fieldClass = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-nav-dark focus-visible:ring-2 focus-visible:ring-crx-green disabled:opacity-50';

interface Draft { kind: LabelAdjuvant['kind']; ticked: string[]; other: string; preferred: string; when: string; note: string }

const blank = (): Draft => ({ kind: 'required', ticked: [], other: '', preferred: '', when: '', note: '' });
const toDraft = (entry: LabelAdjuvant): Draft => ({
  kind: entry.kind,
  ticked: entry.adjuvant_types.filter((t) => ADJUVANT_TYPES.includes(t)),
  other: entry.adjuvant_types.filter((t) => !ADJUVANT_TYPES.includes(t)).join('\n'),
  preferred: entry.preferred ?? '',
  when: entry.when ?? '',
  note: entry.note ?? '',
});
// "Other" types are one per line (a type may contain commas; this editor never saves one with a line break).
const typesOf = (d: Draft) => [...d.ticked, ...d.other.split('\n').map((t) => t.trim()).filter(Boolean)];
const toEntry = (d: Draft): LabelAdjuvant => {
  const types = typesOf(d);
  return {
    kind: d.kind,
    adjuvant_types: types,
    ...(d.kind !== 'do_not_use' && types.includes(d.preferred) ? { preferred: d.preferred } : {}),
    ...(d.when.trim() ? { when: d.when.trim() } : {}),
    ...(d.note.trim() ? { note: d.note.trim() } : {}),
  };
};

/** The first thing wrong with the draft (the database checks the same rules), or null. */
function problem(none: boolean, drafts: Draft[], reason: string): string | null {
  if (!none && drafts.length === 0) return 'Add a statement, or tick "None on the label".';
  if (drafts.length > 50) return 'At most 50 statements.';
  for (const [i, d] of drafts.entries()) {
    const types = typesOf(d);
    const n = `Statement ${i + 1}`;
    if (types.length === 0) return `${n}: pick at least one adjuvant type.`;
    if (types.length > 8) return `${n}: at most 8 types.`;
    if (types.some((t) => t.length > 100)) return `${n}: a type is over 100 characters.`;
    if (new Set(types.map((t) => t.toLowerCase())).size !== types.length) return `${n}: a type is listed twice.`;
    if (d.when.trim().length > 200) return `${n}: "When" is over 200 characters.`;
    if (d.note.trim().length > 500) return `${n}: the note is over 500 characters.`;
  }
  if (!reason.trim()) return 'Say why (for example "from the 2025 label").';
  if (reason.trim().length > 1000) return 'The reason is over 1000 characters.';
  return null;
}

const codeOf = (error: unknown) => (error instanceof Error ? error.message
  : String((error as { message?: unknown } | null)?.message ?? '')).match(/^[A-Z][A-Z_]+/)?.[0] ?? null;

/** Admins and sales reps record what one EPA number's label says about adjuvants (USE-2 sheet 3.2). */
export default function LabelAdjuvantsModal({ epaRegistration, row, profileId, onSaved, onClose }: {
  /** Normalized. */
  epaRegistration: string;
  /** undefined: no registration stored yet; the save creates one. */
  row: RegistrationRow | undefined;
  profileId: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [version, setVersion] = useState<number | null>(row?.registration_version ?? null);
  const [none, setNone] = useState(row?.label_adjuvants?.length === 0);
  const [drafts, setDrafts] = useState<Draft[]>(() => (row?.label_adjuvants ?? []).map(toDraft));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a stale refusal: the list someone else saved (null = not reviewed), shown beside the kept draft.
  const [theirs, setTheirs] = useState<LabelAdjuvant[] | null | undefined>(undefined);
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('set_registration_adjuvants', profileId);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);

  const update = (i: number, change: Partial<Draft>) => setDrafts((all) => all.map((d, j) => (j === i ? { ...d, ...change } : d)));
  const toggle = (i: number, type: string) => setDrafts((all) => all.map((d, j) => {
    if (j !== i) return d;
    // Keep the list order, so the same choice always saves the same way.
    const ticked = d.ticked.includes(type) ? d.ticked.filter((t) => t !== type) : ADJUVANT_TYPES.filter((t) => t === type || d.ticked.includes(t));
    return { ...d, ticked };
  }));

  const save = async () => {
    const wrong = problem(none, drafts, reason);
    if (wrong) { setError(wrong); return; }
    const list = none ? [] : drafts.map(toEntry);
    const request = { epaRegistration, version, list, reason: reason.trim() };
    // One key per exact request: an unchanged retry (after a dropped connection) replays the first answer.
    const scope = JSON.stringify(request);
    setSaving(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabaseUntyped.rpc('set_registration_adjuvants', {
        p_epa_registration: epaRegistration, p_expected_version: version, p_adjuvants: list,
        p_reason: request.reason, p_idempotency_key: getKeyFor(scope),
      });
      if (rpcError) throw rpcError;
      assertRpcResult(data, 'set_registration_adjuvants');
      resetKeyFor(scope);
      onSaved();
      if (!open.current) return;
      toast('success', `Saved the label adjuvants for EPA ${epaRegistration}.`);
      onClose();
    } catch (err) {
      if (!open.current) return;
      const code = codeOf(err);
      if (code === 'EPA_REGISTRATION_STALE') {
        // The page re-reads too, so a reopened editor starts from the current version even if the read below fails.
        onSaved();
        try {
          const fresh = (await getRegistrations([epaRegistration])).get(epaRegistration);
          if (!open.current) return;
          setVersion(fresh?.registration_version ?? null);
          setTheirs(fresh?.label_adjuvants ?? null);
          setError('Someone else just saved this label. Their list is shown below; your edits are kept. Check them and save again.');
        } catch (readError) {
          if (open.current) setError(`Someone else just saved this label, and it could not be re-read: ${sanitizeError(readError)}. Close and reopen to see it.`);
        }
      } else if (code === 'EPA_REGISTRATION_NO_CHANGES') {
        setError('Nothing to save: the label already has exactly this list.');
      } else if (code) {
        setError(sanitizeError(err));
      } else {
        // No answer (for example a dropped connection): it may have saved. Same request, same key: a retry cannot save twice.
        setError(`No answer from the server: ${sanitizeError(err)}. Press Save again; it cannot save twice.`);
      }
    } finally {
      if (open.current) setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} closeDisabled={saving} title={`Label adjuvants: EPA ${epaRegistration}`} size="large"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} loading={saving} disabled={saving}>Save</Button>
        </>
      )}>
      <fieldset disabled={saving} className="space-y-4">
        <p className="text-sm text-secondary">This applies to every product and brand with EPA number {epaRegistration}.</p>
        {error && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</p>}
        {theirs !== undefined && (
          <div className="rounded-lg border border-amber-200 p-3 text-sm">
            <p className="mb-1 font-medium text-nav-dark">Just saved by someone else</p>
            {theirs === null ? <p className="text-secondary">Not reviewed</p>
              : theirs.length === 0 ? <p className="text-secondary">None on the label</p>
                : <LabelAdjuvantLines list={theirs} />}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-nav-dark">
          <input type="checkbox" checked={none} onChange={(e) => setNone(e.target.checked)} />
          None on the label
        </label>
        {!none && (
          <div className="space-y-3">
            {drafts.map((d, i) => {
              const types = typesOf(d);
              return (
                // Statements have no id; a removed row shifts the rest, which is fine for an unsaved form.
                <div key={i} className="space-y-2 rounded-lg border border-gray-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <select aria-label={`Statement ${i + 1} kind`} className={`${fieldClass} sm:w-48`} value={d.kind}
                      onChange={(e) => update(i, { kind: e.target.value as LabelAdjuvant['kind'] })}>
                      {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </select>
                    <Button size="sm" variant="secondary" onClick={() => setDrafts((all) => all.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                  <div role="group" aria-label={`Statement ${i + 1} types`} className="flex flex-wrap gap-x-4 gap-y-1">
                    {ADJUVANT_TYPES.map((type) => (
                      <label key={type} className="flex items-center gap-1.5 text-sm">
                        <input type="checkbox" checked={d.ticked.includes(type)} onChange={() => toggle(i, type)} />
                        {type}
                      </label>
                    ))}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <textarea aria-label={`Statement ${i + 1} other types`} className={fieldClass} value={d.other} rows={1} maxLength={850}
                      placeholder="Other (type it; one per line)" onChange={(e) => update(i, { other: e.target.value })} />
                    {d.kind !== 'do_not_use' && types.length > 1 && (
                      <select aria-label={`Statement ${i + 1} preferred`} className={fieldClass}
                        value={types.includes(d.preferred) ? d.preferred : ''} onChange={(e) => update(i, { preferred: e.target.value })}>
                        <option value="">No preferred type</option>
                        {types.map((t) => <option key={t} value={t}>Preferred: {t}</option>)}
                      </select>
                    )}
                    <input aria-label={`Statement ${i + 1} when`} className={fieldClass} value={d.when} maxLength={200}
                      placeholder="When (optional), e.g. tank mixed with atrazine" onChange={(e) => update(i, { when: e.target.value })} />
                    <input aria-label={`Statement ${i + 1} note`} className={fieldClass} value={d.note} maxLength={500}
                      placeholder="Note (optional), e.g. 1% v/v" onChange={(e) => update(i, { note: e.target.value })} />
                  </div>
                </div>
              );
            })}
            <Button size="sm" variant="secondary" onClick={() => setDrafts((all) => [...all, blank()])}>Add a statement</Button>
          </div>
        )}
        <div>
          <label htmlFor="label-adjuvants-reason" className="mb-1 block text-sm font-medium text-secondary">Why</label>
          <textarea id="label-adjuvants-reason" className={fieldClass} rows={2} maxLength={1000} value={reason}
            placeholder="e.g. read from the current label" onChange={(e) => setReason(e.target.value)} />
        </div>
      </fieldset>
    </Modal>
  );
}
