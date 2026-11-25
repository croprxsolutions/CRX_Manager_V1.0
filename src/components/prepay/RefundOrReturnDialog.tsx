/**
 * RefundOrReturnDialog — M9 (design v73): the admin dialog "Record refund or returned check".
 * Two choices: a refund paid outside CRX (record_outside_refund) or a check that came back (record_returned_check).
 * Opened with a payment (allocationSetId) it is "Mark check as returned" with the check already picked.
 * Every rule here is a preview; the database decides and refuses with a plain message.
 */
import { useEffect, useState } from 'react';
import { CircleX, Info, RotateCcw, Undo2 } from 'lucide-react';
import Modal, { ALERT_BUTTON } from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { formatCents as fmt } from '../../lib/money';
import { todayInBusinessTz } from '../../lib/dateUtils';
import { Sentry } from '../../lib/sentry';
import { toSentryError } from '../../lib/sentryError';
import { loadDialogBasics } from '../../lib/m9Reversals';
import { useRefundForm, useReturnForm, type DialogBasics, type RefundForm, type ReturnForm } from './useRefundOrReturn';
import { BounceFields, CheckCard, CheckPicker, Choice, RefundConfirmBody, RefundFields, ReturnConfirmBody } from './RefundOrReturnParts';

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

/** The footer's left line: what to do next, or what the save will do. */
function footerText(kind: Kind | null, tried: boolean, f: RefundForm, r: ReturnForm): string {
  if (kind === null) return 'Pick what happened to see the form';
  if (kind === 'refund') {
    return tried && f.errorCount ? `Fix the ${f.errorCount} field${f.errorCount === 1 ? '' : 's'} above to continue` : 'Shows as “Refund paid outside CRX”';
  }
  if (!r.effect) return r.picked ? '' : 'Pick the check that came back';
  const reopened = new Set(r.effect.invoices.map((i) => i.id)).size;
  const prepay = r.effect.prepayRemovedCents > 0 ? `prepay −${fmt(r.effect.prepayRemovedCents)}` : '';
  return [`${reopened} invoice${reopened === 1 ? '' : 's'} back to unpaid`, prepay].filter(Boolean).join(' · ');
}

function subtitleText(farmName: string, kind: Kind | null, fromLabel: string | undefined, preset: boolean, availableCents: number) {
  if (preset) return `${farmName} · from ${fromLabel ?? 'the payment'}`;
  return kind === 'bounce' ? `${farmName} · checks received` : `${farmName} · prepay available ${fmt(availableCents)}`;
}

/** The returned-check form can go to its confirm: a check, a valid bank date, a reason, and its effect loaded. */
const returnReady = (r: ReturnForm, reason: string) => !!r.picked && !r.bankError && !!reason.trim() && !!r.effect;

