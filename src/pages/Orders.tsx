import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, Download, FileText, Trash2, Users, Truck, Printer, ClipboardList, PanelRightOpen } from 'lucide-react';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import BulkOrderImport from '../components/orders/BulkOrderImport';
import CustomerDrawer from '../components/customers/CustomerDrawer';
import { hasPageAccess } from '../lib/pagePermissions';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { fetchAllRows, fetchAllRowsForIds } from '../lib/pagedRead';
import { buildOrdersQuery, fetchOrdersPage, fetchAllMatchingOrders, isBookmarkRefused, type OrderListRow, type OrdersQuery } from '../lib/ordersPage';
import type { Json } from '../types/supabase';
import type { SortDir } from '../lib/tableSearchSort';
import { ORDER_ITEM_COLUMNS } from '../lib/costFields';
import { Sentry } from '../lib/sentry';
import { formatUSD as fmt, formatCents } from '../lib/money';
import { sumNeedByProduct } from '../lib/inventoryShortage';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { downloadBatchOrderSummaryPdf } from '../lib/orderSummaryPdf';
import { downloadBatchPickListPdf } from '../lib/orderPickListPdf';
import type { OrderSummaryData } from '../lib/orderSummaryPdf';
import type { PickListData } from '../lib/orderPickListPdf';
import { SkeletonTable } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import PageHeader from '../components/ui/PageHeader';
import type { Order } from '../types';
import { getSeasonDates } from '../utils/season';
import { toSentryError } from '../lib/sentryError';

type OrderWithFulfillment = OrderListRow;

const ORDERS_PAGE_SIZE = 50;
/** Page one has no bookmark: it reads from the top of the list. */
const FIRST_PAGE: (Json | null)[] = [null];

type NextBookmark = { key: string; page: number; cursor: Json | null };
/** The bookmark after the page on screen, only when it came from that same query and page. */
function nextBookmarkFor(next: NextBookmark | null, key: string, page: number): Json | null {
  return next && next.key === key && next.page === page ? next.cursor : null;
}

