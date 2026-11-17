import { useEffect, useRef, useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Modal from '../ui/Modal';
import { LoadFailedState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { Sentry } from '../../lib/sentry';
import {
  SCHEMES, fetchIngredientModeUsers, ingredientModesScope, pendingSaves, refusalCode, startChemistrySave, type IngredientModeUsers,
} from '../../lib/productChemistry';
import { PendingSavesNotice } from './ChemistryParts';
import { errorOf, nextKey, reportSaveError } from './chemistryFormHelpers';
import type { IngredientModeEntry, ModeOfActionScheme } from '../../types';

interface GroupDraft { key: number; scheme: ModeOfActionScheme; code: string; note: string }

const MAX_GROUPS = 10;
const draftsOf = (modes: IngredientModeEntry[]): GroupDraft[] =>
  modes.map((mode) => ({ key: nextKey(), scheme: mode.scheme, code: mode.group_code, note: mode.source_note }));
const entryOf = (draft: GroupDraft): IngredientModeEntry => ({ scheme: draft.scheme, group_code: draft.code.trim().toUpperCase(), source_note: draft.note.trim() });
// JSON per entry, so a note containing a separator can never make two different lists compare equal.
const codeSet = (modes: IngredientModeEntry[]) => JSON.stringify(modes.map((mode) => JSON.stringify([mode.scheme, mode.group_code])).sort());
const fullSet = (modes: IngredientModeEntry[]) => JSON.stringify(modes.map((mode) => JSON.stringify([mode.scheme, mode.group_code, mode.source_note])).sort());

/** What is wrong with the list, or null. The database checks all of it again (and refuses an equivalent spelling). */
function listProblem(entries: IngredientModeEntry[], reason: string): string | null {
  if (entries.length > MAX_GROUPS) return `An ingredient has at most ${MAX_GROUPS} groups.`;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!/^[A-Z0-9]{1,10}$/.test(entry.group_code)) return 'Each group is 1 to 10 letters or digits, like 9 or M3.';
    if (!entry.source_note || entry.source_note.length > 1000) return `Say where ${entry.scheme} ${entry.group_code} is from.`;
    const id = `${entry.scheme}:${entry.group_code}`;
    if (seen.has(id)) return `${entry.scheme} ${entry.group_code} is listed twice.`;
    seen.add(id);
  }
  if (!reason.trim() || reason.trim().length > 1000) return 'Say why the groups change.';
  return null;
}

const reachText = (products: number, codesChanged: boolean) => {
  const count = `${products} product${products === 1 ? '' : 's'}`;
  return codesChanged ? `This changes the groups shown on ${count}.` : `Used by ${count}.`;
};

