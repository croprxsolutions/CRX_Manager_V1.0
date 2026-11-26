/**
 * Payments — Unified payment entry page (formerly PaymentAllocation).
 * Select a customer, enter a check amount, allocate to invoices (auto or manual),
 * any remainder becomes prepay credit. Calls allocate_payment RPC.
 *
 * Sprint 16: Unified Payment Allocation
 * AR Single Source of Truth: This is now the sole payment entry point.
 */
import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  DollarSign,
  Zap,
  RotateCcw,
  CheckCircle,
  AlertTriangle,
  ChevronRight,
  ListChecks,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ConfirmModal from '../components/ui/ConfirmModal';
import PageHeader from '../components/ui/PageHeader';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import CustomerSearchPicker, { CUSTOMER_SEARCH_SELECT, type CustomerSearchResult } from '../components/customers/CustomerSearchPicker';
import DatePicker from '../components/ui/DatePicker';
import { LoadFailedState } from '../components/ui/EmptyState';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, sanitizeError, hasRpcCode, rpcAuthErrorMessage, RpcErrorCodes } from '../lib/db';
import {
  DUPLICATE_CHECK_FAILED_MESSAGE,
  PAYMENT_RETRY_REFUSED_MESSAGE,
  duplicatePaymentMessage,
  findDuplicatePayment,
} from '../lib/paymentDuplicate';
import {
  closedPeriodMessage,
  findClosedPeriod,
  oldPaymentDateDays,
  oldPaymentDateMessage,
  paymentDateProblem,
  paymentDateRefusal,
} from '../lib/paymentDateCheck';
import { daysSinceBusinessDate, todayInBusinessTz } from '../lib/dateUtils';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { hasPageAccess } from '../lib/pagePermissions';
import { fetchAllRows, pageWithList } from '../lib/pagedRead';
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../lib/parseCents';
import { formatCents as fmt } from '../lib/money';
import type { DuplicatePayment, PaymentAllocationEntry, PaymentAllocationResult, InvoiceType } from '../types';
import { toSentryError } from '../lib/sentryError';

/* ─── Helpers ──────────────────────────────────────────────────────────── */

const toDollarDisplay = (cents: number): string => (cents / 100).toFixed(2);

const daysBetween = (from: string, to: Date): number => {
  const d = new Date(from);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((to.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)));
};

/** Auto-allocate: distribute check amount across invoices, oldest first */
// eslint-disable-next-line react-refresh/only-export-components
export function autoAllocate(
  checkCents: number,
  invoices: { id: string; balance_cents: number }[],
): Map<string, number> {
  if (!Number.isFinite(checkCents) || checkCents <= 0) return new Map();
  const result = new Map<string, number>();
  let remaining = checkCents;
  for (const inv of invoices) {
    if (remaining <= 0) break;
    if (!Number.isFinite(inv.balance_cents) || inv.balance_cents <= 0) continue;
    const apply = Math.min(remaining, inv.balance_cents);
    if (apply > 0) {
      result.set(inv.id, apply);
      remaining -= apply;
    }
  }
  return result;
}

/* ─── Customer Search Result ──────────────────────────────────────────── */

// The shared customer box's columns plus the prepay balance shown beside the chosen customer.
const PAYMENT_CUSTOMER_SELECT = `${CUSTOMER_SEARCH_SELECT}, prepay_balance_cents`;

interface CustomerOption extends CustomerSearchResult {
  prepay_balance_cents: number;
}

/** What Apply Payment validated: the only values the duplicate check reads and the save sends. */
interface PaymentEntry {
  customerId: string;
  cents: number;
  method: string;
  // The one number box: a check's number goes to check_number, any other method's to reference_number.
  checkNumber: string;
  reference: string;
  paymentDate: string;
  notes: string;
  allocations: { invoice_id: string; amount_cents: number }[];
}

/** A validated payment waiting on one warning that names every question it raises (a duplicate, an old date, all prepay). */
interface PaymentToConfirm {
  payment: PaymentEntry;
  match: DuplicatePayment | null;
  oldDays: number | null;
}

const prepayMessage = (cents: number): string =>
  `No invoices allocated. ${fmt(cents)} will be added as prepay credit. Continue?`;

function confirmTitle({ match, oldDays }: PaymentToConfirm): string {
  if (match) return 'Possible Duplicate Payment';
  return oldDays !== null ? `Record a payment dated ${oldDays} days ago?` : 'Full Prepay Credit';
}

function confirmMessage({ payment, match, oldDays }: PaymentToConfirm): string {
  return [
    ...(match ? [duplicatePaymentMessage(match, payment.cents)] : []),
    ...(oldDays !== null ? [oldPaymentDateMessage(payment.paymentDate, oldDays)] : []),
    ...(payment.allocations.length === 0 ? [prepayMessage(payment.cents)] : []),
  ].join(' ');
}

