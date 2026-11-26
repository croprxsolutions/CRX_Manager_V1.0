/** Payment History's M9 parts: the ⋯ menu (Mark check as returned, Void payment last), status, phone card, dialog. */
import type { ReactNode } from 'react';
import { Ban, Lock, RotateCcw } from 'lucide-react';
import ActionMenu, { type ActionMenuItem } from '../ui/ActionMenu';
import Badge from '../ui/Badge';
import RefundOrReturnDialog from './RefundOrReturnDialog';
import { alreadyReturnedReason, RETURN_NOT_CHECK_REASON } from '../../lib/m9Reversals';
import { formatCents as fmt } from '../../lib/money';
import { parseLocalDate } from '../../lib/dateUtils';

export interface PaymentRow {
  id: string;
  customer_id: string;
  farm_name: string;
  is_active: boolean;
  payment_method: string | null;
  check_number: string | null;
  reference_number: string | null;
  total_payment_cents: number;
  payment_date: string | null;
  created_at: string;
}

const reference = (r: PaymentRow) => r.check_number || r.reference_number || '';

/** The admin's ⋯ menu on an active payment: Mark check as returned, then Void payment as the red last item. */
export function PaymentActions<T extends PaymentRow>({ r, returnedOn, onReturn, onVoid }: {
  r: T; returnedOn: string | undefined; onReturn: (r: T) => void; onVoid: (r: T) => void;
}) {
  if (!r.is_active) return null;
  const notCheck = r.payment_method !== 'check';
  const items: ActionMenuItem[] = [{
    id: 'return', label: 'Mark check as returned',
    icon: returnedOn || notCheck ? <Lock className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />,
    disabled: !!returnedOn || notCheck,
    disabledReason: returnedOn ? alreadyReturnedReason(returnedOn) : RETURN_NOT_CHECK_REASON(r.payment_method),
    description: `Returns all of check ${reference(r)} (${fmt(r.total_payment_cents || 0)}). Opens with the check picked.`,
    onAction: () => onReturn(r),
  }];
  // A returned check is never voided (the server refuses PAYMENT_RETURNED).
  if (!returnedOn) items.push({ id: 'void', label: 'Void payment', icon: <Ban className="h-4 w-4" />, danger: true, onAction: () => onVoid(r) });
  return (
    <div className="flex justify-end">
      <ActionMenu label={`More actions for ${r.payment_method || 'payment'} ${reference(r)}`.trim()} items={items} />
    </div>
  );
}

export function PaymentStatus({ r, returned }: { r: PaymentRow; returned: boolean }) {
  if (returned) return <Badge variant="danger">Returned</Badge>;
  return r.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="danger">Voided</Badge>;
}

/** Phone: each payment is a card (customer and total, then date, method, status and the ⋯ menu). */
export function PaymentMobileRow({ r, status, actions }: { r: PaymentRow; status: ReactNode; actions: ReactNode }) {
  const day = r.payment_date ? parseLocalDate(r.payment_date).toLocaleDateString() : new Date(r.created_at).toLocaleDateString();
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3"><b className="text-nav-dark">{r.farm_name}</b><b className="tabular-nums">{fmt(r.total_payment_cents || 0)}</b></div>
      <div className="mt-1 flex items-center justify-between gap-3 text-xs text-secondary">
        <span>{day} · <span className="capitalize">{r.payment_method || '—'}</span> {reference(r)}</span>
        <span className="flex items-center gap-2">{status}{actions}</span>
      </div>
    </div>
  );
}

/** "Mark check as returned" from a payment row: the returned-check form with this payment picked (M9). */
export function ReturnCheckDialog({ payment, onClose, onRecorded }: { payment: PaymentRow | null; onClose: () => void; onRecorded: () => void }) {
  if (!payment) return null;
  return (
    <RefundOrReturnDialog key={payment.id} open onClose={onClose} onRecorded={onRecorded} customerId={payment.customer_id}
      farmName={payment.farm_name} allocationSetId={payment.id} fromLabel="Payment History" />
  );
}
