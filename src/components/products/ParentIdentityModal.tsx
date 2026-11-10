import { useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import {
  correctParentIdentity, previewIdentityCorrection,
  type IdentityPreview, type IdentityValues, type ProductParent,
} from '../../lib/productParents';
import { ReasonField } from './ProductParentPanel';

const FIELDS: Array<{ key: keyof IdentityValues; label: string }> = [
  { key: 'formulation_type', label: 'Formulation type' },
  { key: 'safener', label: 'Safener' },
  { key: 'generic_epa_registration', label: 'EPA number' },
];
const shown = (value: string | null) => value || 'blank';

/**
 * Corrects what the formulation is (formulation type, safener, EPA number) on the parent, with a reason
 * and evidence. The database refuses an EPA number change until the EPA correction work (REG-1) lands.
 */
export default function ParentIdentityModal({ parent, profileId, onClose, onSaved }: {
  parent: ProductParent;
  profileId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [values, setValues] = useState<IdentityValues>({
    formulation_type: parent.formulation_type ?? '',
    safener: parent.safener ?? '',
    generic_epa_registration: parent.generic_epa_registration ?? '',
  });
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ input: string; result: IdentityPreview } | null>(null);

  const changes: Partial<IdentityValues> = {};
  for (const { key } of FIELDS) {
    const next = (values[key] ?? '').trim();
    if (next !== (parent[key] ?? '')) changes[key] = next === '' ? null : next;
  }
  const changeInput = JSON.stringify(changes);
  const previewed = preview?.input === changeInput ? preview.result : null;
  const ready = Object.keys(changes).length > 0 && reason.trim() !== '' && evidence.trim() !== '' && !saving;
  const { getKey, resetKey } = useIdempotencyKey('correct_product_parent_identity', profileId,
    JSON.stringify([parent.id, previewed?.parent_version, changeInput, reason.trim(), evidence.trim()]));

  const refuse = (error: unknown) => {
    toast('error', sanitizeError(error));
    if (hasRpcCode(error, RpcErrorCodes.PRODUCT_PARENT_STALE)) onSaved();
  };
  const showPreview = async () => {
    setSaving(true);
    try {
      setPreview({ input: changeInput, result: await previewIdentityCorrection(parent.id, changes) });
    } catch (error) {
      refuse(error);
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (!previewed) return;
    setSaving(true);
    try {
      await correctParentIdentity({
        parentId: parent.id, expectedVersion: previewed.parent_version, changes,
        reason: reason.trim(), evidence: evidence.trim(), key: getKey(),
      });
      resetKey();
      toast('success', `Corrected ${parent.name}`);
      onSaved();
    } catch (error) {
      refuse(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      title="Correct identity"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          {previewed
            ? <Button onClick={() => void save()} loading={saving} disabled={!ready}>Save correction</Button>
            : <Button onClick={() => void showPreview()} loading={saving} disabled={!ready}>Preview</Button>}
        </>
      )}
    >
      <fieldset disabled={saving} className="space-y-3">
        <p className="text-sm text-secondary">
          Fixes a wrong record of what {parent.name} is. It is logged with your reason and evidence and applies to all {parent.sizes.length} size(s).
        </p>
        {FIELDS.map(({ key, label }) => (
          <Input key={key} id={`parent-identity-${key}`} label={label} value={values[key] ?? ''}
            onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
        ))}
        <p className="text-xs text-secondary">EPA number corrections are switched off until the EPA correction work lands; the save will say so.</p>
        <ReasonField id="parent-identity-reason" label="Reason" value={reason} onChange={setReason} />
        <ReasonField id="parent-identity-evidence" label="Evidence (what shows it)" value={evidence} onChange={setEvidence} />
        {previewed && (
          <div className="space-y-1 text-sm">
            <p className="text-secondary">If you save:</p>
            <ul className="list-disc pl-5 text-nav-dark">
              {FIELDS.filter(({ key }) => key in changes).map(({ key, label }) => (
                <li key={key}>{label}: {shown(previewed.before[key])} → {shown(previewed.after[key])}</li>
              ))}
            </ul>
            <p className="text-secondary">Sizes: {previewed.sizes.map((size) => size.product_name).join(', ')}</p>
          </div>
        )}
      </fieldset>
    </Modal>
  );
}
