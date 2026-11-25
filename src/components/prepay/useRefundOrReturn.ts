/**
 * State and saves behind RefundOrReturnDialog (M9): one hook per choice. The database decides; these only
 * keep the form, preview it, and send it with a retry key bound to exactly what is sent.
 */
import { useEffect, useRef, useState } from 'react';
import { supabase, assertRpcResult } from '../../lib/db';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { getIdempotencyBindingRejection } from '../../lib/idempotency';
import { CriticalActionHandledError, runCriticalAction } from '../../lib/criticalAction';
import { parseDollarsToCents } from '../../lib/parseCents';
import { formatCents as fmt } from '../../lib/money';
import { Sentry } from '../../lib/sentry';
import { toSentryError } from '../../lib/sentryError';
import {
  loadReturnEffect, loadReturnableCheck, loadReturnableChecks, planRefundDraw, refundErrors, returnedDateError,
  type ClosedPeriod, type DrawCredit, type ReturnEffect, type ReturnableCheck,
} from '../../lib/m9Reversals';

type Toast = (type: 'success' | 'error' | 'info' | 'warning', message: string) => void;
export interface DialogBasics { credits: DrawCredit[]; closed: ClosedPeriod[]; owesCents: number | null }

export function useRefundForm(o: { customerId: string; basics: DialogBasics | null; today: string; reason: string; profileId?: string; toast: Toast }) {
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState<string | null>(o.today);
  const [method, setMethod] = useState('Check');
  const [reference, setReference] = useState('');
  const [source, setSource] = useState<'oldest' | 'pick'>('oldest');
  const [pickedId, setPickedId] = useState('');
  const [duplicate, setDuplicate] = useState(false);

  const credits = o.basics?.credits ?? [];
  const availableCents = credits.reduce((s, c) => s + c.balance_cents, 0);
  const pickedOnly = source === 'pick' && pickedId ? pickedId : null;
  const refundCap = credits.filter((c) => !pickedOnly || c.id === pickedOnly).reduce((s, c) => s + c.balance_cents, 0);
  const amountCents = parseDollarsToCents(amount);
  const errors = refundErrors({
    amountCents: amount.trim() ? amountCents : 0, availableCents: refundCap, paidOn, reference, reason: o.reason, today: o.today,
    closed: o.basics?.closed ?? [],
  });
  const canDraw = amountCents !== null && amountCents > 0 && amountCents <= refundCap;
  const draw = canDraw ? planRefundDraw(credits, amountCents, pickedOnly) : [];
  const refundReference = `${method} · ${reference.trim()}`;
  const idem = useIdempotencyKey('record_outside_refund', o.profileId || '',
    JSON.stringify([o.customerId, amountCents, paidOn, refundReference, o.reason.trim(), pickedOnly, duplicate]));

  const reset = () => {
    setAmount(''); setPaidOn(o.today); setMethod('Check'); setReference(''); setSource('oldest'); setPickedId(''); setDuplicate(false);
  };

  /** True once recorded (the toast is shown); false when refused or asked to confirm a duplicate. */
  const record = async (setSaving: (v: boolean) => void): Promise<boolean> => {
    if (amountCents === null || !paidOn) return false;
    const result = await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('record_outside_refund', {
          p_customer_id: o.customerId,
          p_amount_cents: amountCents,
          p_paid_on: paidOn,
          p_reference: refundReference,
          p_reason: o.reason.trim(),
          p_credit_id: pickedOnly ?? undefined,
          p_performed_by: o.profileId,
          p_idempotency_key: idem.getKey(),
          p_allow_duplicate_reference: duplicate,
        });
        if (error) {
          // Refused as another request's retry key: nothing was saved, so the next try starts fresh.
          const binding = getIdempotencyBindingRejection(error);
          if (binding === 'intent' || binding === 'actor') idem.resetKey();
          if (/^REFUND_DUPLICATE_REFERENCE\b/.test(error.message ?? '')) { setDuplicate(true); throw new CriticalActionHandledError('duplicate reference'); }
          throw error;
        }
        return assertRpcResult<{ amount_cents: number }>(data, 'record_outside_refund');
      },
      toast: o.toast,
      setLoading: setSaving,
      sentryTag: 'record_outside_refund',
    });
    if (!result) return false;
    idem.resetKey();
    o.toast('success', `Refund of ${fmt(result.amount_cents)} recorded. Prepay is now ${fmt(Math.max(availableCents - result.amount_cents, 0))}.`);
    return true;
  };

  return {
    amount, setAmount, paidOn, setPaidOn, method, setMethod, reference, setReference, source, setSource, pickedId, setPickedId,
    duplicate, availableCents, refundCap, amountCents, errors, errorCount: Object.keys(errors).length, draw, refundReference, reset, record,
  };
}
export type RefundForm = ReturnType<typeof useRefundForm>;

