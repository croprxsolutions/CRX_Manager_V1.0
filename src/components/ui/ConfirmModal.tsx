import type { LucideIcon } from 'lucide-react';
import { toneButton, toneIconStyles, toneIcons, type ConfirmTone } from './confirmTones';
import Modal, { ALERT_BUTTON } from './Modal';
import Button from './Button';

type ConfirmVariant = ConfirmTone;

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  icon?: LucideIcon;
  loading?: boolean;
}

export default function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  icon,
  loading = false,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={loading}
      title={title}
      size="alert"
      icon={icon || toneIcons[variant]}
      iconClassName={toneIconStyles[variant]}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading} className={ALERT_BUTTON}>
            {cancelLabel}
          </Button>
          {/* Red is kept for danger. A warning or info confirm is a green go-ahead. */}
          <Button
            variant={toneButton(variant)}
            onClick={onConfirm}
            loading={loading}
            className={ALERT_BUTTON}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
    </Modal>
  );
}
