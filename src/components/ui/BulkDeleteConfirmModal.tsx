import { Trash2, XCircle, ToggleLeft } from 'lucide-react';
import Modal, { ALERT_BUTTON } from './Modal';
import Button from './Button';

interface BulkDeleteConfirmModalProps {
  open: boolean;
  onClose: () => void;
  count: number;
  entityName: string;
  entityNamePlural?: string;
  actionWord?: 'delete' | 'deactivate' | 'cancel';
  onConfirm: () => void;
  loading?: boolean;
}

const iconMap = {
  delete: Trash2,
  deactivate: ToggleLeft,
  cancel: XCircle,
};

// Red for deleting and cancelling. Deactivating can be undone, so it is a warning with a green go-ahead.
const iconTone = {
  delete: 'bg-red-50 text-red-700',
  deactivate: 'bg-amber-50 text-amber-700',
  cancel: 'bg-red-50 text-red-700',
};

const verbs = { delete: 'Delete', deactivate: 'Deactivate', cancel: 'Cancel' };

export default function BulkDeleteConfirmModal({
  open,
  onClose,
  count,
  entityName,
  entityNamePlural,
  actionWord = 'delete',
  onConfirm,
  loading = false,
}: BulkDeleteConfirmModalProps) {
  const plural = entityNamePlural || `${entityName}s`;
  const label = count === 1 ? entityName : plural;
  const verb = verbs[actionWord];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${verb} ${count} ${label}?`}
      size="alert"
      icon={iconMap[actionWord]}
      iconClassName={iconTone[actionWord]}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className={ALERT_BUTTON}>
            Keep {label}{actionWord === 'deactivate' ? ' active' : ''}
          </Button>
          <Button
            variant={actionWord === 'deactivate' ? 'primary' : 'danger'}
            onClick={onConfirm}
            loading={loading}
            className={ALERT_BUTTON}
          >
            {verb} {count} {label}
          </Button>
        </>
      }
    >
      <p>
        You are about to {actionWord} <strong>{count}</strong> {label}. This is recorded in the audit log.
      </p>
    </Modal>
  );
}
