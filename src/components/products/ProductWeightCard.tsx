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
  const ready = stored !== null && Number(stored) > 0 && !saving && (!correction || (reason.trim() !== '' && evidence.trim() !== ''));
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
        <p className="text-sm text-secondary">
          {density
            ? `Weight per gallon for every size of ${subject.parent_name ?? 'this parent'}. Your entry is saved as approved by you.`
            : `Net pounds in one ${entry.inventory_unit ?? 'unit'} of ${entry.product_name ?? 'this size'}. Your entry is saved as approved by you.`}
        </p>
        <Input id="weight-value" label={density ? 'Weight' : `Net weight (lb per ${entry.inventory_unit ?? 'unit'})`} inputMode="decimal"
          value={value} onChange={(event) => setValue(event.target.value)}
          error={value.trim() !== '' && stored === null ? 'Enter a number, like 8.34' : undefined} />
        {density && (
          <Select id="weight-unit" label="Entered as" value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}
            options={[{ value: 'lb_per_gal', label: 'lb per gallon' }, { value: 'specific_gravity', label: 'Specific gravity' }]} />
        )}
        {stored !== null && (
          <p className="text-sm text-nav-dark" role="status">Saves as {stored} {unitLabel(subject, entry.inventory_unit)}</p>
        )}
        <Select id="weight-source" label="Source" value={source} onChange={(event) => setSource(event.target.value as ProductWeightSource)}
          options={WEIGHT_SOURCES.map((item) => ({ value: item.value, label: item.label }))} />
        <Input id="weight-note" label="Note" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
        {correction && (
          <>
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" role="status">
              The approved weight is from {sourceText(approvedSource)}, which is trusted more than {sourceText(source)}. A correction needs a reason and evidence.
            </p>
            <ReasonField id="weight-reason" label="Reason" value={reason} onChange={setReason} />
            <ReasonField id="weight-evidence" label="Evidence (what shows it)" value={evidence} onChange={setEvidence} />
          </>
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

function WeightHistory({ subject, stockUnit, reloadToken }: { subject: WeightSubject; stockUnit: string | null | undefined; reloadToken: number }) {
  const [rows, setRows] = useState<ProductWeightEvent[] | null | 'failed'>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    fetchWeightEvents(subject).then((data) => { if (!cancelled) setRows(data); }).catch((error: unknown) => {
      Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), { extra: { context: 'product_weight_events' } });
      if (!cancelled) setRows('failed');
    });
    return () => { cancelled = true; };
  }, [subject.kind, subject.subject_id, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps -- the subject's identity, not its object
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
    </details>
  );
}

/**
 * DM-2 weight on the product page: weight per gallon on a liquid's parent, net weight per pack on a dry
 * size stocked in a count unit, or where the weight comes from. Seed and each products have no weight row.
 */
