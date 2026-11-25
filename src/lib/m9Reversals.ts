/**
 * M9 screens (20270301180000): refunds paid outside CRX, returned (bounced) checks and the prepay balance check.
 * The pure rules the dialog shows before saving, and the admin reads behind them. The server (record_outside_refund,
 * record_returned_check, get_prepay_balance_check) stays the authority; this only previews and explains.
 */
import { supabase, assertRpcResult } from './db';
import { fetchAllRows } from './pagedRead';
import { addDaysToDate, businessDayStartIso, parseLocalDate, todayInBusinessTz } from './dateUtils';
import { formatCents as fmt } from './money';
import { agingCents, isPricedAgingRow } from './arAging';
import type { ARAgingRow } from '../types';

// ---------------------------------------------------------------------------------------------------------------
// Dates

/** "Nov 20, 2026" for a plain YYYY-MM-DD day. */
export const fmtDay = (ymd: string) => parseLocalDate(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
/** The Chicago business day of a timestamp. */
export const businessDay = (iso: string) => todayInBusinessTz(new Date(iso));
const monthName = (ymd: string) => parseLocalDate(ymd).toLocaleDateString('en-US', { month: 'long' });
const shortMonth = (ymd: string) => parseLocalDate(ymd).toLocaleDateString('en-US', { month: 'short' });

export interface ClosedPeriod { period_start: string; period_end: string }

export const isInClosedMonth = (ymd: string, closed: ClosedPeriod[]) => closed.some((p) => ymd >= p.period_start && ymd <= p.period_end);

/** The first day after the latest closed month that has ended (the open months start there); null if none closed. */
export function firstOpenDay(closed: ClosedPeriod[], today: string): string | null {
  const ends = closed.map((p) => p.period_end).filter((d) => d < today).sort();
  return ends.length ? addDaysToDate(ends[ends.length - 1], 1) : null;
}

/** "Nov 1 to today", the open-month window for a refund's paid date. */
export function openWindowText(closed: ClosedPeriod[], today: string): string {
  const from = firstOpenDay(closed, today);
  return from ? `${parseLocalDate(from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} to today` : 'up to today';
}

// ---------------------------------------------------------------------------------------------------------------
// Refund paid outside CRX

export interface DrawCredit { id: string; label: string; balance_cents: number; created_at: string }
export interface DrawPart { id: string; label: string; cents: number }

/** The credits a refund takes from: oldest first (the server's created_at, id order), or only the picked one. */
export function planRefundDraw(credits: DrawCredit[], amountCents: number, pickedId: string | null = null): DrawPart[] {
  let left = amountCents;
  const parts: DrawPart[] = [];
  const pool = credits
    .filter((c) => c.balance_cents > 0 && (!pickedId || c.id === pickedId))
    .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  for (const c of pool) {
    if (left <= 0) break;
    const take = Math.min(c.balance_cents, left);
    parts.push({ id: c.id, label: c.label, cents: take });
    left -= take;
  }
  return parts;
}

export const drawText = (parts: DrawPart[]) => parts.map((p) => `${p.label} ${fmt(p.cents)}`).join(', then ');

export interface RefundInput {
  /** parseDollarsToCents of the amount field: null = more than two decimals. */
  amountCents: number | null;
  availableCents: number;
  paidOn: string | null;
  reference: string;
  reason: string;
  today: string;
  closed: ClosedPeriod[];
}
export type RefundErrors = Partial<Record<'amount' | 'paidOn' | 'reference' | 'reason', string>>;

export function refundErrors(i: RefundInput): RefundErrors {
  const e: RefundErrors = {};
  if (i.amountCents === null) e.amount = 'Enter an amount with no more than two decimal places.';
  else if (i.amountCents <= 0) e.amount = 'Enter an amount more than $0.00.';
  else if (i.amountCents > i.availableCents) e.amount = `More than the ${fmt(i.availableCents)} available.`;
  if (!i.paidOn) e.paidOn = 'Pick the date it was paid.';
  else if (i.paidOn > i.today) e.paidOn = "Can't be after today.";
  else if (isInClosedMonth(i.paidOn, i.closed)) e.paidOn = `${monthName(i.paidOn)} is closed. Use ${openWindowText(i.closed, i.today)}.`;
  if (!i.reference.trim()) e.reference = 'Add the reference, for example the QuickBooks check number.';
  if (!i.reason.trim()) e.reason = 'Add a reason. It shows in the prepay history.';
  return e;
}

// ---------------------------------------------------------------------------------------------------------------
// Returned check

export interface ReturnableCheck {
  /** allocation_sets.id for a Record Payment check, else null. */
  allocationSetId: string | null;
  /** One bucket's id for a Prepayment Manager check (the server returns every bucket of its entry), else null. */
  creditId: string | null;
  customerId: string;
  number: string;
  /** The day it was received: the payment date, or the Prepayment Manager entry day. */
  date: string;
  amountCents: number;
  prepayCheck: boolean;
  /** "Paid INV-20290 $1,200.00 · created Fall 2026 prepay $500.00" */
  meta: string;
  closedMonth: boolean;
  /** Set when it can't be picked: "Already returned Nov 3" or "Edited/deleted, handle by hand". */
  disabledReason: string | null;
}

export const RETURN_EDITED_REASON = 'Edited/deleted, handle by hand';
export const RETURN_NOT_CHECK_REASON = (method: string | null) => `Not a check${method ? ` (${method.toUpperCase()})` : ''}. Only checks can come back.`;
export const alreadyReturnedReason = (entryDate: string) => `Already returned ${parseLocalDate(entryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

/** Not before the check; may be a closed month; never after today (the entry itself is always today). */
export function returnedDateError(bankDate: string | null, checkDate: string, today: string): string | null {
  if (!bankDate) return 'Pick the day the bank returned it.';
  if (bankDate > today) return "Can't be after today.";
  if (bankDate < checkDate) return `Can't be before the check (${parseLocalDate(checkDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}).`;
  return null;
}

