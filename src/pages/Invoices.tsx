import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FileText, Check, Send, Ban, Printer, Mail, Zap, Trash2, Download, PanelRightOpen, ChevronRight } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult, describePostInvoiceBlock } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { fetchAllRows, fetchAllRowsForIds, pageWithList } from '../lib/pagedRead';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import BatchVoidModal from '../components/invoices/BatchVoidModal';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import InvoicePrintDialog from '../components/invoices/InvoicePrintDialog';
import CustomerDrawer from '../components/customers/CustomerDrawer';
import { hasPageAccess } from '../lib/pagePermissions';
import type { Invoice, InvoiceStatus, InvoicePrintOptions } from '../types';
import {
  assertInvoiceLinesLoaded,
  batchInvoicePrintToast,
  buildBatchInvoicePdfData,
  generateBatchInvoicePdf,
  groupReturnCreditDisplayItems,
  InvoiceDetailsUnavailableError,
  isBillSplitInvoice,
  loadBillSplitPayers,
  mapInvoicePdfItem,
  type InvoicePdfData,
} from '../lib/invoicePdf';
import { formatCents as fmt } from '../lib/money';
import { INVOICE_COLUMNS, INVOICE_ITEM_COLUMNS, INVOICE_POST_VERSION_COLUMNS, INVOICES_POSTABLE } from '../lib/costFields';
import { SkeletonTable, SkeletonCard } from '../components/ui/Skeleton';
import { isCurrentSeason, openOrInSeasonFilter, otherSeasonLabels } from '../lib/invoiceSeasonWindow';
import SeasonTag from '../components/invoices/SeasonTag';
import { fingerprintIntentPayload, generateIdempotencyKey, getIdempotencyBindingRejection } from '../lib/idempotency';
import { buildInvoicePostTargets, describeInvoicePostScope } from '../lib/invoiceBatchPosting';
import { postInvoiceTarget } from '../lib/invoicePostVersion';
import { applyTableSearchSort } from '../lib/tableSearchSort';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import { sendEmail, buildEmailHtml, invoiceEmailSnapshot } from '../lib/emailService';
import { assertInvoiceSendDisposition } from '../lib/invoiceSendDisposition';
import { logActivity } from '../lib/activityLogger';
import { INVOICE_BILL_TO_COLUMNS, invoiceEmailKey, invoiceEmailLogPrefix, isBulkEmailable, isEmailRateLimit, sentSinceInvoiceChanged, summarizeBulkEmail, type BulkEmailResult, type InvoiceBillTo, type InvoiceEmailLogRow } from '../lib/invoiceBulkEmail';

type InvoiceRow = Invoice & { customer_name: string; salesman_name: string | null; order_number: string | null };

// Only these statuses get a row checkbox, so only these can be part of a selection.
const SELECTABLE_STATUSES: readonly InvoiceStatus[] = ['draft', 'unposted', 'posted', 'overdue', 'voided'];
const SEARCH_KEYS = ['invoice_number', 'customer_name', 'salesman_name'];

type InvoiceStatusFilter = InvoiceStatus | '' | 'ready_to_post';

const STATUS_OPTIONS: { value: InvoiceStatusFilter; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'ready_to_post', label: 'Ready to Post (draft + unposted)' },
  { value: 'draft', label: 'Draft' },
  { value: 'unposted', label: 'Unposted' },
  { value: 'posted', label: 'Posted' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'voided', label: 'Voided' },
  { value: 'cancelled', label: 'Cancelled' },
];

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Types' },
  { value: 'chemical_sale', label: 'Chemical Sale' },
  // 'field_application' intentionally omitted — field invoices are filtered out
  // of this Chemical Sales list (see fetch .neq). They live at /field-invoices.
  { value: 'misc_charge', label: 'Misc Charge' },
];

const statusBadge = (status: InvoiceStatus) => {
  const map: Record<InvoiceStatus, { variant: 'default' | 'warning' | 'success' | 'error' | 'info'; label: string }> = {
    draft: { variant: 'default', label: 'Draft' },
    unposted: { variant: 'warning', label: 'Unposted' },
    posted: { variant: 'success', label: 'Posted' },
    paid: { variant: 'info', label: 'Paid' },
    overdue: { variant: 'error', label: 'Overdue' },
    voided: { variant: 'error', label: 'Voided' },
    cancelled: { variant: 'default', label: 'Cancelled' },
  };
  const s = map[status] || { variant: 'default' as const, label: status };
  return <Badge variant={s.variant}>{s.label}</Badge>;
};

const typeBadge = (t: string) => {
  const map: Record<string, string> = {
    chemical_sale: 'Chemical',
    field_application: 'Application',
    misc_charge: 'Misc',
  };
  return <Badge variant="info">{map[t] || t}</Badge>;
};


type InvoiceShareRow = { customer?: { farm_name: string }; split_percentage: number; acres: number; amount_cents: number; price_per_acre_cents: number | null; pricing_note: string | null };

// The invoice-row half of a printed invoice (the list row already holds these).
function invoiceRowPdfFields(inv: InvoiceRow) {
  return {
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    due_date: inv.due_date || undefined,
    invoice_type: inv.invoice_type || 'chemical_sale',
    status: inv.status || 'draft',
    customer_name: inv.customer_name,
    salesman_name: inv.salesman_name || undefined,
    purchase_order_ref: inv.purchase_order_ref || undefined,
    header_notes: inv.header_notes || undefined,
    footer_notes: inv.footer_notes || undefined,
    crop_type: inv.crop_type || undefined,
    field_names: inv.field_names || undefined,
    total_acres: inv.total_acres || undefined,
    applicator_name: inv.applicator_name || undefined,
    vehicle_name: inv.vehicle_name || undefined,
    application_date: inv.application_date || undefined,
    total_amount_cents: inv.total_amount_cents || 0,
    total_cost_cents: inv.total_cost_cents || 0,
    paid_amount_cents: inv.paid_amount_cents || 0,
    prepay_applied_cents: inv.prepay_applied_cents || 0,
    balance_cents: inv.balance_cents || 0,
  };
}

function invoicePdfShares(shares: InvoiceShareRow[]) {
  return shares.map((s) => ({
    customer_name: s.customer?.farm_name || 'Unknown',
    split_percentage: s.split_percentage,
    acres: s.acres,
    amount_cents: s.amount_cents,
    price_per_acre_cents: s.price_per_acre_cents || null,
    pricing_note: s.pricing_note || null,
  }));
}