export function useReturnForm(o: {
  open: boolean; active: boolean; customerId: string; allocationSetId?: string; today: string; reason: string; profileId?: string; toast: Toast;
}) {
  const preset = !!o.allocationSetId;
  const [checks, setChecks] = useState<ReturnableCheck[] | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ReturnableCheck | null>(null);
  const [effect, setEffect] = useState<ReturnEffect | null>(null);
  const [failed, setFailed] = useState(false);
  const [bankDate, setBankDate] = useState<string | null>(o.today);
  const seq = useRef(0);

  const pick = (c: ReturnableCheck | null) => {
    const mine = ++seq.current;
    setPicked(c); setEffect(null); setFailed(false);
    if (!c) return;
    loadReturnEffect(c).then((e) => { if (mine === seq.current) setEffect(e); }).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'm9_return_effect' } });
      if (mine === seq.current) setFailed(true);
    });
  };

  // Opened from a payment: that check, at any age.
  useEffect(() => {
    if (!o.open || !o.allocationSetId) return;
    let live = true;
    loadReturnableCheck(o.customerId, o.allocationSetId).then((c) => { if (live) pick(c); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [o.open, o.customerId, o.allocationSetId]);

  // The picker: the customer's checks of the last 12 months, read once the choice is made.
  useEffect(() => {
    if (!o.open || !o.active || preset || checks) return;
    loadReturnableChecks(o.customerId).then(setChecks).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'm9_returnable_checks' } });
      setChecks([]); setFailed(true);
    });
  }, [o.open, o.active, preset, checks, o.customerId]);

  const bankError = picked ? returnedDateError(bankDate, picked.date, o.today) : null;
  const idem = useIdempotencyKey('record_returned_check', o.profileId || '',
    JSON.stringify([picked?.allocationSetId, picked?.creditId, bankDate, o.reason.trim()]));

  const reset = () => {
    setChecks(null); setSearch(''); setBankDate(o.today);
    if (!preset) pick(null);
  };

  const record = async (setSaving: (v: boolean) => void, availableCents: number): Promise<boolean> => {
    if (!picked || !bankDate) return false;
    const result = await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('record_returned_check', {
          // A Prepayment Manager check has no payment: the server takes exactly one of the two.
          p_allocation_set_id: picked.allocationSetId as string,
          p_credit_id: picked.creditId ?? undefined,
          p_returned_date: bankDate,
          p_reason: o.reason.trim(),
          p_performed_by: o.profileId,
          p_idempotency_key: idem.getKey(),
        });
        if (error) {
          // Refused as another request's retry key: nothing was saved, so the next try starts fresh.
          const binding = getIdempotencyBindingRejection(error);
          if (binding === 'intent' || binding === 'actor') idem.resetKey();
          throw error;
        }
        return assertRpcResult<{ amount_cents: number }>(data, 'record_returned_check');
      },
      toast: o.toast,
      setLoading: setSaving,
      sentryTag: 'record_returned_check',
    });
    if (!result) return false;
    idem.resetKey();
    o.toast('success', `Check ${picked.number} (${fmt(result.amount_cents)}) recorded as returned. Prepay is now ${fmt(Math.max(availableCents - (effect?.prepayRemovedCents ?? 0), 0))}.`);
    return true;
  };

  return {
    preset, checks, search, setSearch, picked, pick, effect, failed, bankDate, setBankDate, bankError,
    // A picked check's "What happens" is still loading: the save waits for it (it is what the confirm shows).
    effectLoading: !!picked && !effect && !failed,
    reset, record,
  };
}
export type ReturnForm = ReturnType<typeof useReturnForm>;