type Row = Record<string, unknown>;
const creditLabel = (c: { bucket_label?: unknown; reference_number?: unknown; source_reference?: unknown }) =>
  (c.bucket_label as string) || `Prepay ${(c.source_reference as string) || (c.reference_number as string) || ''}`.trim();

async function all<T = Row>(query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }>): Promise<T[]> {
  const { data, error } = await fetchAllRows<T>(query as never);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

export async function loadClosedPeriods(): Promise<ClosedPeriod[]> {
  return all<ClosedPeriod>((from, to) => supabase.from('accounting_periods')
    .select('id, period_start, period_end', { count: 'exact' }).eq('status', 'closed').order('id').range(from, to));
}

interface ReturnedRecord { id: string; entry_date: string; allocation_set_id: string | null; prepay_credit_id: string | null }

/** This customer's returned checks: by payment, and by every Prepayment Manager bucket they took. */
async function loadReturned(customerId: string) {
  const returns = await all<ReturnedRecord>((from, to) => supabase.from('money_reversals')
    .select('id, entry_date, allocation_set_id, prepay_credit_id', { count: 'exact' })
    .eq('customer_id', customerId).eq('kind', 'returned_check').order('id').range(from, to));
  const lines = returns.length ? await all<{ id: string; reversal_id: string; prepay_credit_id: string | null }>((from, to) => supabase
    .from('money_reversal_lines').select('id, reversal_id, prepay_credit_id', { count: 'exact' })
    .in('reversal_id', returns.map((r) => r.id)).eq('line_kind', 'prepay_credit').order('id').range(from, to)) : [];
  const bySet = new Map<string, string>();
  const byCredit = new Map<string, string>();
  for (const r of returns) {
    if (r.allocation_set_id) bySet.set(r.allocation_set_id, r.entry_date);
    if (r.prepay_credit_id) byCredit.set(r.prepay_credit_id, r.entry_date);
  }
  for (const l of lines) {
    const r = returns.find((x) => x.id === l.reversal_id);
    if (r && l.prepay_credit_id && !byCredit.has(l.prepay_credit_id)) byCredit.set(l.prepay_credit_id, r.entry_date);
  }
  return { bySet, byCredit };
}

/** Returned-check dates by payment (allocation set) for a set of payments: Payment History's status and menu. */
export async function loadReturnedPayments(setIds: string[]): Promise<Map<string, string>> {
  if (!setIds.length) return new Map();
  const rows = await all<ReturnedRecord>((from, to) => supabase.from('money_reversals')
    .select('id, entry_date, allocation_set_id, prepay_credit_id', { count: 'exact' })
    .eq('kind', 'returned_check').in('allocation_set_id', setIds).order('id').range(from, to));
  return new Map(rows.map((r) => [r.allocation_set_id as string, r.entry_date]));
}

const sumBy = (rows: Row[], key: string, value: string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r[key] as string, (m.get(r[key] as string) ?? 0) + Number(r[value] ?? 0));
  return m;
};