/** The confirm: a centred card, a bottom sheet on phones. It repeats the action and shows the balance change. */
function ConfirmDialog({ refund, f, r, saving, onBack, onRecord, farmName, today, reason }: {
  refund: boolean; f: RefundForm; r: ReturnForm; saving: boolean; onBack: () => void; onRecord: () => void; farmName: string; today: string; reason: string;
}) {
  const recordLabel = refund ? (f.duplicate ? 'Record a second refund' : 'Record refund') : 'Record returned check';
  return (
    <Modal
      open
      onClose={() => { if (!saving) onBack(); }}
      closeDisabled={saving}
      size="alert"
      icon={refund ? Undo2 : CircleX}
      iconClassName={refund ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}
      title={refund ? `Record a ${fmt(f.amountCents ?? 0)} refund?` : `Return check ${r.picked?.number} (${fmt(r.picked?.amountCents ?? 0)})?`}
      footer={
        <>
          <Button variant="secondary" onClick={onBack} disabled={saving} className={ALERT_BUTTON}>Go back</Button>
          <Button onClick={onRecord} loading={saving} className={ALERT_BUTTON}>{saving ? 'Recording…' : recordLabel}</Button>
        </>
      }
    >
      {refund ? <RefundConfirmBody f={f} /> : <ReturnConfirmBody r={r} farmName={farmName} availableCents={f.availableCents} today={today} reason={reason} />}
    </Modal>
  );
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
  const [reason, setReason] = useState('');
  const [basics, setBasics] = useState<DialogBasics | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const f = useRefundForm({ customerId, basics, today, reason, profileId: profile?.id, toast });
  const r = useReturnForm({ open, active: kind === 'bounce', customerId, allocationSetId, today, reason, profileId: profile?.id, toast });

  useEffect(() => {
    if (!open) return;
    let live = true;
    setBasics(null); setLoadFailed(false);
    loadDialogBasics(customerId).then((b) => { if (live) setBasics(b); }).catch((err) => {
      Sentry.captureException(toSentryError(err), { extra: { context: 'm9_dialog_basics' } });
      if (live) setLoadFailed(true);
    });
    return () => { live = false; };
  }, [open, customerId]);

  const close = () => {
    setKind(preset ? 'bounce' : null); setStep('form'); setTried(false); setReason('');
    f.reset(); r.reset();
    onClose();
  };
  const pickKind = (k: Kind) => { setKind(k); setTried(false); };

  const onPrimary = () => {
    setTried(true);
    if (kind === 'refund' ? f.errorCount === 0 : returnReady(r, reason)) setStep('confirm');
  };
  const effectLoading = kind === 'bounce' && r.effectLoading;
  const onRecord = async () => {
    const done = kind === 'refund' ? await f.record(setSaving) : await r.record(setSaving, f.availableCents);
    if (!done) return;
    onRecorded();
    close();
  };

  if (open && step === 'confirm') {
    return <ConfirmDialog refund={kind === 'refund'} f={f} r={r} saving={saving} onBack={() => setStep('form')} onRecord={onRecord}
      farmName={farmName} today={today} reason={reason} />;
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={preset ? 'Mark check as returned' : 'Record refund or returned check'}
      subtitle={subtitleText(farmName, kind, fromLabel, preset, f.availableCents)}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex w-full flex-col-reverse gap-2.5 md:flex-row md:items-center md:justify-end">
          <span className="text-center text-[13px] text-secondary max-md:order-last md:mr-auto md:text-left">{footerText(kind, tried, f, r)}</span>
          <Button variant="ghost" onClick={close} className="max-md:order-first max-md:min-h-12">Cancel</Button>
          {kind && (
            <Button onClick={onPrimary} disabled={!basics || effectLoading} loading={effectLoading}
              className="max-md:min-h-12" icon={kind === 'refund' ? <Undo2 className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}>
              {kind === 'refund' ? 'Record refund…' : 'Record returned check…'}
            </Button>
          )}
        </div>
      }
    >
      <FormBody kind={kind} pickKind={pickKind} preset={preset} loadFailed={loadFailed} f={f} r={r} tried={tried} basics={basics}
        today={today} reason={reason} setReason={setReason} />
    </Modal>
  );
}

function FormBody({ kind, pickKind, preset, loadFailed, f, r, tried, basics, today, reason, setReason }: {
  kind: Kind | null; pickKind: (k: Kind) => void; preset: boolean; loadFailed: boolean; f: RefundForm; r: ReturnForm; tried: boolean;
  basics: DialogBasics | null; today: string; reason: string; setReason: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      {loadFailed && <p role="alert" className="text-sm text-red-600">This customer's prepay could not be loaded. Close and try again.</p>}
      {!preset && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-secondary">What happened?</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice checked={kind === 'refund'} onPick={() => pickKind('refund')} icon={<Undo2 className="h-4 w-4" />}
              title="Refund paid outside CRX" text="We paid prepay back to the grower, for example a QuickBooks check." />
            <Choice checked={kind === 'bounce'} onPick={() => pickKind('bounce')} icon={<CircleX className="h-4 w-4" />}
              title="Check came back (bounced)" text="A check we recorded was returned by the bank." />
          </div>
        </fieldset>
      )}
      {kind === null && (
        <p className="flex gap-2.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-[13px] text-secondary">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Both are dated in an open month and show in the history.
        </p>
      )}
      {kind === 'refund' && (
        <RefundFields f={f} tried={tried} credits={basics?.credits ?? []} closed={basics?.closed ?? []} today={today} reason={reason} setReason={setReason} />
      )}
      {kind === 'bounce' && <ReturnBody r={r} tried={tried} today={today} availableCents={f.availableCents} owesCents={basics?.owesCents ?? null} reason={reason} setReason={setReason} />}
    </div>
  );
}

function ReturnBody({ r, tried, today, availableCents, owesCents, reason, setReason }: {
  r: ReturnForm; tried: boolean; today: string; availableCents: number; owesCents: number | null; reason: string; setReason: (v: string) => void;
}) {
  return (
    <>
      {!r.preset && <CheckPicker r={r} tried={tried} />}
      {r.preset && (r.picked ? <CheckCard c={r.picked} picked={r.picked} />
        : r.failed ? <p role="alert" className="text-sm text-red-600">This payment can't be returned here: it is not a check, or it was voided. Close and check Payment History.</p>
          : <div className="h-20 animate-pulse rounded-xl bg-gray-100" />)}
      {r.picked && (
        <BounceFields r={r} check={r.picked} tried={tried} today={today} availableCents={availableCents} owesCents={owesCents} reason={reason} setReason={setReason} />
      )}
    </>
  );
}