function GroupRows({ rows, onChange }: { rows: GroupDraft[]; onChange: (update: (current: GroupDraft[]) => GroupDraft[]) => void }) {
  const patch = (key: number, change: Partial<GroupDraft>) => onChange((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-2">
          <div className="w-28">
            <Select id={`grp-scheme-${row.key}`} label="Scheme" value={row.scheme}
              options={SCHEMES.map((scheme) => ({ value: scheme, label: scheme }))}
              onChange={(event) => patch(row.key, { scheme: event.target.value as ModeOfActionScheme })} />
          </div>
          <div className="w-28">
            <Input id={`grp-code-${row.key}`} label="Group" maxLength={10} value={row.code} onChange={(event) => patch(row.key, { code: event.target.value })} />
          </div>
          <div className="min-w-48 flex-1">
            <Input id={`grp-note-${row.key}`} label="Where is this from?" maxLength={1000} value={row.note} placeholder="e.g. HRAC 2024 classification"
              onChange={(event) => patch(row.key, { note: event.target.value })} />
          </div>
          <Button size="sm" variant="ghost" onClick={() => onChange((current) => current.filter((item) => item.key !== row.key))}>Remove</Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" disabled={rows.length >= MAX_GROUPS}
        onClick={() => onChange((current) => [...current, { key: nextKey(), scheme: 'HRAC', code: '', note: '' }])}>
        Add a group
      </Button>
    </div>
  );
}

/**
 * MOA-1: one ingredient's resistance group list (sheet section 5). Every product containing the ingredient, and every
 * salt or ester of it with no list of its own, shows these groups. Admin only; the database refuses anyone else.
 */
export default function IngredientGroupsModal({ ingredientId, ingredientName, acidName, profileId, onClose, onSaved }: {
  ingredientId: string; ingredientName: string;
  /** Set when the product shows this ingredient's acid's groups because it has no list of its own. */
  acidName: string | null;
  profileId: string; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const scope = ingredientModesScope(ingredientId);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; status: 'failed' } | { attempt: number; status: 'loaded'; users: IngredientModeUsers } | null>(null);
  const [rows, setRows] = useState<GroupDraft[]>([]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingTick, setPendingTick] = useState(0);
  const loadSeq = useRef(0);
  const reload = () => setAttempt((n) => n + 1);

  useEffect(() => {
    // Only the newest load for this ingredient lands: a slow reply never shows (or sends back) another list.
    const seq = ++loadSeq.current;
    fetchIngredientModeUsers(ingredientId).then((users) => {
      if (seq !== loadSeq.current) return;
      if (users.ingredient_id !== ingredientId) throw new Error('get_ingredient_mode_users answered for another ingredient');
      setResult({ attempt, status: 'loaded', users });
      setRows(draftsOf(users.modes));
    }).catch((error: unknown) => {
      if (seq !== loadSeq.current) return;
      Sentry.captureException(errorOf(error), { extra: { context: 'get_ingredient_mode_users' } });
      setResult({ attempt, status: 'failed' });
    });
  }, [ingredientId, attempt]);

  void pendingTick;
  const pending = pendingSaves(profileId, scope);
  // A reload shows "Loading" (and locks the form) until its own answer lands.
  const loaded = result?.attempt === attempt ? result : { status: 'loading' as const };
  const users = loaded.status === 'loaded' ? loaded.users : null;
  const entries = rows.map(entryOf);
  const codesChanged = users ? codeSet(entries) !== codeSet(users.modes) : false;
  const changed = users ? fullSet(entries) !== fullSet(users.modes) : false;
  const problem = changed ? listProblem(entries, reason) : null;
  const locked = saving || pending.length > 0 || !users;

  const save = async () => {
    if (!users || !changed || problem || locked) return;
    setSaving(true);
    try {
      await startChemistrySave(profileId, scope, 'set_active_ingredient_modes',
        { p_ingredient_id: ingredientId, p_expected_modes: users.modes, p_modes: entries, p_reason: reason.trim() },
        `Groups of ${users.name}`);
      toast('success', `Groups of ${users.name} saved`);
      onSaved();
    } catch (error) {
      if (refusalCode(error) === 'MOA_LIST_STALE') {
        toast('warning', 'Someone else just changed these groups. The current list is loaded; make your change again.');
        reload();
      } else {
        reportSaveError(error, toast);
        setPendingTick((n) => n + 1);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} closeDisabled={saving} title={`Groups of ${users?.name ?? ingredientName}`} size="large"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} loading={saving} disabled={locked || !changed || problem !== null}>Save groups</Button>
        </>
      )}>
      <div className="space-y-4">
        <PendingSavesNotice records={pending} onSettled={(outcome) => {
          setPendingTick((n) => n + 1);
          if (outcome === 'saved') onSaved();
          else if (outcome === 'refused') reload();
        }} />
        {loaded.status === 'loading' && <p className="text-sm text-secondary" role="status">Loading groups…</p>}
        {loaded.status === 'failed' && <LoadFailedState title="Groups could not be loaded" onRetry={reload} />}
        {users && (
          <fieldset disabled={locked} className="space-y-4">
            <p className="text-sm text-secondary">
              Resistance groups of the ingredient itself. Every product containing {users.name} shows them, and so does each salt or
              ester of it that has no list of its own.
            </p>
            <p className="text-sm text-nav-dark" role="status">
              {reachText(users.products_affected, codesChanged)}
            </p>
            {users.modes.length === 0 && acidName && (
              <p className="text-sm text-secondary">No list of its own yet, so products show {acidName}'s groups. Saving a list here replaces those for {users.name}.</p>
            )}
            <GroupRows rows={rows} onChange={setRows} />
            <Input id="grp-reason" label="Why are the groups changing?" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
            {problem && <p className="text-sm text-amber-800" role="status">{problem}</p>}
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