export default function ProductWeightCard({ productId, isAdmin, profileId, busy, reloadKey }: {
  productId: string;
  isAdmin: boolean;
  profileId: string;
  /** Other unsaved edits on the page: weight actions wait for them. */
  busy: boolean;
  /** Changes when the product or its parent is saved, so a pack or parent change re-reads the weight. */
  reloadKey: string;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'failed' } | { status: 'loaded'; entry: ProductWeightEntry }>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<null | { mode: 'enter' | 'correct' } | { mode: 'approve'; draft: WeightDraft }>(null);
  const [approving, setApproving] = useState(false);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchProductWeights([productId]).then((result) => {
      if (cancelled) return;
      const entry = result.products[productId];
      setState(entry?.found ? { status: 'loaded', entry } : { status: 'failed' });
    }).catch((error: unknown) => {
      Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), { extra: { context: 'get_product_weights' } });
      if (!cancelled) setState({ status: 'failed' });
    });
    return () => { cancelled = true; };
  }, [productId, reloadKey, attempt]);

  const entry = state.status === 'loaded' ? state.entry : null;
  const subject = entry?.subject ?? null;
  const approveKey = useIdempotencyKey('approve_weights', profileId,
    JSON.stringify([subject?.subject_id, subject?.version, open?.mode === 'approve' ? open.draft.id : null]));

  if (state.status === 'loaded' && (entry?.product_form === 'seed' || entry?.product_form === 'each')) return null;

  const blocked = busy ? 'Save or discard your other changes first' : undefined;
  const name = entry?.product_name ?? 'This product';
  const weight = entry?.weight;
  const saved = () => { setOpen(null); reload(); };
  const approve = async (draft: WeightDraft) => {
    if (!subject) return;
    setApproving(true);
    try {
      await approveWeightDraft(subject, draft.id, approveKey.getKey());
      approveKey.resetKey();
      toast('success', 'Draft weight approved');
      saved();
    } catch (error) {
      toast('error', sanitizeError(error));
      if (hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_STALE) || hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_BASIS_CHANGED)) saved();
    } finally {
      setApproving(false);
    }
  };

  let summary: string;
  if (!weight) summary = '';
  else if (weight.kind === 'density' || weight.kind === 'net_weight') {
    summary = `${weight.kind === 'density' ? 'Weight per gallon' : `Net weight per ${weight.per_unit ?? 'unit'}`}: `
      + `${weight.lb_per_unit} ${weight.kind === 'density' ? 'lb/gal' : 'lb'}, from ${sourceText(weight.source)}, `
      + `approved by ${weight.reviewed_by_name || 'an admin'} on ${when(weight.reviewed_at)}`;
  } else if (weight.kind === 'unit_weight') summary = `Weight comes from its stock unit (${weight.per_unit})`;
  else summary = noWeightMessage(name, weight.none_reason, entry?.inventory_unit);

  return (
    <Card>
      <CardHeader title="Weight" accent={subject?.kind === 'density' ? `Parent ${subject.parent_name ?? ''}`.trim() : undefined} />
      <div className="space-y-3" data-testid="product-weight-card">
        {state.status === 'loading' && <p className="text-sm text-secondary" role="status">Loading weight…</p>}
        {state.status === 'failed' && <LoadFailedState title="Weight could not be loaded" onRetry={reload} />}
        {entry && (
          <>
            <p className="text-sm text-nav-dark" data-testid="product-weight-summary">{summary}</p>
            {subject?.kind === 'density' && <p className="text-xs text-secondary">Shared by every size of this parent.</p>}
            {subject && entry.draft && (
              <DraftRow draft={entry.draft} subject={subject} entry={entry} isAdmin={isAdmin} busy={busy || approving}
                onApprove={() => setOpen({ mode: 'approve', draft: entry.draft! })} onSetWeight={() => setOpen({ mode: 'enter' })} />
            )}
            {subject && isAdmin && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" showChevron={false} disabled={busy} title={blocked} onClick={() => setOpen({ mode: 'enter' })}>
                  {weight?.kind === subject.kind ? 'Enter new weight' : 'Enter weight'}
                </Button>
                {weight?.kind === subject.kind && (
                  <Button size="sm" variant="secondary" showChevron={false} disabled={busy} title={blocked} onClick={() => setOpen({ mode: 'correct' })}>
                    Correct weight
                  </Button>
                )}
              </div>
            )}
            {subject && <WeightHistory subject={subject} stockUnit={entry.inventory_unit} reloadToken={attempt} />}
          </>
        )}
      </div>
      {entry && subject && open && open.mode !== 'approve' && (
        <EnterWeightModal subject={subject} entry={entry} profileId={profileId} startAsCorrection={open.mode === 'correct'}
          onClose={() => setOpen(null)} onSaved={saved} onStale={saved} />
      )}
      <ConfirmModal
        open={open?.mode === 'approve'}
        onClose={() => setOpen(null)}
        onConfirm={() => { if (open?.mode === 'approve') void approve(open.draft); }}
        title="Approve draft weight?"
        message={open?.mode === 'approve' && subject
          ? `Approve ${open.draft.value} ${unitLabel(subject, entry?.inventory_unit)} from ${sourceText(open.draft.source)} for ${subject.kind === 'density' ? `every size of ${subject.parent_name ?? 'this parent'}` : name}. Approve only after Mason has reviewed it.`
          : ''}
        confirmLabel="Approve"
        loading={approving}
      />
    </Card>
  );
}