function confirmLabel({ match, oldDays }: PaymentToConfirm): string {
  if (match) return 'Record Anyway';
  return oldDays !== null ? 'Record payment' : 'Continue';
}

/** The short line under the payment date: how far back it is, so a carried-over date is noticed. */
function paymentDateHelper(day: string, today: string): string {
  if (day === today) return 'The day the payment was received';
  const days = daysSinceBusinessDate(day);
  return days === 1 ? '1 day before today' : `${days} days before today`;
}

/* ─── Component ────────────────────────────────────────────────────────── */

export default function PaymentAllocation() {
  const { profile, role, deniedPages } = useAuth();
  // Pay full balance totals the invoices on screen. Only an admin sees all of a customer's
  // invoices; a sales rep sees only their own, so the total could be short of what the farm owes.
  const canPayFullBalance = role === 'admin';
  const { toast } = useToast();
  const allocatePaymentIdem = useIdempotencyKey('allocate_payment', profile?.id || '');
  // True from the first save attempt until one is confirmed: a retry must reach allocate_payment, which
  // replays a save that committed before its reply was lost even if the month has since been closed.
  const saveUnresolvedRef = useRef(false);

  // Customer: the shared customer box (type to search, arrow keys, Enter to choose).
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  // What the customer box shows while it is being edited; null once a pick, blur or Escape settles it.
  const [customerBoxText, setCustomerBoxText] = useState<string | null>(null);
  // A customer chosen in the box sends the cursor straight to the check amount.
  const focusAmountAfterPick = useRef(false);
  const amountInputRef = useRef<HTMLInputElement>(null);
  // The chosen customer's prepay balance, shown beside the box; null = not known (hidden).
  const [prepayBalanceCents, setPrepayBalanceCents] = useState<number | null>(null);
  // Only the newest prepay read, for the customer still chosen, may set the balance.
  const prepayReadSeq = useRef(0);

  // Payment fields
  const [checkAmountInput, setCheckAmountInput] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('check');
  // Check # when the method is Check, Reference # otherwise (one box; the method decides where it is saved).
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  // The day the payment was received (Central business day). undefined = not changed: it follows
  // today, so a page left open past midnight still dates today; null = the field was emptied.
  const [paymentDateInput, setPaymentDateInput] = useState<string | null | undefined>(undefined);
  // The date this check started with. A date kept from the last check is not an unsaved change.
  const [startingPaymentDate, setStartingPaymentDate] = useState<string | null | undefined>(undefined);
  // Why the database (or the closed-month check) refused this date; cleared when the date changes.
  const [paymentDateRefused, setPaymentDateRefused] = useState<string | null>(null);

  // Invoice list + allocations
  const [invoices, setInvoices] = useState<PaymentAllocationEntry[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  // The last invoice load failed: an error shows instead of "no open invoices".
  const [invoicesFailed, setInvoicesFailed] = useState(false);
  // Only the newest customer's invoice load may set state.
  const invoiceLoadSeq = useRef(0);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<PaymentAllocationResult | null>(null);

  // A refused edited retry: stays on screen until the next attempt, a toast is too short for it.
  const [retryRefused, setRetryRefused] = useState(false);

  // A payment waiting on the user's answer. Each holds what was validated, so the answer saves exactly that.
  const [paymentToConfirm, setPaymentToConfirm] = useState<PaymentToConfirm | null>(null);

  // Leaving the page during the duplicate check drops the save.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!selectedCustomer || !focusAmountAfterPick.current) return;
    focusAmountAfterPick.current = false;
    amountInputRef.current?.focus();
  }, [selectedCustomer]);

  /* ── Load invoices when customer selected ──────────────────────────── */

  const fetchInvoices = useCallback(async (customerId: string) => {
    const seq = ++invoiceLoadSeq.current;
    setLoadingInvoices(true);
    // The previous customer's invoices must never stay on screen to be paid against.
    setInvoices([]);
    const today = new Date();
    // Every open invoice, page by page: a check could only be applied to the
    // customer's first 200 before (2026-10-20 Goal 4 part 2).
    const { data, error } = await fetchAllRows((from, to) => pageWithList(supabase
      .from('invoices')
      .select('id, invoice_number, invoice_date, due_date, invoice_type, total_amount_cents, balance_cents', { count: 'exact' })
      .eq('customer_id', customerId)
      // U1 (#41): include 'overdue' — the 6am cron flips past-due posted invoices to
      // 'overdue', which made exactly the invoices checks arrive for vanish from this
      // list. allocate_payment already accepts both statuses.
      .in('status', ['posted', 'overdue'])
      .gt('balance_cents', 0)
      .is('deleted_at', null)
      .order('invoice_date', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id')
      .range(from, to)));
    // Another customer was picked (or cleared) while this one loaded.
    if (seq !== invoiceLoadSeq.current) return;

    if (error || !data) {
      toast('error', 'Failed to load invoices');
      setInvoicesFailed(true);
      setLoadingInvoices(false);
      return;
    }
    setInvoicesFailed(false);

    const mapped = (data as Array<{ id: string; invoice_number: string; invoice_date: string; due_date: string | null; invoice_type: string; total_amount_cents: number; balance_cents: number }>).map((inv): PaymentAllocationEntry => ({
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      due_date: inv.due_date,
      invoice_type: inv.invoice_type as InvoiceType,
      total_amount_cents: inv.total_amount_cents,
      balance_cents: inv.balance_cents,
      days_aged: daysBetween(inv.invoice_date, today),
      allocated_cents: 0,
    }));

    setInvoices(mapped);
    setLoadingInvoices(false);
  }, [toast]);

  const selectCustomer = useCallback((c: CustomerOption) => {
    focusAmountAfterPick.current = true;
    setCustomerBoxText(null);
    // Switching to another farm starts a fresh check, so one farm's check can't be posted to another (Mason, 2026-11-25).
    if (selectedCustomer && selectedCustomer.id !== c.id) {
      setCheckAmountInput('');
      setReferenceNumber('');
      setNotes('');
    }
    setSelectedCustomer(c);
    prepayReadSeq.current += 1;
    setPrepayBalanceCents(c.prepay_balance_cents);
    setLastResult(null);
    setRetryRefused(false);
    fetchInvoices(c.id);
  }, [fetchInvoices, selectedCustomer]);

  const clearCustomer = useCallback(() => {
    // A load still running for the cleared customer must not refill the list.
    invoiceLoadSeq.current += 1;
    setLoadingInvoices(false);
    setInvoicesFailed(false);
    setSelectedCustomer(null);
    setCustomerBoxText(null);
    prepayReadSeq.current += 1;
    setPrepayBalanceCents(null);
    setInvoices([]);
    setCheckAmountInput('');
    setReferenceNumber('');
    setNotes('');
    setLastResult(null);
    setRetryRefused(false);
  }, []);

  // The customer changes only when one is picked from the list. A stray keystroke keeps the
  // chosen customer and the typed allocations; Escape or "keep" puts the name back. While a search
  // is unfinished, nothing that posts or fills allocations runs, so Apply Payment can never
  // post to a customer the box is not showing.
  const customerBeingChanged = selectedCustomer !== null && customerBoxText !== null
    && customerBoxText !== selectedCustomer.farm_name;

  /* ── Allocation helpers ────────────────────────────────────────────── */

  // null = the typed check amount has more than two decimals (refused). It is
  // kept separate from checkCents so the two submit paths can name the reason
  // instead of reporting "Enter a check amount" for an amount that IS entered.
  const checkCentsParsed = parseDollarsToCents(checkAmountInput);
  const checkAmountRefused = checkCentsParsed === null;
  const checkCents = checkCentsParsed ?? 0;

  const setAllocationForInvoice = useCallback((invoiceId: string, cents: number) => {
    setInvoices((prev) =>
      prev.map((inv) =>
        inv.invoice_id === invoiceId ? { ...inv, allocated_cents: cents } : inv,
      ),
    );
  }, []);

  const handleAutoAllocate = useCallback(() => {
    if (checkAmountRefused) {
      toast('error', MONEY_PRECISION_MESSAGE);
      return;
    }
    if (checkCents <= 0) {
      toast('error', 'Enter a check amount first');
      return;
    }
    const allocMap = autoAllocate(
      checkCents,
      invoices.map((inv) => ({ id: inv.invoice_id, balance_cents: inv.balance_cents })),
    );
    setInvoices((prev) =>
      prev.map((inv) => ({
        ...inv,
        allocated_cents: allocMap.get(inv.invoice_id) || 0,
      })),
    );
  }, [checkAmountRefused, checkCents, invoices, toast]);

  // Pays every open invoice in full, in the order and by the rules Auto-Allocate uses. It only
  // fills the screen: nothing is saved until Apply Payment, which checks everything as before.
  const handlePayFullBalance = useCallback(() => {
    if (!canPayFullBalance) return;
    if (checkAmountRefused) {
      toast('error', MONEY_PRECISION_MESSAGE);
      return;
    }
    // The check amount always comes from the paper check, never from the balance owed (Mason,
    // 2026-11-25): a filled-in balance could re-book a check already posted for a different amount.
    if (checkCents <= 0) {
      toast('error', 'Enter the check amount first.');
      return;
    }
    const owed = invoices.map((inv) => ({ id: inv.invoice_id, balance_cents: inv.balance_cents }));
    const fullBalanceCents = owed.reduce(
      (s, inv) => s + (Number.isFinite(inv.balance_cents) && inv.balance_cents > 0 ? inv.balance_cents : 0),
      0,
    );
    if (fullBalanceCents <= 0) return;
    // A typed check smaller than the balance cannot pay it all; its amount is never changed here.
    if (checkCents < fullBalanceCents) {
      toast('error', `This check is ${fmt(fullBalanceCents - checkCents)} short of the full balance of ${fmt(fullBalanceCents)}. Use Auto-Allocate to apply it oldest first.`);
      return;
    }
    const allocMap = autoAllocate(fullBalanceCents, owed);
    setInvoices((prev) =>
      prev.map((inv) => ({
        ...inv,
        allocated_cents: allocMap.get(inv.invoice_id) || 0,
      })),
    );
  }, [canPayFullBalance, checkAmountRefused, checkCents, invoices, toast]);

  const handleClearAllocations = useCallback(() => {
    setInvoices((prev) => prev.map((inv) => ({ ...inv, allocated_cents: 0 })));
  }, []);

  /* ── Computed values ──────────────────────────────────────────────── */

  const totalAllocated = useMemo(
    () => invoices.reduce((s, inv) => s + inv.allocated_cents, 0),
    [invoices],
  );
  const remaining = checkCents - totalAllocated;
  const hasAllocations = totalAllocated > 0;
  const hasValidationError = useMemo(() => {
    return invoices.some((inv) => inv.allocated_cents > inv.balance_cents);
  }, [invoices]);

  const businessToday = todayInBusinessTz();
  const paymentDate = paymentDateInput === undefined ? businessToday : paymentDateInput;
  const paymentDateChanged = paymentDate !== (startingPaymentDate === undefined ? businessToday : startingPaymentDate);
  // A date after today or an emptied field: shown under the field, and Apply Payment stays off.
  const paymentDateError = paymentDateProblem(paymentDate, businessToday);
  const isCheck = paymentMethod === 'check';

  // Typed payment details not yet saved: leaving the page (a link, Back, closing the tab) asks first.
  const hasUnsavedPayment = !lastResult
    && (checkAmountInput.trim() !== '' || hasAllocations || referenceNumber.trim() !== '' || notes.trim() !== ''
      || paymentDateChanged);
  const leaveBlocker = useUnsavedChanges(hasUnsavedPayment);
  // Where this customer's prepay credit is applied to invoices (Prepay > Apply), for those who may open it.
  const canApplyPrepay = hasPageAccess(role, deniedPages ?? [], 'prepay');

  /* ── Submit payment ──────────────────────────────────────────────── */

  // Without the customer's open invoices on screen, a check would go entirely to
  // prepay credit by default, so nothing is applied until they have loaded.
  const invoicesNotReady = loadingInvoices || invoicesFailed;

  // Why Apply Payment cannot go ahead with what is on screen, or null.
  const entryProblem = (): string | null => {
    if (invoicesNotReady) return 'Wait for the open invoices to load before applying the check.';
    if (checkAmountRefused) return MONEY_PRECISION_MESSAGE;
    if (checkCents <= 0) return 'Enter a check amount';
    if (totalAllocated > checkCents) return 'Allocations exceed check amount';
    if (hasValidationError) return 'Some allocations exceed invoice balances';
    return paymentDateError;
  };

  const handleSubmit = async () => {
    if (!selectedCustomer || !profile || customerBeingChanged) return;
    const problem = entryProblem();
    if (problem || !paymentDate) {
      toast('error', problem ?? 'Enter the payment date');
      return;
    }
    const payment: PaymentEntry = {
      customerId: selectedCustomer.id,
      cents: checkCents,
      method: paymentMethod,
      checkNumber: isCheck ? referenceNumber : '',
      reference: isCheck ? '' : referenceNumber,
      paymentDate,
      notes,
      allocations: invoices
        .filter((inv) => inv.allocated_cents > 0)
        .map((inv) => ({
          invoice_id: inv.invoice_id,
          amount_cents: inv.allocated_cents,
        })),
    };
    setRetryRefused(false);
    setPaymentDateRefused(null);
    setSubmitting(true);
    let match: DuplicatePayment | null;
    let closedPeriod: Awaited<ReturnType<typeof findClosedPeriod>>;
    try {
      [match, closedPeriod] = await Promise.all([
        findDuplicatePayment(payment.customerId, payment.cents, payment.checkNumber || payment.reference),
        findClosedPeriod(payment.paymentDate),
      ]);
    } catch (err: unknown) {
      Sentry.captureException(toSentryError(err), { tags: { source: 'critical_action', action: 'duplicate_payment_check' } });
      if (mountedRef.current) toast('error', DUPLICATE_CHECK_FAILED_MESSAGE);
      setSubmitting(false);
      return;
    }
    if (!mountedRef.current) return;
    setSubmitting(false);
    // A closed month: say so plainly instead of letting allocate_payment refuse it.
    if (closedPeriod && !saveUnresolvedRef.current) {
      refuseDate(closedPeriodMessage(payment.paymentDate, closedPeriod));
      return;
    }
    // Ask first for a likely duplicate, an old date, or a check going 100% to prepay (no invoice allocations).
    const oldDays = oldPaymentDateDays(payment.paymentDate);
    if (match || oldDays !== null || payment.allocations.length === 0) {
      setPaymentToConfirm({ payment, match, oldDays });
      return;
    }

    void executeSubmit(payment);
  };

  // Under the date field and as a toast: the field can be scrolled away above a long invoice list.
  const refuseDate = (message: string) => {
    setPaymentDateRefused(message);
    toast('error', message);
  };

  const executeSubmit = async (payment: PaymentEntry) => {
    if (!profile) return;
    setPaymentToConfirm(null);
    if (invoicesNotReady) {
      toast('error', 'Wait for the open invoices to load before applying the check.');
      return;
    }
    setSubmitting(true);
    try {
      const args = {
        p_customer_id: payment.customerId,
        p_total_cents: payment.cents,
        p_allocations: payment.allocations,
        p_payment_method: payment.method,
        p_reference_number: payment.reference || undefined,
        p_check_number: payment.checkNumber || undefined,
        p_payment_date: payment.paymentDate,
        p_notes: payment.notes || undefined,
      };
      // One key for this check until it is confirmed: allocate_payment compares a retry's arguments with the
      // first attempt's (the payment date and check number included), so an edited retry after a lost reply
      // is refused instead of saving a second payment. A new key per date would let that edit save twice.
      saveUnresolvedRef.current = true;
      const { data, error } = await supabase.rpc('allocate_payment', {
        ...args,
        p_performed_by: profile.id,
        p_idempotency_key: allocatePaymentIdem.getKey(),
      });

      if (error) throw error;
      const result = assertRpcResult<PaymentAllocationResult>(data, 'allocate_payment');
      allocatePaymentIdem.resetKey();
      saveUnresolvedRef.current = false;
      setLastResult(result);

      const parts = [`Applied ${fmt(result.total_allocated_cents)} to ${result.invoices_paid} invoice(s)`];
      if (result.prepay_created_cents > 0) {
        parts.push(`${fmt(result.prepay_created_cents)} added as prepay credit`);
      }
      toast('success', parts.join('. '));
    } catch (err: unknown) {
      Sentry.captureException(toSentryError(err), { tags: { source: 'critical_action', action: 'allocate_payment' } });
      const dateRefusal = paymentDateRefusal(err, payment.paymentDate);
      if (hasRpcCode(err, RpcErrorCodes.IDEMPOTENCY_ARGUMENT_MISMATCH)) setRetryRefused(true);
      else if (dateRefusal) refuseDate(dateRefusal);
      else toast('error', rpcAuthErrorMessage(err) ?? sanitizeError(err));
    }
    setSubmitting(false);
  };

  /* ── Post-success actions ──────────────────────────────────────────── */

  const handleNextCheck = () => {
    // Keep customer, clear amounts
    startNextCheck();
    if (selectedCustomer) {
      fetchInvoices(selectedCustomer.id);
      void refreshPrepayBalance(selectedCustomer.id);
    }
  };

  // The payment date stays for the next check, so a stack received on one day is entered in a row.
  const startNextCheck = () => {
    setCheckAmountInput('');
    setReferenceNumber('');
    setNotes('');
    setStartingPaymentDate(paymentDateInput);
    setPaymentDateRefused(null);
    setLastResult(null);
  };

  // The saved check may have added prepay credit: show the balance as it is now, or nothing.
  const refreshPrepayBalance = async (customerId: string) => {
    const seq = ++prepayReadSeq.current;
    setPrepayBalanceCents(null);
    const { data, error } = await supabase.from('customers').select('prepay_balance_cents').eq('id', customerId).maybeSingle();
    if (!mountedRef.current || seq !== prepayReadSeq.current || error || !data) return;
    setPrepayBalanceCents(data.prepay_balance_cents);
  };

  const handleNewCustomer = () => {
    clearCustomer();
    startNextCheck();
    setPaymentMethod('check');
  };

  /* ── Render ──────────────────────────────────────────────────────── */

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payments"
        subtitle="Allocate a check across multiple invoices. Any remainder becomes a prepay credit."
      />

      {/* Success Banner */}
      {lastResult && (
        <Card>
          <div className="flex items-start gap-3">
            <CheckCircle className="w-6 h-6 text-crx-green shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-nav-dark">Payment Applied Successfully</p>
              <p className="text-sm text-secondary mt-1">
                {fmt(lastResult.total_allocated_cents)} applied to {lastResult.invoices_paid} invoice(s)
                {lastResult.prepay_created_cents > 0 && (
                  <> &middot; {fmt(lastResult.prepay_created_cents)} added as prepay credit</>
                )}
              </p>
              <div className="flex gap-2 mt-3">
                <Button size="sm" variant="primary" onClick={handleNextCheck} icon={<ChevronRight className="w-3 h-3" />}>
                  Next Check (Same Customer)
                </Button>
                <Button size="sm" variant="secondary" onClick={handleNewCustomer}>
                  New Customer
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Top Bar: Customer + Payment Info, in typing order: customer, amount, method, reference, notes */}
      {!lastResult && (
        <>
          <Card>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Customer: the shared customer box */}
              <div
                className="lg:col-span-2"
                onChange={(e) => setCustomerBoxText((e.target as HTMLInputElement).value)}
                // Escape keeps the chosen customer. Leaving the box mid-search does not: posting
                // stays blocked until a customer is picked or "Keep" is pressed.
                onKeyDown={(e) => { if (e.key === 'Escape') setCustomerBoxText(null); }}
              >
                <label htmlFor="payment-customer" className="block text-sm font-medium text-nav-dark mb-1">Customer</label>
                <CustomerSearchPicker<CustomerOption>
                  id="payment-customer"
                  value={selectedCustomer?.id ?? ''}
                  selectedLabel={selectedCustomer?.farm_name ?? ''}
                  onSelect={(customer) => {
                    if (customer) selectCustomer(customer);
                    else clearCustomer();
                  }}
                  select={PAYMENT_CUSTOMER_SELECT}
                  disabled={submitting}
                  placeholder="Search by name or account #..."
                  ariaLabel="Customer"
                />
                {/* Two farms can share a name; the account # tells the clerk which one will be paid. */}
                {selectedCustomer?.account_number && (
                  <p className="mt-1 text-xs text-secondary">Account #{selectedCustomer.account_number}</p>
                )}
                {customerBeingChanged && (
                  <p className="mt-1 text-xs text-amber-600">
                    You started a new customer search. Pick a customer from the list to switch, or{' '}
                    <button type="button" className="underline font-medium" onClick={() => setCustomerBoxText(null)}>
                      keep {selectedCustomer.farm_name}
                    </button>
                    .
                  </p>
                )}
                {selectedCustomer && prepayBalanceCents !== null && prepayBalanceCents > 0 && (
                  <p className="mt-1 text-xs text-secondary">
                    Prepay on account: <span className="font-medium text-crx-green">{fmt(prepayBalanceCents)}</span>
                    {canApplyPrepay && (
                      <>
                        {' · '}
                        <Link
                          to={`/prepay?tab=workspace&customer=${encodeURIComponent(selectedCustomer.id)}`}
                          className="font-medium text-crx-green underline hover:text-crx-green-hover"
                        >
                          Apply prepay to invoices
                        </Link>
                      </>
                    )}
                  </p>
                )}
              </div>

              {/* Check Amount */}
              <div>
                <label htmlFor="payment-check-amount" className="block text-sm font-medium text-nav-dark mb-1">Check Amount</label>
                <div className="relative">
                  <DollarSign className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    id="payment-check-amount"
                    ref={amountInputRef}
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={checkAmountInput}
                    // Choose the customer first: the open invoices to pay come from them.
                    disabled={submitting || !selectedCustomer}
                    onChange={(e) => setCheckAmountInput(e.target.value)}
                    aria-invalid={checkAmountRefused}
                    className={`w-full pl-9 pr-3 py-2 text-sm font-semibold bg-white border rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50 ${checkAmountRefused ? 'border-red-400' : 'border-gray-200'}`}
                  />
                </div>
                {/* A refused amount (more than two decimals) parses to null, so checkCents is
                    0 and both action buttons stay disabled — the handler toasts can never
                    fire. Say why right under the field instead (CodeRabbit on PR #588). */}
                {checkAmountRefused && (
                  <p role="alert" className="mt-1 text-sm text-red-600">{MONEY_PRECISION_MESSAGE}</p>
                )}
              </div>

              {/* Payment Method */}
              <div>
                <label htmlFor="payment-method" className="block text-sm font-medium text-nav-dark mb-1">Method</label>
                <select
                  id="payment-method"
                  value={paymentMethod}
                  disabled={submitting}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="check">Check</option>
                  <option value="cash">Cash</option>
                  <option value="wire">Wire Transfer</option>
                  <option value="ach">ACH</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {/* Check # for a check (saved as its check number), Reference # for any other method */}
              <div>
                <label htmlFor="payment-reference" className="block text-sm font-medium text-nav-dark mb-1">
                  {isCheck ? 'Check #' : 'Reference #'}
                </label>
                <input
                  id="payment-reference"
                  type="text"
                  placeholder={isCheck ? 'Check number...' : 'Reference...'}
                  value={referenceNumber}
                  disabled={submitting}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>

              {/* The day the payment was received: a check from the 30th entered on the 1st belongs to the 30th */}
              <div>
                <DatePicker
                  label="Payment date"
                  value={paymentDate}
                  onChange={(day) => {
                    setPaymentDateInput(day);
                    setPaymentDateRefused(null);
                  }}
                  maxValue={businessToday}
                  presets={[{ label: 'Today', value: businessToday }]}
                  disabled={submitting}
                  error={paymentDateError ?? paymentDateRefused ?? undefined}
                  helper={paymentDate ? paymentDateHelper(paymentDate, businessToday) : undefined}
                />
              </div>

              {/* Notes, last in the form */}
              <div className="md:col-span-2 lg:col-span-2">
                <label htmlFor="payment-notes" className="block text-sm font-medium text-nav-dark mb-1">Notes</label>
                <input
                  id="payment-notes"
                  type="text"
                  placeholder="Optional payment notes..."
                  value={notes}
                  disabled={submitting}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
            </div>
          </Card>

          {/* Invoice Table */}
          {selectedCustomer && (
            <Card padding={false}>
              <div className="p-5">
                <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                  <h2 className="text-sm font-semibold text-nav-dark">
                    Open Invoices for {selectedCustomer.farm_name}
                    {invoices.length > 0 && (
                      <span className="ml-2 text-secondary font-normal">
                        ({invoices.length} invoice{invoices.length !== 1 ? 's' : ''}, {fmt(invoices.reduce((s, i) => s + i.balance_cents, 0))} outstanding)
                      </span>
                    )}
                  </h2>
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Zap className="w-4 h-4" />}
                      onClick={handleAutoAllocate}
                      disabled={submitting || customerBeingChanged || checkCents <= 0 || invoices.length === 0}
                    >
                      Auto-Allocate
                    </Button>
                    {canPayFullBalance && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<ListChecks className="w-4 h-4" />}
                        onClick={handlePayFullBalance}
                        showChevron={false}
                        disabled={submitting || customerBeingChanged || invoicesNotReady || invoices.length === 0 || checkAmountRefused || checkCents <= 0}
                        title="Enter the check amount first. Fills every open invoice with its full balance; any extra becomes prepay credit. Nothing is saved until Apply Payment."
                      >
                        Pay full balance
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RotateCcw className="w-4 h-4" />}
                      onClick={handleClearAllocations}
                      showChevron={false}
                      disabled={submitting || !hasAllocations}
                    >
                      Clear
                    </Button>
                  </div>
                </div>

                {loadingInvoices ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="w-6 h-6 border-3 border-crx-green border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : invoicesFailed ? (
                  // Not "no open invoices": a failed read must not look like a paid-up customer.
                  <LoadFailedState
                    title="Open invoices could not be loaded, so the check cannot be applied"
                    onRetry={() => { void fetchInvoices(selectedCustomer.id); }}
                  />
                ) : invoices.length === 0 ? (
                  <div className="text-center py-12 text-secondary text-sm">
                    No open invoices for this customer
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left py-2 px-3 text-xs font-semibold text-secondary uppercase">Invoice #</th>
                          <th className="text-left py-2 px-3 text-xs font-semibold text-secondary uppercase">Date</th>
                          <th className="text-left py-2 px-3 text-xs font-semibold text-secondary uppercase">Due</th>
                          <th className="text-left py-2 px-3 text-xs font-semibold text-secondary uppercase">Days Aged</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold text-secondary uppercase">Total</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold text-secondary uppercase">Balance</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold text-secondary uppercase w-[140px]">Allocate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoices.map((inv) => {
                          const overAllocated = inv.allocated_cents > inv.balance_cents;
                          return (
                            <tr key={inv.invoice_id} className="border-b border-gray-50 hover:bg-gray-25">
                              <td className="py-2.5 px-3 font-medium text-nav-dark">{inv.invoice_number}</td>
                              <td className="py-2.5 px-3 text-secondary">{new Date(inv.invoice_date + 'T00:00:00').toLocaleDateString()}</td>
                              <td className="py-2.5 px-3 text-secondary">
                                {inv.due_date ? new Date(inv.due_date + 'T00:00:00').toLocaleDateString() : '—'}
                              </td>
                              <td className="py-2.5 px-3">
                                <Badge variant={inv.days_aged > 90 ? 'danger' : inv.days_aged > 30 ? 'warning' : 'default'}>
                                  {inv.days_aged}d
                                </Badge>
                              </td>
                              <td className="py-2.5 px-3 text-right text-secondary">{fmt(inv.total_amount_cents)}</td>
                              <td className="py-2.5 px-3 text-right font-medium text-red-600">{fmt(inv.balance_cents)}</td>
                              <td className="py-2.5 px-3 text-right">
                                <div className="relative inline-block">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                                  <input
                                    type="text"
                                    value={inv.allocated_cents > 0 ? toDollarDisplay(inv.allocated_cents) : ''}
                                    placeholder="0.00"
                                    disabled={submitting}
                                    onChange={(e) => {
                                      const cents = parseDollarsToCents(e.target.value);
                                      // null = a third decimal digit. Refuse the keystroke rather than
                                      // drop the allocation to 0 (which would bank the money as prepay).
                                      if (cents === null) { toast('error', MONEY_PRECISION_MESSAGE); return; }
                                      setAllocationForInvoice(inv.invoice_id, cents);
                                    }}
                                    className={`w-[120px] pl-5 pr-2 py-1.5 text-sm text-right border rounded-lg focus:outline-none focus:ring-2 ${
                                      overAllocated
                                        ? 'border-red-300 focus:ring-red-200 bg-red-50'
                                        : inv.allocated_cents > 0
                                          ? 'border-crx-green focus:ring-crx-green/20 bg-crx-green-light/30'
                                          : 'border-gray-200 focus:ring-crx-green/20'
                                    }`}
                                  />
                                </div>
                                {overAllocated && (
                                  <p className="text-xs text-red-500 mt-0.5">Exceeds balance</p>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Card>
          )}

          {retryRefused && (
            <p role="alert" className="text-sm text-red-600">{PAYMENT_RETRY_REFUSED_MESSAGE}</p>
          )}

          {/* Summary Bar: stays on screen (above the phone's bottom bar) while a long invoice list scrolls. */}
          {selectedCustomer && checkCents > 0 && (
            <Card
              role="region"
              aria-label="Payment totals"
              className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:bottom-0 z-20 shadow-lg"
            >
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex gap-6 text-sm">
                  <div>
                    <span className="text-secondary">Check Total:</span>{' '}
                    <span className="font-semibold text-nav-dark">{fmt(checkCents)}</span>
                  </div>
                  <div>
                    <span className="text-secondary">Allocated:</span>{' '}
                    <span className="font-semibold text-nav-dark">{fmt(totalAllocated)}</span>
                  </div>
                  <div>
                    <span className="text-secondary">Remaining:</span>{' '}
                    <span
                      className={`font-semibold ${
                        remaining === 0
                          ? 'text-crx-green'
                          : remaining > 0
                            ? 'text-amber-600'
                            : 'text-red-600'
                      }`}
                    >
                      {fmt(Math.abs(remaining))}
                      {remaining > 0 && ' → Prepay'}
                      {remaining < 0 && ' over-allocated!'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {remaining > 0 && (
                    <div className="flex items-center gap-1 text-xs text-amber-600 mr-2">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>{fmt(remaining)} will become a prepay credit</span>
                    </div>
                  )}
                  <Button
                    variant="primary"
                    onClick={handleSubmit}
                    loading={submitting}
                    disabled={
                      customerBeingChanged ||
                      invoicesNotReady ||
                      paymentDateError !== null ||
                      remaining < 0 ||
                      hasValidationError ||
                      checkCents <= 0 ||
                      (!hasAllocations && remaining <= 0)
                    }
                    icon={<DollarSign className="w-4 h-4" />}
                  >
                    Apply Payment
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      <UnsavedChangesModal
        open={leaveBlocker.state === 'blocked'}
        onStay={() => leaveBlocker.reset?.()}
        onLeave={() => leaveBlocker.proceed?.()}
      />

      {/* One warning covers every question: a second modal in the same spot would catch a double tap. */}
      <ConfirmModal
        open={paymentToConfirm !== null}
        onClose={() => setPaymentToConfirm(null)}
        onConfirm={() => { if (paymentToConfirm) void executeSubmit(paymentToConfirm.payment); }}
        title={paymentToConfirm ? confirmTitle(paymentToConfirm) : ''}
        message={paymentToConfirm ? confirmMessage(paymentToConfirm) : ''}
        confirmLabel={paymentToConfirm ? confirmLabel(paymentToConfirm) : 'Continue'}
        variant="warning"
      />
    </div>
  );
}
