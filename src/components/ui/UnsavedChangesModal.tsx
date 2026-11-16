import { createPortal } from 'react-dom';
import { PencilLine } from 'lucide-react';
import Modal, { ALERT_BUTTON } from './Modal';
import Button from './Button';

interface UnsavedChangesModalProps {
  open: boolean;
  disableLeave?: boolean;
  onStay: () => void;
  onLeave: () => void;
}

/**
 * Confirmation modal shown when a user tries to navigate away from a page with unsaved changes.
 * Portalled to document.body so a hidden ancestor (a desktop-only wrapper) can't hide it.
 */
export default function UnsavedChangesModal({ open, disableLeave = false, onStay, onLeave }: UnsavedChangesModalProps) {
  if (!open) return null;

  return createPortal((
    <Modal
      open
      onClose={onStay}
      title="Leave without saving?"
      size="alert"
      icon={PencilLine}
      iconClassName="bg-amber-50 text-amber-700"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onLeave}
            disabled={disableLeave}
            className={`${ALERT_BUTTON} border-red-200! text-red-700! hover:bg-red-50!`}
          >
            Discard changes
          </Button>
          {/* Safe default: Enter or Esc keeps the user on the page. */}
          <Button onClick={onStay} data-autofocus className={ALERT_BUTTON}>
            Keep editing
          </Button>
        </>
      }
    >
      The changes you made on this page will be lost.
    </Modal>
  ), document.body);
}
