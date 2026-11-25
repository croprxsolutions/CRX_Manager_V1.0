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
  loadReturnEffect, loadReturnableCheck, loadReturnableChecks, planRefundDraw, refundErrors, refundRetryKey, returnedDateError,
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
  // The duplicate-reference go-ahead, bound to the exact refund it was given for: any change takes it back (Sol r1 H3).
  const [duplicateFor, setDuplicateFor] = useState<string | null>(null);

  const credits = o.basics?.credits ?? [];
  const availableCents = credits.reduce((s, c) => s + c.balance_cents, 0);
  const pickedOnly = source === 'pick' && pickedId ? pickedId : null;
  const refundCap = credits.filter((c) => !pickedOnly || c.id === pickedOnly).reduce((s, c) => s + c.balance_cents, 0);
  const amountCents = parseDollarsToCents(amount);
  const errors = {
    ...refundErrors({
      amountCents: amount.trim() ? amountCents : 0, availableCents: refundCap, paidOn, reference, reason: o.reason, today: o.today,
      closed: o.basics?.closed ?? [],
    }),
    // "A credit I pick" with no credit picked never falls back to oldest first (Sol r1 H1).
    ...(source === 'pick' && !pickedId ? { credit: 'Pick the credit to take it from.' } : {}),
  };
  const canDraw = amountCents !== null && amountCents > 0 && amountCents <= refundCap;
  const draw = canDraw ? planRefundDraw(credits, amountCents, pickedOnly) : [];
  // The reference is what was typed, so the server's duplicate check sees the same outside payment whatever the
  // method; the method goes with the reason (Sol r1 MED 6).
  const refundReference = reference.trim();
  const refundReason = `${o.reason.trim()} (paid by ${method})`;
  const intent = JSON.stringify([o.customerId, amountCents, paidOn, refundReference, refundReason, pickedOnly]);
  const duplicate = duplicateFor === intent;
  // The retry key is the refund itself (customer, credit, amount, reference, date paid; Sol r3 H2): entering the same
  // refund again, after a lost reply and even after closing the dialog or reloading, replays its receipt instead of
  // recording it twice. A changed reason on such a resend is refused as changed details. Only a second refund the
  // admin confirms through the "same reference?" prompt gets a fresh key.
  const refundKey = refundRetryKey({
    actorId: o.profileId || '', customerId: o.customerId, creditId: pickedOnly, amountCents, reference: refundReference, paidOn,
  });
  const secondRefund = useIdempotencyKey('record_outside_refund', o.profileId || '', intent);

  const reset = () => {
    setAmount(''); setPaidOn(o.today); setMethod('Check'); setReference(''); setSource('oldest'); setPickedId(''); setDuplicateFor(null);
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
          p_reason: refundReason,
          p_credit_id: pickedOnly ?? undefined,
          p_performed_by: o.profileId,
          p_idempotency_key: duplicate ? secondRefund.getKey() : refundKey,
          p_allow_duplicate_reference: duplicate,
        });
        if (error) {
          // Refused as another request's retry key: nothing was saved, so the next try starts fresh.
          const binding = getIdempotencyBindingRejection(error);
          if (duplicate && (binding === 'intent' || binding === 'actor')) secondRefund.resetKey();
          if (/^REFUND_DUPLICATE_REFERENCE\b/.test(error.message ?? '')) { setDuplicateFor(intent); throw new CriticalActionHandledError('duplicate reference'); }
          throw error;
        }
        return assertRpcResult<{ amount_cents: number; prepay_balance_cents?: number }>(data, 'record_outside_refund');
      },
      toast: o.toast,
      setLoading: setSaving,
      sentryTag: 'record_outside_refund',
    });
    if (!result) return false;
    if (duplicate) secondRefund.resetKey();
    // The receipt's balance, not the preview's (another change may have landed meanwhile; Sol r1 MED 15).
    o.toast('success', `Refund of ${fmt(result.amount_cents)} recorded. Prepay is now ${fmt(result.prepay_balance_cents ?? availableCents - result.amount_cents)}.`);
    return true;
  };

  return {
    amount, setAmount, paidOn, setPaidOn, setMethod, reference, setReference, source, setSource, pickedId, setPickedId,
    method, duplicate, availableCents, refundCap, amountCents, errors, errorCount: Object.keys(errors).length, draw, refundReference, reset, record,
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
  const [listFailed, setListFailed] = useState(false);
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
    // Not found (not a check, voided, another customer's): say so rather than load forever (Sol r1 MED 17).
    loadReturnableCheck(o.customerId, o.allocationSetId).then((c) => { if (!live) return; if (c) pick(c); else setFailed(true); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [o.open, o.customerId, o.allocationSetId]);

  // The picker: the customer's checks of the last 12 months, read once the choice is made.
  // A read answers only the customer it was asked for (Sol r1 H2): another customer's late list is dropped.
  const [listFor, setListFor] = useState<string | null>(null);
  useEffect(() => {
    if (!o.open || !o.active || preset || listFor === o.customerId) return;
    let live = true;
    setListFor(o.customerId); setChecks(null); setListFailed(false);
    if (!preset) pick(null);
    loadReturnableChecks(o.customerId).then((list) => { if (live) setChecks(list); }).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'm9_returnable_checks' } });
      if (live) { setChecks([]); setListFailed(true); }
    });
    // Left before it answered (another choice, closed): the next visit reads again (Sol r2 MED 6).
    return () => { live = false; setListFor(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.open, o.active, preset, o.customerId]);

  const bankError = picked ? returnedDateError(bankDate, picked.date, o.today) : null;
  const idem = useIdempotencyKey('record_returned_check', o.profileId || '',
    JSON.stringify([picked?.allocationSetId, picked?.creditId, bankDate, o.reason.trim()]));

  const reset = () => {
    setChecks(null); setListFor(null); setListFailed(false); setSearch(''); setBankDate(o.today);
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
        return assertRpcResult<{ amount_cents: number; prepay_balance_cents?: number }>(data, 'record_returned_check');
      },
      toast: o.toast,
      setLoading: setSaving,
      sentryTag: 'record_returned_check',
    });
    if (!result) return false;
    idem.resetKey();
    o.toast('success', `Check ${picked.number} (${fmt(result.amount_cents)}) recorded as returned. Prepay is now ${fmt(result.prepay_balance_cents ?? availableCents - (effect?.prepayRemovedCents ?? 0))}.`);
    return true;
  };

  return {
    preset, checks, listFailed, search, setSearch, picked, pick, effect, failed, bankDate, setBankDate, bankError,
    // A picked check's "What happens" is still loading: the save waits for it (it is what the confirm shows).
    effectLoading: !!picked && !effect && !failed,
    reset, record,
  };
}
export type ReturnForm = ReturnType<typeof useReturnForm>;
