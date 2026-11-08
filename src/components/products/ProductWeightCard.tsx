import { useCallback, useEffect, useState } from 'react';
import Card, { CardHeader } from '../ui/Card';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import { LoadFailedState } from '../ui/EmptyState';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { BUSINESS_TIMEZONE } from '../../lib/dateUtils';
import {
  approveWeightDraft, draftMatchesBasis, fetchProductWeights, fetchWeightEvents, isLowerTrust, noWeightMessage,
  saveWeight, sourceText, storedWeightPreview, WEIGHT_SOURCES,
  type ProductWeightEntry, type WeightDraft, type WeightSubject,
} from '../../lib/productWeights';
import { ReasonField } from './ProductParentPanel';
import type { ProductWeightEvent, ProductWeightSource } from '../../types';

const when = (iso: string | null | undefined) =>
  (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: BUSINESS_TIMEZONE }) : 'an unknown date');
const unitLabel = (subject: WeightSubject, stockUnit: string | null | undefined) =>
  (subject.kind === 'density' ? 'lb/gal' : `lb per ${stockUnit ?? 'unit'}`);

const EVENT_LABELS: Record<string, string> = {
  draft_saved: 'Draft saved', draft_replaced: 'Draft replaced', approved: 'Approved',
  corrected: 'Corrected', returned_to_draft: 'Returned to draft',
};

/** The value of the row an event left in use (its `value_id`), from the event's after/before arrays. */
function eventValue(event: ProductWeightEvent): string | null {
  const rows = [...(event.after_value ?? []), ...(event.before_value ?? [])] as Array<{ value_id?: string; value?: unknown }>;
  const row = rows.find((item) => item?.value_id === event.value_id);
  return row?.value == null ? null : String(row.value);
}

function introText(subject: WeightSubject, entry: ProductWeightEntry): string {
  return subject.kind === 'density'
    ? `Weight per gallon for every size of ${subject.parent_name ?? 'this parent'}. Your entry is saved as approved by you.`
    : `Net pounds in one ${entry.inventory_unit ?? 'unit'} of ${entry.product_name ?? 'this size'}. Your entry is saved as approved by you.`;
}

function CorrectionFields({ approvedSource, source, reason, evidence, setReason, setEvidence }: {
  approvedSource: string | undefined; source: ProductWeightSource; reason: string; evidence: string;
  setReason: (value: string) => void; setEvidence: (value: string) => void;
}) {
  return (
    <>
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" role="status">
        The approved weight is from {sourceText(approvedSource)}, which is trusted more than {sourceText(source)}. A correction needs a reason and evidence.
      </p>
      <ReasonField id="weight-reason" label="Reason" value={reason} onChange={setReason} />
      <ReasonField id="weight-evidence" label="Evidence (what shows it)" value={evidence} onChange={setEvidence} />
    </>
  );
}

// The database refuses values above these (OUT_OF_RANGE), so Save is held back instead of failing.
const MAX_DENSITY_LB_PER_GAL = 20;
const MAX_NET_WEIGHT_LB = 4000;
/** The limit a stored preview is over, or null. */
function overLimit(stored: string | null, density: boolean): number | null {
  const max = density ? MAX_DENSITY_LB_PER_GAL : MAX_NET_WEIGHT_LB;
  return stored !== null && Number(stored) > max ? max : null;
}

const storedOk = (stored: string | null, tooHeavy: number | null) => stored !== null && Number(stored) > 0 && tooHeavy === null;