/** The PDF's share table: an invoice's own shares, else a Bill Split payer's sale payers (as its own page prints). */
async function batchPdfShares(inv: InvoiceRow, shares: InvoiceShareRow[]): Promise<InvoicePdfData['shares']> {
  if (shares.length > 0) return invoicePdfShares(shares);
  if (!isBillSplitInvoice(inv) || !inv.invoice_group_id) return undefined;
  const payers = await loadBillSplitPayers(supabase, inv.invoice_group_id)
    .catch(() => { throw new InvoiceDetailsUnavailableError(); });
  return payers.length > 0 ? payers : undefined;
}

// Re-read the server-owned gate and the version the retry key names: an invoice unposted or
// edited since the list loaded is refused, never sent under its old key.
async function assertStillSendable(inv: InvoiceRow): Promise<void> {
  const { data: live, error } = await supabase
    .from('invoices')
    .select('send_disposition, status, deleted_at, updated_at')
    .eq('id', inv.id)
    .maybeSingle();
  if (error) throw error;
  assertInvoiceSendDisposition(live?.send_disposition, live?.status, live?.deleted_at);
  if (live?.status !== 'posted' && live?.status !== 'overdue') {
    throw new Error('This invoice is no longer posted. Reload the list.');
  }
  if (live.updated_at !== inv.updated_at) {
    throw new Error('This invoice changed since the list loaded. Reload the list and email it again.');
  }
}

