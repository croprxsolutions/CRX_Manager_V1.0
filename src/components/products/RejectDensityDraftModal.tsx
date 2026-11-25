import { useState } from 'react';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { rejectLiquidDensityDraft, type WeightSubject } from '../../lib/productWeights';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { ReasonField } from './ProductParentPanel';

interface RejectDensityDraftModalProps {
  subject: WeightSubject;
  draftId: string;
  profileId: string;
  onClose: () => void;
  onDone: () => void;
}

export function RejectDensityDraftModal({ subject, draftId, profileId, onClose, onDone }: RejectDensityDraftModalProps) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const trimmedReason = reason.trim();
  const { getKey, resetKey } = useIdempotencyKey('reject_liquid_density_draft', profileId,
    JSON.stringify([subject.subject_id, subject.version, draftId, trimmedReason]));

  async function reject() {
    if (!trimmedReason || saving) return;
    setSaving(true);
    try {
      await rejectLiquidDensityDraft(subject, draftId, trimmedReason, getKey());
      resetKey();
      toast('success', 'Draft rejected and kept in weight history');
      onDone();
    } catch (error: unknown) {
      toast('error', sanitizeError(error));
      if (hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_STALE)) onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} closeDisabled={saving} title="Reject draft weight?"
      footer={<>
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="button" variant="danger" disabled={!trimmedReason} loading={saving} onClick={() => void reject()}>
          Reject draft
        </Button>
      </>}>
      <fieldset disabled={saving} className="space-y-3">
        <p className="text-sm text-secondary">The draft and your reason will appear in weight history. An admin can then submit a new draft.</p>
        <ReasonField id="reject-density-reason" label="Reason for rejection" value={reason} onChange={setReason} />
      </fieldset>
    </Modal>
  );
}