/**
 * The checks this customer can say came back: Record Payment checks and Prepayment Manager checks of the last
 * 12 months, newest first. ACH and other payments are not listed; a returned or edited check is listed, disabled.
 */
export async function loadReturnableChecks(customerId: string, today = todayInBusinessTz(), lastYearOnly = true): Promise<ReturnableCheck[]> {
  // The picker lists the last 12 months; a payment opened by its own line is found at any age.
  const since = lastYearOnly ? addDaysToDate(today, -365) : '2000-01-01';
  const [sets, pmCredits, closed, returned] = await Promise.all([
    all((from, to) => supabase.from('allocation_sets')
      .select('id, total_payment_cents, check_number, reference_number, payment_date', { count: 'exact' })
      .eq('customer_id', customerId).eq('entity_type', 'payment').eq('payment_method', 'check').eq('is_active', true)
      .gte('payment_date', since).order('id').range(from, to)),
    all((from, to) => supabase.from('prepay_credits')
      .select('id, original_amount_cents, balance_cents, bucket_label, reference_number, source_reference, created_at', { count: 'exact' })
      .eq('customer_id', customerId).eq('source_type', 'check').is('allocation_set_id', null)
      .gte('created_at', businessDayStartIso(since)).order('id').range(from, to)),
    loadClosedPeriods(),
    loadReturned(customerId),
  ]);
  const setIds = sets.map((s) => s.id as string);
  const [allocs, overpay] = setIds.length ? await Promise.all([
    all((from, to) => supabase.from('invoice_line_allocations')
      .select('id, allocation_set_id, invoice_id, amount_cents, invoices!invoice_line_allocations_invoice_id_fkey ( invoice_number )', { count: 'exact' })
      .in('allocation_set_id', setIds).order('id').range(from, to)),
    all((from, to) => supabase.from('prepay_credits')
      .select('id, allocation_set_id, original_amount_cents, bucket_label, reference_number, source_reference', { count: 'exact' })
      .in('allocation_set_id', setIds).eq('source_type', 'overpayment').order('id').range(from, to)),
  ]) : [[], []];

  const out: ReturnableCheck[] = [];
  for (const s of sets) {
    const id = s.id as string;
    const date = s.payment_date as string;
    const byInvoice = new Map<string, { number: string; cents: number }>();
    for (const a of allocs.filter((x) => x.allocation_set_id === id)) {
      const key = a.invoice_id as string;
      const prev = byInvoice.get(key);
      const number = (a.invoices as { invoice_number?: string } | null)?.invoice_number ?? 'invoice';
      byInvoice.set(key, { number, cents: (prev?.cents ?? 0) + Number(a.amount_cents) });
    }
    const meta = [
      ...[...byInvoice.values()].map((v) => `Paid ${v.number} ${fmt(v.cents)}`),
      ...overpay.filter((c) => c.allocation_set_id === id && Number(c.original_amount_cents) > 0)
        .map((c) => `created ${creditLabel(c)} ${fmt(Number(c.original_amount_cents))}`),
    ].join(' · ');
    const returnedOn = returned.bySet.get(id);
    out.push({
      allocationSetId: id, creditId: null, customerId,
      number: (s.check_number as string) || (s.reference_number as string) || 'no number',
      date, amountCents: Number(s.total_payment_cents ?? 0), prepayCheck: false, meta,
      closedMonth: isInClosedMonth(date, closed),
      disabledReason: returnedOn ? alreadyReturnedReason(returnedOn) : null,
    });
  }

  if (pmCredits.length) {
    const ids = pmCredits.map((c) => c.id as string);
    const [entries, edits] = await Promise.all([
      all((from, to) => supabase.from('financial_audit_log').select('id, new_values', { count: 'exact' })
        .eq('operation_type', 'prepay_credit_created').eq('entity_id', customerId).order('id').range(from, to)),
      all((from, to) => supabase.from('financial_audit_log').select('id, entity_id, old_values, new_values', { count: 'exact' })
        .eq('operation_type', 'prepay_edited').in('entity_id', ids).order('id').range(from, to)),
    ]);
    const edited = new Set(edits.filter((e) => (e.old_values as Row | null)?.original_amount_cents !== (e.new_values as Row | null)?.original_amount_cents)
      .map((e) => e.entity_id as string));
    const placed = new Set<string>();
    const groups: { buckets: Row[]; total: number | null }[] = [];
    for (const e of entries) {
      const nv = (e.new_values ?? {}) as { credit_ids?: unknown; total_cents?: unknown };
      if (!Array.isArray(nv.credit_ids)) continue;
      const buckets = pmCredits.filter((c) => (nv.credit_ids as unknown[]).includes(c.id));
      if (!buckets.length) continue;
      buckets.forEach((b) => placed.add(b.id as string));
      groups.push({ buckets, total: Number(nv.total_cents ?? NaN) });
    }
    // A bucket no entry names cannot be returned by the server either; list it, disabled.
    for (const c of pmCredits.filter((x) => !placed.has(x.id as string))) groups.push({ buckets: [c], total: null });

    for (const g of groups) {
      const face = g.buckets.reduce((s, b) => s + Number(b.original_amount_cents), 0);
      // An edited or deleted check (its buckets no longer add up to what was received) is listed, disabled.
      const received = g.total !== null && Number.isFinite(g.total) ? g.total : face;
      const first = g.buckets[0];
      const date = businessDay(first.created_at as string);
      const left = g.buckets.reduce((s, b) => s + Number(b.balance_cents), 0);
      const meta = g.buckets.length > 1
        ? `${g.buckets.length} prepay buckets: ${g.buckets.map((b) => `${creditLabel(b)} ${fmt(Number(b.original_amount_cents))}`).join(' · ')}${left === 0 ? ', all used' : ''} (returns all)`
        : `${creditLabel(first)} ${fmt(received)}${left > 0 && left < face ? ` (${fmt(left)} left)` : ''}`;
      const returnedOn = g.buckets.map((b) => returned.byCredit.get(b.id as string)).find(Boolean);
      const handEdited = g.total === null || g.total !== face || g.buckets.some((b) => edited.has(b.id as string));
      out.push({
        allocationSetId: null, creditId: first.id as string, customerId,
        number: (first.source_reference as string) || (first.reference_number as string) || 'no number',
        date, amountCents: received, prepayCheck: true, meta,
        closedMonth: isInClosedMonth(date, closed),
        disabledReason: returnedOn ? alreadyReturnedReason(returnedOn) : handEdited ? RETURN_EDITED_REASON : null,
      });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? (a.number < b.number ? 1 : -1) : a.date < b.date ? 1 : -1));
}