function EnterWeightModal({ subject, entry, profileId, startAsCorrection, onClose, onSaved, onStale }: {
  subject: WeightSubject;
  entry: ProductWeightEntry;
  profileId: string;
  startAsCorrection: boolean;
  onClose: () => void;
  onSaved: () => void;
  onStale: () => void;
}) {
  const { toast } = useToast();
  const density = subject.kind === 'density';
  const approvedSource = entry.weight?.kind === subject.kind ? entry.weight.source : undefined;
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<'lb_per_gal' | 'specific_gravity'>('lb_per_gal');
  const [source, setSource] = useState<ProductWeightSource>('sds');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [forceCorrection, setForceCorrection] = useState(startAsCorrection);
  const [saving, setSaving] = useState(false);
  const correction = forceCorrection || isLowerTrust(source, approvedSource);
  const stored = storedWeightPreview(value, density ? unit : 'lb');
  const tooHeavy = overLimit(stored, density);
  const ready = !saving && storedOk(stored, tooHeavy) && (!correction || (reason.trim() !== '' && evidence.trim() !== ''));
  const fingerprint = JSON.stringify([subject, value.trim(), unit, source, note.trim(), correction, reason.trim(), evidence.trim()]);
  const { getKey, resetKey } = useIdempotencyKey(correction ? 'correct_weight' : 'set_weight', profileId, fingerprint);

  const save = async () => {
    setSaving(true);
    try {
      await saveWeight({
        subject, value: value.trim(), unit: density ? unit : 'lb_per_gal', source, note,
        correction: correction ? { reason: reason.trim(), evidence: evidence.trim() } : undefined, key: getKey(),
      });
      resetKey();
      toast('success', 'Weight saved and approved');
      onSaved();
    } catch (error) {
      toast('error', sanitizeError(error));
      if (hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_LOWER_TRUST)) setForceCorrection(true);
      if (hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_STALE)) onStale();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      title={correction ? 'Correct weight' : 'Enter weight'}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} loading={saving} disabled={!ready}>{correction ? 'Save correction' : 'Save weight'}</Button>
        </>
      )}
    >
      <fieldset disabled={saving} className="space-y-3">
        <p className="text-sm text-secondary">{introText(subject, entry)}</p>
        <Input id="weight-value" maxLength={30} label={density ? 'Weight' : `Net weight (lb per ${entry.inventory_unit || 'unit'})`} inputMode="decimal"
          value={value} onChange={(event) => setValue(event.target.value)}
          error={value.trim() !== '' && stored === null ? 'Enter a number, like 8.34' : undefined} />
        {density && (
          <Select id="weight-unit" label="Entered as" value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}
            options={[{ value: 'lb_per_gal', label: 'lb per gallon' }, { value: 'specific_gravity', label: 'Specific gravity' }]} />
        )}
        {stored !== null && (
          <p className="text-sm text-nav-dark" role="status">Saves as {stored} {unitLabel(subject, entry.inventory_unit)}
            {tooHeavy !== null && ` (more than ${tooHeavy} ${unitLabel(subject, entry.inventory_unit)}; check the number)`}</p>
        )}
        <Select id="weight-source" label="Source" value={source} onChange={(event) => setSource(event.target.value as ProductWeightSource)}
          options={WEIGHT_SOURCES.map((item) => ({ value: item.value, label: item.label }))} />
        <Input id="weight-note" label="Note" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
        {correction && (
          <CorrectionFields approvedSource={approvedSource} source={source} reason={reason} evidence={evidence}
            setReason={setReason} setEvidence={setEvidence} />
        )}
      </fieldset>
    </Modal>
  );
}

function DraftRow({ draft, subject, entry, isAdmin, busy, onApprove, onSetWeight }: {
  draft: WeightDraft; subject: WeightSubject; entry: ProductWeightEntry; isAdmin: boolean; busy: boolean;
  onApprove: () => void; onSetWeight: () => void;
}) {
  const matches = draftMatchesBasis(draft, entry.current_basis);
  return (
    <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" data-testid="weight-draft">
      <p>Draft: {draft.value} {unitLabel(subject, entry.inventory_unit)} from {sourceText(draft.source)}, waiting for review</p>
      {draft.source_note && <p>Note: {draft.source_note}</p>}
      {draft.reason && <p>Reason: {draft.reason}</p>}
      {draft.evidence && <p>Evidence: {draft.evidence}</p>}
      {matches ? (
        isAdmin && <Button size="sm" showChevron={false} disabled={busy} onClick={onApprove}>Approve draft</Button>
      ) : (
        <>
          <p>{subject.kind === 'density'
            ? 'Entered for the old formulation; enter the weight again.'
            : 'Pack changed: enter the weight again for the new pack.'}</p>
          {isAdmin && <Button size="sm" variant="secondary" showChevron={false} disabled={busy} onClick={onSetWeight}>Set weight</Button>}
        </>
      )}
    </div>
  );
}

const HISTORY_PAGE = 25;