export default function Orders() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, deniedPages } = useAuth();
  // Customer 360 peek exposes AR balance + credit tier — gate it with the canonical
  // customers-page permission (blocks a rep who is denied /customers — Codex P2).
  const canPeekCustomer = hasPageAccess(role, deniedPages, 'customers');
  // One page of rows, read from the database with the search, filters and sort applied there.
  const [orders, setOrders] = useState<OrderWithFulfillment[]>([]);
  // Every matching order (count and summed totals), not just this page, for the query they were read for.
  // null = not known: never shown as 0.
  const [totalsState, setTotals] = useState<{ key: string; count: number; cents: number } | null>(null);
  // First read only: later reads keep the search box and filters on screen.
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  // The last list read failed: no rows, so it never reads as "No orders yet".
  const [loadFailed, setLoadFailed] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  // Ship-now/price-later (sell-side #2): filter unpriced rush orders.
  const [pricingFilter, setPricingFilter] = useState('');
  // U7 SAFE-SCOPE: filter orders complete_delivery queued for manual split billing.
  const [splitFilter, setSplitFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState<{ key: string | null; dir: SortDir }>({ key: null, dir: 'asc' });
  const [showImportModal, setShowImportModal] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [printingSummary, setPrintingSummary] = useState(false);
  const [printingPickList, setPrintingPickList] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  // Customer 360 peek drawer (F2) — view a customer's numbers without leaving the list.
  const [drawerCustomer, setDrawerCustomer] = useState<{ id: string; name: string } | null>(null);

  const canBulkAction = role === 'admin' || role === 'sales_rep';

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo<OrdersQuery>(() => buildOrdersQuery(getSeasonDates(), {
    search: debouncedSearch, status: statusFilter, plan: planFilter, pricing: pricingFilter, split: splitFilter,
    sortKey: sort.key, sortDir: sort.dir,
  }), [debouncedSearch, statusFilter, planFilter, pricingFilter, splitFilter, sort]);
  const queryKey = JSON.stringify(query);
  const listBusy = isListBusy(pageLoading, search, debouncedSearch);

  // Each page is read from the bookmark (the last row) of the page before it, so orders removed in
  // between never push one past the screen. afters[i] is page i's bookmark; the last one is on screen.
  // The pages belong to one query: a new search, filter or sort starts again at page one.
  const [pageState, setPageState] = useState({ key: queryKey, afters: FIRST_PAGE });
  const afters = forQuery(pageState, queryKey)?.afters ?? FIRST_PAGE;
  const page = afters.length - 1;
  const after = afters[page];
  // The bookmark after the page on screen, from its own read; null on the last page.
  const [nextState, setNextState] = useState<NextBookmark | null>(null);
  const nextCursor = nextBookmarkFor(nextState, queryKey, page);
  const goNext = () => {
    if (nextCursor !== null) setPageState({ key: queryKey, afters: [...afters, nextCursor] });
  };
  const goPrevious = () => setPageState({ key: queryKey, afters: afters.slice(0, -1) });

  // "Select all" across every page: the rows read for this exact query, or null.
  const [allMatchingState, setAllMatchingState] = useState<{ key: string; rows: OrderWithFulfillment[] } | null>(null);
  const allMatching = forQuery(allMatchingState, queryKey)?.rows ?? null;

  const { selected, toggleSelect, toggleAll, clearSelection, selectedRows, allSelected } =
    useRowSelection({ data: orders, getId: (o) => o.id });

  // Bumped by every deselect and every list read: a "select all" read that finishes later is dropped.
  const selectAllSeq = useRef(0);
  // Mason, 2026-11-06: any list refresh or page turn clears the selection (ticked rows and
  // "select all"), so a bulk action only ever acts on the list the user is looking at.
  const clearBulkSelection = useCallback(() => {
    selectAllSeq.current += 1;
    setAllMatchingState(null);
    setSelectingAll(false);
    clearSelection();
  }, [clearSelection]);

  // A read can finish after a newer one started (a new page, a refresh after a
  // bulk action); only the latest request may set the list, toasts or loading.
  const fetchSeq = useRef(0);
  const fetchOrders = useCallback(async () => {
    const seq = ++fetchSeq.current;
    clearBulkSelection();
    setPageLoading(true);
    const { data, error } = await fetchOrdersPage(query, ORDERS_PAGE_SIZE, 0, after);
    if (seq !== fetchSeq.current) return;
    // Rows ticked against the old list while this read ran do not carry over to the new one.
    clearBulkSelection();
    setNextState(null);
    if (error && page > 0 && isBookmarkRefused(error.message)) {
      // The bookmark no longer fits this list: start again at page one rather than show an error.
      setPageState({ key: queryKey, afters: FIRST_PAGE });
      return;
    } else if (error || !data) {
      // A failed read shows "could not be loaded" and no totals: an older page would
      // look current, and an empty one would read as "No orders yet".
      Sentry.captureException(new Error(error?.message ?? 'orders page read failed'), { tags: { source: 'fetch', action: 'load_orders' } });
      toast('error', 'Failed to load orders. Please try again.');
      setOrders([]);
      setTotals(null);
      setLoadFailed(true);
    } else if (data.rows.length === 0 && page > 0) {
      // Every order after the bookmark was removed: step back to the page before.
      setPageState({ key: queryKey, afters: afters.slice(0, -1) });
      return;
    } else {
      setOrders(data.rows);
      setNextState({ key: queryKey, page, cursor: data.next_cursor });
      setTotals({ key: queryKey, count: data.total_count, cents: data.total_price_cents });
      setLoadFailed(false);
    }
    setLoading(false);
    setPageLoading(false);
  }, [query, queryKey, afters, page, after, toast, clearBulkSelection]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // The rows the bulk actions act on: every matching order after "select all", else the ticked rows.
  const bulkRows = allMatching ?? selectedRows;
  const bulkCount = bulkRows.length;
  const allMatchingIds = useMemo(() => (allMatching ? new Set(allMatching.map((o) => o.id)) : null), [allMatching]);

  const toggleRow = useCallback((id: string) => {
    if (!allMatching) {
      toggleSelect(id);
      return;
    }
    // Unticking (or re-ticking) one row keeps the rest of "every matching order" selected.
    const row = orders.find((o) => o.id === id);
    setAllMatchingState({
      key: queryKey,
      rows: allMatching.some((o) => o.id === id) ? allMatching.filter((o) => o.id !== id) : row ? [...allMatching, row] : allMatching,
    });
  }, [allMatching, orders, queryKey, toggleSelect]);

  // Typing a search drops the selection at once, not 300 ms later when the query catches up.
  useEffect(() => {
    clearBulkSelection();
  }, [search, clearBulkSelection]);

  const checkboxCol = useMemo(
    () => createCheckboxColumn<OrderWithFulfillment>(allMatchingIds ?? selected, toggleRow, (o) => o.id),
    [allMatchingIds, selected, toggleRow]
  );

  // A new search or filter hides the old totals until its own read lands: they never describe another query.
  const totals = forQuery(totalsState, queryKey);
  const { moreThanThisPage, everythingSelected } = selectionScope(totals, orders.length, allMatching, allSelected);

  const handleSelectAll = async () => {
    if (everythingSelected) {
      clearBulkSelection();
      return;
    }
    // The rows on screen may still be the previous query's until its own read lands.
    if (!totals) return;
    if (!moreThanThisPage) {
      toggleAll();
      return;
    }
    // Every matching order, read page by page; a list that changed mid-read is an error, not a short list.
    const key = queryKey;
    const seq = ++selectAllSeq.current;
    setSelectingAll(true);
    const { data, error } = await fetchAllMatchingOrders(query);
    // A newer read or deselect already cleared the button; this old read changes nothing.
    if (seq !== selectAllSeq.current) return;
    setSelectingAll(false);
    if (error || !data) {
      toast('error', 'Could not select every matching order. Please try again.');
      return;
    }
    setAllMatchingState({ key, rows: data });
  };

  const handleExportCSV = () => {
    exportToCSV(bulkRows as unknown as Record<string, unknown>[], [
      { key: 'order_number', header: 'Order #' },
      { key: 'customer', header: 'Customer', format: (v) => (v as { farm_name: string })?.farm_name || '' },
      { key: 'status', header: 'Status' },
      { key: 'total_price', header: 'Total', format: (v) => fmtCSV(v) },
      { key: 'order_date', header: 'Order Date', format: (v) => fmtDateCSV(v) },
      { key: 'fulfillment_pct', header: 'Fulfillment %', format: (v) => `${v}%` },
      { key: 'invoiced_pct', header: 'Invoiced %', format: (v) => v == null ? 'Unavailable' : `${v}%` },
    ], 'orders');
    toast('success', `Exported ${bulkRows.length} order(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfData = bulkRows.map((o) => ({
        ...o,
        customer_name: (o.customer as unknown as { farm_name: string })?.farm_name || '',
      }));
      await downloadReportPdf({
        title: 'Orders',
        subtitle: `${bulkRows.length} order(s) selected`,
        columns: [
          { header: 'Order #', key: 'order_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Status', key: 'status' },
          { header: 'Total', key: 'total_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
          { header: 'Date', key: 'order_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
          { header: 'Fulfillment', key: 'fulfillment_pct', align: 'right', format: (v) => `${v}%` },
          { header: 'Invoiced', key: 'invoiced_pct', align: 'right', format: (v) => v == null ? 'Unavailable' : `${v}%` },
        ],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${bulkRows.length} order(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleBulkPrintSummaries = async () => {
    setPrintingSummary(true);
    try {
      const orderIds = bulkRows.map((o) => o.id);
      const customerIds = [...new Set(bulkRows.map((o) => o.customer_id))];

      // A selection can be the whole list, so read every row in id chunks.
      const [itemsRes, customersRes] = await Promise.all([
        fetchAllRowsForIds(orderIds, (idChunk, from, to) => supabase
          .from('order_items').select(ORDER_ITEM_COLUMNS, { count: 'exact' }).in('order_id', idChunk)
          .order('sort_order').order('id').range(from, to)),
        fetchAllRowsForIds(customerIds, (idChunk, from, to) => supabase
          .from('customers').select('*', { count: 'exact' }).in('id', idChunk)
          .order('id').range(from, to)),
      ]);
      // A failed read must not print an order with no lines.
      if (itemsRes.error) throw itemsRes.error;
      if (customersRes.error) throw customersRes.error;

      const customerMap: Record<string, { farm_name: string; contact_name: string | null; phone: string | null; billing_address: string | null }> = {};
      for (const c of customersRes.data || []) {
        customerMap[c.id] = { farm_name: c.farm_name, contact_name: c.contact_name, phone: c.phone, billing_address: c.billing_address };
      }

      const allItems = itemsRes.data || [];
      const itemsByOrder: Record<string, typeof allItems> = {};
      for (const item of allItems) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }

      const dataList: OrderSummaryData[] = bulkRows.map((o) => {
        const cust = customerMap[o.customer_id] || { farm_name: '', contact_name: null, phone: null, billing_address: null };
        const orderItems = itemsByOrder[o.id] || [];
        return {
          order_number: o.order_number,
          order_name: o.order_name,
          order_date: o.order_date,
          status: o.status,
          customer_po_number: o.customer_po_number,
          farm_name: cust.farm_name,
          contact_name: cust.contact_name,
          phone: cust.phone,
          billing_address: cust.billing_address,
          items: orderItems.map((it: Record<string, unknown>) => ({
            product_name: it.product_name as string,
            quantity: Number(it.total_units_needed),
            unit_size: (it.unit_size as string | null),
            price_per_unit: Number(it.price_per_unit),
            extended_price: Number(it.total_price),
          })),
          total_price: o.total_price,
          notes: o.notes,
        };
      });

      await downloadBatchOrderSummaryPdf(dataList);
      toast('success', `Downloaded ${dataList.length} order summary PDF(s)`);
    } catch (err: unknown) {
      Sentry.captureException(toSentryError(err), { extra: { context: 'bulk_print_summaries' } });
      toast('error', sanitizeError(err));
    }
    setPrintingSummary(false);
  };

  const handleBulkPrintPickLists = async () => {
    setPrintingPickList(true);
    try {
      const orderIds = bulkRows.map((o) => o.id);
      const customerIds = [...new Set(bulkRows.map((o) => o.customer_id))];

      // A selection can be the whole list, and inventory is a whole-table read, so
      // read every row (id lists in chunks) rather than stopping at the row cap.
      const [itemsRes, customersRes, addrRes, invRes] = await Promise.all([
        fetchAllRowsForIds(orderIds, (idChunk, from, to) => supabase
          .from('order_items').select(ORDER_ITEM_COLUMNS, { count: 'exact' }).in('order_id', idChunk)
          .order('sort_order').order('id').range(from, to)),
        fetchAllRowsForIds(customerIds, (idChunk, from, to) => supabase
          .from('customers').select('*', { count: 'exact' }).in('id', idChunk)
          .order('id').range(from, to)),
        fetchAllRowsForIds(customerIds, (idChunk, from, to) => supabase
          .from('customer_addresses').select('*', { count: 'exact' }).in('customer_id', idChunk)
          .order('is_default', { ascending: false }).order('id').range(from, to)),
        fetchAllRows((from, to) => supabase
          .from('inventory').select('id, product_id, quantity_available, quantity_prebooked', { count: 'exact' })
          .order('id').range(from, to)),
      ]);
      // A failed read must not print a pick list with missing lines or shortage flags.
      for (const res of [itemsRes, customersRes, addrRes, invRes]) {
        if (res.error) throw res.error;
      }

      const customerMap: Record<string, { farm_name: string; contact_name: string | null; phone: string | null; billing_address: string | null }> = {};
      for (const c of customersRes.data || []) {
        customerMap[c.id] = { farm_name: c.farm_name, contact_name: c.contact_name, phone: c.phone, billing_address: c.billing_address };
      }

      // Group addresses by customer
      const addrByCustomer: Record<string, string[]> = {};
      for (const a of addrRes.data || []) {
        const cid = a.customer_id as string;
        if (!addrByCustomer[cid]) addrByCustomer[cid] = [];
        const parts = [a.label, a.address_line, a.city, a.state, a.zip].filter(Boolean);
        const formatted = parts.join(', ');
        if (formatted) addrByCustomer[cid].push(formatted);
      }

      // Build inventory map
      const invMap: Record<string, { available: number; prebooked: number }> = {};
      for (const row of invRes.data || []) {
        const pid = row.product_id as string;
        if (!invMap[pid]) invMap[pid] = { available: 0, prebooked: 0 };
        invMap[pid].available += Number(row.quantity_available);
        invMap[pid].prebooked += Number(row.quantity_prebooked);
      }

      const allItems = itemsRes.data || [];
      const itemsByOrder: Record<string, typeof allItems> = {};
      for (const item of allItems) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }

      const dataList: PickListData[] = bulkRows.map((o) => {
        const cust = customerMap[o.customer_id] || { farm_name: '', contact_name: null, phone: null, billing_address: null };
        const orderItems = itemsByOrder[o.id] || [];
        // Flag the shortage against the product's TOTAL remaining on this order.
        // A tier-split booking puts the same product on several lines, and
        // comparing each line alone against the full net-free stock lets two
        // half-sized tier lines both look covered when together they are not.
        // See src/lib/inventoryShortage.ts.
        const remainingByProduct: Record<string, number> = {};
        for (const need of sumNeedByProduct(
          (orderItems as Array<Record<string, unknown>>).map((it) => ({
            productId: it.product_id as string,
            label: (it.product_name as string) || '',
            quantity: Number(it.quantity_remaining),
          }))
        )) {
          remainingByProduct[need.productId] = need.quantity;
        }
        let addresses = addrByCustomer[o.customer_id] || [];
        if (addresses.length === 0 && cust.billing_address) {
          addresses = [cust.billing_address];
        }
        return {
          order_number: o.order_number,
          order_name: o.order_name,
          order_date: o.order_date,
          farm_name: cust.farm_name,
          contact_name: cust.contact_name,
          phone: cust.phone,
          delivery_addresses: addresses,
          items: orderItems.map((it: Record<string, unknown>) => {
            const pid = it.product_id as string;
            const inv = invMap[pid];
            const netFree = inv ? inv.available - inv.prebooked : null;
            const remaining = Number(it.quantity_remaining);
            return {
              product_name: it.product_name as string,
              unit_size: (it.unit_size as string | null),
              total_units_needed: Number(it.total_units_needed),
              quantity_delivered: Number(it.quantity_delivered),
              quantity_remaining: remaining,
              inventory_available: netFree,
              has_shortage: netFree !== null ? (remainingByProduct[pid] ?? remaining) > netFree : false,
            };
          }),
          notes: o.notes,
          program_notes: o.program_notes,
        };
      });

      await downloadBatchPickListPdf(dataList);
      toast('success', `Downloaded ${dataList.length} pick list PDF(s)`);
    } catch (err: unknown) {
      Sentry.captureException(toSentryError(err), { extra: { context: 'bulk_print_pick_lists' } });
      toast('error', sanitizeError(err));
    }
    setPrintingPickList(false);
  };

  const handleBulkDelete = async () => {
    const activeOrders = bulkRows.filter(
      (order) => order.status !== 'cancelled' && order.status !== 'voided'
    );
    if (activeOrders.length > 0) {
      toast(
        'error',
        `${activeOrders.length} selected order(s) are still active. Cancel or void them first, then delete them.`
      );
      setDeleteModalOpen(false);
      return;
    }

    await runCriticalAction({
      action: async () => {
        const ids = bulkRows.map((o) => o.id);
        const result = await supabase.from('orders').update({ deleted_at: new Date().toISOString() }).in('id', ids).select('id');
        if (result.error?.message.includes('ORDER_MUST_BE_TERMINAL_BEFORE_DELETE')) {
          throw new Error(
            'An order became active before deletion. Refresh the list, then cancel or void it first.'
          );
        }
        checkMutationResult(result, 'Soft-delete orders');
      },
      toast,
      setLoading: setDeleting,
      successMessage: `Deleted ${bulkRows.length} order(s)`,
      sentryTag: 'bulk_delete_orders',
      onSuccess: () => {
        clearBulkSelection();
        fetchOrders();
        setDeleteModalOpen(false);
      },
    });
  };

  const openBulkDelete = () => {
    const activeOrders = bulkRows.filter(
      (order) => order.status !== 'cancelled' && order.status !== 'voided'
    );
    if (activeOrders.length > 0) {
      toast(
        'error',
        `${activeOrders.length} selected order(s) are still active. Cancel or void them first, then delete them.`
      );
      return;
    }
    setDeleteModalOpen(true);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'print-summary', label: 'Print Summaries', icon: <Printer className="w-4 h-4" />, onClick: handleBulkPrintSummaries, loading: printingSummary },
    { key: 'print-picklist', label: 'Print Pick Lists', icon: <ClipboardList className="w-4 h-4" />, onClick: handleBulkPrintPickLists, loading: printingPickList },
    { key: 'delete', label: 'Delete', icon: <Trash2 className="w-4 h-4" />, onClick: openBulkDelete, variant: 'danger' as const },
  ];

  const dataColumns: Column<OrderWithFulfillment>[] = [
    {
      key: 'order_number',
      header: 'Order #',
      sortable: true,
      render: (row) => (
        <div>
          <span className="font-medium text-nav-dark">{row.order_number}</span>
          {row.order_name && (
            <p className="text-xs text-secondary mt-0.5">{row.order_name}</p>
          )}
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => {
        const name = (row.customer as unknown as { farm_name: string })?.farm_name || '-';
        return (
          <div>
            <div className="flex items-center gap-1.5">
              <span>{name}</span>
              {row.customer_id && canPeekCustomer && (
                <button
                  onClick={(e) => { e.stopPropagation(); setDrawerCustomer({ id: row.customer_id, name }); }}
                  title="Peek customer"
                  aria-label={`Peek ${name}`}
                  className="p-0.5 rounded text-gray-300 hover:text-crx-green hover:bg-crx-green-light transition-colors"
                >
                  <PanelRightOpen className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {row.farm_group_name && (
              <div className="flex items-center gap-1 mt-0.5">
                <Users className="w-3 h-3 text-blue-500 shrink-0" />
                <span className="text-xs text-blue-600">{row.farm_group_name}</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
            {row.status.replace(/_/g, ' ')}
          </Badge>
          {row.is_planned && (
            <Badge variant="warning">Planned</Badge>
          )}
          {row.needs_split_billing && (
            <span title="Delivered with field/acre allocations — auto-invoice was skipped; create split invoices from the order.">
              <Badge variant="warning">Needs Split Billing</Badge>
            </span>
          )}
          {row.active_delivery_count > 0 && row.earliest_delivery_date && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
              <Truck className="w-3 h-3" />
              {row.active_delivery_count > 1
                ? `${row.active_delivery_count} Deliveries`
                : new Date(row.earliest_delivery_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'total_price',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_price)}</span>,
    },
    {
      key: 'customer_po_number',
      header: 'Customer PO#',
      render: (row) => (row as Order & { customer_po_number?: string }).customer_po_number || '-',
    },
    {
      key: 'order_date',
      header: 'Order Date',
      sortable: true,
      render: (row) => new Date(row.order_date + 'T00:00:00').toLocaleDateString(),
    },
    {
      key: 'fulfillment_pct',
      header: 'Fulfillment',
      headerExtra: <HelpTip text="Fulfillment shows delivery progress. Invoiced shows billing progress. Both are weighted by dollar value." className="ml-1" />,
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-crx-green rounded-full transition-all"
              style={{ width: `${row.fulfillment_pct}%` }}
            />
          </div>
          <span className="text-xs text-secondary">{row.fulfillment_pct}%</span>
        </div>
      ),
    },
    {
      key: 'invoiced_pct',
      header: 'Invoiced',
      sortable: true,
      render: (row) => row.invoiced_pct == null ? (
        <span className="text-xs text-secondary">Unavailable</span>
      ) : (
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${row.invoiced_pct}%` }}
            />
          </div>
          <span className="text-xs text-secondary">{row.invoiced_pct}%</span>
        </div>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orders"
        actions={
          <>
            {canBulkAction && (
              <BulkActionBar selectedCount={bulkCount} actions={bulkActions} onDeselectAll={clearBulkSelection} />
            )}
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setShowImportModal(true)}>
                <Upload className="w-4 h-4" />
                Import Orders
              </Button>
              <Button onClick={() => navigate('/orders/new')}>
                <Plus className="w-4 h-4" />
                New Order
              </Button>
            </div>
          </>
        }
      />

      <Card padding={false}>
        <div className="p-5">
          <DataTable<OrderWithFulfillment>
            data={orders}
            columns={columns}
            searchable
            searchPlaceholder="Search orders or products…"
            // The database searches order number, customer, farm group and products, sorts and pages.
            serverSide
            searchValue={search}
            onSearchChange={setSearch}
            sortState={sort}
            onSortChange={setSort}
            onRowClick={(row) => navigate(`/orders/${row.id}`)}
            emptyTitle="No orders yet"
            emptyDescription="Start by creating a quote in Sales → Quotes, then convert it to an order. Or create a direct order below."
            emptyAction={
              <div className="flex gap-2">
                <Button variant="secondary" icon={<FileText className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
                  New Quote
                </Button>
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/orders/new')}>
                  New Order
                </Button>
              </div>
            }
            loading={listBusy}
            loadError={loadFailed}
            onRetry={fetchOrders}
            filters={
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by order status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="partially_fulfilled">Partially Fulfilled</option>
                  <option value="fulfilled">Fulfilled</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="voided">Voided</option>
                </select>
                <select
                  value={planFilter}
                  onChange={(e) => setPlanFilter(e.target.value)}
                  aria-label="Filter by planned or committed"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Orders</option>
                  <option value="planned">Planned Only</option>
                  <option value="committed">Committed Only</option>
                </select>
                <select
                  value={pricingFilter}
                  onChange={(e) => setPricingFilter(e.target.value)}
                  aria-label="Filter by pricing status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Pricing</option>
                  <option value="needs_pricing">Needs Pricing</option>
                  <option value="priced">Priced</option>
                </select>
                <select
                  value={splitFilter}
                  onChange={(e) => setSplitFilter(e.target.value)}
                  aria-label="Filter by split billing status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Orders</option>
                  <option value="needs_split">Needs Split Billing</option>
                </select>
                {canBulkAction && orders.length > 0 && (
                  <button
                    onClick={handleSelectAll}
                    disabled={isListBusy(pageLoading, search, debouncedSearch, selectingAll)}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors disabled:opacity-50"
                  >
                    {selectAllLabel(selectingAll, everythingSelected, moreThanThisPage ? totals : null)}
                  </button>
                )}
              </>
            }
          />
          {totals && !loadFailed && (
            <OrdersPager totals={totals} page={page} rowsShown={orders.length} busy={listBusy} hasNext={nextCursor !== null} onPrevious={goPrevious} onNext={goNext} />
          )}
        </div>
      </Card>

      <BulkOrderImport
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={() => {
          setShowImportModal(false);
          fetchOrders();
        }}
        onPartialSuccess={fetchOrders}
      />

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={bulkCount}
        entityName="order"
        onConfirm={handleBulkDelete}
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

/** "Showing 1–B of N orders" (later pages: "Page P · B shown of N orders") · $X total, with Previous/Next; N and $X cover every matching order. */
function OrdersPager({ totals, page, rowsShown, busy, hasNext, onPrevious, onNext }: {
  totals: { count: number; cents: number };
  page: number;
  rowsShown: number;
  busy: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (totals.count === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3" aria-label="Orders pages">
      <span className="text-sm text-secondary">
        {/* Past page one the exact row numbers are unknown: a page starts after the last row seen, and orders removed before it change the numbering. */}
        {page === 0 ? `Showing 1–${rowsShown.toLocaleString()}` : `Page ${page + 1} · ${rowsShown.toLocaleString()} shown`} of {totals.count.toLocaleString()} orders · {formatCents(totals.cents)} total
      </span>
      {(totals.count > ORDERS_PAGE_SIZE || page > 0) && (
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onPrevious} disabled={page === 0 || busy}>
            Previous
          </Button>
          <Button variant="secondary" size="sm" onClick={onNext} disabled={!hasNext || busy}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

/** Rows on screen are stale while a read runs or a typed search waits out its 300 ms debounce; Select All also waits for its own read. */
function isListBusy(pageLoading: boolean, search: string, debouncedSearch: string, selectingAll = false): boolean {
  return pageLoading || selectingAll || search.trim() !== debouncedSearch;
}

/** State saved for one query (page, totals, "select all"), or null once the query has changed. */
function forQuery<T extends { key: string }>(state: T | null, key: string): T | null {
  return state !== null && state.key === key ? state : null;
}

function selectAllLabel(selecting: boolean, everythingSelected: boolean, moreThanThisPage: { count: number } | null): string {
  if (selecting) return 'Selecting…';
  if (everythingSelected) return 'Deselect All';
  return moreThanThisPage ? `Select All ${moreThanThisPage.count.toLocaleString()}` : 'Select All';
}

/** Whether more orders match than this page shows, and whether every matching order is already selected. */
function selectionScope(totals: { count: number } | null, rowsShown: number, allMatching: unknown[] | null, pageAllSelected: boolean) {
  const moreThanThisPage = totals !== null && totals.count > rowsShown;
  // After "select all", unticking rows brings the "Select All" button back.
  const allMatchingSelected = allMatching !== null && totals !== null && allMatching.length >= totals.count;
  return { moreThanThisPage, everythingSelected: allMatchingSelected || (pageAllSelected && !moreThanThisPage) };
}