/** One check as a ReturnableCheck, for the entry points that already know it (invoice payment line, Payment History). */
export async function loadReturnableCheck(customerId: string, allocationSetId: string): Promise<ReturnableCheck | null> {
  const list = await loadReturnableChecks(customerId, todayInBusinessTz(), false);
  return list.find((c) => c.allocationSetId === allocationSetId) ?? null;
}

export interface ReturnEffect {
  invoices: { id: string; number: string; cents: number; dueDate: string | null; overdue: boolean; viaPrepay: string | null; paidOn: string | null }[];
  prepayRemovedCents: number;
  removedLabel: string;
  totalCents: number;
}

/** What returning this check does, read from its payment, its prepay and what that prepay paid. */
export async function loadReturnEffect(check: ReturnableCheck, today = todayInBusinessTz()): Promise<ReturnEffect> {
  let credits: Row[];
  let direct: Row[] = [];
  if (check.allocationSetId) {
    const setId = check.allocationSetId;
    [direct, credits] = await Promise.all([
      all((from, to) => supabase.from('invoice_line_allocations').select('id, invoice_id, amount_cents', { count: 'exact' })
        .eq('allocation_set_id', setId).order('id').range(from, to)),
      all((from, to) => supabase.from('prepay_credits').select('id, balance_cents, bucket_label, reference_number, source_reference', { count: 'exact' })
        .eq('allocation_set_id', setId).eq('source_type', 'overpayment').order('id').range(from, to)),
    ]);
  } else {
    const entry = await all((from, to) => supabase.from('financial_audit_log').select('id, new_values', { count: 'exact' })
      .eq('operation_type', 'prepay_credit_created').eq('entity_id', check.customerId).order('id').range(from, to));
    const ids = (entry.map((e) => (e.new_values as { credit_ids?: unknown } | null)?.credit_ids)
      .find((list) => Array.isArray(list) && list.includes(check.creditId)) as string[] | undefined) ?? [check.creditId as string];
    credits = await all((from, to) => supabase.from('prepay_credits').select('id, balance_cents, bucket_label, reference_number, source_reference', { count: 'exact' })
      .in('id', ids).order('id').range(from, to));
  }
  const creditIds = credits.map((c) => c.id as string);
  const apps = creditIds.length ? await all((from, to) => supabase.from('prepay_applications')
    .select('id, prepay_credit_id, invoice_id, applied_amount_cents, applied_at', { count: 'exact' })
    .in('prepay_credit_id', creditIds).order('id').range(from, to)) : [];
  const directBy = sumBy(direct, 'invoice_id', 'amount_cents');
  const invoiceIds = [...new Set([...directBy.keys(), ...apps.map((a) => a.invoice_id as string)])];
  const invoices = invoiceIds.length ? await all((from, to) => supabase.from('invoices')
    .select('id, invoice_number, due_date', { count: 'exact' }).in('id', invoiceIds).order('id').range(from, to)) : [];
  const inv = (id: string) => invoices.find((i) => i.id === id);
  const row = (id: string, cents: number, viaPrepay: string | null, paidOn: string | null) => {
    const due = (inv(id)?.due_date as string | null) ?? null;
    return { id, number: (inv(id)?.invoice_number as string) ?? 'Invoice', cents, dueDate: due, overdue: !!due && due < today, viaPrepay, paidOn };
  };
  const list = [
    ...[...directBy].map(([id, cents]) => row(id, cents, null, null)),
    ...apps.map((a) => row(a.invoice_id as string, Number(a.applied_amount_cents),
      creditLabel(credits.find((c) => c.id === a.prepay_credit_id) ?? {}), businessDay(a.applied_at as string))),
  ];
  const removed = credits.reduce((s, c) => s + Number(c.balance_cents), 0);
  return {
    invoices: list,
    prepayRemovedCents: removed,
    removedLabel: credits.length === 1 ? creditLabel(credits[0]) : 'prepay',
    totalCents: list.reduce((s, i) => s + i.cents, 0) + removed,
  };
}

