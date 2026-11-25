/**
 * RefundOrReturnDialog — M9 (design v73): the admin dialog "Record refund or returned check".
 * Two choices: a refund paid outside CRX (record_outside_refund) or a check that came back (record_returned_check).
 * Opened with a payment (allocationSetId) it is "Mark check as returned" with the check already picked.
 * Every rule here is a preview; the database decides and refuses with a plain message.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Banknote, CalendarCheck, CircleX, FileX2, Info, Lock, RotateCcw, Search, Sigma, Undo2, Wallet } from 'lucide-react';
import Modal, { ALERT_BUTTON } from '../ui/Modal';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import DatePicker from '../ui/DatePicker';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, assertRpcResult } from '../../lib/db';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { getIdempotencyBindingRejection } from '../../lib/idempotency';
import { CriticalActionHandledError, runCriticalAction } from '../../lib/criticalAction';
import { parseDollarsToCents } from '../../lib/parseCents';
import { formatCents as fmt } from '../../lib/money';
import { parseLocalDate, todayInBusinessTz } from '../../lib/dateUtils';
import { Sentry } from '../../lib/sentry';
import { toSentryError } from '../../lib/sentryError';
import {
  closedMonthBadge, drawText, fmtDay, loadDialogBasics, loadReturnEffect, loadReturnableCheck, loadReturnableChecks, openWindowText,
  planRefundDraw, refundErrors, returnedDateError, type ClosedPeriod, type DrawCredit, type ReturnEffect, type ReturnableCheck,
} from '../../lib/m9Reversals';

interface Props {
  open: boolean;
  onClose: () => void;
  /** After a refund or return was recorded: reload what it changed. */
  onRecorded: () => void;
  customerId: string;
  farmName: string;
  /** Opened from a payment line: "Mark check as returned" with this payment picked. */
  allocationSetId?: string;
  /** The subtitle's "from INV-20290" (the invoice or page it was opened from). */
  fromLabel?: string;
}

type Kind = 'refund' | 'bounce';
const METHODS = ['Check', 'ACH', 'Cash', 'Card', 'Other'];
const monthOf = (ymd: string) => parseLocalDate(ymd).toLocaleDateString('en-US', { month: 'long' });
const shortDay = (ymd: string) => parseLocalDate(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** A form field whose helper line is always there, so an error never makes the form jump. */
function Field({ id, label, required, helper, error, children }: { id: string; label: string; required?: boolean; helper?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-secondary">{label}{required && <span className="ml-0.5 text-red-600">*</span>}</label>
      {children}
      <p id={`${id}-help`} role={error ? 'alert' : undefined} className={`flex min-h-5 items-start gap-1.5 text-xs ${error ? 'text-red-600' : 'text-secondary'}`}>
        {error && <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />}{error || helper}
      </p>
    </div>
  );
}

const textareaClass = (error?: string) => `${inputClass(error).replace('h-11 md:h-10', 'min-h-18 resize-y')} py-2.5`;
const inputClass = (error?: string) => `w-full h-11 md:h-10 px-3 text-sm text-nav-dark bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green ${error ? 'border-red-500' : 'border-gray-300'}`;

function Choice({ checked, onPick, icon, title, text }: { checked: boolean; onPick: () => void; icon: ReactNode; title: string; text: string }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3.5 ${checked ? 'border-crx-green bg-crx-green-tint ring-1 ring-crx-green' : 'border-gray-200 bg-white'}`}>
      <input type="radio" name="m9-kind" checked={checked} onChange={onPick} className="mt-0.5 h-4 w-4 shrink-0 accent-crx-green" />
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-semibold text-nav-dark"><span className="text-secondary" aria-hidden="true">{icon}</span>{title}</span>
        <span className="mt-0.5 block text-[13px] text-secondary">{text}</span>
      </span>
    </label>
  );
}

function EffectRow({ icon, tone, title, cents, children, muted }: { icon: ReactNode; tone: 'bounce' | 'refund' | 'out'; title: string; cents?: number; children: ReactNode; muted?: boolean }) {
  const tones = { bounce: 'bg-red-50 text-red-700', refund: 'bg-amber-50 text-amber-700', out: 'bg-gray-100 text-secondary' };
  return (
    <div className={`flex gap-3 border-t border-gray-200 px-3.5 py-3 first:border-t-0 ${muted ? 'bg-gray-50' : ''}`}>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tones[tone]}`} aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3"><b className="text-nav-dark">{title}</b>{cents !== undefined && <b className="tabular-nums">{fmt(cents)}</b>}</div>
        <div className="text-xs text-secondary">{children}</div>
      </div>
    </div>
  );
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex justify-between gap-3 border-b border-gray-100 py-1.5 last:border-b-0"><span className="text-secondary">{label}</span><span className="text-right text-nav-dark">{children}</span></div>;
}

