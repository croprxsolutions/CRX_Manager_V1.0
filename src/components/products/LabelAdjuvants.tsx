import { useState } from 'react';
import { normalizeEpaRegistration, type LabelAdjuvant, type LookupState, type RegistrationRow } from '../../lib/epaRegistrationStatus';
import LabelAdjuvantsModal from './LabelAdjuvantsModal';

function Types({ entry }: { entry: LabelAdjuvant }) {
  const joiner = entry.kind === 'do_not_use' ? ' or ' : ', ';
  return (
    <>
      {entry.adjuvant_types.map((type, i) => (
        <span key={type}>
          {i > 0 && joiner}
          {type === entry.preferred ? <><strong>{type}</strong> (preferred)</> : type}
        </span>
      ))}
    </>
  );
}

/** "Requires one of:", "Recommended:", "Do not use:"; lower-cased after a "When ...:" condition. */
function lead(entry: LabelAdjuvant, conditional: boolean): string {
  const many = entry.adjuvant_types.length > 1;
  const text = entry.kind === 'do_not_use' ? 'Do not use: '
    : `${entry.kind === 'required' ? 'Requires' : 'Recommended'}${many ? ' one of' : ''}: `;
  return conditional ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** One line per label statement, condition first (USE-2 sheet 3.1). */
export function LabelAdjuvantLines({ list }: { list: LabelAdjuvant[] }) {
  return (
    <ul className="space-y-0.5">
      {list.map((entry, i) => (
        // Statements have no id; their order is the saved order.
        <li key={i} className={entry.kind === 'do_not_use' ? 'text-red-700' : entry.kind === 'recommended' ? 'text-secondary' : 'text-nav-dark'}>
          {entry.when && <strong>When {entry.when}: </strong>}
          {lead(entry, Boolean(entry.when))}
          <Types entry={entry} />
          {entry.note && <span className="block text-xs text-secondary">{entry.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * What the label says about adjuvants for one saved EPA number, and (admins and sales reps) the editor.
 * `row` undefined with lookup `done` means no registration is stored for the number yet.
 */
export default function LabelAdjuvants({ epaRegistration, row, lookup, canEdit, profileId, onSaved }: {
  epaRegistration: string | null | undefined;
  row: RegistrationRow | undefined;
  lookup: LookupState;
  canEdit: boolean;
  profileId: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const number = normalizeEpaRegistration(epaRegistration);
  if (!number || !/^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$/.test(number)) return null;
  // The editor stays open while the page re-reads (after a save someone else beat), so a draft is never lost.
  const editor = editing && (
    <LabelAdjuvantsModal epaRegistration={number} row={row} profileId={profileId}
      onSaved={onSaved} onClose={() => setEditing(false)} />
  );
  const list = row?.label_adjuvants;
  let content = null;
  if (lookup === 'failed') content = <p className="text-xs text-amber-700">Couldn&apos;t check the label; reload</p>;
  else if (lookup === 'done') {
    content = (
      <>
        {row && list === null && <p className="text-secondary">Label adjuvants: not reviewed</p>}
        {row && list?.length === 0 && <p className="text-secondary">Label adjuvants: none on the label</p>}
        {list && list.length > 0 && (
          <div>
            <p className="text-xs font-medium text-secondary">Label adjuvants</p>
            <LabelAdjuvantLines list={list} />
          </div>
        )}
        {/* With no registration stored, editors still get the button: the save creates it. */}
        {canEdit && (
          <button type="button" onClick={() => setEditing(true)} className="mt-0.5 text-xs font-medium text-crx-green hover:underline">
            Edit adjuvants
          </button>
        )}
      </>
    );
  }
  if (!editor && (lookup === 'checking' || (lookup === 'done' && !row && !canEdit))) return null;
  // Same tree shape in every state, so the editor is never remounted.
  return <div className="text-sm">{content}{editor}</div>;
}