export default function Invoices() {
  const navigate = useNavigate();
  const { profile, role, deniedPages } = useAuth();
  // Customer 360 peek exposes AR balance + credit tier — gate with the canonical
  // customers-page permission (blocks a rep denied /customers — Codex P2).
  const canPeekCustomer = hasPageAccess(role, deniedPages, 'customers');
  const { toast } = useToast();
  const batchVoidIdem = useIdempotencyKey('batch_void_invoices', profile?.id || '');
  const batchDeleteIdem = useIdempotencyKey('delete_invoices', profile?.id || '');
  const canPostInvoices = profile?.role === 'admin' || profile?.role === 'sales_rep';
  const isAdmin = profile?.role === 'admin';
  // Keep one stable key per standalone invoice or split group across a
  // failed/network-lost retry, and clear only that action's key on success.
  const postKeysRef = useRef<Record<string, string>>({});
  // The batch void/delete keys are scoped to the exact ids (and reason) each request sends.
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatusFilter>('');
  const [typeFilter, setTypeFilter] = useState('');
  const [quickDeliveryOnly, setQuickDeliveryOnly] = useState(false);
  const [balanceOnly, setBalanceOnly] = useState(false);
  // The table's search box is lifted here so the page knows exactly which rows are
  // on screen (a ticked row the search hides must not be acted on).
  const [tableSearch, setTableSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);
  const [showPostModal, setShowPostModal] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const emailingRef = useRef(false);
  const [emailResults, setEmailResults] = useState<BulkEmailResult[] | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [showBatchPrintDialog, setShowBatchPrintDialog] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  // Customer 360 peek drawer (F2) — view a customer's numbers without leaving the list.
  const [drawerCustomer, setDrawerCustomer] = useState<{ id: string; name: string } | null>(null);

  // A refresh after posting/voiding/deleting is a multi-page read; an older,
  // slower load must not overwrite the newer list, so only the latest may set state.
  const fetchSeq = useRef(0);
  const fetchInvoices = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // A failed read (an error, or no list) clears the rows and shows "could not be loaded"
    // with Try again: never "No invoices yet", $0 cards, or older rows whose Post / Void /
    // Print / Delete still work (To-Do 10.5). Clearing the rows also drops any selection.
    const failLoad = (err: unknown) => {
      if (seq !== fetchSeq.current) return;
      Sentry.captureException(err, { tags: { source: 'fetch', page: 'invoices' } });
      toast('error', 'Failed to load invoices');
      setInvoices([]);
      setSelected(new Set());
      setLoadError(true);
      setLoading(false);
    };
    // PR-07 follow-up: dropped salesman FK embed; resolve via profile_public_view.
    // Read every page: a single request is silently cut off at the server's row cap.
    let data: unknown[] | null;
    let error: unknown;
    try {
      ({ data, error } = await fetchAllRows((from, to) => pageWithList(supabase
        .from(INVOICES_POSTABLE)
        // invoice_post_version: posting refuses a row changed since this list loaded it.
        .select(`${INVOICE_COLUMNS}, ${INVOICE_POST_VERSION_COLUMNS}, customer:customers!invoices_customer_id_fkey(farm_name)`, { count: 'exact' })
        .is('deleted_at', null)
        // Segregation (Mason 2026-06-19): field-application invoices live in their
        // own area (/field-invoices). This Chemical Sales list excludes them so a
        // field invoice no longer shows in BOTH lists.
        .neq('invoice_type', 'field_application')
        // Open invoices (draft / unposted / posted / overdue) show from EVERY season, so a
        // prior-season invoice still to post or collect never drops off at the Oct 1
        // rollover; closed ones (paid / voided / cancelled) stay this-season only,
        // windowed on created_at as before. See src/lib/invoiceSeasonWindow.ts.
        .or(openOrInSeasonFilter('created_at'))
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to))));
    } catch (err: unknown) {
      failLoad(err);
      return;
    }
    if (seq !== fetchSeq.current) return;

    if (error || !data) {
      failLoad(error ?? new Error('The invoice list read returned no list'));
      return;
    }

    const salesmanIds = [...new Set(
      ((data || []) as Array<{ salesman_id?: string | null }>)
        .map((inv) => inv.salesman_id)
        .filter(Boolean) as string[]
    )];
    const salesmanMap: Record<string, string> = {};
    // A failed label lookup keeps the list but must not fail silently. One that throws
    // counts as failed too, so it can never leave the list on its skeleton.
    let labelLookupError: { message: string } | null = null;
    const lookup = <T,>(read: Promise<{ data: T[] | null; error: { message: string } | null }>) =>
      read.catch((err: unknown) => ({ data: null, error: { message: err instanceof Error ? err.message : String(err) } }));
    if (salesmanIds.length > 0) {
      // pageWithList: a page with no list is a failed lookup (named below), not "no names".
      const { data: salesmen, error: salesmenError } = await lookup(fetchAllRowsForIds(salesmanIds, (idChunk, from, to) => pageWithList(supabase
        .from('profile_public_view')
        .select('id, full_name', { count: 'exact' })
        .in('id', idChunk)
        .order('id')
        .range(from, to))));
      if (salesmenError) labelLookupError = salesmenError;
      ((salesmen || []) as { id: string; full_name: string }[]).forEach((s) => { salesmanMap[s.id] = s.full_name; });
    }

    // F7: resolve the source order number so the list can show + link to it.
    const orderIds = [...new Set(
      ((data || []) as Array<{ order_id?: string | null }>).map((inv) => inv.order_id).filter(Boolean) as string[]
    )];
    const orderMap: Record<string, string> = {};
    if (orderIds.length > 0) {
      const { data: ords, error: ordersLookupError } = await lookup(fetchAllRowsForIds(orderIds, (idChunk, from, to) => pageWithList(supabase
        .from('orders')
        .select('id, order_number', { count: 'exact' })
        .in('id', idChunk)
        .order('id')
        .range(from, to))));
      if (ordersLookupError) labelLookupError ??= ordersLookupError;
      ((ords || []) as { id: string; order_number: string }[]).forEach((o) => { orderMap[o.id] = o.order_number; });
    }

    const rows = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name: string }; salesman_id?: string | null; order_id?: string | null }>).map((inv) => ({
      ...inv,
      customer_name: inv.customer?.farm_name || 'Unknown',
      salesman_name: inv.salesman_id ? salesmanMap[inv.salesman_id] || null : null,
      order_number: inv.order_id ? orderMap[inv.order_id] || null : null,
    })) as unknown as InvoiceRow[];
    // Checked again after the label lookups: a newer load (or a newer failure) that started
    // while they ran wins, so these older rows never come back.
    if (seq !== fetchSeq.current) return;
    if (labelLookupError) {
      Sentry.captureException(labelLookupError, { tags: { source: 'fetch', page: 'invoices', action: 'load_invoice_labels' } });
      toast('error', 'Some salesperson or order labels could not be loaded.');
    }
    setInvoices(rows);
    setLoadError(false);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  const filtered = invoices.filter((inv) => {
    if (statusFilter === 'ready_to_post' && !['draft', 'unposted'].includes(inv.status)) return false;
    if (statusFilter && statusFilter !== 'ready_to_post' && inv.status !== statusFilter) return false;
    if (typeFilter && inv.invoice_type !== typeFilter) return false;
    if (quickDeliveryOnly && !inv.is_quick_delivery) return false;
    if (balanceOnly && !(inv.balance_cents > 0)) return false;
    return true;
  });

  // Summary stats. An overdue invoice is a posted invoice past its due date, so it
  // counts as posted here (as the Field Invoices list's isPostedLike does). The list
  // includes open invoices from earlier seasons, so these totals do too (noted under
  // the cards).
  const unpostedCount = invoices.filter((i) => i.status === 'draft' || i.status === 'unposted').length;
  const postedLikeInvoices = invoices.filter((i) => i.status === 'posted' || i.status === 'overdue');
  const postedTotal = postedLikeInvoices.reduce((s, i) => s + i.total_amount_cents, 0);
  const outstandingBalance = postedLikeInvoices
    .filter((i) => i.balance_cents > 0)
    .reduce((s, i) => s + i.balance_cents, 0);

  // What the bulk actions act on (2026-10-09): only ticked rows that are loaded AND on
  // screen right now — passing the Status / Type / Quick Deliveries / Has-a-balance
  // filters and the search box — AND showing a checkbox. A ticked row that a filter
  // hides, that is no longer loaded (deleted elsewhere, or past the row cap), or whose
  // status lost its checkbox is never posted, voided, printed, deleted or counted.
  const visibleSelectable = applyTableSearchSort(filtered, SEARCH_KEYS, tableSearch, null, 'asc')
    .filter((i) => SELECTABLE_STATUSES.includes(i.status));
  const selectedInvoices = visibleSelectable.filter((i) => selected.has(i.id));

  // Drop ticked rows as soon as they leave the screen (a filter or search hides them,
  // a reload no longer returns them, or a failed batch post re-selects a row a filter
  // now hides), so a hidden selection can never reappear later and be acted on.
  // `selected` is a dependency on purpose: a failed batch post re-ticks the failed ids
  // with setSelected while the visible set (visibleSelectableKey) stays the same, and one
  // of those ids may be hidden by a filter. Re-running on selection changes prunes it at
  // once; with only visibleSelectableKey it would linger and reappear when the filter is
  // cleared. The updater returns `prev` when nothing is pruned, so this cannot loop.
  const visibleSelectableKey = visibleSelectable.map((i) => i.id).join(',');
  useEffect(() => {
    const inView = new Set(visibleSelectableKey.split(','));
    setSelected((prev) => {
      const kept = [...prev].filter((id) => inView.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [visibleSelectableKey, selected]);

  const selectedPostable = selectedInvoices.filter((i) => ['draft', 'unposted'].includes(i.status));
  const basePostConfirmation = describeInvoicePostScope(selectedPostable);
  // The list shows open invoices from every season, and the server does not check the
  // season when posting, so the confirm names any selected invoice not from this season.
  const selectedOtherSeasonPostable = selectedPostable.filter((i) => !isCurrentSeason(i.season));
  const postConfirmation = selectedOtherSeasonPostable.length > 0
    ? {
        ...basePostConfirmation,
        message:
          `${basePostConfirmation.message} This includes ${selectedOtherSeasonPostable.length} invoice(s) not from ` +
          `this season (${otherSeasonLabels(selectedOtherSeasonPostable)}); each posts into its own invoice-date month.`,
      }
    : basePostConfirmation;
  const selectedVoidable = selectedInvoices.filter((i) => ['posted', 'overdue'].includes(i.status));
  const selectedDeletable = selectedInvoices.filter((i) => ['draft', 'voided'].includes(i.status));
  const selectedEmailable = selectedInvoices.filter(isBulkEmailable);

  // Batch post — standalone invoices post independently, while split invoices
  // are deduplicated by group and posted atomically through post_invoice_group.
  // This preserves partial success across unrelated actions without allowing a
  // single group member to bypass the server's GROUP_POST_REQUIRED guard.
  const handleBatchPost = async () => {
    setShowPostModal(false);
    if (!profile || !canPostInvoices) {
      toast('error', 'Admin or sales access is required to post invoices');
      return;
    }
    // A split group's versions come from every member this list loaded, not just the selected ones.
    const targets = buildInvoicePostTargets(selectedPostable, invoices);
    if (targets.length === 0) {
      toast('error', 'No postable invoices selected');
      return;
    }
    await runCriticalAction({
      action: async () => {
        let completedActions = 0;
        const failures: string[] = [];
        const failedIds: string[] = [];
        for (const target of targets) {
          if (!postKeysRef.current[target.key]) {
            postKeysRef.current[target.key] = generateIdempotencyKey(
              target.operation,
              `${profile.id}:${target.scopeId}`,
            );
          }
          try {
            // Each target carries the version its rows were loaded with; a row changed since
            // is refused on its own with a "reload" message, and the others still post.
            await postInvoiceTarget(target, profile.id, postKeysRef.current[target.key]);
            completedActions++;
            delete postKeysRef.current[target.key];
          } catch (err: unknown) {
            failedIds.push(...target.selectedIds);
            const blocked = describePostInvoiceBlock(err);
            if (blocked) {
              failures.push(`${target.label}: ${blocked}`);
            } else {
              failures.push(`${target.label}: ${sanitizeError(err)}`);
            }
          }
        }

        await fetchInvoices();
        if (failures.length > 0) {
          // Leave only failed invoices selected so the next retry is focused and
          // reuses their existing per-invoice idempotency keys.
          setSelected(new Set(failedIds));
          const shown = failures.slice(0, 3).join(' | ');
          const extra = failures.length > 3 ? ` | +${failures.length - 3} more` : '';
          throw new Error(`Completed ${completedActions}/${targets.length} posting action(s). Failed: ${shown}${extra}`);
        }
        setSelected(new Set());
      },
      toast,
      successMessage: 'Posting completed for the selected invoices and full split groups',
      setLoading: setPosting,
      sentryTag: 'batch_post_invoices_client_loop',
    });
  };

  // Batch void
  const handleBatchVoid = async (reason: string) => {
    const ids = selectedVoidable.map((i) => i.id);
    if (ids.length === 0) {
      toast('error', 'No posted invoices selected to void');
      return;
    }

    await runCriticalAction({
      action: async () => {
        // One key per set of invoices, in any order: the server binds this key to its request, so edited details after a lost reply are refused with the committed result.
        const voidScope = fingerprintIntentPayload([...ids].sort());
        const { data, error } = await supabase.rpc('batch_void_invoices', {
          p_invoice_ids: ids,
          p_void_reason: reason,
          p_performed_by: profile?.id,
          p_idempotency_key: batchVoidIdem.getKeyFor(voidScope),
        });
        if (error) {
          // Refused as another batch's retry key: nothing was voided, so start the next try fresh.
          // Only 'intent' and 'actor' prove nothing committed under this key; a 'receipt' refusal keeps it.
          const bindingRejection = getIdempotencyBindingRejection(error);
          if (bindingRejection === 'intent' || bindingRejection === 'actor') batchVoidIdem.resetKeyFor(voidScope);
          // A changed reason after a lost reply: the earlier void already committed, so show the current list.
          if (bindingRejection === 'intent') {
            setSelected(new Set());
            await fetchInvoices();
            throw new Error('An earlier void of these invoices already went through. The list has been refreshed.');
          }
          throw error;
        }
        const voided = assertRpcResult(data, 'batch_void_invoices');
        batchVoidIdem.resetKeyFor(voidScope);
        return voided;
      },
      toast,
      successMessage: `Voided ${ids.length} invoice(s)`,
      setLoading: setVoiding,
      sentryTag: 'batch_void_invoices',
      onSuccess: () => {
        setSelected(new Set());
        fetchInvoices();
      },
    });
    setShowVoidModal(false);
  };

  // One invoice's printable data, read fresh. Print and Email both use it, so an emailed
  // invoice's money check matches what Print would show.
  // billTo: the customer row an email already read for its key, so the PDF prints exactly what the key covers.
  const loadInvoicePdfData = async (inv: InvoiceRow, options?: InvoicePrintOptions, billTo?: InvoiceBillTo): Promise<InvoicePdfData> => {
    // Fetch customer details
    // A dropped request is a failed read too: the same refusal, not a raw network error.
    const detailsUnavailable = () => { throw new InvoiceDetailsUnavailableError(); };
    const { data: cust, error: custError } = billTo
      ? { data: billTo, error: null }
      : await supabase
        .from('customers')
        .select('billing_address, city, state, zip, account_number, payment_terms')
        .eq('id', inv.customer_id)
        .maybeSingle()
        .then((r) => r, detailsUnavailable);
    // A failed or missing customer read refuses the PDF: printing on would send the
    // customer an invoice with a blank address block (To-Do 10.5 follow-up).
    if (custError || !cust) throw new InvoiceDetailsUnavailableError();

    // Fetch items with product details
    const { data: items, error: itemsError } = await supabase
      .from('invoice_items')
      .select(`${INVOICE_ITEM_COLUMNS}, product:products(product_name, epa_registration, product_form)`)
      .eq('invoice_id', inv.id)
      .order('sort_order');
    // Checked against the same total the PDF prints (total_amount_cents below).
    assertInvoiceLinesLoaded(itemsError, items, inv.total_amount_cents || 0);

    // Fetch shares
    const { data: shares, error: sharesError } = await supabase
      .from('invoice_shares')
      .select('*, customer:customers!invoice_shares_customer_id_fkey(farm_name)')
      .eq('invoice_id', inv.id)
      .then((r) => r, detailsUnavailable);
    // A split invoice printed without its shares would hide who owes what.
    if (sharesError || !Array.isArray(shares)) throw new InvoiceDetailsUnavailableError();
    const pdfShares = await batchPdfShares(inv, shares as InvoiceShareRow[]);

    return {
      ...invoiceRowPdfFields(inv),
      ...(billTo ? { customer_name: billTo.farm_name || inv.customer_name } : {}),
      customer_address: cust.billing_address || undefined,
      customer_city: cust.city || undefined,
      customer_state: cust.state || undefined,
      customer_zip: cust.zip || undefined,
      account_number: cust.account_number || undefined,
      payment_terms: inv.payment_terms || cust.payment_terms || undefined,
      shares: pdfShares,
      items: groupReturnCreditDisplayItems(inv.invoice_type, (items || []).map(mapInvoicePdfItem)),
      options,
    };
  };

  // Bulk email (To-Do 9.6): one invoice at a time through the same send-email path and
  // checks as the invoice page's Email button. Every invoice gets its own result.
  const handleBulkEmail = async () => {
    setShowEmailModal(false);
    if (!profile || emailingRef.current) return;
    emailingRef.current = true;
    setEmailing(true);
    const targets = selectedEmailable;
    const results: BulkEmailResult[] = [];
    try {
      for (const [index, inv] of targets.entries()) {
        const base = { invoiceId: inv.id, invoiceNumber: inv.invoice_number, customerName: inv.customer_name };
        try {
          // Read the address and bill-to right before each send, so a change made mid-batch is used.
          const { data: cust, error: custError } = await supabase
            .from('customers')
            .select(INVOICE_BILL_TO_COLUMNS)
            .eq('id', inv.customer_id)
            .maybeSingle();
          if (custError) throw custError;
          const to = cust?.email?.trim() || '';
          if (!to) {
            results.push({ ...base, outcome: 'skipped', detail: 'No email address on file' });
            continue;
          }
          // The log check below trusts the list's version, so confirm it is still current first (Sol 9.6 r2).
          await assertStillSendable(inv);
          // Sent since it last changed, under any key (KI-104, option A2): skip before the send, so the
          // hourly cap cannot turn an already-sent invoice into "Not sent". A read error sends nothing.
          const { data: logRows, error: logError } = await supabase
            .from('email_log')
            .select('idempotency_key, recipient_email, status, created_at')
            .eq('email_type', 'invoice')
            .like('idempotency_key', `${invoiceEmailLogPrefix(inv.id)}%`)
            .gte('created_at', inv.updated_at);
          if (logError) throw logError;
          if (sentSinceInvoiceChanged((logRows ?? []) as InvoiceEmailLogRow[], inv, to)) {
            results.push({ ...base, outcome: 'already_sent', detail: `Already emailed to ${to} since it last changed; not sent again` });
            continue;
          }
          // The server draws the PDF from the saved invoice; this copy is only what the screen would print (KI-98).
          const pdfData = await loadInvoicePdfData(inv, undefined, cust ?? undefined);
          await assertStillSendable(inv);
          const result = await sendEmail({
            to,
            subject: `Invoice ${inv.invoice_number} from Crop RX Solutions`,
            html: buildEmailHtml('<p style="margin:0;color:#374151;">Please find your invoice attached to this email.</p>'),
            email_type: 'invoice',
            customer_id: inv.customer_id,
            resource_type: 'invoice',
            resource_id: inv.id,
            idempotency_key: await invoiceEmailKey(inv, to, cust ?? {}),
            invoice_snapshot: invoiceEmailSnapshot(pdfData),
          });
          if (!result.success) throw new Error(result.error || 'Failed to send email');
          if (result.deduplicated) {
            // The same key already went (from either screen): the server sent nothing new.
            results.push({ ...base, outcome: 'already_sent', detail: `Already emailed to ${to}; not sent again` });
          } else {
            results.push({ ...base, outcome: 'sent', detail: to });
            logActivity({ event: 'invoice_emailed', description: `Invoice ${inv.invoice_number} emailed to ${to}`, performedBy: profile.id, entityType: 'invoice', entityId: inv.id, customerId: inv.customer_id });
          }
        } catch (err) {
          if (err instanceof Error && isEmailRateLimit(err.message)) {
            // Every later send would be refused too: stop, and leave the rest ticked for a retry.
            const detail = 'Not sent: the hourly email limit (50 an hour) was reached. Try again later.';
            results.push(...targets.slice(index).map((t) => ({ invoiceId: t.id, invoiceNumber: t.invoice_number, customerName: t.customer_name, outcome: 'failed' as const, detail })));
            break;
          }
          Sentry.captureException(err, { tags: { action: 'bulk_email_invoices' }, extra: { invoiceId: inv.id } });
          results.push({ ...base, outcome: 'failed', detail: sanitizeError(err) });
        }
      }
    } finally {
      emailingRef.current = false;
      setEmailing(false);
    }
    // Untick what went out and keep what did not, so a retry is one click; other ticks made meanwhile stay.
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of results) {
        // A row unticked during the run stays unticked, even if it failed.
        if (r.outcome === 'sent' || r.outcome === 'already_sent') next.delete(r.invoiceId);
      }
      return next;
    });
    setEmailResults(results);
    const done = summarizeBulkEmail(results);
    toast(done.type, done.message);
  };

  // Batch print
  const handleBatchPrint = async (options: InvoicePrintOptions) => {
    setShowBatchPrintDialog(false);
    await runCriticalAction({
      action: async () => {
        // Fetch full data for each selected invoice. An invoice whose lines could not be
        // read is skipped and named; the rest still print.
        const { list: pdfDataList, skipped } = await buildBatchInvoicePdfData(selectedInvoices, (inv) => loadInvoicePdfData(inv, options));

        if (pdfDataList.length === 0) {
          throw new Error('No invoices to print');
        }

        const { failures } = await generateBatchInvoicePdf(pdfDataList);
        const done = batchInvoicePrintToast(pdfDataList.length - failures.length, skipped, failures);
        toast(done.type, done.message);
      },
      toast,
      setLoading: setPrinting,
      sentryTag: 'batch_print_invoices',
    });
  };

  const handleBatchDelete = async () => {
    const ids = selectedDeletable.map((i) => i.id);
    if (ids.length === 0) return;
    await runCriticalAction({
      action: async () => {
        // Route through the guarded RPC (admin-only, audited, idempotent) instead
        // of a raw .update({ deleted_at }). See migration delete_invoices.
        // One key per set of invoices, in any order: the server binds this key to its request, so edited details after a lost reply are refused with the committed result.
        const deleteScope = fingerprintIntentPayload([...ids].sort());
        const { data, error } = await supabase.rpc('delete_invoices', {
          p_invoice_ids: ids,
          p_performed_by: profile?.id,
          p_idempotency_key: batchDeleteIdem.getKeyFor(deleteScope),
        });
        if (error) throw error;
        const deleted = assertRpcResult<number>(data, 'delete_invoices');
        batchDeleteIdem.resetKeyFor(deleteScope);
        return deleted;
      },
      toast,
      setLoading: setDeleting,
      sentryTag: 'delete_invoices',
      onSuccess: (deleted) => {
        // delete_invoices skips rows that are no longer deletable (e.g. posted in
        // another tab after this list loaded), returning a smaller count — report
        // the ACTUAL deleted count, not the requested count (Codex P2).
        if (deleted < ids.length) {
          toast('warning', `Deleted ${deleted} of ${ids.length} invoice(s) — the rest were no longer deletable (status changed).`);
        } else {
          toast('success', `Deleted ${deleted} invoice(s)`);
        }
        setSelected(new Set());
        fetchInvoices();
      },
    });
    setShowDeleteModal(false);
  };

  const handleExportPDF = async () => {
    setExportingPdf(true);
    try {
      const rows = selectedInvoices.length > 0 ? selectedInvoices : filtered;
      await downloadReportPdf({
        title: 'Invoices',
        subtitle: `${rows.length} invoice(s)`,
        columns: [
          { header: 'Invoice #', key: 'invoice_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Type', key: 'invoice_type', format: (v) => {
            const map: Record<string, string> = { chemical_sale: 'Chemical', field_application: 'Application', misc_charge: 'Misc' };
            return map[String(v)] || String(v || '-');
          }},
          { header: 'Date', key: 'invoice_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
          { header: 'Total', key: 'total_amount_cents', align: 'right', format: (v) => fmt(Number(v) || 0) },
          { header: 'Balance', key: 'balance_cents', align: 'right', format: (v) => fmt(Number(v) || 0) },
          { header: 'Status', key: 'status' },
        ],
        data: rows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${rows.length} invoice(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExportingPdf(false);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Select All picks only THIS season's rows (2026-10-09). The list also shows older
  // seasons' open invoices (and any whose season is unknown), and one Select All +
  // Post / Void / Delete must not reach that work by accident. An older invoice is
  // still selectable by ticking its own box (it carries a visible "Season N" tag).
  //
  // The toggle works on invoice IDs, not on how many rows are selected: a hand-ticked
  // older row counts toward the selection but is never one of the rows Select All
  // picks, so comparing counts could clear when the button said Select All, or select
  // when it said Deselect All. Everything here reads the on-screen selection
  // (selectedInvoices), never ticked rows a filter hides.
  //   - "Deselect All" shows only when something is selected AND every this-season row
  //     in view is already selected (or none is in view); it clears the whole selection.
  //   - Otherwise "Select All" REPLACES the selection with exactly this season's rows in
  //     view (as before the season change), so it never carries along a row ticked
  //     earlier. It is disabled when no this-season row in view can be selected.
  // "Clear selection" shows whenever anything on screen is selected.
  const selectableThisSeason = visibleSelectable.filter((i) => isCurrentSeason(i.season));
  const toggleAllClears = selectedInvoices.length > 0 && selectableThisSeason.every((i) => selected.has(i.id));
  const toggleAllDisabled = !toggleAllClears && selectableThisSeason.length === 0;
  const toggleAll = () => {
    if (toggleAllClears) {
      setSelected(new Set());
      return;
    }
    if (selectableThisSeason.length === 0) return;
    setSelected(new Set(selectableThisSeason.map((i) => i.id)));
  };

  const selectBox = (row: InvoiceRow) => (
    <input
      type="checkbox"
      checked={selected.has(row.id)}
      onChange={(e) => {
        e.stopPropagation();
        toggleSelect(row.id);
      }}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Select invoice ${row.invoice_number}`}
      className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
    />
  );

  // Phone layout of one invoice: the same values and formatting as the table's columns.
  const invoiceMobileRow = (row: InvoiceRow) => (
    <div className="flex items-center gap-1 px-4 py-2">
      {/* A 44px tap area around the small checkbox; a spacer keeps rows aligned without one. */}
      {SELECTABLE_STATUSES.includes(row.status)
        ? <label className="-ml-3 flex h-11 w-11 shrink-0 items-center justify-center">{selectBox(row)}</label>
        : <span aria-hidden="true" className="-ml-3 w-11 shrink-0" />}
      <button
        type="button"
        onClick={() => navigate(`/invoices/${row.id}`)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
      >
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm text-secondary">
              <span>{row.invoice_number}</span>
              {row.is_quick_delivery && <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-label="Quick Delivery" />}
            </span>
            <span className="shrink-0 font-heading text-lg font-bold text-nav-dark">{fmt(row.total_amount_cents)}</span>
          </span>
          <span className="line-clamp-2 break-words font-heading text-lg font-bold leading-snug text-nav-dark">{row.customer_name}</span>
          <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-secondary">
            <span className="flex flex-wrap items-center gap-1.5">
              <span>{new Date(row.invoice_date + 'T00:00:00').toLocaleDateString()}</span>
              <SeasonTag season={row.season} />
            </span>
            <span className={row.balance_cents > 0 ? 'text-red-600 font-semibold' : 'text-crx-green'}>
              Balance {fmt(row.balance_cents)}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {statusBadge(row.status)}
            {typeBadge(row.invoice_type)}
          </span>
        </span>
        <ChevronRight className="w-5 h-5 shrink-0 text-gray-400" aria-hidden="true" />
      </button>
    </div>
  );

  const columns: Column<InvoiceRow>[] = [
    {
      key: 'id',
      header: '',
      className: 'w-10',
      render: (row) => (SELECTABLE_STATUSES.includes(row.status) ? selectBox(row) : null),
    },
    {
      key: 'invoice_number',
      header: 'Invoice #',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-crx-green shrink-0" />
          <span className="whitespace-nowrap font-medium text-nav-dark">{row.invoice_number}</span>
          {row.is_quick_delivery && (
            <span title="Quick Delivery"><Zap className="w-3.5 h-3.5 text-amber-500 shrink-0" /></span>
          )}
        </div>
      ),
    },
    {
      key: 'order_number',
      header: 'Order #',
      sortable: true,
      render: (row) =>
        row.order_number && row.order_id ? (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/orders/${row.order_id}`); }}
            className="whitespace-nowrap text-crx-green hover:underline font-medium"
            title="Open the source order"
          >
            {row.order_number}
          </button>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/customers/${row.customer_id}`);
            }}
            className="text-crx-green hover:underline"
          >
            {row.customer_name}
          </button>
          {row.customer_id && canPeekCustomer && (
            <button
              onClick={(e) => { e.stopPropagation(); setDrawerCustomer({ id: row.customer_id, name: row.customer_name }); }}
              title="Peek customer"
              aria-label={`Peek ${row.customer_name}`}
              className="p-0.5 rounded text-gray-300 hover:text-crx-green hover:bg-crx-green-light transition-colors"
            >
              <PanelRightOpen className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ),
    },
    {
      key: 'invoice_type',
      header: 'Type',
      sortable: true,
      render: (row) => typeBadge(row.invoice_type),
    },
    {
      key: 'invoice_date',
      header: 'Date',
      sortable: true,
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{new Date(row.invoice_date + 'T00:00:00').toLocaleDateString()}</span>
          <SeasonTag season={row.season} />
        </div>
      ),
    },
    {
      key: 'total_amount_cents',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-medium">{fmt(row.total_amount_cents)}</span>,
    },
    {
      key: 'balance_cents',
      header: 'Balance',
      sortable: true,
      render: (row) => (
        <span className={row.balance_cents > 0 ? 'text-red-600 font-semibold' : 'text-crx-green'}>
          {fmt(row.balance_cents)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => statusBadge(row.status),
    },
    {
      key: 'salesman_name',
      header: 'Salesman',
      render: (row) => row.salesman_name || '-',
    },
  ];

  // Determine if batch print dialog needs any shares info
  const anySelectedIsFieldApp = selectedInvoices.some((i) => i.invoice_type === 'field_application');
  // A Bill Split chemical sale prints its payers too (the misc charge layout has no share table).
  const anySelectedHasShares = anySelectedIsFieldApp
    || selectedInvoices.some((i) => i.invoice_type === 'chemical_sale' && isBillSplitInvoice(i));

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="phone-touch space-y-4">
      <PageHeader
        title="Customer"
        accent="Invoices"
        large
        subtitle="Post, print and follow up on every bill sent to customers."
        actions={
          <div className="flex gap-2 flex-wrap justify-end">
            {selectedInvoices.length > 0 && canPostInvoices && (
              <>
                {selectedPostable.length > 0 && (
                  <Button
                    variant="secondary"
                    icon={<Send className="w-4 h-4" />}
                    onClick={() => setShowPostModal(true)}
                    loading={posting}
                  >
                    Post {selectedPostable.length} Selected
                  </Button>
                )}
                {isAdmin && selectedVoidable.length > 0 && (
                  <Button
                    variant="danger"
                    icon={<Ban className="w-4 h-4" />}
                    onClick={() => setShowVoidModal(true)}
                  >
                    Void {selectedVoidable.length} Selected
                  </Button>
                )}
                <Button
                  variant="secondary"
                  icon={<Printer className="w-4 h-4" />}
                  onClick={() => setShowBatchPrintDialog(true)}
                  loading={printing}
                >
                  Print {selectedInvoices.length} Selected
                </Button>
                {isAdmin && selectedEmailable.length > 0 && (
                  <Button
                    variant="secondary"
                    icon={<Mail className="w-4 h-4" />}
                    onClick={() => setShowEmailModal(true)}
                    loading={emailing}
                  >
                    Email {selectedEmailable.length} Selected
                  </Button>
                )}
                {isAdmin && selectedDeletable.length > 0 && (
                  <Button
                    variant="danger"
                    icon={<Trash2 className="w-4 h-4" />}
                    onClick={() => setShowDeleteModal(true)}
                  >
                    Delete {selectedDeletable.length}
                  </Button>
                )}
              </>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                exportToCSV(
                  filtered as unknown as Record<string, unknown>[],
                  [
                    { key: 'invoice_number', header: 'Invoice #' },
                    { key: 'customer_name', header: 'Customer' },
                    { key: 'invoice_type', header: 'Type' },
                    { key: 'invoice_date', header: 'Date' },
                    { key: 'total_amount_cents', header: 'Total ($)', format: (v: unknown) => ((Number(v) || 0) / 100).toFixed(2) },
                    { key: 'balance_cents', header: 'Balance ($)', format: (v: unknown) => ((Number(v) || 0) / 100).toFixed(2) },
                    { key: 'status', header: 'Status' },
                  ],
                  'invoices'
                )
              }
            >
              Export CSV
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-4 h-4" />}
              onClick={handleExportPDF}
              loading={exportingPdf}
            >
              Download PDF
            </Button>
            <Button variant="secondary" icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/invoices/new?type=misc_charge')}>
              Misc Charge
            </Button>
          </div>
        }
      />

      {/* Summary: one compact card; on a phone each figure is a label-left row. */}
      <div className="space-y-2">
        <Card padding={false} className="grid grid-cols-1 overflow-hidden divide-y divide-gray-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <button
            type="button"
            className={`w-full text-left transition-colors hover:bg-cream-dark/60 ${statusFilter === 'ready_to_post' ? 'bg-amber-50 ring-2 ring-inset ring-amber-400' : ''}`}
            onClick={() => setStatusFilter('ready_to_post')}
            aria-label="Show invoices ready to post"
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 sm:block">
              <div className="flex shrink-0 items-center gap-2 sm:mb-1">
                <FileText className="w-4 h-4 text-amber-600" aria-hidden="true" />
                <span className="text-sm font-semibold text-nav-dark">Unposted</span>
              </div>
              <div className="text-right sm:text-left">
                <p className="font-heading text-2xl font-bold leading-tight text-amber-600">{loadError ? '—' : unpostedCount}</p>
                <p className="text-xs text-secondary">invoices awaiting review</p>
              </div>
            </div>
          </button>
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:block">
            <div className="flex shrink-0 items-center gap-2 sm:mb-1">
              <Check className="w-4 h-4 text-crx-green" aria-hidden="true" />
              <span className="text-sm font-semibold text-nav-dark">Posted Total</span>
            </div>
            <div className="text-right sm:text-left">
              <p className="font-heading text-2xl font-bold leading-tight text-crx-green">{loadError ? '—' : fmt(postedTotal)}</p>
              <p className="text-xs text-secondary">
                {loadError ? 'Could not be loaded' : `${postedLikeInvoices.length} posted invoices (including overdue)`}
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:block">
            <div className="flex shrink-0 items-center gap-2 sm:mb-1">
              <Ban className="w-4 h-4 text-red-600" aria-hidden="true" />
              <span className="text-sm font-semibold text-nav-dark">Outstanding</span>
            </div>
            <div className="text-right sm:text-left">
              <p className="font-heading text-2xl font-bold leading-tight text-red-600">{loadError ? '—' : fmt(outstandingBalance)}</p>
              <p className="text-xs text-secondary">unpaid balance on posted and overdue invoices</p>
            </div>
          </div>
        </Card>
        <p className="text-xs text-secondary">
          Shows this season&apos;s invoices plus any invoice from an earlier season that is still unposted
          or unpaid; the totals above include those older open invoices.
        </p>
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-3 sm:p-5">
          <DataTable<InvoiceRow>
            data={filtered}
            columns={columns}
            mobileRow={invoiceMobileRow}
            searchable
            searchPlaceholder="Search invoices..."
            searchKeys={SEARCH_KEYS}
            searchValue={tableSearch}
            onSearchChange={setTableSearch}
            onRowClick={(row) => navigate(`/invoices/${row.id}`)}
            emptyTitle="No invoices yet"
            emptyDescription="Invoices are created from orders or blend tickets — open one to bill."
            emptyAction={
              <Button variant="secondary" icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/orders')}>
                Go to Orders
              </Button>
            }
            loading={loading}
            loadError={loadError}
            onRetry={() => { void fetchInvoices(); }}
            filters={
              <div className="flex flex-wrap gap-2 items-center">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as InvoiceStatusFilter)}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  aria-label="Filter by type"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setQuickDeliveryOnly((v) => !v)}
                  className={`flex items-center gap-1 px-3 py-2 text-sm border rounded-lg transition-colors ${
                    quickDeliveryOnly
                      ? 'border-amber-400 bg-amber-50 text-amber-700'
                      : 'border-gray-200 text-secondary hover:border-gray-300'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5" />
                  Quick Deliveries
                </button>
                <button
                  onClick={() => setBalanceOnly((v) => !v)}
                  className={`flex items-center gap-1 px-3 py-2 text-sm border rounded-lg transition-colors ${
                    balanceOnly
                      ? 'border-crx-green/50 bg-crx-green-tint text-crx-green'
                      : 'border-gray-200 text-secondary hover:border-gray-300'
                  }`}
                  title="Show only invoices with money still owed"
                >
                  Has a balance
                </button>
                {visibleSelectable.length > 0 && (
                  <button
                    type="button"
                    onClick={toggleAll}
                    disabled={toggleAllDisabled}
                    className="text-xs text-crx-green hover:underline ml-2 disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed"
                    title={
                      toggleAllClears
                        ? 'Clears every selected invoice.'
                        : toggleAllDisabled
                          ? "No invoice from this season is in view. Tick an older-season invoice's own box to select it."
                          : "Selects exactly this season's invoices in view, replacing any other selection. Tick an older-season invoice's own box afterwards to include it."
                    }
                  >
                    {toggleAllClears ? 'Deselect All' : 'Select All'}
                  </button>
                )}
                {selectedInvoices.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="text-xs text-secondary hover:underline ml-2"
                  >
                    Clear selection
                  </button>
                )}
              </div>
            }
          />
        </div>
      </Card>

      {/* Batch Void Modal */}
      <BatchVoidModal
        open={showVoidModal}
        onClose={() => setShowVoidModal(false)}
        count={selectedVoidable.length}
        onConfirm={handleBatchVoid}
        loading={voiding}
      />

      <ConfirmModal
        open={showPostModal}
        onClose={() => setShowPostModal(false)}
        onConfirm={handleBatchPost}
        title="Post Selected Invoices"
        message={postConfirmation.message}
        confirmLabel={postConfirmation.confirmLabel}
        variant="info"
        icon={Send}
        loading={posting}
      />

      <ConfirmModal
        open={showEmailModal}
        onClose={() => setShowEmailModal(false)}
        onConfirm={handleBulkEmail}
        title="Email Selected Invoices"
        message={
          `Email ${selectedEmailable.length} posted or overdue invoice(s) to each customer's email on file? ` +
          (selectedInvoices.length > selectedEmailable.length
            ? `${selectedInvoices.length - selectedEmailable.length} selected invoice(s) are left out (only posted or overdue invoices are emailed). `
            : '') +
          'An invoice already emailed to the same address and unchanged since is not sent twice. Up to 50 emails go out an hour.'
        }
        confirmLabel={`Email ${selectedEmailable.length}`}
        variant="info"
        icon={Mail}
        loading={emailing}
      />

      <Modal open={!!emailResults} onClose={() => setEmailResults(null)} title="Email Results">
        {emailResults && (
          <div className="space-y-3">
            <p className="text-sm text-gray-700">{summarizeBulkEmail(emailResults).message}.</p>
            <ul className="divide-y divide-gray-100 text-sm max-h-96 overflow-y-auto">
              {emailResults.map((r) => (
                <li key={r.invoiceId} className="py-2 flex items-start justify-between gap-3">
                  <span>
                    <span className="font-medium">{r.invoiceNumber}</span>
                    <span className="text-gray-500"> · {r.customerName}</span>
                    {r.detail && <span className="block text-xs text-gray-500">{r.detail}</span>}
                  </span>
                  <Badge variant={r.outcome === 'sent' ? 'success' : r.outcome === 'already_sent' ? 'info' : 'error'}>
                    {r.outcome === 'sent' ? 'Sent' : r.outcome === 'already_sent' ? 'Already sent' : 'Not sent'}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      {/* Batch Print Dialog */}
      <InvoicePrintDialog
        open={showBatchPrintDialog}
        onClose={() => setShowBatchPrintDialog(false)}
        invoiceType={anySelectedIsFieldApp ? 'field_application' : 'chemical_sale'}
        hasShares={anySelectedHasShares}
        onPrint={handleBatchPrint}
        loading={printing}
      />

      {/* Batch Delete Modal */}
      <BulkDeleteConfirmModal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        count={selectedDeletable.length}
        entityName="invoice"
        onConfirm={handleBatchDelete}
        loading={deleting}
      />

      <CustomerDrawer
        open={canPeekCustomer && !!drawerCustomer}
        customerId={drawerCustomer?.id ?? ''}
        customerName={drawerCustomer?.name ?? ''}
        onClose={() => setDrawerCustomer(null)}
      />
    </div>
  );
}
