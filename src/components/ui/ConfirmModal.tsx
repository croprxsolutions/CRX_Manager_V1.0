import { AlertTriangle, Trash2, ClipboardCheck, type LucideIcon } from 'lucide-react';
import Modal from './Modal';
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
  const styles = variantStyles[variant];
  const Icon = icon || defaultIcons[variant];

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={loading}
      title={title}
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={loading} className="min-h-11 w-full sm:w-auto">
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'info' ? 'primary' : 'danger'}
            icon={<Icon className="w-4 h-4" />}
            onClick={onConfirm}
            loading={loading}
            className="min-h-11 w-full sm:w-auto"
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${styles}`} aria-hidden="true">
          <Icon className="w-5 h-5" />
        </span>
        <p className="pt-2 text-sm text-secondary">{message}</p>
      </div>
    </Modal>
  );
}