export default function RefundOrReturnDialog({ open, onClose, onRecorded, customerId, farmName, allocationSetId, fromLabel }: Props) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const today = todayInBusinessTz();
  const preset = !!allocationSetId;

  const [kind, setKind] = useState<Kind | null>(preset ? 'bounce' : null);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [basics, setBasics] = useState<{ credits: DrawCredit[]; closed: ClosedPeriod[]; owesCents: number | null } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Refund form
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState<string | null>(today);
  const [method, setMethod] = useState('Check');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState<'oldest' | 'pick'>('oldest');
  const [pickedId, setPickedId] = useState('');
  const [duplicate, setDuplicate] = useState(false);

  // Returned check
  const [checks, setChecks] = useState<ReturnableCheck[] | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ReturnableCheck | null>(null);
  const [effect, setEffect] = useState<ReturnEffect | null>(null);
  const [effectFailed, setEffectFailed] = useState(false);
  const [bankDate, setBankDate] = useState<string | null>(today);
  const effectSeq = useRef(0);

  const pickCheck = (c: ReturnableCheck | null) => {
    const seq = ++effectSeq.current;
    setPicked(c); setEffect(null); setEffectFailed(false);
    if (!c) return;
    loadReturnEffect(c).then((e) => { if (seq === effectSeq.current) setEffect(e); }).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'm9_return_effect' } });
      if (seq === effectSeq.current) setEffectFailed(true);
    });
  };
  useEffect(() => {
    if (!open) return;
    let live = true;
    setBasics(null); setLoadFailed(false);
    loadDialogBasics(customerId).then((b) => { if (live) setBasics(b); }).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'm9_dialog_basics' } });
      if (live) setLoadFailed(true);
    });
    if (preset) {
      loadReturnableCheck(customerId, allocationSetId).then((c) => { if (live) pickCheck(c); }).catch(() => { if (live) setEffectFailed(true); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customerId, allocationSetId]);

  useEffect(() => {
    if (!open || kind !== 'bounce' || preset || checks) return;
    loadReturnableChecks(customerId).then(setChecks).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'm9_returnable_checks' } });
      setChecks([]); setEffectFailed(true);
    });
  }, [open, kind, preset, checks, customerId]);



  const availableCents = basics?.credits.reduce((s, c) => s + c.balance_cents, 0) ?? 0;
  const closed = basics?.closed ?? [];
  const amountCents = parseDollarsToCents(amount);
  const sourceCredits = source === 'pick' && pickedId ? basics?.credits.filter((c) => c.id === pickedId) ?? [] : basics?.credits ?? [];
  const refundCap = sourceCredits.reduce((s, c) => s + c.balance_cents, 0);
  const errors = refundErrors({ amountCents: amount.trim() ? amountCents : 0, availableCents: refundCap, paidOn, reference, reason, today, closed });
  const errorCount = Object.keys(errors).length;
  const draw = amountCents && amountCents > 0 && amountCents <= refundCap ? planRefundDraw(basics?.credits ?? [], amountCents, source === 'pick' ? pickedId || null : null) : [];
  const refundReference = `${method} · ${reference.trim()}`;

  const bankError = picked ? returnedDateError(bankDate, picked.date, today) : null;
  const bounceErrors = { check: !picked, bank: bankError, reason: reason.trim() ? null : 'Add a reason. It shows in the prepay history.' };
  const reopened = effect ? new Set(effect.invoices.map((i) => i.id)).size : 0;
  const owesAdd = effect ? effect.invoices.reduce((s, i) => s + i.cents, 0) : 0;

  const refundIdem = useIdempotencyKey('record_outside_refund', profile?.id || '', JSON.stringify([customerId, amountCents, paidOn, refundReference, reason.trim(), source === 'pick' ? pickedId : null, duplicate]));
  const returnIdem = useIdempotencyKey('record_returned_check', profile?.id || '', JSON.stringify([picked?.allocationSetId, picked?.creditId, bankDate, reason.trim()]));

  const resetAndClose = () => {
    setKind(preset ? 'bounce' : null); setStep('form'); setTried(false); setAmount(''); setPaidOn(today); setMethod('Check');
    setReference(''); setReason(''); setSource('oldest'); setPickedId(''); setDuplicate(false); setChecks(null); setSearch('');
    if (!preset) pickCheck(null);
    setBankDate(today);
    onClose();
  };

  const recordRefund = async () => {
    if (amountCents === null) return;
    const result = await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('record_outside_refund', {
          p_customer_id: customerId,
          p_amount_cents: amountCents,
          p_paid_on: paidOn as string,
          p_reference: refundReference,
          p_reason: reason.trim(),
          p_credit_id: source === 'pick' && pickedId ? pickedId : undefined,
          p_performed_by: profile?.id,
          p_idempotency_key: refundIdem.getKey(),
          p_allow_duplicate_reference: duplicate,
        });
        if (error) {
          const binding = getIdempotencyBindingRejection(error);
          if (binding === 'intent' || binding === 'actor') refundIdem.resetKey();
          if (/^REFUND_DUPLICATE_REFERENCE\b/.test(error.message ?? '')) { setDuplicate(true); throw new CriticalActionHandledError('duplicate reference'); }
          throw error;
        }
        return assertRpcResult<{ amount_cents: number; prepay_balance_cents: number }>(data, 'record_outside_refund');
      },
      toast,
      setLoading: setSaving,
      sentryTag: 'record_outside_refund',
    });
    if (!result) return;
    refundIdem.resetKey();
    toast('success', `Refund of ${fmt(result.amount_cents)} recorded. Prepay is now ${fmt(Math.max(availableCents - result.amount_cents, 0))}.`);
    onRecorded();
    resetAndClose();
  };

  const recordReturn = async () => {
    if (!picked || !bankDate) return;
    const result = await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('record_returned_check', {
          // A Prepayment Manager check has no payment: the server takes exactly one of the two.
          p_allocation_set_id: picked.allocationSetId as string,
          p_credit_id: picked.creditId ?? undefined,
          p_returned_date: bankDate,
          p_reason: reason.trim(),
          p_performed_by: profile?.id,
          p_idempotency_key: returnIdem.getKey(),
        });
        if (error) {
          const binding = getIdempotencyBindingRejection(error);
          if (binding === 'intent' || binding === 'actor') returnIdem.resetKey();
          throw error;
        }
        return assertRpcResult<{ amount_cents: number; prepay_removed_cents: number }>(data, 'record_returned_check');
      },
      toast,
      setLoading: setSaving,
      sentryTag: 'record_returned_check',
    });
    if (!result) return;
    returnIdem.resetKey();
    toast('success', `Check ${picked.number} (${fmt(result.amount_cents)}) recorded as returned. Prepay is now ${fmt(Math.max(availableCents - (effect?.prepayRemovedCents ?? 0), 0))}.`);
    onRecorded();
    resetAndClose();
  };

  const onPrimary = () => {
    setTried(true);
    if (kind === 'refund' ? errorCount > 0 : (bounceErrors.check || bounceErrors.bank || bounceErrors.reason || !effect)) return;
    setStep('confirm');
  };

  const subtitle = preset ? `${farmName} · from ${fromLabel ?? 'the payment'}` : kind === 'bounce' ? `${farmName} · checks received` : `${farmName} · prepay available ${fmt(availableCents)}`;
  const closedNote = picked?.closedMonth ? `${monthOf(picked.date)} stays closed.` : '';

  // ---------- Confirm (a short sheet on phones) ----------
  if (open && step === 'confirm') {
    const refund = kind === 'refund';
    return (
      <Modal
        open
        onClose={() => { if (!saving) setStep('form'); }}
        closeDisabled={saving}
        size="alert"
        icon={refund ? Undo2 : CircleX}
        iconClassName={refund ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}
        title={refund ? `Record a ${fmt(amountCents ?? 0)} refund?` : `Return check ${picked?.number} (${fmt(picked?.amountCents ?? 0)})?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setStep('form')} disabled={saving} className={ALERT_BUTTON}>Go back</Button>
            <Button onClick={refund ? recordRefund : recordReturn} loading={saving} className={ALERT_BUTTON}>
              {saving ? 'Recording…' : refund ? (duplicate ? 'Record a second refund' : 'Record refund') : 'Record returned check'}
            </Button>
          </>
        }
      >
        {refund ? (
          <div className="text-sm">
            <p className="mb-2 font-heading text-2xl font-semibold tabular-nums text-nav-dark"><span className="font-light text-secondary">Prepay {fmt(availableCents)}</span> → {fmt(availableCents - (amountCents ?? 0))}</p>
            <Kv label="From"><span className="whitespace-pre-line">{draw.map((d) => `${d.label} ${fmt(d.cents)}`).join('\n')}</span></Kv>
            <Kv label="Dated">{paidOn ? fmtDay(paidOn) : ''}</Kv>
            <Kv label="Paid by">{refundReference}</Kv>
            {duplicate && (
              <p role="alert" className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-amber-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                A refund with reference “{refundReference}” is already recorded for this customer. Record it only if this is a second payment.
              </p>
            )}
          </div>
        ) : (
          <div className="text-sm">
            <Kv label="Customer">{farmName}</Kv>
            <Kv label="Back to unpaid"><span className="whitespace-pre-line tabular-nums">{effect?.invoices.map((i) => `${i.number} ${fmt(i.cents)}${i.overdue ? ' (Overdue)' : ''}`).join('\n') || 'None'}</span></Kv>
            <Kv label="Prepay"><span className="tabular-nums">{fmt(availableCents)} → {fmt(availableCents - (effect?.prepayRemovedCents ?? 0))}</span></Kv>
            <Kv label="Bank returned it">{bankDate ? fmtDay(bankDate) : ''}</Kv>
            <Kv label="Entry dated">{fmtDay(today)} (today)</Kv>
            <Kv label="Reason">{reason.trim()}</Kv>
            {closedNote && (
              <p className="mt-2.5 flex gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5 text-secondary">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{closedNote} Nothing in a closed month changes.
              </p>
            )}
          </div>
        )}
      </Modal>
    );
  }

  // ---------- Returned-check parts ----------
  const visibleChecks = (checks ?? []).filter((c) => !search.trim() || c.number.toLowerCase().includes(search.trim().toLowerCase()));
  const checkCard = (c: ReturnableCheck, asRadio: boolean) => {
    const on = picked?.allocationSetId === c.allocationSetId && picked?.creditId === c.creditId;
    const body = (
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3"><b className={c.disabledReason ? 'text-secondary' : 'text-nav-dark'}>Check {c.number} · {fmtDay(c.date)}</b><b className="tabular-nums">{fmt(c.amountCents)}</b></div>
        {c.meta && <div className="text-[13px] text-secondary">{c.meta}</div>}
        <div className="mt-1 flex flex-wrap gap-1.5">
          {c.prepayCheck && <Badge variant="success" normalCase>Prepay check</Badge>}
          {c.closedMonth && <Badge variant="default" normalCase>{closedMonthBadge(c.date)}</Badge>}
          {c.disabledReason && <Badge variant="danger" normalCase>{c.disabledReason}</Badge>}
        </div>
      </div>
    );
    const cls = `mb-2 flex items-start gap-3 rounded-xl border px-3.5 py-3 ${on ? 'border-crx-green bg-crx-green-tint ring-1 ring-crx-green' : 'border-gray-200'} ${c.disabledReason ? 'cursor-not-allowed bg-gray-50' : asRadio ? 'cursor-pointer bg-white' : 'bg-white'}`;
    if (!asRadio) return <div className={cls}><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-secondary" aria-hidden="true"><Banknote className="h-4 w-4" /></span>{body}</div>;
    return (
      <label key={`${c.allocationSetId}-${c.creditId}`} className={cls}>
        <input type="radio" name="m9-check" aria-label={`Check ${c.number} · ${fmtDay(c.date)} ${fmt(c.amountCents)}`} checked={on} disabled={!!c.disabledReason} onChange={() => pickCheck(c)} className="mt-1 h-4 w-4 shrink-0 accent-crx-green" />
        {body}
      </label>
    );
  };

  const bounceFields = picked && (
    <>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <DatePicker label="Bank returned it on *" value={bankDate} onChange={setBankDate}
            error={tried && bankError ? bankError : undefined}
            helper={`Any date, even in a closed month; not before the check (${shortDay(picked.date)})`} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-medium text-secondary">Entry date</span>
          <div data-testid="entry-date" className="flex h-11 items-center justify-between rounded-lg border border-gray-300 bg-gray-50 px-3 text-sm text-secondary md:h-10">
            <span className="tabular-nums">{fmtDay(today)} (today)</span><Lock className="h-4 w-4" aria-hidden="true" />
          </div>
          <p className="min-h-5 text-xs text-secondary">{closedNote ? `Always today. ${closedNote}` : 'Always today.'}</p>
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium text-secondary">What happens</p>
        {effectFailed ? (
          <p role="alert" className="text-sm text-red-600">What this check paid could not be loaded. Close and try again.</p>
        ) : !effect ? (
          <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200" aria-live="polite">
            {effect.invoices.map((i) => (
              <EffectRow key={`${i.id}-${i.viaPrepay}`} icon={<FileX2 className="h-4 w-4" />} tone="bounce" title={`${i.number} goes back to unpaid`} cents={i.cents}>
                {i.dueDate ? `Due ${shortDay(i.dueDate)}` : 'No due date'}
                {i.overdue && <>, so it shows as <Badge variant="danger" normalCase>Overdue</Badge></>}
                {i.viaPrepay ? ` · paid${i.paidOn ? ` on ${shortDay(i.paidOn)}` : ''} from ${i.viaPrepay}, which this check funded` : ` · the check's ${fmt(i.cents)} is removed from it`}
              </EffectRow>
            ))}
            {effect.prepayRemovedCents > 0 && (
              <EffectRow icon={<Wallet className="h-4 w-4" />} tone="refund" title={`Remaining ${effect.removedLabel} is removed`} cents={effect.prepayRemovedCents}>
                <span className="tabular-nums">Prepay {fmt(availableCents)} → {fmt(availableCents - effect.prepayRemovedCents)}</span>
              </EffectRow>
            )}
            <EffectRow icon={<Sigma className="h-4 w-4" />} tone="out" title="Check total" cents={picked.amountCents} muted>
              <span className="tabular-nums">
                {[...effect.invoices.map((i) => i.cents), ...(effect.prepayRemovedCents > 0 ? [effect.prepayRemovedCents] : [])].map((c) => fmt(c)).join(' + ')}
                {basics?.owesCents != null && ` · customer owes ${fmt(basics.owesCents)} → ${fmt(basics.owesCents + owesAdd)}`}
              </span>
            </EffectRow>
            <EffectRow icon={<CalendarCheck className="h-4 w-4" />} tone="out" title={`Entry dated today, ${fmtDay(today)}`}>
              {`The bank returned it on ${bankDate ? shortDay(bankDate) : '…'}. `}
              {picked.closedMonth ? `The check was in ${monthOf(picked.date)}, which stays closed; the entry goes in ${monthOf(today)}, which is open.` : `The entry goes in ${monthOf(today)}, which is open.`}
            </EffectRow>
          </div>
        )}
      </div>
      <Field id="m9-bounce-reason" label="Reason" required error={tried ? bounceErrors.reason ?? undefined : undefined} helper="Shows in the prepay history and on the invoices">
        <textarea id="m9-bounce-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000}
          placeholder="Bank returned it: insufficient funds" className={textareaClass(tried ? bounceErrors.reason ?? undefined : undefined)} />
      </Field>
    </>
  );

  // ---------- Refund form ----------
  const fieldError = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  const refundForm = (
    <>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <Field id="m9-amount" label="Amount" required error={fieldError('amount')} helper={`Up to ${fmt(refundCap)} available`}>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500" aria-hidden="true">$</span>
            <input id="m9-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!fieldError('amount')}
              aria-describedby="m9-amount-help" className={`${inputClass(fieldError('amount'))} pl-7 tabular-nums`} data-autofocus />
          </div>
        </Field>
        <div className="flex min-w-0 flex-col gap-1.5">
          <DatePicker label="Date paid *" value={paidOn} onChange={setPaidOn} error={fieldError('paidOn')}
            helper={`${paidOn === today ? 'Today. ' : ''}Open month only (${openWindowText(closed, today)}).`} />
        </div>
        <Field id="m9-method" label="How it was paid" required>
          <select id="m9-method" value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass()}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
        </Field>
        <Field id="m9-reference" label="Reference" required error={fieldError('reference')} helper="So it can be found in QuickBooks">
          <input id="m9-reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={180} placeholder="QuickBooks check 1057"
            aria-invalid={!!fieldError('reference')} className={inputClass(fieldError('reference'))} />
        </Field>
      </div>
      <Field id="m9-refund-reason" label="Reason" required error={fieldError('reason')}>
        <textarea id="m9-refund-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000}
          placeholder="Why was this paid back?" aria-invalid={!!fieldError('reason')} className={textareaClass(fieldError('reason'))} />
      </Field>
      <fieldset>
        <legend className="text-sm font-medium text-secondary">Take it from</legend>
        <label className="flex cursor-pointer items-start gap-2.5 py-2">
          <input type="radio" name="m9-src" checked={source === 'oldest'} onChange={() => setSource('oldest')} className="mt-0.5 h-4 w-4 accent-crx-green" aria-label="Oldest prepay first (recommended)" />
          <span><b>Oldest prepay first</b><span className="text-secondary"> (recommended)</span>
            <span className="block text-xs text-secondary">{source === 'oldest' && draw.length ? drawText(draw) : `Shows which credits are used once the amount is ${fmt(availableCents)} or less`}</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 py-2">
          <input type="radio" name="m9-src" checked={source === 'pick'} onChange={() => setSource('pick')} className="mt-0.5 h-4 w-4 accent-crx-green" aria-label="A credit I pick" />
          <span className="min-w-0 flex-1"><b>A credit I pick</b><span className="block text-xs text-secondary">Opens a list of open credits with their balances</span>
            {source === 'pick' && (
              <select aria-label="Credit to take it from" value={pickedId} onChange={(e) => setPickedId(e.target.value)} className={`${inputClass()} mt-2`}>
                <option value="">Choose a credit…</option>
                {basics?.credits.map((c) => <option key={c.id} value={c.id}>{c.label} · {fmt(c.balance_cents)}</option>)}
              </select>
            )}
          </span>
        </label>
      </fieldset>
      {draw.length > 0 && (
        <div data-testid="refund-summary" aria-live="polite" className="rounded-xl border border-gray-200 bg-cream px-3.5 py-3">
          <div className="text-xs text-secondary">After this refund</div>
          <div className="font-heading text-[22px] font-semibold tabular-nums text-nav-dark">Prepay {fmt(availableCents)} <span className="text-secondary">→</span> {fmt(availableCents - (amountCents ?? 0))}</div>
        </div>
      )}
    </>
  );

  const footerLeft = kind === null
    ? 'Pick what happened to see the form'
    : kind === 'refund'
      ? (tried && errorCount ? `Fix the ${errorCount} field${errorCount === 1 ? '' : 's'} above to continue` : 'Shows as “Refund paid outside CRX”')
      : effect ? [`${reopened} invoice${reopened === 1 ? '' : 's'} back to unpaid`, effect.prepayRemovedCents > 0 ? `prepay −${fmt(effect.prepayRemovedCents)}` : ''].filter(Boolean).join(' · ') : picked ? '' : 'Pick the check that came back';

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title={preset ? 'Mark check as returned' : 'Record refund or returned check'}
      subtitle={subtitle}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex w-full flex-col-reverse gap-2.5 md:flex-row md:items-center md:justify-end">
          <span className="text-center text-[13px] text-secondary max-md:order-last md:mr-auto md:text-left">{footerLeft}</span>
          <Button variant="ghost" onClick={resetAndClose} className="max-md:order-first max-md:min-h-12">Cancel</Button>
          {kind && (
            <Button onClick={onPrimary} disabled={!basics} className="max-md:min-h-12" icon={kind === 'refund' ? <Undo2 className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}>
              {kind === 'refund' ? 'Record refund…' : 'Record returned check…'}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        {loadFailed && <p role="alert" className="text-sm text-red-600">This customer's prepay could not be loaded. Close and try again.</p>}
        {!preset && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-secondary">What happened?</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Choice checked={kind === 'refund'} onPick={() => { setKind('refund'); setTried(false); }} icon={<Undo2 className="h-4 w-4" />}
                title="Refund paid outside CRX" text="We paid prepay back to the grower, for example a QuickBooks check." />
              <Choice checked={kind === 'bounce'} onPick={() => { setKind('bounce'); setTried(false); }} icon={<CircleX className="h-4 w-4" />}
                title="Check came back (bounced)" text="A check we recorded was returned by the bank." />
            </div>
          </fieldset>
        )}
        {kind === null && (
          <p className="flex gap-2.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-[13px] text-secondary">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Both are dated in an open month and show in the history.
          </p>
        )}
        {kind === 'refund' && refundForm}
        {kind === 'bounce' && !preset && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-secondary">Which check came back? <span className="text-red-600">*</span></legend>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden="true" />
              <input type="search" aria-label="Find a check by number" placeholder="Find a check by number" value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputClass()} pl-9`} />
            </div>
            {checks === null ? <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
              : visibleChecks.length === 0 ? <p className="py-3 text-sm text-secondary">{checks.length ? 'No check with that number.' : 'No checks from this customer in the last 12 months.'}</p>
                : visibleChecks.map((c) => checkCard(c, true))}
            {tried && !picked && <p role="alert" className="text-xs text-red-600">Pick the check that came back.</p>}
            <p className="text-xs text-secondary">Checks only, last 12 months, newest first. ACH and other payments are not listed.</p>
          </fieldset>
        )}
        {kind === 'bounce' && preset && (picked ? checkCard(picked, false) : effectFailed
          ? <p role="alert" className="text-sm text-red-600">This payment can't be returned here: it is not a check, or it was voided. Close and check Payment History.</p>
          : <div className="h-20 animate-pulse rounded-xl bg-gray-100" />)}
        {kind === 'bounce' && bounceFields}
      </div>
    </Modal>
  );
}
