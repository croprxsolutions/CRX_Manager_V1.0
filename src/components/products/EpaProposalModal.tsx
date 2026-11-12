import { useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Badge, { type BadgeVariant } from '../ui/Badge';
import ConfirmModal from '../ui/ConfirmModal';
import ReasonModal from '../ui/ReasonModal';
import { useToast } from '../ui/Toast';
import { Sentry } from '../../lib/sentry';
import { generateIdempotencyKey, isDefinitiveRpcRejection } from '../../lib/idempotency';
import { plainRefusal } from '../../lib/productChemistry';
import {
  CLASS_LABEL, HOLD_LABEL, WRITABLE_CLASSES, commitEpaProposal, itemName, rejectEpaProposal, sideText, type EpaDecision,
  type EpaProposalDraft,
} from '../../lib/epaProposals';
import type { EpaChemistryProposal, EpaProposalItem } from '../../types';

type KeySlot = 'commitKey' | 'rejectKey';

function classVariant(item: EpaProposalItem): BadgeVariant {
  if (item.class === 'confirm' || item.class === 'matches') return 'success';
  if (WRITABLE_CLASSES.has(item.class)) return 'info';
  return 'warning';
}

function fixHint(item: EpaProposalItem): string | null {
  if (item.class === 'differs_typed' || item.class === 'differs_epa' || item.class === 'differs_identity') {
    return 'Kept as it is. To change it, use Correct on the chemistry card, then look up again.';
  }
  if (item.kind === 'label' && item.class === 'differs') return 'Kept as it is. Change it on the EPA registration if EPA is right.';
  return null;
}

function ItemRow({ item, ticked, editable, onTick }: {
  item: EpaProposalItem; ticked: boolean; editable: boolean; onTick: (accept: boolean) => void;
}) {
  const writable = WRITABLE_CLASSES.has(item.class);
  const hint = fixHint(item);
  return (
    <li className="flex gap-3 border-b border-gray-100 py-2 last:border-0">
      <div className="w-6 pt-0.5">
        {writable && (
          <input type="checkbox" className="h-4 w-4" checked={ticked} disabled={!editable} aria-label={`Accept ${itemName(item)}`}
            onChange={(event) => onTick(event.target.checked)} />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-primary">{itemName(item)}</span>
          <Badge variant={classVariant(item)} normalCase>{CLASS_LABEL[item.class]}</Badge>
        </div>
        <p className="text-secondary">Now: {sideText(item, 'current')}</p>
        <p className="text-secondary">EPA: {sideText(item, 'epa')}</p>
        {item.note && <p className="text-xs text-amber-700">{item.note}</p>}
        {hint && <p className="text-xs text-secondary">{hint}</p>}
      </div>
    </li>
  );
}

function SummaryNotes({ proposal }: { proposal: EpaChemistryProposal }) {
  const summary = proposal.epa_summary as { productname?: string | null; manufacturer?: string | null; isCancelled?: boolean; base_label_note?: boolean };
  return (
    <div className="space-y-2 text-sm">
      <p className="text-secondary">
        EPA {proposal.epa_registration}: {summary.productname ?? 'no product name'}{summary.manufacturer ? `, ${summary.manufacturer}` : ''}
      </p>
      {summary.base_label_note && <p className="text-secondary">Label facts come from the base registration.</p>}
      {summary.isCancelled && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-800" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          EPA lists this registration as cancelled. Record the date on the registration. Selling is not blocked.
        </p>
      )}
      {proposal.status === 'held' && proposal.hold_reason && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800" role="alert">
          On hold: {HOLD_LABEL[proposal.hold_reason]} It can no longer be committed. Run the lookup again or reject it.
        </p>
      )}
    </div>
  );
}

function confirmMessage(items: EpaProposalItem[], ticks: Record<string, boolean>): string {
  const accepted = items.filter((item) => WRITABLE_CLASSES.has(item.class) && ticks[item.item_id]);
  const writes = accepted.filter((item) => item.class !== 'confirm').map(itemName);
  const confirms = accepted.length - writes.length;
  const parts = [writes.length > 0 ? `Write: ${writes.join(', ')}.` : 'Nothing new is written.'];
  if (confirms > 0) parts.push(`${confirms} item${confirms === 1 ? '' : 's'} recorded as matching EPA.`);
  parts.push('Differences are kept as they are.');
  return parts.join(' ');
}

/**
 * DM-4: review one EPA proposal. Writable items have a tick box; differences are shown and never written (D-L).
 * Nothing is written until Commit (D-I). Ticks survive a refused commit.
 */
export default function EpaProposalModal({ proposal, draft, profileId, onClose, onSettled, onRunAgain }: {
  proposal: EpaChemistryProposal; draft: EpaProposalDraft; profileId: string; onClose: () => void;
  /** A commit, hold or reject was saved: re-read the rows. */
  onSettled: () => void;
  /** Absent when the number is no longer on the product, so only Reject is offered for a held proposal. */
  onRunAgain?: (epaNumber: string) => void;
}) {
  const { toast } = useToast();
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => draft.read().ticks ?? Object.fromEntries(
    proposal.items.filter((item) => WRITABLE_CLASSES.has(item.class)).map((item) => [item.item_id, item.accept_default])));
  const [asking, setAsking] = useState<'commit' | 'reject' | null>(null);
  const [saving, setSaving] = useState(false);
  const open = proposal.status === 'proposed' || proposal.status === 'held';
  const ingredients = proposal.items.filter((item) => item.kind === 'ingredient');
  const labels = proposal.items.filter((item) => item.kind === 'label');

  const keyFor = (slot: KeySlot, operation: string, request: string) => {
    const held = draft.read()[slot];
    if (held?.request === request) return held.key;
    const key = generateIdempotencyKey(operation, profileId);
    draft.update({ [slot]: { key, request } });
    return key;
  };
  const failed = (error: unknown, slot: KeySlot, context: string) => {
    if (isDefinitiveRpcRejection(error)) draft.update({ [slot]: null });
    else Sentry.captureException(error, { extra: { context } });
    const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? plainRefusal((error as { message: string }).message) : 'It may not have saved. Try again; a retry is safe.';
    toast('error', message);
  };

  const commit = async () => {
    const decisions: EpaDecision[] = Object.entries(ticks).map(([item_id, accept]) => ({ item_id, accept }));
    const key = keyFor('commitKey', 'commit_epa_proposal', JSON.stringify(decisions));
    setSaving(true);
    try {
      const result = await commitEpaProposal(proposal.id, proposal.proposal_version, decisions, key);
      draft.update({ commitKey: null });
      setAsking(null);
      if (result.status === 'held') {
        toast('warning', `Not committed. ${HOLD_LABEL[result.hold_reason]} Run the lookup again.`);
      } else {
        const posted = result.posted_sales_to_record.length;
        toast('success', `Committed EPA ${proposal.epa_registration}.`);
        if (posted > 0) toast('warning', `${posted} posted sale line${posted === 1 ? '' : 's'} of this product now need restricted-use records.`);
      }
      onSettled();
    } catch (error) {
      setAsking(null);
      failed(error, 'commitKey', 'commit_epa_proposal');
    } finally {
      setSaving(false);
    }
  };

  const reject = async (reason: string) => {
    const key = keyFor('rejectKey', 'reject_epa_proposal', reason);
    setSaving(true);
    try {
      await rejectEpaProposal(proposal.id, proposal.proposal_version, reason, key);
      draft.update({ rejectKey: null });
      setAsking(null);
      toast('success', `Rejected the EPA ${proposal.epa_registration} proposal.`);
      onSettled();
    } catch (error) {
      setAsking(null);
      failed(error, 'rejectKey', 'reject_epa_proposal');
    } finally {
      setSaving(false);
    }
  };

  const row = (item: EpaProposalItem) => (
    <ItemRow key={item.item_id} item={item} ticked={ticks[item.item_id] ?? false} editable={proposal.status === 'proposed' && !saving}
      onTick={(accept) => {
        const next = { ...ticks, [item.item_id]: accept };
        draft.update({ ticks: next });
        setTicks(next);
      }} />
  );

  return (
    <>
      <Modal open onClose={onClose} closeDisabled={saving} title={`EPA lookup ${proposal.epa_registration}`} size="large"
        footer={open ? (
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={saving} onClick={() => setAsking('reject')}>Reject</Button>
            {proposal.status === 'held'
              ? onRunAgain && <Button icon={<RefreshCw className="h-4 w-4" />} disabled={saving} onClick={() => onRunAgain(proposal.epa_registration)}>Run lookup again</Button>
              : <Button disabled={saving} onClick={() => setAsking('commit')}>Commit</Button>}
          </div>
        ) : undefined}>
        <div className="space-y-4">
          <SummaryNotes proposal={proposal} />
          <section>
            <h3 className="text-sm font-semibold text-primary">Chemistry</h3>
            {ingredients.length === 0 ? <p className="text-sm text-secondary">EPA lists no active ingredients.</p> : <ul>{ingredients.map(row)}</ul>}
          </section>
          <section>
            <h3 className="text-sm font-semibold text-primary">Label facts (registration {proposal.epa_registration})</h3>
            <ul>{labels.map(row)}</ul>
          </section>
        </div>
      </Modal>
      <ConfirmModal open={asking === 'commit'} onClose={() => setAsking(null)} onConfirm={() => { void commit(); }} variant="info"
        title={`Commit EPA ${proposal.epa_registration}?`} message={confirmMessage(proposal.items, ticks)} confirmLabel="Commit" loading={saving} />
      <ReasonModal open={asking === 'reject'} onClose={() => setAsking(null)} onConfirm={(reason) => { void reject(reason); }} variant="warning"
        title={`Reject EPA ${proposal.epa_registration}?`} message="Nothing is written. Say why, for the record." confirmLabel="Reject" loading={saving} />
    </>
  );
}
