import { useEffect, useState, useMemo , useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { parseLocalDate, localDatePlusDays, localToday } from '../lib/dateUtils';
import { Plus, Upload, Copy, Download, FileText, Trash2, ChevronDown, ChevronUp, PackageCheck, AlertTriangle, Check } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Dropdown from '../components/ui/Dropdown';
import ActionMenu, { type ActionMenuItem } from '../components/ui/ActionMenu';
import DataTable, { type Column } from '../components/ui/DataTable';
import { LoadFailedState } from '../components/ui/EmptyState';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import BulkQuoteImport from '../components/quotes/BulkQuoteImport';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { supabase, supabaseUntyped, assertRpcResult, checkMutationResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { convertQuoteToOrderWithRowVersion } from '../lib/quoteLifecycleRpc';
import { resendRequiredMessage } from '../lib/quotePriceLock';
import { fetchAllRows, fetchAllRowsForIds, pageWithList } from '../lib/pagedRead';
import { QUOTE_COLUMNS } from '../lib/costFields';
import { quoteStatusLabel } from '../lib/quoteStatusLabel';
import { applyTableSearchSort } from '../lib/tableSearchSort';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { formatUSD as fmt } from '../lib/money';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { isBelowCostApprovalHandledError, withBelowCostReason } from '../lib/belowCostApproval';
import { Sentry } from '../lib/sentry';
import { SkeletonTable } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import PageHeader from '../components/ui/PageHeader';
import { notifyLargeOrder, notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { sendOrderConfirmedEmail } from '../lib/orderConfirmedEmail';
import { trackBusinessEvent } from '../lib/metrics';
import type { Quote, BookingRolloverRow } from '../types';

const DELETABLE = ['draft', 'sent', 'revised'];
const STATUSES = ['draft', 'sent', 'revised', 'accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short'];
// The Dropdown needs a real key for "no status filter"; it maps back to ''.
const ALL = 'all';
const STATUS_OPTIONS = [{ value: ALL, label: 'All' }, ...STATUSES.map((s) => ({ value: s, label: quoteStatusLabel(s) }))];
const SEARCH_KEYS = ['quote_number', 'customer_name', 'product_names'];

const shortDate = (d: Date, withYear = true) =>
  d.toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });

// Row shape with denormalized, searchable strings (F1: search by product/customer).
interface QuoteRow extends Quote {
  customer_name: string;
  product_names: string;
}

// Today's row actions and conditions: Convert to order only for sent and revised.
// A component (not an inline items list) so the handlers stay event props, never render-time calls.
function RowMenu({ row, onConvert, onDuplicate }: { row: QuoteRow; onConvert: (row: QuoteRow) => void; onDuplicate: (id: string) => void }) {
  const items: ActionMenuItem[] = [
    ...(row.status === 'sent' || row.status === 'revised'
      ? [{ id: 'convert', label: 'Convert to order', icon: <PackageCheck className="w-4 h-4" />, onAction: () => onConvert(row) }]
      : []),
    { id: 'duplicate', label: 'Duplicate', icon: <Copy className="w-4 h-4" />, onAction: () => onDuplicate(row.id) },
  ];
  return (
    // The menu's clicks and keys bubble (through its portal) to the row, which would open the quote.
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <ActionMenu label={`Actions for ${row.quote_number}`} items={items} />
    </div>
  );
}

export default function Quotes() {
  const navigate = useNavigate();
  const location = useLocation();
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  // The last list read failed: no rows, so it never reads as "No quotes yet".
  const [loadFailed, setLoadFailed] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [plannedFilter, setPlannedFilter] = useState(false);
  // Held here (not inside the table) so the result count matches the rows shown.
  const [search, setSearch] = useState('');
  const [importModalOpen, setImportModalOpen] = useState(false);
  const { toast } = useToast();
  const { profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const duplicateQuoteIdem = useIdempotencyKey('duplicate_quote', profile?.id || '');
  // F3 act-from-list: convert a sent/revised quote to an order in place (confirm popup).
  const convertQuoteIdem = useIdempotencyKey('convert_quote_to_order', profile?.id || '');
  const [convertTarget, setConvertTarget] = useState<QuoteRow | null>(null);
  const [converting, setConverting] = useState(false);
  // F3 guardrail parity with QuoteBuilder: warn (not block) before the one-click
  // convert if the quote is stale (>30d) or the customer already ordered recently.
  const [convertStaleMsg, setConvertStaleMsg] = useState<string | null>(null);
  const [convertDupMsg, setConvertDupMsg] = useState<string | null>(null);
  // True while the async duplicate-order guard is still running — the modal's
  // Convert button stays disabled until it resolves so a fast click can't bypass
  // the warning before it renders (Codex P2 race).
  const [convertChecking, setConvertChecking] = useState(false);
  // Fire the non-idempotent post-conversion side effects (email/notifications) at
  // most once per order. convert_quote_to_order is idempotent but returns no replay
  // marker, so a same-key retry after a lost response replays status:'created' — the
  // stable order_id is how we avoid duplicate alerts/emails on that replay (Codex P2).
  const firedConvertSideEffects = useRef<Set<string>>(new Set());
  // Monotonic token so an in-flight duplicate-order check from a previous
  // open/close is discarded if the modal is reopened for another quote before it
  // resolves — prevents quote A's warning landing on quote B (Codex P3 stale race).
  const convertReqId = useRef(0);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canBulkAction = profile?.role === 'admin' || profile?.role === 'sales_rep';

  // #6(d-UI): open-booking rollover (season-end roll-up). Lazy-loaded on expand.
  const [showRollover, setShowRollover] = useState(false);
  const [rolloverRows, setRolloverRows] = useState<BookingRolloverRow[]>([]);
  const [rolloverLoading, setRolloverLoading] = useState(false);
  const [rolloverLoaded, setRolloverLoaded] = useState(false);
  // The last rollover read failed: "No open bookings." would read as nothing outstanding.
  const [rolloverFailed, setRolloverFailed] = useState(false);

  // Only the newest rollover read may set the rows: a slower, older one (the panel
  // closed and reopened while it ran) must not overwrite them (Luna round 1).
  const rolloverSeq = useRef(0);
  const loadRollover = useCallback(async () => {
    const seq = ++rolloverSeq.current;
    setRolloverLoading(true);
    setRolloverFailed(false);
    try {
      const { data, error } = await supabase.rpc('get_open_booking_rollover', { p_customer_id: undefined, p_season: undefined });
      if (seq !== rolloverSeq.current) return;
      if (error) throw error;
      const result = assertRpcResult<{ success: boolean; bookings: BookingRolloverRow[] }>(data, 'get_open_booking_rollover');
      // The function always answers with a list; none at all is a failed read.
      if (!Array.isArray(result.bookings)) throw new Error('get_open_booking_rollover returned no bookings list');
      setRolloverRows(result.bookings);
      setRolloverLoaded(true);
    } catch (err) {
      if (seq !== rolloverSeq.current) return;
      setRolloverRows([]);
      setRolloverFailed(true);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'get_open_booking_rollover' } });
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) toast('error', 'Only admin or sales can view the booking rollover.');
      else toast('error', sanitizeError(err));
    } finally {
      if (seq === rolloverSeq.current) setRolloverLoading(false);
    }
  }, [toast]);

  const toggleRollover = () => {
    const next = !showRollover;
    setShowRollover(next);
    if (next && !rolloverLoaded) loadRollover();
  };

  // === GAP FIX #7: Duplicate a quote ===
  const handleDuplicate = async (quoteId: string) => {
    try {
      // Keyed per source quote: a retry reuses it, duplicating another quote gets its own.
      const key = duplicateQuoteIdem.getKeyFor(quoteId);
      const { data: result, error } = await runWithBelowCostApproval((reason) => supabaseUntyped.rpc('duplicate_quote', withBelowCostReason('duplicate_quote', {
        p_source_quote_id: quoteId,
        p_performed_by: profile!.id,
        p_idempotency_key: key,
      }, reason)));
      if (error) {
        toast('error', `Failed to duplicate quote: ${error.message}`);
        return;
      }
      const dupResult = assertRpcResult<{ quote_id: string; quote_number: string }>(result, 'duplicate_quote');
      duplicateQuoteIdem.resetKeyFor(quoteId);
      toast('success', `Quote duplicated as ${dupResult.quote_number}`);
      navigate(`/quotes/${dupResult.quote_id}`);
    } catch (err: unknown) {
      if (isBelowCostApprovalHandledError(err)) return;
      toast('error', `Failed to duplicate quote: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Open the convert confirm modal, computing QuoteBuilder's two pre-conversion
  // guardrails so they show INSIDE the dialog (warn, don't block — one informed
  // click acknowledges them). The third QuoteBuilder guard (partial draw-down) is
  // already covered server-side: convert_quote_to_order raises BOOKING_PARTIALLY_DRAWN
  // which handleConvertConfirm catches.
  const openConvert = async (row: QuoteRow) => {
    const reqId = ++convertReqId.current;
    convertQuoteIdem.resetKey();
    setConvertTarget(row);
    setConvertChecking(true);
    // Stale-price guard — same 30-day threshold as useStaleQuoteCheck (pure).
    const ageDays = Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86_400_000);
    setConvertStaleMsg(ageDays > 30 ? `This quote is ${ageDays} days old - product prices may have changed since it was created.` : null);
    // Duplicate-order guard — same query QuoteBuilder runs (last 7 days, same customer).
    setConvertDupMsg(null);
    try {
      const { data: recent } = await supabase
        .from('orders')
        .select('order_number, order_date')
        .eq('customer_id', row.customer_id)
        .is('deleted_at', null)
        .gte('order_date', localDatePlusDays(-7))
        .order('order_date', { ascending: false })
        .limit(1);
      // Discard if a newer open/close superseded this check (stale-result race).
      if (convertReqId.current !== reqId) return;
      if (recent && recent.length > 0) {
        const daysAgo = Math.max(0, Math.ceil((Date.now() - new Date(recent[0].order_date + 'T00:00:00').getTime()) / 86_400_000));
        setConvertDupMsg(`${row.customer_name || 'This customer'} already has order ${recent[0].order_number} from ${daysAgo} day(s) ago - this would create another.`);
      }
    } catch {
      // Non-blocking — a failed duplicate check must not stop conversion.
    } finally {
      // Only clear the in-flight flag if this is still the active request.
      if (convertReqId.current === reqId) setConvertChecking(false);
    }
  };

  const closeConvert = () => {
    convertReqId.current++; // invalidate any in-flight duplicate-order check
    setConvertTarget(null);
    setConvertStaleMsg(null);
    setConvertDupMsg(null);
    setConvertChecking(false);
  };

  // F3 act-from-list: convert a sent/revised quote to a confirmed order in place.
  // Uses the same atomic RPC QuoteBuilder calls (order + items + prebooking +
  // commissions); the RPC is idempotent + actor-bound and accepts sent/revised
  // directly (status guard allows 'sent','revised','accepted').
  const handleConvertConfirm = async () => {
    if (!convertTarget || !profile) return;
    setConverting(true);
    try {
      const idemKey = convertQuoteIdem.getKey();
      const { data, error } = await runWithBelowCostApproval((reason) => convertQuoteToOrderWithRowVersion(
        withBelowCostReason('convert_quote_to_order', {
          p_quote_id: convertTarget.id,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
          p_expected_row_version: convertTarget.row_version ?? null,
        }, reason),
      ));
      if (error) throw error;
      convertQuoteIdem.resetKey();
      const result = data;
      if (result.status === 'already_converted') {
        toast('info', 'This booking was already converted. Opening the order.');
      } else {
        toast('success', `Order ${result.order_number || ''} created`);
      }
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach((w) => toast('warning', `Inventory: ${w}`));
      }
      // Mirror QuoteBuilder's post-conversion side effects (Codex P2): orders are
      // born 'confirmed' with no later transition to gate on, so the creation site
      // is the ONLY place these fire. Run once per order_id — skips both an
      // 'already_converted' result AND a same-key idempotency replay (which returns
      // the cached status:'created' for the same order_id).
      if (result.status !== 'already_converted' && result.order_id && !firedConvertSideEffects.current.has(result.order_id)) {
        firedConvertSideEffects.current.add(result.order_id);
        trackBusinessEvent('quote_converted_to_order', {
          message: `Quote converted → Order ${result.order_number || ''}`,
          data: { orderId: result.order_id, orderNumber: result.order_number ?? '', quoteId: convertTarget.id },
        });
        // Customer "Order Confirmed" email — fire-and-forget, swallows its own errors.
        sendOrderConfirmedEmail(result.order_id);
        // Large-order admin alert (self-guards under its $50k threshold).
        notifyLargeOrder(result.order_id, result.order_number || '', convertTarget.customer_name || 'customer', convertTarget.total_price || 0);
        // Credit-limit warning — non-blocking, must not prevent navigation.
        try {
          const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', { p_customer_id: convertTarget.customer_id });
          const cl = assertRpcResult<{ exceeded?: boolean; outstanding_ar?: number; credit_limit?: number } | null>(creditCheck, 'check_customer_credit_limit');
          if (cl && cl.exceeded) {
            const fmtCl = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
            toast('warning', `Credit limit warning: ${convertTarget.customer_name || 'Customer'} outstanding AR ${fmtCl(cl.outstanding_ar ?? 0)} exceeds limit ${fmtCl(cl.credit_limit ?? 0)}`);
            notifyCreditLimitExceeded(convertTarget.customer_name || 'Customer', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, convertTarget.customer_id);
          }
        } catch {
          // Non-blocking — credit limit check should not prevent navigation.
        }
      }
      closeConvert();
      if (result.order_id) navigate(`/orders/${result.order_id}`);
      else fetchQuotes();
    } catch (err: unknown) {
      if (isBelowCostApprovalHandledError(err)) return;
      if (hasRpcCode(err, RpcErrorCodes.BOOKING_PARTIALLY_DRAWN)) {
        toast('warning', 'This booking has partial draw-downs. Draw the remaining balance from the quote instead of converting.');
      } else if (hasRpcCode(err, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('error', 'This booking is closed. Only sent or revised quotes can be converted.');
      } else if (hasRpcCode(err, RpcErrorCodes.QUOTE_RESEND_REQUIRED)) {
        // The sent-price lock (20261027040000): an expected refusal with a plain-English instruction.
        toast('error', resendRequiredMessage(err));
      } else if (hasRpcCode(err, RpcErrorCodes.COST_BASIS_REQUIRED)) {
        toast('error', 'A line on this quote has no recorded cost. Open the quote, revise and save it, then convert it again.');
      } else if (hasRpcCode(err, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(err, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        convertQuoteIdem.resetKey();
        closeConvert();
        await fetchQuotes();
        toast('warning', 'This quote changed before conversion. Review the refreshed quote before trying again.');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'convert_quote_to_order' } });
        toast('error', sanitizeError(err));
      }
    } finally {
      setConverting(false);
    }
  };

  // A refresh after a convert/duplicate/delete is a multi-page read; an older,
  // slower load must not overwrite the newer list, so only the latest may set state.
  const fetchSeq = useRef(0);
  const fetchQuotes = useCallback(async () => {
    const seq = ++fetchSeq.current;
    // Read every page: a single request is silently cut off at the server's row cap.
    const { data, error } = await fetchAllRows((from, to) => pageWithList(supabase
      .from('quotes')
      .select(`${QUOTE_COLUMNS}, customer:customers(farm_name)`, { count: 'exact' })
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to)));
    if (seq !== fetchSeq.current) return;
    if (error || !data) {
      Sentry.captureException(error ?? new Error('quotes read returned no list'), { tags: { source: 'fetch', action: 'load_quotes' } });
      toast('error', 'Failed to load quotes. Please try again.');
      // An older list would look current; none at all would read as "No quotes yet".
      setQuotes([]);
      setLoadFailed(true);
      setLoading(false);
      return;
    }

    // Seed rows with searchable strings; customer name is denormalized off the join.
    const quoteList: QuoteRow[] = data.map((q) => ({
      ...(q as Quote),
      customer_name: (q as { customer?: { farm_name?: string } | null }).customer?.farm_name || '',
      product_names: '',
    }));

    // quote_items only carries product_id, so join through products for the name (F1: search by product).
    const quoteIds = quoteList.map((q) => q.id);
    // The list still loads without product names, but a product search would then
    // silently miss quotes, so a failed lookup is reported once below.
    let productNamesFailed = false;
    if (quoteIds.length > 0) {
      // Chunked and paged: a full quote list has more ids than one URL holds and
      // more item rows than the server's row cap.
      // pageWithList: a page with no list reports the names as failed, not as "no products".
      const { data: itemRows, error: itemErr } = await fetchAllRowsForIds(quoteIds, (idChunk, from, to) => pageWithList(supabase
        .from('quote_items')
        .select('id, quote_id, product_id', { count: 'exact' })
        .in('quote_id', idChunk)
        .order('id')
        .range(from, to)));
      if (itemErr) {
        Sentry.captureException(itemErr, { tags: { source: 'fetch', action: 'load_quote_items' } });
        productNamesFailed = true;
      } else if (itemRows && itemRows.length > 0) {
        const productIds = [...new Set(itemRows.map((r) => r.product_id).filter(Boolean) as string[])];
        const { data: prodRows, error: prodErr } = await fetchAllRowsForIds(productIds, (idChunk, from, to) => pageWithList(supabase
          .from('products')
          .select('id, product_name', { count: 'exact' })
          .in('id', idChunk)
          .order('id')
          .range(from, to)));
        if (prodErr) {
          Sentry.captureException(prodErr, { tags: { source: 'fetch', action: 'load_quote_products' } });
          productNamesFailed = true;
        }
        const nameById: Record<string, string> = {};
        (prodRows || []).forEach((p) => { nameById[p.id] = p.product_name; });
        const namesByQuote: Record<string, Set<string>> = {};
        itemRows.forEach((r) => {
          const nm = r.product_id ? nameById[r.product_id] : undefined;
          if (nm) (namesByQuote[r.quote_id] ??= new Set()).add(nm);
        });
        quoteList.forEach((q) => {
          q.product_names = Array.from(namesByQuote[q.id] || []).join(', ');
        });
      }
    }

    if (seq !== fetchSeq.current) return;
    setQuotes(quoteList);
    setLoadFailed(false);
    setLoading(false);
    if (productNamesFailed) {
      toast('error', 'Product names could not be loaded, so searching by product may miss quotes. Reload to try again.');
    }
  }, [toast]);

  useEffect(() => {
    fetchQuotes();
    // Support ?filter=planned from dashboard alert link
    const params = new URLSearchParams(location.search);
    if (params.get('filter') === 'planned') setPlannedFilter(true);
  }, [fetchQuotes, location.search]);

  const filtered = quotes.filter((q) => {
    if (plannedFilter && !q.is_planned) return false;
    if (statusFilter && q.status !== statusFilter) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (q) => q.id,
      isSelectable: (q) => DELETABLE.includes(q.status),
    });

  const hasSelectable = filtered.some((q) => DELETABLE.includes(q.status));
  const someSelected = selectedCount > 0 && !allSelected;
  // The header checkbox selects the same rows the old "Select All" button did (draft, sent, revised).
  const checkboxCol = useMemo(
    () => ({
      ...createCheckboxColumn<QuoteRow>(selected, toggleSelect, (q) => q.id, (q) => DELETABLE.includes(q.status), (q) => `Select ${q.quote_number}`),
      header: (
        <input
          type="checkbox"
          aria-label="Select all quotes"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected; }}
          onChange={toggleAll}
          disabled={!hasSelectable}
          className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
        />
      ),
    }),
    [selected, toggleSelect, allSelected, someSelected, toggleAll, hasSelectable]
  );

  const filtersActive = !!statusFilter || plannedFilter;
  const clearFilters = () => { setStatusFilter(''); setPlannedFilter(false); };
  const shownCount = applyTableSearchSort(filtered, SEARCH_KEYS, search, null, 'asc').length;

  // ─── Bulk action handlers ───────────────────────────────────
  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'quote_number', header: 'Quote #' },
      { key: 'customer', header: 'Customer', format: (v) => {
        const c = v as { farm_name?: string } | undefined;
        return c?.farm_name || '-';
      }},
      { key: 'status', header: 'Status' },
      { key: 'tier', header: 'Tier' },
      { key: 'total_price', header: 'Total', format: (v) => fmtCSV(v as number) },
      { key: 'created_at', header: 'Created', format: (v) => fmtDateCSV(v as string) },
      { key: 'expires_at', header: 'Expires', format: (v) => fmtDateCSV(v as string) },
    ], 'quotes');
    toast('success', `Exported ${selectedRows.length} quote(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'Quote #', key: 'quote_number' },
        { header: 'Customer', key: 'customer', format: (v) => {
          const c = v as { farm_name?: string } | undefined;
          return c?.farm_name || '-';
        }},
        { header: 'Status', key: 'status' },
        { header: 'Tier', key: 'tier', format: (v) => `Tier ${v}` },
        { header: 'Total', key: 'total_price', align: 'right', format: (v) => fmt(Number(v)) },
        { header: 'Created', key: 'created_at', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
        { header: 'Expires', key: 'expires_at', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
      ];
      await downloadReportPdf({
        title: 'Quotes',
        subtitle: `${selectedRows.length} quote(s) selected`,
        columns: pdfCols,
        data: selectedRows as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} quote(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      let ids = selectedRows.map((q) => q.id);
      // Open bookings with partial draw-downs must not be soft-deleted:
      // deletion changes no status, so the hold-release trigger never fires —
      // the booking's reserved inventory would stay held on a hidden quote.
      // Layer 2 (§6.5 / Codex round-5 P2): a job reservation is a SECOND draw ledger
      // (job_product_draws) and the FK only cascades on HARD deletes, so a quote with
      // a live job draw must be skipped here too — else it's hidden while its booking
      // stays consumed by a schedulable/invoiceable job.
      // Read every draw row (ids in chunks): a selection can be the whole list, and a
      // draw missed past the row cap would let a drawn booking be deleted.
      const [orderDrawnRes, jobDrawnRes] = await Promise.all([
        fetchAllRowsForIds(ids, (idChunk, from, to) => supabase
          .from('quote_product_draws').select('id, quote_id', { count: 'exact' }).in('quote_id', idChunk).gt('quantity_drawn', 0)
          .order('id').range(from, to)),
        fetchAllRowsForIds<{ id: string; quote_id: string }, string>(ids, (idChunk, from, to) => supabaseUntyped
          .from('job_product_draws').select('id, quote_id', { count: 'exact' }).in('quote_id', idChunk).gt('quantity_drawn', 0)
          .order('id').range(from, to)),
      ]);
      if (orderDrawnRes.error) throw orderDrawnRes.error;
      if (jobDrawnRes.error) throw jobDrawnRes.error;
      const drawnIds = new Set<string>([
        ...(orderDrawnRes.data || []).map((d) => d.quote_id),
        ...(jobDrawnRes.data || []).map((d: { quote_id: string }) => d.quote_id),
      ]);
      if (drawnIds.size > 0) {
        const blocked = selectedRows.filter((q) => drawnIds.has(q.id));
        toast('warning', `${blocked.length} booking(s) with draw-downs or job reservations skipped. Close the booking (draw or cancel the remainder or the job) before deleting them: ${blocked.map((q) => q.quote_number).join(', ')}`);
        ids = ids.filter((id) => !drawnIds.has(id));
        if (ids.length === 0) {
          setDeleting(false);
          setDeleteModalOpen(false);
          return;
        }
      }
      const result = await supabase
        .from('quotes')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', ids)
        .select('id');
      checkMutationResult(result, 'Delete quotes');
      toast('success', `Deleted ${ids.length} quote(s)`);
      clearSelection();
      fetchQuotes();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete quotes', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const customerName = (row: QuoteRow) => (row.customer as unknown as { farm_name: string })?.farm_name || '-';
  const isPastDue = (row: QuoteRow) =>
    !!row.expires_at && (row.status === 'sent' || row.status === 'revised') && row.expires_at.slice(0, 10) < localToday();
  const statusBadge = (row: QuoteRow) => (
    <Badge variant={statusToBadgeVariant[row.status] || 'default'} normalCase dot>
      {quoteStatusLabel(row.status)}
    </Badge>
  );

  const rowMenu = (row: QuoteRow) => <RowMenu row={row} onConvert={openConvert} onDuplicate={handleDuplicate} />;

  const dataColumns: Column<QuoteRow>[] = [
    {
      key: 'quote_number',
      header: 'Quote',
      sortable: true,
      render: (row) => <span className="font-semibold text-crx-green whitespace-nowrap">{row.quote_number}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => <span className="block max-w-64 truncate" title={customerName(row)}>{customerName(row)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          {statusBadge(row)}
          {row.is_planned && (
            <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full">
              Planned
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      sortable: true,
      render: (row) => <span className="text-secondary whitespace-nowrap">Tier {row.tier}</span>,
    },
    {
      key: 'total_price',
      header: 'Total',
      sortable: true,
      className: 'text-right',
      render: (row) => <span className="font-medium tabular-nums whitespace-nowrap">{fmt(row.total_price)}</span>,
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: (row) => <span className="text-secondary whitespace-nowrap">{shortDate(new Date(row.created_at))}</span>,
    },
    {
      key: 'expires_at',
      header: 'Expires',
      sortable: true,
      render: (row) => {
        if (!row.expires_at) return '-';
        const date = shortDate(parseLocalDate(row.expires_at));
        return isPastDue(row) ? (
          <span className="text-red-600 font-medium">{date} (past due)</span>
        ) : <span className="text-secondary whitespace-nowrap">{date}</span>;
      },
    },
    {
      key: 'id',
      header: <span className="sr-only">Actions</span>,
      // relative: keeps the absolutely placed sr-only label inside the table's scroll box (else the page scrolls sideways).
      className: 'relative w-14',
      render: rowMenu,
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  // Phone card (Style D list row): number and status, customer, then tier, planned and expiry beside the total.
  const mobileRow = (row: QuoteRow) => {
    const pastDue = isPastDue(row);
    return (
      // The quote-number button stretches over the whole card (after:inset-0); the checkbox and menu sit above it.
      <div className="relative flex flex-col gap-1.5 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          {canBulkAction && DELETABLE.includes(row.status) && (
            <label className="relative z-10 -ml-3 flex h-11 w-11 shrink-0 items-center justify-center">{checkboxCol.render?.(row)}</label>
          )}
          <button
            type="button"
            onClick={() => navigate(`/quotes/${row.id}`)}
            className="font-semibold text-crx-green text-left focus:outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-crx-green/30"
          >
            {row.quote_number}
          </button>
          <span className="ml-auto">{statusBadge(row)}</span>
          <span className="relative z-10 -mr-1.5">{rowMenu(row)}</span>
        </div>
        <span className="truncate text-[15px] font-medium text-nav-dark" title={customerName(row)}>{customerName(row)}</span>
        <span className="flex items-baseline justify-between gap-2 tabular-nums">
          <span className="min-w-0 text-[13px] text-secondary">
            Tier {row.tier}
            {row.is_planned && ' · Planned'}
            {row.expires_at && (
              <>
                {' · '}
                <span className={pastDue ? 'text-red-600 font-medium' : undefined}>
                  Expires {shortDate(parseLocalDate(row.expires_at), false)}{pastDue && ' (past due)'}
                </span>
              </>
            )}
          </span>
          <span className="shrink-0 text-base font-semibold text-nav-dark">{fmt(row.total_price)}</span>
        </span>
      </div>
    );
  };

  const showPrepaid = rolloverRows.some((b) => (b.prepay_remaining_cents ?? 0) > 0 || (b.prepay_earmarked_cents ?? 0) > 0);

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quotes"
        accent="& Bookings"
        subtitle="Build quotes, send them to growers and track booked product."
        actions={
          <>
            {canBulkAction && (
              <BulkActionBar
                selectedCount={selectedCount}
                actions={bulkActions}
                onDeselectAll={clearSelection}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon={<Upload className="w-4 h-4" />}
                onClick={() => setImportModalOpen(true)}
              >
                Import quotes
              </Button>
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
                New quote
              </Button>
            </div>
          </>
        }
      />

      <BulkQuoteImport
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchQuotes}
      />

      {canBulkAction && (
        <Card padding={false}>
          <section aria-labelledby="open-bookings-title">
            <div className="flex items-center justify-between gap-3 px-4 py-2 md:px-5">
              <div className="flex min-w-0 items-center gap-2">
                <h2 id="open-bookings-title" className="font-heading text-lg font-semibold text-nav-dark">Open bookings</h2>
                {/* The count is unknown until the panel's first read (it still loads on first expand). */}
                {rolloverLoaded && (
                  <span className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-crx-green-light px-1.5 text-xs font-semibold text-crx-green tabular-nums">
                    {rolloverRows.length}
                  </span>
                )}
                <HelpTip text="Every open booking (a sent or revised quote) with what was booked, what has been drawn and what is left. Use it at season end to see what is still outstanding. A Prepaid left column shows when a booking has prepayment set aside." />
              </div>
              <button
                type="button"
                onClick={toggleRollover}
                aria-expanded={showRollover}
                aria-controls="open-bookings-panel"
                aria-label={`${showRollover ? 'Hide' : 'Show'} open bookings`}
                className="inline-flex h-11 md:h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-secondary hover:bg-gray-50 hover:text-nav-dark transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-crx-green/30"
              >
                {showRollover ? 'Hide' : 'Show'}
                {showRollover ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
              </button>
            </div>
            {showRollover && (
              <div id="open-bookings-panel" className="border-t border-cream-dark">
                {rolloverLoading ? (
                  <div className="p-4 md:p-5"><SkeletonTable rows={3} /></div>
                ) : rolloverFailed ? (
                  <LoadFailedState title="The booking rollover could not be loaded" onRetry={loadRollover} />
                ) : rolloverRows.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-secondary md:px-5">No open bookings.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm tabular-nums">
                      <thead>
                        <tr className="text-left text-xs text-secondary">
                          <th scope="col" className="px-4 py-2.5 font-medium md:pl-5">Customer</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Booking</th>
                          <th scope="col" className="px-3 py-2.5 text-right font-medium">Booked</th>
                          <th scope="col" className="px-3 py-2.5 text-right font-medium">Drawn</th>
                          <th scope="col" className="px-3 py-2.5 text-right font-medium">Remaining</th>
                          {/* Prepaid column hidden while no booking has earmarked prepay: the
                              earmark engine is shelved (docs/roadmap/shelved-earmark-engine/),
                              so this is 0 for now and returns automatically when the engine ships. */}
                          {showPrepaid && <th scope="col" className="px-3 py-2.5 text-right font-medium">Prepaid left</th>}
                          <th scope="col" className="w-48 px-4 py-2.5 font-medium md:pr-5">Progress</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rolloverRows.map((b) => {
                          // Display only: the bar never changes a figure shown beside it.
                          const pct = b.booked_cents > 0 ? Math.min(100, Math.max(0, Math.round((b.drawn_cents / b.booked_cents) * 100))) : 0;
                          return (
                            <tr
                              key={b.quote_id}
                              className="border-t border-cream-dark hover:bg-crx-green-tint cursor-pointer"
                              onClick={() => navigate(`/quotes/${b.quote_id}`)}
                            >
                              <td className="px-4 py-3 font-medium md:pl-5"><span className="block max-w-56 truncate" title={b.customer_name || undefined}>{b.customer_name || '-'}</span></td>
                              <td className="px-3 py-3 font-medium text-crx-green whitespace-nowrap">{b.quote_number}</td>
                              <td className="px-3 py-3 text-right whitespace-nowrap">{fmt(b.booked_cents / 100)}</td>
                              <td className="px-3 py-3 text-right whitespace-nowrap">{fmt(b.drawn_cents / 100)}</td>
                              <td className="px-3 py-3 text-right font-semibold whitespace-nowrap">{fmt(b.remaining_cents / 100)}</td>
                              {showPrepaid && (
                                <td className="px-3 py-3 text-right text-crx-green whitespace-nowrap">{fmt(b.prepay_remaining_cents / 100)}</td>
                              )}
                              <td className="px-4 py-3 md:pr-5">
                                <div className="flex items-center gap-2.5">
                                  <div role="img" aria-label={`${pct} percent drawn`} className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-cream-dark">
                                    <div className="h-full rounded-full bg-crx-green" style={{ width: `${pct}%` }} />
                                  </div>
                                  <span className="w-9 text-right text-xs text-secondary">{pct}%</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        </Card>
      )}

      <Card padding={false} className="max-md:border-0 max-md:bg-transparent max-md:shadow-none">
        <section aria-label="All quotes" className="md:p-5">
          <DataTable<QuoteRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search by quote number, customer or product"
            searchKeys={SEARCH_KEYS}
            searchValue={search}
            onSearchChange={setSearch}
            onRowClick={(row) => navigate(`/quotes/${row.id}`)}
            mobileRow={mobileRow}
            emptyTitle={filtersActive || search ? 'No matching quotes' : 'No quotes yet'}
            emptyDescription={filtersActive || search
              ? 'Try a different search or clear the filters.'
              : 'Quotes are the first step. Build a quote, send it to your customer, then convert it to an order.'}
            emptyAction={filtersActive ? (
              <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>
            ) : search ? undefined : (
              <Button icon={<FileText className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
                Create your first quote
              </Button>
            )}
            loading={loading}
            loadError={loadFailed}
            onRetry={() => { setLoading(true); fetchQuotes(); }}
            filters={
              <div className="flex flex-wrap items-center gap-2">
                <Dropdown
                  inline
                  label="Status"
                  value={statusFilter || ALL}
                  onChange={(v) => setStatusFilter(v === ALL ? '' : v)}
                  options={STATUS_OPTIONS}
                />
                <button
                  type="button"
                  aria-label="Planned programs"
                  aria-pressed={plannedFilter}
                  onClick={() => setPlannedFilter(!plannedFilter)}
                  className={`inline-flex h-11 md:h-10 items-center gap-2 rounded-full px-3.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-crx-green/30 ${plannedFilter ? 'border border-crx-green bg-crx-green-light text-crx-green' : 'border border-dashed border-gray-300 bg-white text-nav-dark hover:bg-gray-50'}`}
                >
                  {plannedFilter ? <Check className="w-4 h-4" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />}
                  <span className="md:hidden">Planned</span>
                  <span className="hidden md:inline">Planned programs</span>
                </button>
                <HelpTip text="Planned quotes reserve inventory but aren't committed orders yet. Turn on Planned programs to see all of them." />
                {filtersActive && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="h-11 md:h-10 rounded-lg px-2 text-sm font-medium text-crx-green hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-crx-green/30"
                  >
                    Clear
                  </button>
                )}
                <span className="whitespace-nowrap text-[13px] text-secondary">
                  {shownCount} {shownCount === 1 ? 'quote' : 'quotes'}
                </span>
                {canBulkAction && hasSelectable && (
                  // Phones have no table header, so the select-all box sits here (md+ uses the header one).
                  <label className="inline-flex h-11 items-center gap-2 px-1 text-sm text-secondary md:hidden">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                    />
                    Select all
                  </label>
                )}
              </div>
            }
          />
        </section>
      </Card>

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="quote"
        onConfirm={handleDelete}
        loading={deleting}
      />

      <ConfirmModal
        open={!!convertTarget}
        onClose={closeConvert}
        onConfirm={handleConvertConfirm}
        title="Convert to order?"
        message={
          convertTarget
            ? [
                `Create a confirmed order from quote ${convertTarget.quote_number} for ${convertTarget.customer_name || 'this customer'}? This reserves inventory (holds → prebooked) and can't be undone from here.`,
                convertStaleMsg ? `Heads up: ${convertStaleMsg}` : '',
                convertDupMsg ? `Heads up: ${convertDupMsg}` : '',
              ].filter(Boolean).join('  ')
            : ''
        }
        confirmLabel={convertChecking ? 'Checking…' : (convertStaleMsg || convertDupMsg ? 'Convert anyway' : 'Convert to order')}
        variant={convertStaleMsg || convertDupMsg ? 'warning' : 'info'}
        icon={convertStaleMsg || convertDupMsg ? AlertTriangle : PackageCheck}
        loading={converting || convertChecking}
      />
    </div>
  );
}