function WeightHistory({ subject, stockUnit, reloadToken }: { subject: WeightSubject; stockUnit: string | null | undefined; reloadToken: number }) {
  const [rows, setRows] = useState<ProductWeightEvent[] | null | 'failed'>(null);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [olderFailed, setOlderFailed] = useState(false);
  const [reload, setReload] = useState(0);
  // A new product starts empty at the first page; "Show older" keeps the list open while it loads more.
  useEffect(() => { setRows(null); setLimit(HISTORY_PAGE); }, [subject.kind, subject.subject_id]);
  useEffect(() => {
    let cancelled = false;
    setOlderFailed(false);
    fetchWeightEvents(subject, limit).then((data) => { if (!cancelled) setRows(data); }).catch((error: unknown) => {
      Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), { extra: { context: 'product_weight_events' } });
      // A failed "Show older" keeps the rows already shown; only a failed first page replaces them.
      if (!cancelled) setRows((shown) => (Array.isArray(shown) && limit > HISTORY_PAGE ? shown : 'failed'));
      if (!cancelled) setOlderFailed(limit > HISTORY_PAGE);
    });
    return () => { cancelled = true; };
  }, [subject.kind, subject.subject_id, reloadToken, limit, reload]); // eslint-disable-line react-hooks/exhaustive-deps -- the subject's identity, not its object
  if (rows === 'failed') return <p className="text-sm text-secondary">Weight history could not be loaded.</p>;
  if (rows === null || rows.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-secondary">Weight history</summary>
      <ul className="mt-2 space-y-2">
        {rows.map((row) => {
          const value = eventValue(row);
          return (
            <li key={row.id} className="border-b border-gray-100 pb-2 last:border-0">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-nav-dark">{row.actor_kind === 'system' ? 'System' : row.changed_by_name || 'Unknown staff member'}</span>
                <time className="text-secondary" dateTime={row.changed_at}>{new Date(row.changed_at).toLocaleString('en-US', { timeZone: BUSINESS_TIMEZONE })}</time>
              </div>
              <p>{EVENT_LABELS[row.event_type] ?? row.event_type}{value ? `: ${value} ${unitLabel(subject, stockUnit)}` : ''}</p>
              {row.reason && <p className="text-secondary">Reason: {row.reason}</p>}
              {row.evidence && <p className="text-secondary">Evidence: {row.evidence}</p>}
            </li>
          );
        })}
      </ul>
      {olderFailed && <p className="text-secondary">Older history could not be loaded.</p>}
      {(rows.length >= limit || olderFailed) && (
        <Button size="sm" variant="secondary" showChevron={false} onClick={() => (olderFailed ? setReload((count) => count + 1) : setLimit(limit + HISTORY_PAGE))}>
          {olderFailed ? 'Try again' : 'Show older'}</Button>
      )}
    </details>
  );
}

function weightSummary(entry: ProductWeightEntry, name: string): string {
  const weight = entry.weight;
  if (!weight) return '';
  if (weight.kind === 'density' || weight.kind === 'net_weight') {
    const density = weight.kind === 'density';
    return `${density ? 'Weight per gallon' : `Net weight per ${weight.per_unit ?? 'unit'}`}: `
      + `${weight.lb_per_unit} ${density ? 'lb/gal' : 'lb'}, from ${sourceText(weight.source)}, `
      + `approved by ${weight.reviewed_by_name || 'an admin'} on ${when(weight.reviewed_at)}`;
  }
  if (weight.kind === 'unit_weight') return `Weight comes from its stock unit (${weight.per_unit})`;
  return noWeightMessage(name, weight.none_reason, entry.inventory_unit);
}

function WeightActions({ hasApproved, busy, onOpen }: { hasApproved: boolean; busy: boolean; onOpen: (mode: 'enter' | 'correct') => void }) {
  const blocked = busy ? 'Save or discard your other changes first' : undefined;
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" showChevron={false} disabled={busy} title={blocked} onClick={() => onOpen('enter')}>
        {hasApproved ? 'Enter new weight' : 'Enter weight'}
      </Button>
      {hasApproved && (
        <Button size="sm" variant="secondary" showChevron={false} disabled={busy} title={blocked} onClick={() => onOpen('correct')}>
          Correct weight
        </Button>
      )}
    </div>
  );
}

type OpenState = null | { mode: 'enter' | 'correct' } | { mode: 'approve'; draft: WeightDraft };

function WeightBody({ entry, name, isAdmin, busy, reloadToken, setOpen }: {
  entry: ProductWeightEntry; name: string; isAdmin: boolean; busy: boolean; reloadToken: number; setOpen: (open: OpenState) => void;
}) {
  const subject = entry.subject ?? null;
  const draft = entry.draft ?? null;
  return (
    <>
      <p className="text-sm text-nav-dark" data-testid="product-weight-summary">{weightSummary(entry, name)}</p>
      {subject?.kind === 'density' && <p className="text-xs text-secondary">Shared by every size of this parent.</p>}
      {subject && draft && (
        <DraftRow draft={draft} subject={subject} entry={entry} isAdmin={isAdmin} busy={busy}
          onApprove={() => setOpen({ mode: 'approve', draft })} onSetWeight={() => setOpen({ mode: 'enter' })} />
      )}
      {subject && isAdmin && (
        <WeightActions hasApproved={entry.weight?.kind === subject.kind} busy={busy} onOpen={(mode) => setOpen({ mode })} />
      )}
      {subject && <WeightHistory subject={subject} stockUnit={entry.inventory_unit} reloadToken={reloadToken} />}
    </>
  );
}

