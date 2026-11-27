/** The pieces RefundOrReturnDialog (M9, design v73) is drawn from: fields, the two forms and the confirm bodies. */
import type { ReactNode } from 'react';
import { AlertCircle, Banknote, CalendarCheck, FileX2, Lock, Search, Sigma, Wallet } from 'lucide-react';
import Badge from '../ui/Badge';
import DatePicker from '../ui/DatePicker';
import { formatCents as fmt } from '../../lib/money';
import { parseLocalDate } from '../../lib/dateUtils';
import { closedMonthBadge, drawText, fmtDay, openWindowText, type ClosedPeriod, type DrawCredit, type ReturnEffect, type ReturnableCheck } from '../../lib/m9Reversals';
import type { RefundForm as RefundState, ReturnForm as ReturnState } from './useRefundOrReturn';

const METHODS = ['Check', 'ACH', 'Cash', 'Card', 'Other'];
const monthOf = (ymd: string) => parseLocalDate(ymd).toLocaleDateString('en-US', { month: 'long' });
const shortDay = (ymd: string) => parseLocalDate(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const REASON_REQUIRED = 'Add a reason. It shows in the prepay history.';

const inputClass = (error?: string) => `w-full h-11 md:h-10 px-3 text-sm text-nav-dark bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green ${error ? 'border-red-500' : 'border-gray-300'}`;
const textareaClass = (error?: string) => `${inputClass(error).replace('h-11 md:h-10', 'min-h-18 resize-y')} py-2.5`;

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

function ReasonField({ id, value, onChange, error, placeholder, helper }: { id: string; value: string; onChange: (v: string) => void; error?: string; placeholder: string; helper?: string }) {
  return (
    <Field id={id} label="Reason" required error={error} helper={helper}>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={2000}
        placeholder={placeholder} aria-invalid={!!error} className={textareaClass(error)} />
    </Field>
  );
}

export function Choice({ checked, onPick, icon, title, text }: { checked: boolean; onPick: () => void; icon: ReactNode; title: string; text: string }) {
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

// ---------------------------------------------------------------------------------------------------------------
// Refund

export function RefundFields({ f, tried, credits, closed, today, reason, setReason }: {
  f: RefundState; tried: boolean; credits: DrawCredit[]; closed: ClosedPeriod[]; today: string; reason: string; setReason: (v: string) => void;
}) {
  const err = (k: keyof RefundState['errors']) => (tried ? f.errors[k] : undefined);
  return (
    <>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <Field id="m9-amount" label="Amount" required error={err('amount')} helper={`Up to ${fmt(f.refundCap)} available`}>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500" aria-hidden="true">$</span>
            <input id="m9-amount" inputMode="decimal" value={f.amount} onChange={(e) => f.setAmount(e.target.value)} aria-invalid={!!err('amount')}
              aria-describedby="m9-amount-help" className={`${inputClass(err('amount'))} pl-7 tabular-nums`} data-autofocus />
          </div>
        </Field>
        <div className="flex min-w-0 flex-col gap-1.5">
          <DatePicker label="Date paid *" value={f.paidOn} onChange={f.setPaidOn} error={err('paidOn')}
            helper={`${f.paidOn === today ? 'Today. ' : ''}Open month only (${openWindowText(closed, today)}).`} />
        </div>
        <Field id="m9-method" label="How it was paid" required>
          <select id="m9-method" value={f.method} onChange={(e) => f.setMethod(e.target.value)} className={inputClass()}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
        </Field>
        <Field id="m9-reference" label="Reference" required error={err('reference')} helper="So it can be found in QuickBooks">
          <input id="m9-reference" value={f.reference} onChange={(e) => f.setReference(e.target.value)} maxLength={180} placeholder="QuickBooks check 1057"
            aria-invalid={!!err('reference')} className={inputClass(err('reference'))} />
        </Field>
      </div>
      <ReasonField id="m9-refund-reason" value={reason} onChange={setReason} error={err('reason')} placeholder="Why was this paid back?" />
      <RefundSource f={f} credits={credits} error={err('credit')} />
      {f.draw.length > 0 && (
        <div data-testid="refund-summary" aria-live="polite" className="rounded-xl border border-gray-200 bg-cream px-3.5 py-3">
          <div className="text-xs text-secondary">After this refund</div>
          <div className="font-heading text-[22px] font-semibold tabular-nums text-nav-dark">Prepay {fmt(f.availableCents)} <span className="text-secondary">→</span> {fmt(f.availableCents - (f.amountCents ?? 0))}</div>
        </div>
      )}
    </>
  );
}

function RefundSource({ f, credits, error }: { f: RefundState; credits: DrawCredit[]; error?: string }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-secondary">Take it from</legend>
      <label className="flex cursor-pointer items-start gap-2.5 py-2">
        <input type="radio" name="m9-src" checked={f.source === 'oldest'} onChange={() => f.setSource('oldest')} className="mt-0.5 h-4 w-4 accent-crx-green" aria-label="Oldest prepay first (recommended)" />
        <span><b>Oldest prepay first</b><span className="text-secondary"> (recommended)</span>
          <span className="block text-xs text-secondary">{f.source === 'oldest' && f.draw.length ? drawText(f.draw) : `Shows which credits are used once the amount is ${fmt(f.availableCents)} or less`}</span></span>
      </label>
      <label className="flex cursor-pointer items-start gap-2.5 py-2">
        <input type="radio" name="m9-src" checked={f.source === 'pick'} onChange={() => f.setSource('pick')} className="mt-0.5 h-4 w-4 accent-crx-green" aria-label="A credit I pick" />
        <span className="min-w-0 flex-1"><b>A credit I pick</b><span className="block text-xs text-secondary">Opens a list of open credits with their balances</span>
          {f.source === 'pick' && (
            <select aria-label="Credit to take it from" value={f.pickedId} onChange={(e) => f.setPickedId(e.target.value)} className={`${inputClass()} mt-2`}>
              <option value="">Choose a credit…</option>
              {credits.map((c) => <option key={c.id} value={c.id}>{c.label} · {fmt(c.balance_cents)}</option>)}
            </select>
          )}
          {error && <span role="alert" className="mt-1 flex items-center gap-1.5 text-xs text-red-600"><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />{error}</span>}
        </span>
      </label>
    </fieldset>
  );
}

export function RefundConfirmBody({ f }: { f: RefundState }) {
  return (
    <div className="text-sm">
      <p className="mb-2 font-heading text-2xl font-semibold tabular-nums text-nav-dark"><span className="font-light text-secondary">Prepay {fmt(f.availableCents)}</span> → {fmt(f.availableCents - (f.amountCents ?? 0))}</p>
      <Kv label="From"><span className="whitespace-pre-line">{f.draw.map((d) => `${d.label} ${fmt(d.cents)}`).join('\n')}</span></Kv>
      <Kv label="Dated">{f.paidOn ? fmtDay(f.paidOn) : ''}</Kv>
      <Kv label="Paid by">{f.method} · {f.refundReference}</Kv>
      {f.duplicate && (
        <p role="alert" className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          A refund with reference “{f.refundReference}” is already recorded for this customer. Record it only if this is a second payment.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Returned check

export function CheckCard({ c, picked, onPick }: { c: ReturnableCheck; picked: ReturnableCheck | null; onPick?: (c: ReturnableCheck) => void }) {
  const on = picked?.allocationSetId === c.allocationSetId && picked?.creditId === c.creditId;
  const off = !!c.disabledReason;
  const cls = `mb-2 flex items-start gap-3 rounded-xl border px-3.5 py-3 ${on ? 'border-crx-green bg-crx-green-tint ring-1 ring-crx-green' : 'border-gray-200'} ${off ? 'cursor-not-allowed bg-gray-50' : 'bg-white'} ${onPick && !off ? 'cursor-pointer' : ''}`;
  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-3"><b className={off ? 'text-secondary' : 'text-nav-dark'}>Check {c.number} · {fmtDay(c.date)}</b><b className="tabular-nums">{fmt(c.amountCents)}</b></div>
      {c.meta && <div className="text-[13px] text-secondary">{c.meta}</div>}
      <div className="mt-1 flex flex-wrap gap-1.5">
        {c.prepayCheck && <Badge variant="success" normalCase>Prepay check</Badge>}
        {c.closedMonth && <Badge variant="default" normalCase>{closedMonthBadge(c.date)}</Badge>}
        {off && <Badge variant="danger" normalCase>{c.disabledReason}</Badge>}
      </div>
    </div>
  );
  if (!onPick) return <div className={cls}><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-secondary" aria-hidden="true"><Banknote className="h-4 w-4" /></span>{body}</div>;
  return (
    <label className={cls}>
      <input type="radio" name="m9-check" aria-label={`Check ${c.number} · ${fmtDay(c.date)} ${fmt(c.amountCents)}`} checked={on} disabled={off} onChange={() => onPick(c)} className="mt-1 h-4 w-4 shrink-0 accent-crx-green" />
      {body}
    </label>
  );
}

export function CheckPicker({ r, tried }: { r: ReturnState; tried: boolean }) {
  const q = r.search.trim().toLowerCase();
  // The picked check stays in view whatever the search, so the list never hides what the save will return.
  const isPicked = (c: ReturnableCheck) => r.picked?.allocationSetId === c.allocationSetId && r.picked?.creditId === c.creditId;
  const visible = (r.checks ?? []).filter((c) => !q || c.number.toLowerCase().includes(q) || isPicked(c));
  const empty = r.checks?.length ? 'No check with that number.' : 'No checks from this customer in the last 12 months.';
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-secondary">Which check came back? <span className="text-red-600">*</span></legend>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden="true" />
        <input type="search" aria-label="Find a check by number" placeholder="Find a check by number" value={r.search} onChange={(e) => r.setSearch(e.target.value)} className={`${inputClass()} pl-9`} />
      </div>
      {r.listFailed ? <p role="alert" className="py-3 text-sm text-red-600">This customer's checks could not be loaded. Close and try again.</p>
        : r.checks === null ? <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
        : visible.length === 0 ? <p className="py-3 text-sm text-secondary">{empty}</p>
          : visible.map((c) => <CheckCard key={`${c.allocationSetId}-${c.creditId}`} c={c} picked={r.picked} onPick={r.pick} />)}
      {tried && !r.picked && <p role="alert" className="text-xs text-red-600">Pick the check that came back.</p>}
      <p className="text-xs text-secondary">Checks only, last 12 months, newest first. ACH and other payments are not listed.</p>
    </fieldset>
  );
}

function InvoiceEffect({ i }: { i: ReturnEffect['invoices'][number] }) {
  const due = i.dueDate ? `Due ${shortDay(i.dueDate)}` : 'No due date';
  const how = i.viaPrepay
    ? ` · paid${i.paidOn ? ` on ${shortDay(i.paidOn)}` : ''} from ${i.viaPrepay}, which this check funded`
    : ` · the check's ${fmt(i.cents)} is removed from it`;
  return (
    <EffectRow icon={<FileX2 className="h-4 w-4" />} tone="bounce" title={`${i.number} goes back to unpaid`} cents={i.cents}>
      {due}{i.overdue && <>, so it shows as <Badge variant="danger" normalCase>Overdue</Badge></>}{how}
    </EffectRow>
  );
}

function EffectList({ effect, check, availableCents, owesCents, bankDate, today }: {
  effect: ReturnEffect; check: ReturnableCheck; availableCents: number; owesCents: number | null; bankDate: string | null; today: string;
}) {
  const parts = [...effect.invoices.map((i) => i.cents), ...(effect.prepayRemovedCents > 0 ? [effect.prepayRemovedCents] : [])];
  const owesAdd = effect.invoices.reduce((s, i) => s + i.cents, 0);
  const where = check.closedMonth
    ? `The check was in ${monthOf(check.date)}, which stays closed; the entry goes in ${monthOf(today)}, which is open.`
    : `The entry goes in ${monthOf(today)}, which is open.`;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200" aria-live="polite">
      {effect.invoices.map((i, n) => <InvoiceEffect key={`${i.id}-${n}`} i={i} />)}
      {effect.prepayRemovedCents > 0 && (
        <EffectRow icon={<Wallet className="h-4 w-4" />} tone="refund" title={`Remaining ${effect.removedLabel} is removed`} cents={effect.prepayRemovedCents}>
          <span className="tabular-nums">Prepay {fmt(availableCents)} → {fmt(availableCents - effect.prepayRemovedCents)}</span>
        </EffectRow>
      )}
      <EffectRow icon={<Sigma className="h-4 w-4" />} tone="out" title="Check total" cents={check.amountCents} muted>
        <span className="tabular-nums">
          {parts.map((c) => fmt(c)).join(' + ')}
          {owesCents != null && ` · customer owes ${fmt(owesCents)} → ${fmt(owesCents + owesAdd)}`}
        </span>
      </EffectRow>
      <EffectRow icon={<CalendarCheck className="h-4 w-4" />} tone="out" title={`Entry dated today, ${fmtDay(today)}`}>
        {`The bank returned it on ${bankDate ? shortDay(bankDate) : '…'}. ${where}`}
      </EffectRow>
    </div>
  );
}

export function BounceFields({ r, check, tried, today, availableCents, owesCents, reason, setReason }: {
  r: ReturnState; check: ReturnableCheck; tried: boolean; today: string; availableCents: number; owesCents: number | null; reason: string; setReason: (v: string) => void;
}) {
  const closedNote = check.closedMonth ? ` ${monthOf(check.date)} stays closed.` : '';
  return (
    <>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <DatePicker label="Bank returned it on *" value={r.bankDate} onChange={r.setBankDate}
            error={tried && r.bankError ? r.bankError : undefined}
            helper={`Any date, even in a closed month; not before the check (${shortDay(check.date)})`} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-medium text-secondary">Entry date</span>
          <div data-testid="entry-date" className="flex h-11 items-center justify-between rounded-lg border border-gray-300 bg-gray-50 px-3 text-sm text-secondary md:h-10">
            <span className="tabular-nums">{fmtDay(today)} (today)</span><Lock className="h-4 w-4" aria-hidden="true" />
          </div>
          <p className="min-h-5 text-xs text-secondary">Always today.{closedNote}</p>
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium text-secondary">What happens</p>
        {r.failed ? <p role="alert" className="text-sm text-red-600">What this check paid could not be loaded. Close and try again.</p>
          : r.effect ? <EffectList effect={r.effect} check={check} availableCents={availableCents} owesCents={owesCents} bankDate={r.bankDate} today={today} />
            : <div className="h-24 animate-pulse rounded-xl bg-gray-100" />}
      </div>
      <ReasonField id="m9-bounce-reason" value={reason} onChange={setReason} error={tried && !reason.trim() ? REASON_REQUIRED : undefined}
        placeholder="Bank returned it: insufficient funds" helper="Shows in the prepay history and on the invoices" />
    </>
  );
}

export function ReturnConfirmBody({ r, farmName, availableCents, today, reason }: { r: ReturnState; farmName: string; availableCents: number; today: string; reason: string }) {
  const back = r.effect?.invoices.map((i) => `${i.number} ${fmt(i.cents)}${i.overdue ? ' (Overdue)' : ''}`).join('\n') || 'None';
  return (
    <div className="text-sm">
      <Kv label="Customer">{farmName}</Kv>
      <Kv label="Back to unpaid"><span className="whitespace-pre-line tabular-nums">{back}</span></Kv>
      <Kv label="Prepay"><span className="tabular-nums">{fmt(availableCents)} → {fmt(availableCents - (r.effect?.prepayRemovedCents ?? 0))}</span></Kv>
      <Kv label="Bank returned it">{r.bankDate ? fmtDay(r.bankDate) : ''}</Kv>
      <Kv label="Entry dated">{fmtDay(today)} (today)</Kv>
      <Kv label="Reason">{reason.trim()}</Kv>
      {r.picked?.closedMonth && (
        <p className="mt-2.5 flex gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5 text-secondary">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{monthOf(r.picked.date)} stays closed. Nothing in a closed month changes.
        </p>
      )}
    </div>
  );
}
