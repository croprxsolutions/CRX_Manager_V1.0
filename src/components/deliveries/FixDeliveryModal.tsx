/**
 * FixDeliveryModal — admin-only, one screen: undo a wrong completed delivery and its unpaid invoice
 * together (fix_delivery, 20261106100000), then open New Delivery for the same order to re-enter it.
 * The preview comes from the server; the server re-checks everything and refuses if it changed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Wrench } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabaseUntyped, assertRpcResult, sanitizeError } from '../../lib/db';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { getIdempotencyBindingRejection } from '../../lib/idempotency';
import { formatCents } from '../../lib/money';
import { Sentry } from '../../lib/sentry';
import type { FixDeliveryPlan, FixDeliveryResult } from '../../types';

interface FixDeliveryModalProps {
  open: boolean;
  onClose: () => void;
  deliveryId: string;
  deliveryNumber: string;
}

export default function FixDeliveryModal({ open, onClose, deliveryId, deliveryNumber }: FixDeliveryModalProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const fixIdem = useIdempotencyKey('fix_delivery', profile?.id || '');
  const [plan, setPlan] = useState<FixDeliveryPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  // A fix whose reply was lost: the delivery is already undone, so offer the re-entry link.
  const [submittedScope, setSubmittedScope] = useState<string | null>(null);
  const planRequestRef = useRef(0);

  const loadPlan = useCallback(async () => {
    const seq = ++planRequestRef.current;
    setPlan(null);
    setLoadError(null);
    try {
      const { data, error } = await supabaseUntyped.rpc('preview_fix_delivery', { p_delivery_id: deliveryId });
      if (error) throw error;
      const next = assertRpcResult<FixDeliveryPlan>(data, 'preview_fix_delivery');
      if (seq === planRequestRef.current) setPlan(next);
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'preview_fix_delivery' } });
      if (seq === planRequestRef.current) setLoadError(sanitizeError(err));
    }
  }, [deliveryId]);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setTyped('');
    void loadPlan();
  }, [open, loadPlan]);

  const confirmText = `FIX ${deliveryNumber}`;
  const ready = !!plan?.can_fix && reason.trim() !== '' && typed.trim() === confirmText && !saving;

  const handleFix = async () => {
    if (!profile || !plan || !ready) return;
    // The token covers everything the preview showed, so the server refuses if any of it changed since.
    const scope = JSON.stringify([deliveryId, reason.trim(), plan.plan_token]);
    setSaving(true);
    setSubmittedScope(scope);
    try {
      const { data, error } = await supabaseUntyped.rpc('fix_delivery', {
        p_delivery_id: deliveryId,
        p_reason: reason.trim(),
        p_plan_token: plan.plan_token,
        p_idempotency_key: fixIdem.getKeyFor(scope),
      });
      if (error) throw error;
      const result = assertRpcResult<FixDeliveryResult>(data, 'fix_delivery');
      fixIdem.resetKeyFor(scope);
      setSubmittedScope(null);
      const billed = result.invoices.length === 0 ? '' : result.invoices.length === 1 ? ' with its invoice' : ' with its invoices';
      toast('success', `Delivery ${deliveryNumber} undone${billed}. Enter the corrected delivery now.`);
      onClose();
      navigate(`/deliveries/new?order=${encodeURIComponent(result.order_id)}`);
    } catch (err) {
      // Retire the key only when the server says it belongs to another request; a lost reply keeps it.
      const binding = getIdempotencyBindingRejection(err);
      if (binding === 'intent' || binding === 'actor') fixIdem.resetKeyFor(scope);
      // Reload so the screen shows what is true now (refusal reasons, a changed plan, or already undone).
      void loadPlan();
      Sentry.captureException(err, { tags: { source: 'rpc', action: 'fix_delivery' } });
      toast('error', sanitizeError(err));
    } finally {
      setSaving(false);
    }
  };

  // The fix went through but its reply was lost: the delivery is no longer completed and this key was kept.
  const alreadyUndone = !!plan && !!submittedScope && fixIdem.hasKeyFor(submittedScope)
    && plan.refusals.some((r) => r.code === 'NOT_COMPLETED');

  return (
    <Modal open={open} onClose={onClose} closeDisabled={saving} title="Fix Delivery">
      <div className="space-y-4 text-sm">
        <p className="text-secondary">
          Use this when delivery <strong>{deliveryNumber}</strong> was entered wrong (amount or product). It undoes the
          delivery and its unpaid invoice together, puts the product back in stock, and then opens a new delivery for
          the same order so you can enter it correctly and bill it again.
        </p>

        {loadError && <p role="alert" className="p-3 rounded-lg bg-red-50 text-red-800">{loadError}</p>}
        {!plan && !loadError && <p className="text-secondary">Checking this delivery…</p>}

        {alreadyUndone && <AlreadyUndoneNotice orderId={plan?.order_id ?? null} onClose={onClose} />}

        {plan && <FixRefusals refusals={plan.refusals} />}

        {plan?.can_fix && (
          <>
            <FixPlanSummary plan={plan} />
            <div>
              <label htmlFor="fix-delivery-reason" className="block font-medium text-nav-dark mb-1">What was wrong? <span aria-hidden="true" className="text-red-500">*</span></label>
              <textarea
                id="fix-delivery-reason"
                aria-required="true"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="e.g. Delivered 10 gal, entered 100"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
              />
            </div>
            <div>
              <label htmlFor="fix-delivery-confirm" className="block font-medium text-nav-dark mb-1">
                Type <strong>{confirmText}</strong> to confirm
              </label>
              <input
                id="fix-delivery-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
          </>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Go Back</Button>
          <Button variant="danger" icon={<Wrench className="w-4 h-4" />} showChevron={false} onClick={handleFix} disabled={!ready} loading={saving}>
            Fix Delivery
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AlreadyUndoneNotice({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  if (!orderId) return null;
  return (
    <p role="status" className="p-3 rounded-lg bg-green-50 text-green-900">
      This delivery was already undone.{' '}
      <Link className="font-semibold underline" to={`/deliveries/new?order=${encodeURIComponent(orderId)}`} onClick={onClose}>Enter the corrected delivery</Link>
    </p>
  );
}

function FixRefusals({ refusals }: { refusals: FixDeliveryPlan['refusals'] }) {
  if (refusals.length === 0) return null;
  return (
    <div role="alert" className="p-3 rounded-lg bg-amber-50 text-amber-900 space-y-1">
      <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="w-4 h-4" /> This delivery cannot be fixed here yet:</p>
      <ul className="list-disc list-inside">{refusals.map((r) => <li key={r.code}>{r.message}</li>)}</ul>
    </div>
  );
}

function FixPlanSummary({ plan }: { plan: FixDeliveryPlan }) {
  return (
    <div className="p-3 rounded-lg bg-red-50 text-red-900 space-y-2">
      <p className="font-semibold">What will happen:</p>
      <ul className="list-disc list-inside space-y-0.5">
        {plan.invoices.map((i) => (
          <li key={i.id}>
            Invoice {i.invoice_number} ({formatCents(i.total_cents)}) will be {i.action === 'void' ? 'voided' : 'cancelled'}
            {i.prepay_applied_cents > 0 && `; ${formatCents(i.prepay_applied_cents)} of prepay goes back to the customer's credit`}
          </li>
        ))}
        {plan.invoices.length === 0 && <li>No invoice is linked to this delivery.</li>}
        {plan.other_draft_invoices.map((i) => <li key={i.id}>Draft invoice {i.invoice_number} on this order will be cancelled</li>)}
        {plan.items.map((it, n) => <li key={`${it.product_name ?? ''}-${n}`}>{it.quantity} {it.unit ?? ''} of {it.product_name ?? 'a product'} go back into stock</li>)}
        <li>Order {plan.order_number ?? ''} reopens for these lines; the sales rep keeps the commission</li>
      </ul>
    </div>
  );
}
