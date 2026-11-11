import { AlertTriangle, Trash2, ClipboardCheck, type LucideIcon } from 'lucide-react';
import Modal, { ALERT_BUTTON } from './Modal';
import Button from './Button';

type ConfirmVariant = 'danger' | 'warning' | 'info';

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

const variantStyles: Record<ConfirmVariant, string> = {
  danger: 'bg-red-50 text-red-700',
  warning: 'bg-amber-50 text-amber-700',
  info: 'bg-crx-green-light text-crx-green',
};

const defaultIcons: Record<ConfirmVariant, LucideIcon> = {
  danger: Trash2,
  warning: AlertTriangle,
  info: ClipboardCheck,
};

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
      icon={icon || defaultIcons[variant]}
      iconClassName={variantStyles[variant]}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading} className={ALERT_BUTTON}>
            {cancelLabel}
          </Button>
          {/* Red is kept for danger. A warning or info confirm is a green go-ahead. */}
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
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