function ApproveDraftModal({ draft, subject, entry, name, profileId, onClose, onDone }: {
  draft: WeightDraft | null; subject: WeightSubject | null; entry: ProductWeightEntry | null; name: string; profileId: string;
  onClose: () => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [approving, setApproving] = useState(false);
  const approveKey = useIdempotencyKey('approve_weights', profileId, JSON.stringify([subject?.subject_id, subject?.version, draft?.id ?? null]));
  const approve = async () => {
    if (!subject || !draft) return;
    setApproving(true);
    try {
      await approveWeightDraft(subject, draft.id, approveKey.getKey());
      approveKey.resetKey();
      toast('success', 'Draft weight approved');
      onDone();
    } catch (error) {
      toast('error', sanitizeError(error));
      if (hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_STALE) || hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_BASIS_CHANGED)) onDone();
    } finally {
      setApproving(false);
    }
  };
  const target = subject?.kind === 'density' ? `every size of ${subject.parent_name ?? 'this parent'}` : name;
  return (
    <ConfirmModal
      open={draft !== null}
      onClose={onClose}
      onConfirm={() => void approve()}
      title="Approve draft weight?"
      message={draft && subject
        ? `Approve ${draft.value} ${unitLabel(subject, entry?.inventory_unit)} from ${sourceText(draft.source)} for ${target}. Approve only after Mason has reviewed it.`
        : ''}
      confirmLabel="Approve"
      loading={approving}
    />
  );
}

function LoadedWeight({ entry, isAdmin, profileId, busy, reloadToken, reload, onSaved }: {
  entry: ProductWeightEntry; isAdmin: boolean; profileId: string; busy: boolean; reloadToken: number; reload: () => void; onSaved?: () => void;
}) {
  const [open, setOpen] = useState<OpenState>(null);
  const subject = entry.subject ?? null;
  const name = entry.product_name ?? 'This product';
  const saved = () => { setOpen(null); reload(); onSaved?.(); };
  return (
    <>
      <CardHeader title="Weight" accent={subject?.kind === 'density' ? `Parent ${subject.parent_name ?? ''}`.trim() : undefined} />
      <div className="space-y-3" data-testid="product-weight-card">
        <WeightBody entry={entry} name={name} isAdmin={isAdmin} busy={busy} reloadToken={reloadToken} setOpen={setOpen} />
      </div>
      {subject && open && open.mode !== 'approve' && (
        <EnterWeightModal subject={subject} entry={entry} profileId={profileId} startAsCorrection={open.mode === 'correct'}
          onClose={() => setOpen(null)} onSaved={saved} onStale={saved} />
      )}
      <ApproveDraftModal draft={open?.mode === 'approve' ? open.draft : null} subject={subject} entry={entry} name={name}
        profileId={profileId} onClose={() => setOpen(null)} onDone={saved} />
    </>
  );
}

/**
 * DM-2 weight on the product page: weight per gallon on a liquid's parent, net weight per pack on a dry
 * size stocked in a count unit, or where the weight comes from. Seed and each products have no weight row.
 */
export default function ProductWeightCard({ productId, isAdmin, profileId, busy, reloadKey, onSaved }: {
  productId: string;
  isAdmin: boolean;
  profileId: string;
  /** Other unsaved edits on the page: weight actions wait for them. */
  busy: boolean;
  /** Changes when the product or its parent is saved, so a pack or parent change re-reads the weight. */
  reloadKey: string;
  /** After a weight save or stale refusal, so figures that use the weight (cost per lb of active) re-read. */
  onSaved?: () => void;
}) {
  const [loaded, setState] = useState<{ forKey: string; status: 'loading' | 'failed' } | { forKey: string; status: 'loaded'; entry: ProductWeightEntry }>({ forKey: '', status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // Only a result for the product and saved state on screen counts, so a stale card can never act on another product.
  const forKey = JSON.stringify([productId, reloadKey, attempt]);
  const state = loaded.forKey === forKey ? loaded : { status: 'loading' as const };
  useEffect(() => {
    let cancelled = false;
    fetchProductWeights([productId]).then((result) => {
      if (cancelled) return;
      const entry = result.products[productId];
      setState(entry?.found ? { forKey, status: 'loaded', entry } : { forKey, status: 'failed' });
    }).catch((error: unknown) => {
      Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), { extra: { context: 'get_product_weights' } });
      if (!cancelled) setState({ forKey, status: 'failed' });
    });
    return () => { cancelled = true; };
  }, [productId, forKey]);

  if (state.status === 'loaded' && (state.entry.product_form === 'seed' || state.entry.product_form === 'each')) return null;
  return (
    <Card>
      {state.status === 'loaded' ? (
        <LoadedWeight entry={state.entry} isAdmin={isAdmin} profileId={profileId} busy={busy} reloadToken={attempt} reload={reload} onSaved={onSaved} />
      ) : (
        <>
          <CardHeader title="Weight" />
          <div className="space-y-3" data-testid="product-weight-card">
            {state.status === 'loading'
              ? <p className="text-sm text-secondary" role="status">Loading weight…</p>
              : <LoadFailedState title="Weight could not be loaded" onRetry={reload} />}
          </div>
        </>
      )}
    </Card>
  );
}