/** What the dialog needs before either form: the open credits, the closed months and what the customer owes. */
export async function loadDialogBasics(customerId: string): Promise<{ credits: DrawCredit[]; closed: ClosedPeriod[]; owesCents: number | null }> {
  const [credits, closed] = await Promise.all([
    all<Row>((from, to) => supabase.from('prepay_credits')
      .select('id, balance_cents, bucket_label, reference_number, source_reference, created_at', { count: 'exact' })
      .eq('customer_id', customerId).gt('balance_cents', 0).order('id').range(from, to)),
    loadClosedPeriods(),
  ]);
  const { data, error } = await supabase.rpc('get_ar_aging', { p_as_of_date: todayInBusinessTz() }).eq('customer_id', customerId);
  if (error) throw error;
  const aging = assertRpcResult<ARAgingRow[]>(data, 'get_ar_aging').find((a) => a.customer_id === customerId) ?? null;
  return {
    credits: credits.map((c) => ({ id: c.id as string, label: creditLabel(c), balance_cents: Number(c.balance_cents), created_at: c.created_at as string })),
    closed,
    // No row: nothing owed. A row that can't be priced: unknown, so the dialog leaves the figure out.
    owesCents: aging === null ? 0 : isPricedAgingRow(aging) ? agingCents(aging.total_outstanding) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Prepay balance check

export interface PrepayTie {
  customer_id: string; farm_name: string; stored_cents: number; credits_cents: number; expected_cents: number;
  difference_cents: number; ok: boolean;
}

export async function fetchPrepayTie(customerId?: string): Promise<PrepayTie[]> {
  const { data, error } = await supabase.rpc('get_prepay_balance_check', customerId ? { p_customer_id: customerId } : {});
  if (error) throw error;
  return assertRpcResult<PrepayTie[]>(data, 'get_prepay_balance_check');
}

// ---------------------------------------------------------------------------------------------------------------
// Prepay history

export type HistoryKind = 'in' | 'out' | 'refund' | 'bounce';
export interface HistoryRow { key: string; at: string; day: string; kind: HistoryKind; what: string; sub: string; ref: string; by: string; cents: number; afterCents: number }

/**
 * Every change to this customer's prepay, newest first, with the balance after it: money received, applied to
 * invoices, refunded outside CRX and taken back by a returned check. Admin only (money_reversals is admin-read).
 */
export async function loadPrepayHistory(customerId: string): Promise<HistoryRow[]> {
  const [credits, reversals] = await Promise.all([
    all((from, to) => supabase.from('prepay_credits')
      .select('id, original_amount_cents, bucket_label, reference_number, source_reference, source_type, created_at, created_by', { count: 'exact' })
      .eq('customer_id', customerId).order('id').range(from, to)),
    all((from, to) => supabase.from('money_reversals')
      .select('id, kind, entry_date, reference, reason, performed_by, created_at, allocation_set_id, prepay_credit_id', { count: 'exact' })
      .eq('customer_id', customerId).order('id').range(from, to)),
  ]);
  const creditIds = credits.map((c) => c.id as string);
  const [apps, lines] = await Promise.all([
    creditIds.length ? all((from, to) => supabase.from('prepay_applications')
      .select('id, prepay_credit_id, invoice_id, applied_amount_cents, applied_at, applied_by, invoices!prepay_applications_invoice_id_fkey ( invoice_number )', { count: 'exact' })
      .in('prepay_credit_id', creditIds).order('id').range(from, to)) : [],
    reversals.length ? all((from, to) => supabase.from('money_reversal_lines')
      .select('id, reversal_id, line_kind, amount_cents', { count: 'exact' })
      .in('reversal_id', reversals.map((r) => r.id as string)).order('id').range(from, to)) : [],
  ]);
  const people = [...new Set([...credits.map((c) => c.created_by), ...apps.map((a) => a.applied_by), ...reversals.map((r) => r.performed_by)].filter(Boolean) as string[])];
  const names = people.length ? await all<{ id: string; full_name: string | null }>((from, to) => supabase.from('profiles')
    .select('id, full_name', { count: 'exact' }).in('id', people).order('id').range(from, to)) : [];
  const who = (id: unknown) => names.find((n) => n.id === id)?.full_name || 'someone';

  const rows: Omit<HistoryRow, 'afterCents'>[] = [];
  for (const c of credits) {
    const cents = Number(c.original_amount_cents);
    if (cents <= 0) continue; // voided or deleted: never counted
    rows.push({
      key: `c-${c.id}`, at: c.created_at as string, day: businessDay(c.created_at as string), kind: 'in', what: 'Prepay received',
      sub: c.source_type === 'overpayment' ? 'Left over from a payment' : creditLabel(c),
      ref: c.source_type === 'overpayment' ? (c.source_reference as string) || '' : `Check ${(c.source_reference as string) || (c.reference_number as string) || ''}`.trim(),
      by: who(c.created_by), cents,
    });
  }
  for (const a of apps) {
    const credit = credits.find((c) => c.id === a.prepay_credit_id) ?? {};
    rows.push({
      key: `a-${a.id}`, at: a.applied_at as string, day: businessDay(a.applied_at as string), kind: 'out', what: 'Applied to invoice',
      sub: (a.invoices as { invoice_number?: string } | null)?.invoice_number ?? 'Invoice', ref: creditLabel(credit), by: who(a.applied_by),
      cents: -Number(a.applied_amount_cents),
    });
  }
  for (const r of reversals) {
    const mine = lines.filter((l) => l.reversal_id === r.id);
    const taken = mine.filter((l) => l.line_kind === 'prepay_credit').reduce((s, l) => s + Number(l.amount_cents), 0);
    const restored = mine.filter((l) => l.line_kind === 'prepay_application').reduce((s, l) => s + Number(l.amount_cents), 0);
    const refund = r.kind === 'outside_refund';
    rows.push({
      key: `r-${r.id}`, at: r.created_at as string, day: r.entry_date as string, kind: refund ? 'refund' : 'bounce',
      what: refund ? 'Refund paid outside CRX' : 'Check came back (bounced)', sub: r.reason as string,
      ref: refund ? (r.reference as string) ?? '' : `Check ${(r.reference as string) ?? ''}`.trim(), by: who(r.performed_by),
      cents: -(taken - restored),
    });
  }
  rows.sort((a, b) => (a.at === b.at ? (a.key < b.key ? -1 : 1) : a.at < b.at ? -1 : 1));
  let running = 0;
  return rows.map((r) => ({ ...r, afterCents: (running += r.cents) })).reverse();
}

/** "Mon" of a day, for the "Sep · closed month" badge. */
export const closedMonthBadge = (ymd: string) => `${shortMonth(ymd)} · closed month`;
