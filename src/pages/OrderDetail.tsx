/**
 * OrderDetail.tsx — View and edit orders after creation
 * GAP FIX #13: Edit Orders After Creation
 * AR derived from linked invoices (single source of truth).
 */
import { Fragment, useEffect, useState , useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button as RACButton, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { Truck, Pencil, Save, X, Trash2, FileText, Plus, AlertTriangle, MessageSquarePlus, Printer, ClipboardList, DollarSign, ChevronDown, ChevronRight } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import RecordVersionConflictDialog from '../components/ui/RecordVersionConflictDialog';
import { readRowVersion } from '../lib/recordVersionConcurrency';
import { readOrderEditSnapshot } from '../lib/orderEditSnapshot';
import Input from '../components/ui/Input';
import { LoadFailedState } from '../components/ui/EmptyState';
import CustomerSearchPicker from '../components/customers/CustomerSearchPicker';
import LineBillSplit, { type LineShare } from '../components/orders/LineBillSplit';
import WhoPaysCard from '../components/orders/WhoPaysCard';
import SaleMoneySummary from '../components/orders/SaleMoneySummary';
import SaleInvoicesCard from '../components/orders/SaleInvoicesCard';
import ActionMenu from '../components/ui/ActionMenu';
import Switch from '../components/ui/Switch';
import { statusLabel } from '../lib/statusLabel';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { generateIdempotencyKey, getIdempotencyBindingRejection } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import { fetchAllRows, fetchAllRowsForIds, pageWithList } from '../lib/pagedRead';
import { notifyOrderStatusChange } from '../lib/notificationTriggers';
import { supabase, checkMutationResult, sanitizeError, assertRpcResult, hasRpcCode, RpcErrorCodes, describePostInvoiceBlock } from '../lib/db';
import { Sentry } from '../lib/sentry';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { runCriticalAction } from '../lib/criticalAction';
import { parseLocalDate } from '../lib/dateUtils';
import { formatUSD as fmt } from '../lib/money';
import { exactRound2 } from '../lib/quoteCalc';
import { isBelowCostApprovalHandledError, withBelowCostReason } from '../lib/belowCostApproval';
import QuickTaskModal from '../components/team/QuickTaskModal';
import HelpTip from '../components/ui/HelpTip';
import RelatedNotes from '../components/team/RelatedNotes';
import TransactionThread from '../components/ui/TransactionThread';
import { downloadOrderSummaryPdf } from '../lib/orderSummaryPdf';
import { downloadPickListPdf } from '../lib/orderPickListPdf';
import { sumNeedByProduct } from '../lib/inventoryShortage';
import { buildInvoicePostTargets } from '../lib/invoiceBatchPosting';
import { postInvoiceTarget } from '../lib/invoicePostVersion';
import type { OrderSummaryData } from '../lib/orderSummaryPdf';
import type { PickListData } from '../lib/orderPickListPdf';
import { validateInventoryPositionShape } from '../lib/inventoryPositionValidator';
import { inventoryPositionByProduct } from '../lib/inventoryPositionLookup';
import { activeInvoiceCoversOrder } from '../lib/deliveryInvoiceCoverage';
import { billSplitLock, canEditBillSplit, cardLiveCents, sharesLeft, sharesOverHundred } from '../lib/billSplitLock';
import { ProductOptionDetails } from '../components/products/ProductOptionPresentation';
import { INVOICE_COLUMNS, INVOICE_POST_VERSION_COLUMNS, INVOICES_POSTABLE, PRODUCT_COLUMNS, withAdminCosts } from '../lib/costFields';
import type { Order, OrderItem, OrderShare, OrderItemFieldAllocation, Customer, Invoice, Delivery, Product, LinkedEntityType, InventoryPositionRow } from '../types';

/** Temporary new item (not yet saved to DB — has no real id) */
interface NewOrderItem {
  _tempKey: string;
  product_id: string;
  product_name: string;
  price_per_unit: number;
  cost_per_unit: number;
  total_units_needed: number;
  unit_size: string | null;
  section_name: string | null;
}

let _editKeyCounter = 0;
function nextEditKey() { return `_new_${++_editKeyCounter}`; }

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const updateOrderIdem = useIdempotencyKey('update_order_items', profile?.id || '', id ?? '');
  const voidOrderIdem = useIdempotencyKey('void_order', profile?.id || '');
  // F1: scoped by order id. This component does NOT remount when the route id
  // changes (App.tsx renders it without a key, the effects are keyed on [id], and
  // activeOrderIdRef exists precisely to guard the stale in-flight fetch), so the
  // hook's key map survives an order-to-order navigation. These actions no
  // longer retire their key on click, so without the scope an ambiguous result on
  // order A could replay A's receipt after the user navigated to order B —
  // reporting B cancelled without cancelling it, or opening A's invoice. Scoping
  // keeps retry-under-the-same-key for the SAME order while minting a fresh key
  // per order.
  const cancelOrderIdem = useIdempotencyKey('cancel_order', profile?.id || '', id ?? '');
  const priceOrderIdem = useIdempotencyKey('price_order', profile?.id || '');
  // Keyed per order and value: a retry of "on" never replays an "off".
  const salesTaxIdem = useIdempotencyKey('set_order_sales_tax', profile?.id || '');
  // Keep retries scoped to the order, as for cancellation.
  const splitInvoiceIdem = useIdempotencyKey('create_split_invoices_from_order', profile?.id || '', id ?? '');
  // Latest order id the route is showing — older in-flight fetches bail (M6 stale guard).
  const activeOrderIdRef = useRef<string | undefined>(undefined);
  const fetchSeqRef = useRef(0);
  // Per-target idempotency keys for "post all drafts" (M7) — keyed by standalone
  // invoice or split group so a network retry reuses the server dedup boundary.
  const postDraftKeysRef = useRef<Record<string, string>>({});
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [deliveries, setDeliveries] = useState<(Delivery & { driver_name?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);
  // Display only: the sale's salesperson and the sales tax rate from Settings. A failed read leaves them out.
  const [salesmanName, setSalesmanName] = useState<string | null>(null);
  const [salesTaxRate, setSalesTaxRate] = useState<string | null>(null);

  // Parent quote for transaction thread
  const [parentQuote, setParentQuote] = useState<{ id: string; quote_number: string } | null>(null);

  // Shares state
  const [shares, setShares] = useState<OrderShare[]>([]);
  const [newShareCustomerId, setNewShareCustomerId] = useState('');
  // Farm name of the customer picked for a new share (the picker searches; no list is loaded).
  const [newShareCustomerName, setNewShareCustomerName] = useState('');
  const [savingShares, setSavingShares] = useState(false);

  // Field/acre split state (multi-field split invoicing — entered on the order, billed by acres).
  type AllocField = { id: string; field_name: string; total_acres: number | null; customer_id: string; owners: { customer_id: string; split_pct: number }[] };
  const [lineShares, setLineShares] = useState<LineShare[]>([]);
  const [allocations, setAllocations] = useState<OrderItemFieldAllocation[]>([]);
  const [allocFields, setAllocFields] = useState<AllocField[]>([]);
  const [custNames, setCustNames] = useState<Record<string, string>>({});
  const [allocLoadFailed, setAllocLoadFailed] = useState(false);
  const [allocEditorItemId, setAllocEditorItemId] = useState<string | null>(null);
  const [newAllocFieldId, setNewAllocFieldId] = useState('');
  const [newAllocAcres, setNewAllocAcres] = useState('');
  const [savingAlloc, setSavingAlloc] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  useEffect(() => { editingRef.current = editing; }, [editing]);
  const [editRowVersion, setEditRowVersion] = useState<number | null>(null);
  const [orderConflict, setOrderConflict] = useState(false);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [editItems, setEditItems] = useState<OrderItem[]>([]);
  // The last fully loaded draft and its version. Cancel restores it at once, so re-entering
  // edit mode before the follow-up reload lands never shows (or saves) the discarded edits.
  const loadedDraftRef = useRef<{ items: OrderItem[]; rowVersion: number | null }>({ items: [], rowVersion: null });
  const [newItems, setNewItems] = useState<NewOrderItem[]>([]);
  const [saving, setSaving] = useState(false);

  // Add-product modal state
  const [products, setProducts] = useState<Product[]>([]);
  // A failed catalog read empties the list and blocks adding products (never a short list).
  const [productsLoadFailed, setProductsLoadFailed] = useState(false);
  // True while a catalog read is in flight: the add-product picker offers nothing until it lands,
  // so no product is ever picked from an older list (Luna, #1017).
  const [productsLoading, setProductsLoading] = useState(false);
  const [showProductModal, setShowProductModal] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [inventoryByProduct, setInventoryByProduct] = useState<Record<string, { available: number; prebooked: number; onOrder: number }>>({});

  // Create invoice
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  // Status change
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string>('');

  // Void order (fulfilled → voided, admin-only)
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // Planned/Committed toggle
  const [togglingPlanned, setTogglingPlanned] = useState(false);
  const [savingSalesTax, setSavingSalesTax] = useState(false);

  // Print state
  const [printingSummary, setPrintingSummary] = useState(false);
  const [printingPickList, setPrintingPickList] = useState(false);

  // Ship-now/price-later (#2): per-line price inputs for a needs_pricing order.
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [pricingOrder, setPricingOrder] = useState(false);
  // #4 billing cockpit: post-all-drafts action.
  const [postingAll, setPostingAll] = useState(false);
  // An admin whose line costs failed to load must not edit lines: the edit would start from
  // cost-less rows (Luna round 2). Cleared by the next successful load.
  const [itemCostsFailed, setItemCostsFailed] = useState(false);

  const isAdmin = role === 'admin';
  // Draw-created orders (booking_draw) mirror their booking's draw ledger —
  // items are locked server-side (BOOKING_DRAW_ORDER_LOCKED); void/cancel the
  // order to return quantity to the booking, then draw again.
  const canEdit = (role === 'admin' || role === 'sales_rep') && order?.status !== 'fulfilled' && order?.status !== 'cancelled' && order?.status !== 'partially_fulfilled' && !order?.booking_draw && !itemCostsFailed;

  const fetchOrder = useCallback(async (reloadDraft = false): Promise<boolean> => {
    // Stale-route guard (M6): on rapid order-to-order navigation an older in-flight
    // fetch must not render the previous order's items/invoices/deliveries. Only the newest
    // fetch may install state either, so an older cost-less load cannot overwrite an admin's
    // costed lines (Luna round 3).
    const seq = ++fetchSeqRef.current;
    const isStale = () => activeOrderIdRef.current !== id || seq !== fetchSeqRef.current;
    // A read the page depends on that fails (an error, or no list) shows "could not be
    // loaded" with Try again. It must not show "Order not found", $0 invoiced, or re-offer
    // Create Invoice for an order whose invoices could not be read (To-Do 10.5).
    const failLoad = (err: unknown) => {
      if (isStale()) return false;
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'load_order' } });
      if (editingRef.current) {
        toast('error', 'This order could not be checked, try again. Your unsaved edits are still available.');
      } else setLoadFailed(true);
      setLoading(false);
      return false;
    };
    const readFailed = (result: { data: unknown; error: unknown }, what: string) => {
      const err = result.error ?? (Array.isArray(result.data) ? null : new Error(`The order's ${what} read returned no list`));
      if (!err) return false;
      failLoad(err);
      return true;
    };
    let draftItems: OrderItem[] = [];
    try {
      const snapshot = await readOrderEditSnapshot(id!, isAdmin);
      if (isStale()) return false;
      const orderData = snapshot.order;
      if (orderData) {
        setOrder(orderData);
        for (const [error, context] of [[snapshot.orderCostError, 'load_order_costs'], [snapshot.itemCostError, 'load_order_item_costs']] as const) {
          if (error) Sentry.captureException(error, { tags: { source: 'fetch', action: context } });
        }
        if (snapshot.orderCostError) toast('error', 'Failed to load order cost. Please refresh.');
        if (snapshot.itemCostError) toast('error', 'Failed to load order item costs. Please refresh.');
        if (reloadDraft && snapshot.itemCostError) return failLoad(snapshot.itemCostError);

        // Fetch parent quote for transaction thread
        if (orderData.quote_id) {
          const { data: qData } = await supabase
            .from('quotes').select('id, quote_number')
            .eq('id', orderData.quote_id).maybeSingle();
          if (isStale()) return false;
          setParentQuote(qData as { id: string; quote_number: string } | null);
        } else { setParentQuote(null); }

        const { data: custData, error: custError } = await supabase.from('customers')
          .select('*').eq('id', orderData.customer_id).maybeSingle();
        if (custError || !custData) return failLoad(custError ?? new Error("The order's customer read returned no row"));
        if (isStale()) return false;
        setCustomer(custData as Customer | null);
        const itemsList = snapshot.items;
        setItemCostsFailed(Boolean(snapshot.itemCostError));
        setItems(itemsList);
        draftItems = itemsList;
        // Ship-now/price-later (#2): seed price inputs from each pending line's tier snapshot.
        setPriceInputs(Object.fromEntries(
          itemsList.filter((i) => i.pricing_pending).map((i) => [i.id, i.suggested_price != null ? String(i.suggested_price) : ''])
        ));

        // Load linked deliveries
        // PR-07 follow-up: dropped driver FK embed; resolve via profile_public_view.
        const deliveryRes = await supabase
          .from('deliveries')
          .select('*')
          .eq('order_id', id!)
          .order('scheduled_date');
        if (readFailed(deliveryRes, 'deliveries')) return false;
        const deliveryData = deliveryRes.data as Delivery[];
        const deliveryDriverIds = [...new Set(
          deliveryData
            .map((d: { assigned_driver?: string | null }) => d.assigned_driver)
            .filter(Boolean) as string[]
        )];
        const deliveryDriverMap: Record<string, string> = {};
        const profileIds = [...new Set([...deliveryDriverIds, orderData.salesman_id].filter(Boolean) as string[])];
        if (profileIds.length > 0) {
          // Driver and salesperson names are display only: a lookup that fails or throws leaves them
          // blank rather than failing the whole order.
          const { data: driverData } = await Promise.resolve(supabase
            .from('profile_public_view')
            .select('id, full_name')
            .in('id', profileIds))
            .catch(() => ({ data: null }));
          (Array.isArray(driverData) ? driverData : []).forEach((p: { id: string | null; full_name: string | null }) => { if (p.id) deliveryDriverMap[p.id] = p.full_name ?? ''; });
        }
        if (isStale()) return false;
        setSalesmanName(orderData.salesman_id ? deliveryDriverMap[orderData.salesman_id] || null : null);
        setDeliveries(
          deliveryData.map((d: Delivery) => ({
            ...d,
            driver_name: d.assigned_driver ? deliveryDriverMap[d.assigned_driver] || undefined : undefined,
          }))
        );

        // Load linked invoices (AR single source of truth)
        const invoiceRes = await supabase
          .from(INVOICES_POSTABLE)
          // invoice_post_version: "Post all drafts" refuses an invoice changed since this page loaded.
          .select(`${INVOICE_COLUMNS}, ${INVOICE_POST_VERSION_COLUMNS}`)
          .eq('order_id', id!)
          .not('status', 'in', '("voided","cancelled")')
          .order('invoice_number');
        if (readFailed(invoiceRes, 'invoices')) return false;
        if (isStale()) return false;
        setInvoices(invoiceRes.data as Invoice[]);

        // Load order shares (who is billed what share of this order)
        const shareRes = await supabase
          .from('order_shares')
          .select('*')
          .eq('order_id', id!)
          .order('sort_order');
        if (readFailed(shareRes, 'shares')) return false;
        if (isStale()) return false;
        setShares(shareRes.data as OrderShare[]);

        // A line's own payers, overriding the card for that line (billing plan M2).
        // Paged and counted, so a capped read can't leave lines looking like they follow the card.
        const lineShareRes = await fetchAllRows((from, to) => pageWithList(supabase
          .from('order_item_shares')
          .select('id, order_item_id, customer_id, split_percentage, customer:customers(farm_name), order_items!inner(order_id)', { count: 'exact' })
          .eq('order_items.order_id', id!)
          .order('created_at')
          .order('id')
          .range(from, to)));
        if (readFailed(lineShareRes, 'line shares')) return false;
        if (isStale()) return false;
        setLineShares((lineShareRes.data || []) as unknown as LineShare[]);

        // Field/acre split: existing per-line allocations for this order, the active fields to pick
        // from (with their owner splits), and a customer-id → name map for the live preview.
        // Every read below is paged: one request stops at the server's row cap, which
        // would drop fields, owner splits or names from the split editor (Goal 4 M36).
        // pageWithList: a page with no list sets allocLoadFailed instead of reading as "no splits".
        const { data: allocData, error: allocError } = await fetchAllRows((from, to) => pageWithList(supabase
          .from('order_item_field_allocations')
          .select('id, order_item_id, field_id, acres, created_at, order_items!inner(order_id)', { count: 'exact' })
          .eq('order_items.order_id', id!)
          .order('id')
          .range(from, to)));
        if (isStale()) return false;
        setAllocations(((allocData || []) as unknown as (OrderItemFieldAllocation & { order_items?: unknown })[])
          .map(({ order_items: _oi, ...a }) => a as OrderItemFieldAllocation));

        const [fieldsRes, fbdRes] = await Promise.all([
          fetchAllRows<{ id: string; field_name: string; total_acres: number | null; customer_id: string }>((from, to) => pageWithList(supabase
            .from('fields')
            .select('id, field_name, total_acres, customer_id', { count: 'exact' })
            .eq('is_active', true)
            .order('field_name')
            .order('id')
            .range(from, to))),
          fetchAllRows<{ id: string; field_id: string; customer_id: string; split_pct: number }>((from, to) => pageWithList(supabase
            .from('field_billing_defaults')
            .select('id, field_id, customer_id, split_pct', { count: 'exact' })
            .order('id')
            .range(from, to))),
        ]);
        if (isStale()) return false;
        // Names for just the customers the preview can show (this order's customer + field owners).
        // No active filter: an inactive field owner still shows by name. (customers has no
        // deleted_at column; filtering on it made this query 400.)
        const nameIds = [...new Set([
          orderData.customer_id,
          ...(fieldsRes.data || []).map((f) => f.customer_id),
          ...(fbdRes.data || []).map((r) => r.customer_id),
        ].filter(Boolean))];
        // Sent in chunks, so a long id list never overflows the request URL either.
        const custRes = await fetchAllRowsForIds(nameIds, (idChunk, from, to) => pageWithList(supabase
          .from('customers')
          .select('id, farm_name', { count: 'exact' })
          .in('id', idChunk)
          .order('id')
          .range(from, to)));
        if (isStale()) return false;
        const allocLoadErrors = [allocError, fieldsRes.error, fbdRes.error, custRes.error].filter((e) => e != null);
        for (const err of allocLoadErrors) {
          Sentry.captureException(err, { tags: { source: 'fetch', action: 'load_field_split_lookups_for_order' } });
        }
        if (allocLoadErrors.length > 0) toast('error', 'Failed to load field split details. Please refresh.');
        setAllocLoadFailed(allocLoadErrors.length > 0);
        const ownersByField: Record<string, { customer_id: string; split_pct: number }[]> = {};
        for (const r of fbdRes.data || []) {
          (ownersByField[r.field_id] ||= []).push({ customer_id: r.customer_id, split_pct: Number(r.split_pct) });
        }
        setAllocFields(((fieldsRes.data || []) as { id: string; field_name: string; total_acres: number | null; customer_id: string }[])
          .map((f) => ({ ...f, owners: ownersByField[f.id] || [] })));
        const names: Record<string, string> = {};
        for (const c of (custRes.data || []) as { id: string; farm_name: string }[]) names[c.id] = c.farm_name;
        setCustNames(names);
      } else {
        // A read that found no order (not a failed one) says "Order not found", never the
        // previous order this page was showing. A conflict reload keeps the unsaved editor
        // instead, so its draft can still be copied; Cancel leaves it.
        if (reloadDraft && editingRef.current) {
          return failLoad(new Error('The order is no longer available to reload.'));
        }
        setOrder(null);
      }
      if (isStale()) return false;
      setLoadFailed(false);
      setLoading(false);
      if (orderData && (!editingRef.current || reloadDraft)) {
        // Adopt a new draft/token only after the complete load succeeds. A failed
        // recovery must never replace the unsaved editor with a partial snapshot.
        loadedDraftRef.current = { items: draftItems, rowVersion: readRowVersion(orderData.row_version) };
        setEditItems(draftItems.map((i) => ({ ...i })));
        setEditRowVersion(loadedDraftRef.current.rowVersion);
      }
      return orderData !== null;
    } catch (err: unknown) {
      return failLoad(err);
    }
  }, [id, toast, isAdmin]);

  // The rate as SettingsPage reads it (app_settings.sales_tax_rate), for the Billing card's sub-line.
  useEffect(() => {
    let live = true;
    Promise.resolve(supabase.from('app_settings').select('setting_value').eq('setting_key', 'sales_tax_rate').maybeSingle())
      .then(({ data }) => { if (live) setSalesTaxRate((data as { setting_value?: string } | null)?.setting_value || null); })
      .catch(() => { /* display only */ });
    return () => { live = false; };
  }, []);

  const retryLoad = () => {
    setLoadFailed(false);
    setLoading(true);
    void fetchOrder();
  };

  useEffect(() => {
    activeOrderIdRef.current = id;
    editingRef.current = false;
    setEditing(false);
    setNewItems([]);
    setOrderConflict(false);
    setConflictDialogOpen(false);
    setEditRowVersion(null);
    loadedDraftRef.current = { items: [], rowVersion: null };
  }, [id]);

  // Kept apart from the reset above: fetchOrder is also rebuilt when the signed-in role
  // changes, and that refresh must not close the editor or discard its unsaved draft.
  useEffect(() => {
    if (id) fetchOrder();
  }, [id, fetchOrder]);

  // Fetch products + inventory when entering edit mode (lazy load — only when needed).
  // Only the newest load may write: leaving and re-entering edit mode mid-load starts a
  // second one, and the first must never land last over it (Codex review, #1017).
  const productsLoadRef = useRef(0);
  const fetchProducts = useCallback(async () => {
    const loadId = ++productsLoadRef.current;
    setProductsLoading(true);
    // The whole active catalog, page by page: the add-product modal filters, tier-prices and
    // cost-overlays this list locally, and one read stops at the server's row cap.
    const productsRes = await fetchAllRows((from, to) => supabase
      .from('products')
      .select(`${PRODUCT_COLUMNS}, product_family:product_families(name)`, { count: 'exact' })
      .eq('is_active', true)
      .order('product_name')
      .order('id')
      .range(from, to));
    const { data: positionData, error: positionError } = await supabase.rpc('get_inventory_position');
    if (loadId !== productsLoadRef.current) return;

    if (productsRes.error) {
      Sentry.captureException(productsRes.error, { tags: { source: 'fetch', action: 'load_products_for_order_edit' } });
      toast('error', 'Failed to load products. Please refresh.');
    }
    setProductsLoadFailed(!!productsRes.error);
    if (positionError) {
      Sentry.captureException(positionError, { tags: { source: 'fetch', action: 'load_inventory_position_for_order_edit' } });
      toast('error', 'Failed to load inventory positions. Please refresh.');
    }

    let productRows = (productsRes.data || []) as Product[];
    try {
      productRows = await withAdminCosts('products', productRows, isAdmin);
    } catch (err) {
      if (loadId !== productsLoadRef.current) return;
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'load_product_costs_for_order_edit' } });
      toast('error', 'Failed to load product costs. Please refresh.');
      // Never offer an admin a product list without cost (Luna round 1).
      productRows = [];
      setProductsLoadFailed(true);
    }
    if (loadId !== productsLoadRef.current) return;
    setProducts(productRows);
    setProductsLoading(false);

    if (positionError) {
      setInventoryByProduct({});
    } else {
      try {
        const positionRows = assertRpcResult<InventoryPositionRow[]>(positionData, 'get_inventory_position');
        validateInventoryPositionShape(positionRows);
        setInventoryByProduct(inventoryPositionByProduct(positionRows));
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', action: 'parse_inventory_position_for_order_edit' } });
        toast('error', 'Inventory position data was malformed. Please refresh.');
        setInventoryByProduct({});
      }
    }
  }, [toast, isAdmin]);

  // Load products when edit mode is activated
  useEffect(() => {
    if (editing && products.length === 0) {
      fetchProducts();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // ── Print Handlers ────────────────────────────────────────────────────

  const handlePrintSummary = async () => {
    if (!order || !customer) return;
    setPrintingSummary(true);
    try {
      const data: OrderSummaryData = {
        order_number: order.order_number,
        order_name: order.order_name,
        order_date: order.order_date,
        status: order.status,
        customer_po_number: order.customer_po_number,
        farm_name: customer.farm_name,
        contact_name: customer.contact_name || null,
        phone: customer.phone || null,
        billing_address: customer.billing_address || null,
        items: items.map((it) => ({
          product_name: it.product_name,
          quantity: it.total_units_needed,
          unit_size: it.unit_size,
          price_per_unit: it.price_per_unit,
          extended_price: it.total_price,
        })),
        total_price: order.total_price,
        notes: order.notes,
      };
      await downloadOrderSummaryPdf(data);
      toast('success', 'Order summary downloaded');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'print_order_summary' } });
      toast('error', 'Failed to generate PDF');
    }
    setPrintingSummary(false);
  };

  const handlePrintPickList = async () => {
    if (!order || !customer) return;
    setPrintingPickList(true);
    try {
      // Fetch customer addresses + inventory in parallel. Every row is read, page by
      // page: one request stops at the server's row cap, and a product past it would
      // print as out of stock (Goal 4 M62).
      const [addrRes, invRes] = await Promise.all([
        fetchAllRows((from, to) => supabase
          .from('customer_addresses')
          .select('*', { count: 'exact' })
          .eq('customer_id', customer.id)
          .order('is_default', { ascending: false })
          .order('id')
          .range(from, to)),
        fetchAllRows<{ id: string; product_id: string; quantity_available: number; quantity_prebooked: number }>((from, to) => supabase
          .from('inventory')
          .select('id, product_id, quantity_available, quantity_prebooked', { count: 'exact' })
          .order('id')
          .range(from, to)),
      ]);
      // A pick list printed from part of the stock would flag false shortages.
      if (invRes.error) throw new Error(`Stock could not be loaded: ${invRes.error.message}`);
      if (addrRes.error) throw new Error(`Customer addresses could not be loaded: ${addrRes.error.message}`);

      // Build inventory map
      const invMap: Record<string, { available: number; prebooked: number }> = {};
      for (const row of invRes.data || []) {
        const pid = row.product_id as string;
        if (!invMap[pid]) invMap[pid] = { available: 0, prebooked: 0 };
        invMap[pid].available += Number(row.quantity_available);
        invMap[pid].prebooked += Number(row.quantity_prebooked);
      }

      // Flag the shortage against the product's TOTAL remaining on this order.
      // A tier-split booking puts the same product on several lines, and
      // comparing each line alone against the full net-free stock lets two
      // half-sized tier lines both look covered when together they are not.
      // See src/lib/inventoryShortage.ts.
      const remainingByProduct: Record<string, number> = {};
      for (const need of sumNeedByProduct(
        items.map((it) => ({
          productId: it.product_id,
          label: it.product_name,
          quantity: Number(it.quantity_remaining),
        }))
      )) {
        remainingByProduct[need.productId] = need.quantity;
      }

      // Format delivery addresses
      const addresses = (addrRes.data || []).map((a: Record<string, unknown>) => {
        const parts = [a.label, a.address_line, a.city, a.state, a.zip].filter(Boolean);
        return parts.join(', ');
      }).filter((s: string) => s.length > 0);

      // Fall back to billing address if no delivery addresses
      if (addresses.length === 0 && customer.billing_address) {
        addresses.push(customer.billing_address);
      }

      const data: PickListData = {
        order_number: order.order_number,
        order_name: order.order_name,
        order_date: order.order_date,
        farm_name: customer.farm_name,
        contact_name: customer.contact_name || null,
        phone: customer.phone || null,
        delivery_addresses: addresses,
        items: items.map((it) => {
          const inv = invMap[it.product_id];
          const netFree = inv ? inv.available - inv.prebooked : null;
          const remaining = remainingByProduct[it.product_id] ?? it.quantity_remaining;
          return {
            product_name: it.product_name,
            unit_size: it.unit_size,
            total_units_needed: it.total_units_needed,
            quantity_delivered: it.quantity_delivered,
            quantity_remaining: it.quantity_remaining,
            inventory_available: netFree,
            has_shortage: netFree !== null ? remaining > netFree : false,
          };
        }),
        notes: order.notes,
        program_notes: order.program_notes,
      };
      await downloadPickListPdf(data);
      toast('success', 'Pick list downloaded');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'print_pick_list' } });
      toast('error', 'Failed to generate pick list');
    }
    setPrintingPickList(false);
  };

  const handleAddProduct = (product: Product) => {
    const tierNum = customer?.assigned_tier || 1;
    // Cascade: tier3 → tier2 → tier1 fallback (same logic as quoteCalc.getTierPrice)
    const t1 = product.tier1_price || 0;
    const tierPrice =
      tierNum === 1 ? t1
        : tierNum === 2 ? product.tier2_price || t1
          : product.tier3_price || t1;

    const item: NewOrderItem = {
      _tempKey: nextEditKey(),
      product_id: product.id,
      product_name: product.product_name,
      price_per_unit: tierPrice,
      cost_per_unit: product.current_cost || 0,
      total_units_needed: 0,
      unit_size: product.unit_size || null,
      section_name: null,
    };
    setNewItems((prev) => [...prev, item]);
    setShowProductModal(false);
    setProductSearch('');
  };

  const updateNewItem = (key: string, field: keyof NewOrderItem, value: number | string | null) => {
    setNewItems((prev) =>
      prev.map((i) => (i._tempKey === key ? { ...i, [field]: value } : i))
    );
  };

  const removeNewItem = (key: string) => {
    setNewItems((prev) => prev.filter((i) => i._tempKey !== key));
  };

  const filteredProducts = productSearch
    ? products.filter(
        (p) =>
          p.product_name.toLowerCase().includes(productSearch.toLowerCase()) ||
          p.manufacturer?.toLowerCase().includes(productSearch.toLowerCase())
      )
    : products;

  const handleSaveEdits = async () => {
    if (!profile) return;
    if (orderConflict || editRowVersion === null) {
      setOrderConflict(true);
      setConflictDialogOpen(true);
      return;
    }
    const savingOrderId = id;
    await runCriticalAction({
      action: async () => {
        // Build payload: existing items (with id) + new items (without id)
        const existingPayload = editItems.map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_name: item.product_name,
          unit_size: item.unit_size,
          cost_per_unit: item.cost_per_unit,
          price_per_unit: item.price_per_unit,
          total_units_needed: item.total_units_needed,
        }));

        const newPayload = newItems
          .filter((item) => item.product_id && item.total_units_needed > 0)
          .map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            price_per_unit: item.price_per_unit,
            cost_per_unit: item.cost_per_unit,
            total_units_needed: item.total_units_needed,
            unit_size: item.unit_size,
            section_name: item.section_name,
          }));

        const itemsPayload = [...existingPayload, ...newPayload];

        const idemKey = updateOrderIdem.getKey();
        const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('update_order_items', withBelowCostReason('update_order_items', {
          p_order_id: id!,
          p_items: itemsPayload,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
          p_expected_row_version: editRowVersion,
        }, reason)));

        if (activeOrderIdRef.current !== savingOrderId) return;
        if (error) {
          if (hasRpcCode(error, RpcErrorCodes.ORDER_STALE_WRITE)
            || hasRpcCode(error, RpcErrorCodes.ORDER_EXPECTED_VERSION_REQUIRED)
            || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)
            || getIdempotencyBindingRejection(error)) {
            setOrderConflict(true);
            setConflictDialogOpen(true);
            return;
          }
          // Server-side backstop for the hidden Edit button: a draw-created
          // order's items are locked to the booking ledger (Codex r2 HIGH).
          if (hasRpcCode(error, RpcErrorCodes.BOOKING_DRAW_ORDER_LOCKED)) {
            toast('error', 'This order was created by a booking draw-down — its items are locked to the booking. Void or cancel the order to return quantity to the booking, then draw again.');
            setEditing(false);
            setNewItems([]);
            fetchOrder();
            return;
          }
          throw error;
        }
        assertRpcResult(data, 'update_order_items');
        const receipt = data as { order_id?: unknown; row_version?: unknown; success?: unknown };
        if (receipt.order_id !== savingOrderId || receipt.success !== true
          || readRowVersion(receipt.row_version) === null) {
          throw new Error('The order save could not be confirmed. Your edits are still available; try again.');
        }

        updateOrderIdem.resetKey();
        const addedCount = newPayload.length;
        toast('success', addedCount > 0 ? `Order updated — ${addedCount} product(s) added` : 'Order updated');
        setEditing(false);
        setNewItems([]);
        fetchOrder();
      },
      toast,
      setLoading: setSaving,
      sentryTag: 'save_order_edits',
    });
  };

  const reloadConflictingOrder = async () => {
    const reloaded = await fetchOrder(true);
    if (!reloaded) return false;
    updateOrderIdem.resetKey();
    setOrderConflict(false);
    setConflictDialogOpen(false);
    setEditing(false);
    setNewItems([]);
    return true;
  };

  const handleTogglePlanned = async () => {
    if (!order || !profile) return;
    setTogglingPlanned(true);
    try {
      const newValue = !order.is_planned;
      const result = await supabase
        .from('orders')
        .update({ is_planned: newValue, updated_at: new Date().toISOString() })
        .eq('id', order.id)
        .select('id');
      checkMutationResult(result, 'Toggle planned status');
      setOrder({ ...order, is_planned: newValue });
      toast('success', newValue ? 'Order marked as Planned' : 'Order marked as Committed');
      logActivity({ event: 'order_updated', description: `Order ${order.order_number} marked as ${newValue ? 'planned' : 'committed'}`, performedBy: profile.id, entityType: 'order', entityId: order.id, customerId: order.customer_id });
      // The toggle advances the order's row_version. Reload the whole order (lines and
      // version together) so the next edit saves against it; adopting only the new version
      // could pair it with lines another user has since changed.
      await fetchOrder();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'toggle_order_planned' } });
      toast('error', sanitizeError(err));
    }
    setTogglingPlanned(false);
  };

  // The sales tax box (billing plan M4a): an admin or the sale's own rep. The database applies it to the
  // sale's draft invoices; posted ones keep their tax.
  const handleToggleSalesTax = async () => {
    if (!order || !profile || order.id !== id) return;
    const next = !order.sales_tax;
    const scope = `${order.id}:${next}`;
    setSavingSalesTax(true);
    try {
      const { data, error } = await supabase.rpc('set_order_sales_tax', {
        p_order_id: order.id, p_sales_tax: next, p_idempotency_key: salesTaxIdem.getKeyFor(scope),
      });
      if (error) throw error;
      const result = assertRpcResult<{ drafts_updated?: number }>(data, 'set_order_sales_tax');
      salesTaxIdem.resetKeyFor(scope);
      const drafts = result.drafts_updated ?? 0;
      if (drafts) toast('success', `Sales tax ${next ? 'on' : 'off'} (${drafts} draft invoice${drafts === 1 ? '' : 's'} updated)`);
      else {
        const hasPosted = invoices.some((inv) => !['draft', 'voided', 'cancelled'].includes(inv.status));
        toast('info', `Sales tax ${next ? 'on' : 'off'}. New invoices for this sale will${next ? '' : ' not'} be taxed${hasPosted ? '; posted invoices keep their tax' : ''}.`);
      }
      await fetchOrder();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'set_order_sales_tax' } });
      toast('error', sanitizeError(err));
    }
    setSavingSalesTax(false);
  };

  const executeStatusChange = async () => {
    if (!pendingStatus || !order || !profile) return;
    setStatusConfirmOpen(false);
    const targetStatus = pendingStatus;

    await runCriticalAction({
      action: async () => {
        if (targetStatus === 'cancelled' && order.status !== 'cancelled') {
          // Atomic RPC: a zero-delivery order is cancelled; a partially delivered
          // order keeps its delivered lineage and closes only the remaining quantity.
          const cancelKey = cancelOrderIdem.getKey();
          const { data: cancelResult, error } = await supabase.rpc('cancel_order', {
            p_order_id: id!,
            p_performed_by: profile.id,
            p_idempotency_key: cancelKey,
          });
          if (error) throw error;
          const result = assertRpcResult<{
            success: boolean;
            mode?: 'full_cancel' | 'remainder_closed';
            status?: 'cancelled' | 'fulfilled';
            holds_released: number;
            released_quantity?: number;
            commissions_cancelled: number;
            commissions_recomputed?: number;
            draft_invoices_cancelled: number;
            posted_invoices_flagged: number;
            paid_commissions_flagged: number;
          }>(cancelResult, 'cancel_order');
          cancelOrderIdem.resetKey();
          // Show summary toast with cascade details
          if (result && result.success) {
            const remainderClosed = result.mode === 'remainder_closed';
            const parts: string[] = [
              remainderClosed
                ? 'Remaining quantity cancelled; delivered quantity kept as fulfilled.'
                : 'Order cancelled.',
            ];
            if (remainderClosed && (result.released_quantity ?? 0) > 0)
              parts.push(`${result.released_quantity} undelivered unit(s) released.`);
            if (remainderClosed && (result.commissions_recomputed ?? 0) > 0)
              parts.push(`${result.commissions_recomputed} commission(s) recalculated to delivered profit.`);
            if (result.holds_released > 0) parts.push(`${result.holds_released} hold(s) released.`);
            if (result.commissions_cancelled > 0) parts.push(`${result.commissions_cancelled} commission(s) zeroed.`);
            if (result.draft_invoices_cancelled > 0) parts.push(`${result.draft_invoices_cancelled} draft invoice(s) cancelled.`);
            if (result.posted_invoices_flagged > 0) parts.push(`Admin notified about ${result.posted_invoices_flagged} posted invoice(s) requiring manual void.`);
            if (result.paid_commissions_flagged > 0) parts.push(`Admin notified about ${result.paid_commissions_flagged} paid commission(s).`);
            toast('success', parts.join(' '));
          }

          // Idempotent/status-only responses (for example already_cancelled)
          // are not a new cancellation. Refresh the page state, but do not
          // write duplicate client activity or send a false status notice.
          if (!result.success) {
            await fetchOrder();
            return;
          }

          // A remainder close finishes as fulfilled, so do not write or notify a
          // second, false "cancelled" client event. Preserve the existing client
          // activity/notification behavior for a true full cancellation below.
          if (result.mode === 'remainder_closed') {
            await fetchOrder();
            return;
          }
        } else {
          // Cancel (above) is the only manual status change; delivery, void and pricing RPCs set the
          // rest, and signed-in users have no direct UPDATE on orders.status (20261116100000).
          toast('error', `Cannot change status from '${order.status}' to '${targetStatus}'`);
          return;
        }

        logActivity({ event: 'order_status_changed', description: `Order ${order.order_number} status changed to ${targetStatus}`, performedBy: profile.id, entityType: 'order', entityId: order.id, customerId: order.customer_id });
        // NOTE: the `orders` table has no created_by column, so the order-creator
        // notification path is not available here (it would require a migration to
        // add the column). Admins are still notified inside notifyOrderStatusChange.
        notifyOrderStatusChange(order.id, order.order_number, customer?.farm_name || 'customer', targetStatus);

        // The "Order Confirmed" customer email is now sent at the order
        // creation sites (QuoteBuilder.executeConvertToOrder and
        // NewOrder.submitOrder), not from this status-change handler.
        // Orders are born at status='confirmed', so there is no transition
        // INTO confirmed to gate on. Wave A.2 / audit finding P1-7.

        fetchOrder();
      },
      toast,
      setLoading: setChangingStatus,
      sentryTag: 'change_order_status',
    });
  };

  // ── Void Order (fulfilled → voided, admin-only) ───────────────────────
  const handleVoidOrder = async () => {
    if (!order || !profile) return;
    setVoiding(true);
    // One key per exact request (this order + this reason): an edited reason or another order gets
    // its own key, and an exact retry reuses the first key, which the server (replay-binding batch 3b,
    // 20261019235000) replays only for the same person and the same order and reason.
    const reason = voidReason.trim() || 'Voided by admin';
    const voidScope = JSON.stringify([order.id, reason]);
    try {
      const idemKey = voidOrderIdem.getKeyFor(voidScope);
      const { data: voidResult, error } = await supabase.rpc('void_order', {
        p_order_id: order.id,
        p_performed_by: profile.id,
        p_reason: reason,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      // Retire the key only after a confirmed result: an empty reply keeps it, so retrying the same
      // request replays the server's saved receipt. A binding refusal is retired in the catch.
      const voided = assertRpcResult<{
        inventory_products_restored?: number;
        commissions_cancelled?: number;
        draft_invoices_voided?: number;
        posted_invoices_flagged?: number;
        paid_commissions_flagged?: number;
      }>(voidResult, 'void_order');
      voidOrderIdem.resetKeyFor(voidScope);

      const parts: string[] = ['Order voided.'];
      if ((voided.inventory_products_restored ?? 0) > 0)
        parts.push(`Inventory restored for ${voided.inventory_products_restored} product(s).`);
      if ((voided.commissions_cancelled ?? 0) > 0)
        parts.push(`${voided.commissions_cancelled} commission(s) cancelled.`);
      if ((voided.draft_invoices_voided ?? 0) > 0)
        parts.push(`${voided.draft_invoices_voided} draft invoice(s) voided.`);
      if ((voided.posted_invoices_flagged ?? 0) > 0)
        parts.push(`Admin notified about ${voided.posted_invoices_flagged} posted invoice(s).`);
      if ((voided.paid_commissions_flagged ?? 0) > 0)
        parts.push(`Admin notified about ${voided.paid_commissions_flagged} paid commission(s).`);

      toast('success', parts.join(' '));
      setVoidModalOpen(false);
      setVoidReason('');
      fetchOrder();
    } catch (error: unknown) {
      // Any replay-binding refusal (another request's or person's key, or a receipt that can never be
      // used) retires the key; nothing ran for THIS request. A void cannot repeat: the next try runs
      // fresh and the body refuses an order that is no longer fulfilled. Reload so a void an earlier
      // attempt already committed shows.
      if (getIdempotencyBindingRejection(error)) {
        voidOrderIdem.resetKeyFor(voidScope);
        fetchOrder();
      }
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { source: 'critical_action', action: 'void_order' } });
      toast('error', sanitizeError(error));
    } finally {
      setVoiding(false);
    }
  };

  // ── Share management ──────────────────────────────────────────────────
  // Resolves true once the share is saved, so the card closes its form.
  const handleAddShare = async (customerId: string, pct: number): Promise<boolean> => {
    if (!order || !customerId) return false;
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      toast('error', 'Percentage must be between 0 and 100');
      return false;
    }
    // Added exactly, as the database does: a float sum refuses a card that is exactly 100%.
    if (sharesOverHundred([...shares.map((sh) => sh.split_percentage), pct])) {
      toast('error', `Total split would exceed 100% (currently ${Math.round((100 - sharesLeft(shares.map((sh) => sh.split_percentage))) * 100) / 100}%)`);
      return false;
    }
    // The picked customer's name, kept from the search picker.
    const farmName = newShareCustomerName;
    if (!farmName) return false;

    setSavingShares(true);
    let saved = false;
    try {
      const amountCents = Math.round(order.total_price * 100 * (pct / 100));
      const result = await supabase.from('order_shares').insert({
        order_id: order.id,
        customer_id: customerId,
        customer_name: farmName,
        split_percentage: pct,
        amount_cents: amountCents,
        is_primary: shares.length === 0,
        sort_order: shares.length + 1,
      }).select();
      checkMutationResult(result, 'Add order share');
      toast('success', `Added ${farmName} at ${pct}%`);
      setNewShareCustomerId('');
      setNewShareCustomerName('');
      saved = true;
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'add_order_share' } });
      toast('error', sanitizeError(err));
    }
    // Reload either way, and hold the card until it lands: a reply that fails after the row is written
    // (a 500, a dropped connection) still changed the card, which showed it only after a page refresh (staging, 13 Nov).
    await fetchOrder();
    setSavingShares(false);
    return saved;
  };

  const handleRemoveShare = async (shareId: string) => {
    setSavingShares(true);
    try {
      const result = await supabase.from('order_shares').delete().eq('id', shareId).select();
      checkMutationResult(result, 'Remove order share');
      toast('success', 'Share removed');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'remove_order_share' } });
      toast('error', sanitizeError(err));
    }
    // Reload either way, as for adding: a failed reply may still have deleted the row.
    await fetchOrder();
    setSavingShares(false);
  };

  const handleAddAllocation = async (orderItemId: string) => {
    if (!newAllocFieldId || !newAllocAcres) return;
    const acres = parseFloat(newAllocAcres);
    if (isNaN(acres) || acres <= 0) { toast('error', 'Acres must be greater than 0'); return; }
    if (allocations.some((a) => a.order_item_id === orderItemId && a.field_id === newAllocFieldId)) {
      toast('error', 'That field is already allocated on this line'); return;
    }
    setSavingAlloc(true);
    try {
      const result = await supabase.from('order_item_field_allocations').insert({
        order_item_id: orderItemId, field_id: newAllocFieldId, acres,
      }).select();
      checkMutationResult(result, 'Add field allocation');
      toast('success', 'Field allocation added');
      setNewAllocFieldId(''); setNewAllocAcres('');
      fetchOrder();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'add_field_allocation' } });
      toast('error', sanitizeError(err));
    }
    setSavingAlloc(false);
  };

  const handleRemoveAllocation = async (allocId: string) => {
    setSavingAlloc(true);
    try {
      const result = await supabase.from('order_item_field_allocations').delete().eq('id', allocId).select();
      checkMutationResult(result, 'Remove field allocation');
      toast('success', 'Field allocation removed');
      fetchOrder();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'remove_field_allocation' } });
      toast('error', sanitizeError(err));
    }
    setSavingAlloc(false);
  };

  const hasAllocations = allocations.length > 0;

  // Live per-customer preview of the split. Approximate (the server does the penny-exact
  // largest-remainder version at generation); shown only to sanity-check the allocation.
  const splitPreview = useMemo(() => {
    if (allocations.length === 0) return null;
    const perCust: Record<string, number> = {};
    const add = (cid: string, amt: number) => { if (cid) perCust[cid] = (perCust[cid] || 0) + amt; };
    for (const it of items) {
      const lineAllocs = allocations.filter((a) => a.order_item_id === it.id);
      if (lineAllocs.length === 0) { add(order?.customer_id || '', it.total_price); continue; }
      const totalAcres = lineAllocs.reduce((s, a) => s + Number(a.acres), 0);
      if (totalAcres <= 0) continue;
      for (const a of lineAllocs) {
        const fieldShare = it.total_price * Number(a.acres) / totalAcres;
        const fld = allocFields.find((f) => f.id === a.field_id);
        const owners = fld?.owners?.length ? fld.owners : (fld ? [{ customer_id: fld.customer_id, split_pct: 100 }] : []);
        const pctSum = owners.reduce((s, o) => s + o.split_pct, 0) || 100;
        for (const o of owners) add(o.customer_id, fieldShare * o.split_pct / pctSum);
      }
    }
    return Object.entries(perCust)
      .map(([cid, amt]) => ({ customer_id: cid, name: custNames[cid] || 'Unknown', amount: amt }))
      .filter((r) => Math.abs(r.amount) > 0.005)
      .sort((a, b) => b.amount - a.amount);
  }, [allocations, items, allocFields, custNames, order?.customer_id]);

  const handleDeleteItem = async (itemId: string) => {
    setEditItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  const updateEditItem = (itemId: string, field: string, value: number) => {
    setEditItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, [field]: value } : i))
    );
  };

  const handleCreateInvoice = async () => {
    if (!profile || !id) return;
    await runCriticalAction({
      action: async () => {
        // The billing path must follow the order's real field split. A failed or stale
        // allocation read leaves `allocations` empty or out of date, and an allocated order
        // sent down the single-invoice path bills the order's customer for every field
        // owner's share. Since 20261022021000 create_invoice_from_order refuses such an order
        // itself (ORDER_HAS_FIELD_SPLIT); this check keeps the page on the right path first.
        if (allocLoadFailed) {
          throw new Error('The field split details failed to load. Refresh the page before creating the invoice.');
        }
        const allocCheck = await supabase
          .from('order_item_field_allocations')
          .select('id, order_items!inner(order_id)', { count: 'exact' })
          .eq('order_items.order_id', id)
          .order('id')
          .range(0, 0);
        if (allocCheck.error) {
          throw new Error(`The order's field split could not be checked: ${allocCheck.error.message}`);
        }
        if (typeof allocCheck.count !== 'number' || (allocCheck.count > 0) !== hasAllocations) {
          throw new Error("The order's field split changed since this page loaded. Refresh the page before creating the invoice.");
        }
        const splitKey = splitInvoiceIdem.getKey();
        const { data, error } = await supabase.rpc('create_split_invoices_from_order', {
          p_order_id: id,
          p_salesman_id: profile.id,
          p_invoice_type: 'chemical_sale',
          p_idempotency_key: splitKey,
        });
        if (error) throw error;
        const ids = assertRpcResult<string[]>(data, 'create_split_invoices_from_order');
        splitInvoiceIdem.resetKey();
        if (!ids || ids.length === 0) {
          throw new Error('No split invoices were generated — the order has no billable (positive) amount allocated to a customer.');
        }
        navigate(`/invoices/${ids[0]}`);
      },
      toast,
      successMessage: `Split invoices created${splitPreview ? ` (${splitPreview.length} customer${splitPreview.length !== 1 ? 's' : ''})` : ''}`,
      setLoading: setCreatingInvoice,
      sentryTag: 'create_split_invoices_from_order',
    });
  };

  const hasActiveInvoice = invoices.some((inv) => activeInvoiceCoversOrder(inv, order?.id ?? ''));
  const hasPendingDelivery = deliveries.some(
    (d) => d.status === 'scheduled' || d.status === 'in_progress'
  );

  // #4 billing cockpit: post every draft/unposted invoice on this order in one
  // action. Standalone invoices post independently; split siblings post as one
  // atomic group. PRICING_INCOMPLETE / period errors remain isolated per target.
  const handlePostAllDrafts = async () => {
    if (!profile) { toast('error', 'You must be signed in to post invoices.'); return; }
    const drafts = invoices.filter((i) => i.status === 'draft' || i.status === 'unposted');
    if (drafts.length === 0) { toast('warning', 'No draft invoices to post.'); return; }
    const targets = buildInvoicePostTargets(drafts, invoices);
    setPostingAll(true);
    let posted = 0;
    let alreadyPosted = 0;
    const errors: string[] = [];
    // Codex round-6 P2: post_invoice's status guard is NOT a silent no-op — it RAISES
    // on an already-posted invoice. So a lost response (post committed server-side, but
    // the client got a network error) would make a retry report a false failure. Guard
    // each target with a fresh status re-check: if a prior attempt already posted
    // it, skip it (count as done) instead of raising. The idempotency cache is keyed
    // to the exact standalone/group RPC boundary.
    for (const target of targets) {
      try {
        const statusQuery = supabase.from('invoices').select('status').is('deleted_at', null);
        const { data: currentRows, error: curErr } = target.operation === 'post_invoice_group'
          ? await statusQuery.eq('invoice_group_id', target.invoiceGroupId!)
          : await statusQuery.eq('id', target.invoiceId!);
        if (curErr) throw curErr;
        if (currentRows && currentRows.length > 0 && currentRows.every(
          (row) => row.status !== 'draft' && row.status !== 'unposted'
        )) {
          alreadyPosted += target.selectedIds.length;
          continue;
        }
        if (!postDraftKeysRef.current[target.key]) {
          postDraftKeysRef.current[target.key] = generateIdempotencyKey(
            target.operation,
            `${profile.id}:${target.scopeId}`,
          );
        }
        // Posts with the versions this page loaded; a changed invoice is refused with a reload message.
        await postInvoiceTarget(target, profile.id, postDraftKeysRef.current[target.key]);
        posted += target.selectedIds.length;
        delete postDraftKeysRef.current[target.key];
      } catch (err) {
        const blocked = describePostInvoiceBlock(err);
        if (blocked) errors.push(`${target.label}: ${blocked}`);
        else {
          const sanitized = sanitizeError(err);
          const message = sanitized.includes('RETURN_CREDIT_SOURCE_CONCURRENT')
            ? 'A related invoice or return credit is being changed elsewhere. Wait a moment and try again.'
            : sanitized;
          errors.push(`${target.label}: ${message}`);
        }
      }
    }
    if (alreadyPosted > 0 && posted === 0 && errors.length === 0) {
      toast('info', `Already posted (${alreadyPosted}).`);
    }
    if (posted > 0) toast('success', `Posted ${posted} invoice(s).`);
    if (errors.length > 0) {
      Sentry.captureException(new Error('post_all_drafts partial failure'), { level: 'warning', tags: { source: 'critical_action', action: 'post_all_drafts' }, extra: { errors } });
      for (const e of errors) toast('error', e);
    }
    if (errors.length === 0) postDraftKeysRef.current = {}; // clean run — mint fresh keys next time
    await fetchOrder();
    setPostingAll(false);
  };

  // (Consolidate drafts removed 2026-11-11: each delivery bills on its own invoice, capped at what it
  // delivered, and invoice lines can't move between invoices (20260721), so the merge could only fail.)

  // (booking-prepay "Apply booking prepay" action removed 2026-06-14 — the earmark
  // engine is shelved for a reserved-pool redesign: docs/roadmap/shelved-earmark-engine/)

  // Codex round-5 P2: reset the price_order idempotency key whenever the normalized
  // pricing payload (order id + the {item:price} pairs) changes, but keep it stable
  // for an identical retry. Without this, a lost price_order response leaves the key
  // in place; editing a price and resubmitting would replay the SAME key and return
  // the cached result, silently discarding the edited prices. Mirrors NewOrder's
  // rushOrderIdem intent-change reset.
  const pricingPayloadHash = useMemo(() => {
    const pairs = items
      .filter((i) => i.pricing_pending)
      .filter((i) => (priceInputs[i.id] ?? '').trim() !== '')
      .map((i) => `${i.id}:${parseFloat(priceInputs[i.id]) || 0}`)
      .sort()
      .join('|');
    return `${order?.id || ''}#${pairs}`;
  }, [items, priceInputs, order?.id]);
  useEffect(() => {
    priceOrderIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingPayloadHash]);

  // Ship-now/price-later (#2 v2): finalize a needs_pricing rush order via price_order.
  const handlePriceOrder = async () => {
    if (!order || !profile) return;
    const priced = items
      .filter((i) => i.pricing_pending)
      .filter((i) => (priceInputs[i.id] ?? '').trim() !== '')
      .map((i) => ({ order_item_id: i.id, price: parseFloat(priceInputs[i.id]) || 0 }));
    if (priced.length === 0) { toast('warning', 'Enter a price for at least one line.'); return; }
    if (priced.some((x) => x.price < 0)) { toast('error', 'Prices cannot be negative.'); return; }
    setPricingOrder(true);
    try {
      const idemKey = priceOrderIdem.getKey();
      const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('price_order', withBelowCostReason('price_order', {
        p_order_id: order.id,
        p_items: priced,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      }, reason)));
      if (error) throw error;
      const result = assertRpcResult<{ success: boolean; pricing_status: string; remaining_pending: number; invoices_swept: number }>(data, 'price_order');
      priceOrderIdem.resetKey();
      toast('success', result.pricing_status === 'priced'
        ? `Order priced${result.invoices_swept ? ` — ${result.invoices_swept} draft invoice(s) updated` : ''}`
        : `Saved — ${result.remaining_pending} line(s) still need a price`);
      await fetchOrder();
    } catch (err) {
      if (isBelowCostApprovalHandledError(err)) return;
      // Retire the key only when the refusal proves nothing ran under it; keep it on 'receipt'.
      const bindingRejection = getIdempotencyBindingRejection(err);
      if (bindingRejection === 'intent' || bindingRejection === 'actor') priceOrderIdem.resetKey();
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'price_order' } });
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) toast('error', 'Only admin or sales can price orders.');
      else toast('error', sanitizeError(err));
    } finally {
      setPricingOrder(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (loadFailed) {
    return (
      <Card>
        <LoadFailedState title="This order could not be loaded" onRetry={retryLoad} />
      </Card>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-16">
        <p className="text-secondary">Order not found</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/orders')}>
          Back to Orders
        </Button>
      </div>
    );
  }

  const sections = [...new Set((editing ? editItems : items).map((i) => i.section_name || 'General'))];
  const displayItems = editing ? editItems : items;
  // AR derived from invoices (single source of truth — never use order.total_paid / balance_due)
  const totalInvoicedCents = invoices.reduce((sum, inv) => sum + (inv.total_amount_cents || 0), 0);
  const totalPaidCents = invoices.reduce((sum, inv) => sum + (inv.paid_amount_cents || 0) + (inv.prepay_applied_cents || 0), 0);
  const balanceCents = invoices.reduce((sum, inv) => sum + (inv.balance_cents || 0), 0);
  // Written-off amount on the linked invoices. balance_cents is a generated column
  // (total − paid − prepay − write_off), so write-offs are already reflected in
  // Balance Due; surfacing them as their own tile makes Amount Paid + Written Off +
  // Balance Due reconcile to Total Invoiced when part of an invoice was written off.
  const writeOffCents = invoices.reduce((sum, inv) => sum + (inv.write_off_cents || 0), 0);
  const totalInvoiced = totalInvoicedCents / 100;
  const totalPaid = totalPaidCents / 100;
  const balanceDue = balanceCents / 100;
  const writeOff = writeOffCents / 100;

  // Bill split is locked once an invoice on this order is posted/paid/overdue —
  // editing the order_shares row would drift from the invoice's historical
  // invoice_shares snapshot. Enforced at DB level by the
  // prevent_order_shares_edit_after_post() trigger; this is just the UI half.
  // Also frozen once a completed delivery is billed (BILL_SPLIT_FROZEN) or a draft bills the sale to one
  // customer (BILL_SPLIT_HAS_DRAFT), in the database's order.
  const splitLock = billSplitLock(invoices, deliveries);
  const sharesLocked = !!splitLock;
  const linesWithOwnSplit = new Set(lineShares.map((ls) => ls.order_item_id));
  // Each card payer's live amount, the main customer with whatever is left, as the split writer bills it.
  const cardLive = cardLiveCents(items, linesWithOwnSplit,
    shares.map((sh) => ({ customer_id: sh.customer_id, pct: sh.split_percentage })), order?.customer_id ?? '');
  // The split editors follow the lock, not the delivery status: a split the database refused to bill stays open.
  const canEditSplit = canEditBillSplit(role, order?.status);
  // Why Who pays is locked, in the card's words, linking the delivery or invoice that locks it.
  const splitLockNote = (() => {
    if (!splitLock) return null;
    const n = splitLock.number ?? '';
    const named = n ? `${n} ` : '';
    if (splitLock.kind === 'delivery') {
      const d = deliveries.find((x) => x.delivery_number === splitLock.number);
      return { text: `Delivery ${named}is complete and billed. To change who pays, void its invoices or the delivery first.`, href: d && `/deliveries/${d.id}`, linkLabel: n };
    }
    const inv = invoices.find((x) => x.invoice_number === splitLock.number);
    const href = inv && `/invoices/${inv.id}`;
    return splitLock.kind === 'posted'
      ? { text: `Invoice ${named}is posted. To change who pays, void it first.`, href, linkLabel: n }
      : { text: `Draft invoice ${named}bills this sale to one customer. To change who pays, remove that draft first.`, href, linkLabel: n };
  })();

  const canPostInvoices = role === 'admin' || role === 'sales_rep';
  // Who each invoice bills, and the payer's share of the card when every line follows it.
  const payerName = (customerId: string) =>
    (customerId === order.customer_id ? customer?.farm_name : undefined)
    ?? shares.find((sh) => sh.customer_id === customerId)?.customer_name
    ?? lineShares.find((ls) => ls.customer_id === customerId)?.customer?.farm_name
    ?? custNames[customerId] ?? '';
  const cardSharePct = (customerId: string) => {
    const own = shares.filter((sh) => sh.customer_id === customerId).map((sh) => sh.split_percentage);
    const left = customerId === order.customer_id ? sharesLeft(shares.map((sh) => sh.split_percentage)) : 0;
    return Math.round(own.reduce((a, p) => a + p, left) * 100) / 100;
  };
  const showSharePct = shares.length > 0 && linesWithOwnSplit.size === 0 && !hasAllocations;
  const saleInvoices = invoices.map((inv) => ({
    id: inv.id,
    number: inv.invoice_number,
    payerName: payerName(inv.customer_id),
    sharePct: showSharePct && inv.invoice_group_id ? cardSharePct(inv.customer_id) : undefined,
    status: inv.status,
    total: inv.total_amount_cents / 100,
    balance: inv.balance_cents / 100,
    paid: ((inv.paid_amount_cents || 0) + (inv.prepay_applied_cents || 0)) / 100,
    typeLabel: inv.invoice_type && inv.invoice_type !== 'chemical_sale'
      ? inv.invoice_type.charAt(0).toUpperCase() + inv.invoice_type.slice(1).replace(/_/g, ' ')
      : undefined,
  }));
  // Under Balance due: how many invoices and whether they are drafts, e.g. "2 invoices, both drafts".
  // Voided and cancelled invoices owe nothing, so they are left out of the note.
  const owingInvoices = invoices.filter((inv) => inv.status !== 'voided' && inv.status !== 'cancelled');
  const draftCount = owingInvoices.filter((inv) => inv.status === 'draft' || inv.status === 'unposted').length;
  const invCount = owingInvoices.length;
  const balanceNote = invCount === 0 ? undefined : `${invCount} invoice${invCount === 1 ? '' : 's'}, ${
    draftCount === 0 ? (invCount === 1 ? 'posted' : 'all posted')
      : draftCount === invCount ? (invCount === 1 ? 'a draft' : invCount === 2 ? 'both drafts' : 'all drafts')
        : `${draftCount} draft${draftCount === 1 ? '' : 's'}`}`;
  const canSetSalesTax = (isAdmin || (role === 'sales_rep' && order.salesman_id === profile?.id))
    && order.status !== 'cancelled' && order.status !== 'voided';
  const standingDiscount = Number(customer?.standing_discount_pct ?? 0);
  const subtitle = [
    customer?.farm_name || 'Unknown customer',
    order.customer_po_number && `PO ${order.customer_po_number}`,
    `Ordered ${new Date(order.order_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    salesmanName && `Sales: ${salesmanName}`,
  ].filter(Boolean).join(' · ');
  // Delivered share of the products, by dollar value.
  const orderedValue = items.reduce((sum, i) => sum + i.total_units_needed * i.price_per_unit, 0);
  const deliveredValue = items.reduce((sum, i) => sum + Math.min(i.quantity_delivered, i.total_units_needed) * i.price_per_unit, 0);
  // "All delivered" only when every line is; a rounded percent caps at 99 while anything remains.
  const allDelivered = items.every((i) => i.quantity_delivered >= i.total_units_needed);
  const deliveredPct = orderedValue > 0 ? (allDelivered ? 100 : Math.min(99, Math.round((deliveredValue / orderedValue) * 100))) : null;
  const showSectionNames = sections.length > 1 || sections[0] !== 'General';
  const pill = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium';
  const lineInput = 'w-full xl:w-24 px-2 py-1 min-h-11 md:min-h-0 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green';
  // Below xl a line is a card: a two-column grid when reading, stacked fields when editing.
  const rowClass = editing
    ? 'flex flex-col gap-2 border-t border-gray-100 px-5 py-3 xl:table-row xl:p-0'
    : 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-gray-100 px-5 py-3 xl:table-row xl:p-0';
  const cell = 'xl:table-cell xl:px-3 xl:py-3 xl:align-top';
  const editCell = editing ? `flex items-center justify-between gap-3 ${cell}` : `hidden ${cell}`;
  const mobileLabel = (text: string) => <span aria-hidden="true" className="text-sm text-secondary xl:hidden">{text}</span>;

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[
        { label: 'Orders', href: '/orders' },
        { label: order?.order_number || 'Order' },
      ]} />
      <RecordVersionConflictDialog
        open={conflictDialogOpen}
        entityLabel="order"
        onKeepEditing={() => setConflictDialogOpen(false)}
        onReload={reloadConflictingOrder}
      />
      {editing && orderConflict && (
        <Card>
          <p role="status">This order needs a refresh before saving. Your unsaved edits are still shown. Copy anything you want to keep, then reload and reconcile with the saved order.</p>
          <Button variant="secondary" onClick={() => setConflictDialogOpen(true)}>Review reload options</Button>
        </Card>
      )}
      <TransactionThread
        quoteId={parentQuote?.id}
        quoteNumber={parentQuote?.quote_number}
        orderId={order.id}
        orderNumber={order.order_number}
        deliveries={deliveries.map(d => ({ id: d.id, number: d.delivery_number }))}
        invoices={invoices.map(i => ({ id: i.id, number: i.invoice_number }))}
        invoicesMayBeHidden={!isAdmin}
        currentEntity="order"
        currentEntityId={order.id}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-semibold text-nav-dark md:text-3xl">{order.order_number}</h1>
            <span className={`${pill} ${order.status === 'cancelled' || order.status === 'voided' ? 'bg-red-100 text-red-800' : order.status === 'partially_fulfilled' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
              {statusLabel(order.status)}
            </span>
            <MenuTrigger>
              <RACButton
                isDisabled={togglingPlanned}
                className={`${pill} min-h-11 border border-gray-300 bg-white text-nav-dark hover:bg-gray-50 data-[disabled]:opacity-50 md:min-h-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-crx-green`}
              >
                {togglingPlanned ? '...' : order.is_planned ? 'Planned' : 'Committed'}
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </RACButton>
              <Popover placement="bottom start" className="min-w-48 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg outline-none">
                <Menu className="outline-none" onAction={() => void handleTogglePlanned()}>
                  <MenuItem id="toggle" className="cursor-pointer rounded-md px-2.5 py-3 text-sm text-nav-dark outline-none data-[focused]:bg-crx-green-tint data-[hovered]:bg-crx-green-tint md:py-2.5">
                    {order.is_planned ? 'Mark as committed' : 'Mark as planned'}
                  </MenuItem>
                </Menu>
              </Popover>
            </MenuTrigger>
            {order.needs_split_billing && (
              <span className={`${pill} bg-amber-100 text-amber-800`} title="This delivered order has field allocations, so its auto-invoice was skipped. Use Create split invoices to bill it.">
                Needs split billing
              </span>
            )}
          </div>
          {order.order_name && <p className="mt-0.5 text-base font-medium text-nav-dark">{order.order_name}</p>}
          <p className="mt-1 text-sm text-secondary">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Button variant="ghost" className="min-h-11 md:min-h-0" icon={<X className="w-4 h-4" />} showChevron={false} disabled={saving} onClick={() => {
                const loaded = loadedDraftRef.current;
                setEditItems(loaded.items.map((i) => ({ ...i })));
                setEditRowVersion(loaded.rowVersion);
                setEditing(false);
                setNewItems([]);
                void fetchOrder();
              }}>
                Cancel
              </Button>
              <Button className="min-h-11 md:min-h-0" icon={<Save className="w-4 h-4" />} onClick={handleSaveEdits} loading={saving}>
                Save changes
              </Button>
            </>
          ) : (
            <>
              {order.booking_draw && (role === 'admin' || role === 'sales_rep') && order.status !== 'cancelled' && order.status !== 'voided' && (
                <span className="text-xs text-secondary" title="This order was created by a booking draw-down. Its items mirror the booking ledger, so they can't be edited here — void or cancel the order to return quantity to the booking, then draw again.">
                  Booking draw — items locked
                </span>
              )}
              {canEdit && (
                <Button
                  variant="secondary"
                  className="min-h-11 md:min-h-0"
                  icon={<Pencil className="w-4 h-4" />}
                  showChevron={false}
                  // Wait for the planned toggle's reload, or the editor would open on the pre-toggle version.
                  disabled={togglingPlanned}
                  onClick={() => { setEditing(true); }}
                >
                  Edit order
                </Button>
              )}
              {/* U7 SAFE-SCOPE: a delivered field/acre-allocated order that should be split-billed
                  per owner (complete_delivery skipped the mono-bill auto-draft to avoid over-billing
                  undelivered quantity). Gate on the DERIVABLE state, not the needs_split_billing
                  flag: hasAllocations + fully delivered (status='fulfilled', so the whole-order
                  create_split_invoices_from_order can't over-bill) + no active invoice + no open
                  delivery. Deriving it (rather than requiring needs_split_billing=true) means a
                  fulfilled allocated order whose split group was later VOIDED (flag already cleared,
                  hasActiveInvoice now false) can be RE-billed here — Codex R2 P2. The
                  needs_split_billing flag remains as the Orders-list queue badge/filter. */}
              {hasAllocations && order.status === 'fulfilled' && !hasActiveInvoice && !hasPendingDelivery && (<span className="inline-flex items-center">
                <Button
                  variant="secondary"
                  className="min-h-11 md:min-h-0"
                  icon={<FileText className="w-4 h-4" />}
                  showChevron={false}
                  onClick={handleCreateInvoice}
                  loading={creatingInvoice}
                >
                  Create split invoices
                </Button>
                <HelpTip
                  text="This order has field/acre allocations, so its auto-invoice was skipped on delivery to avoid over-billing. Generates one draft invoice per field owner, split by acres — nothing is sent to the customer yet."
                  className="ml-1"
                />
              </span>)}
              {order.status !== 'cancelled' && order.status !== 'fulfilled' && (<span className="inline-flex items-center">
                <Button
                  className="min-h-11 md:min-h-0"
                  icon={<Truck className="w-4 h-4" />}
                  onClick={() => navigate(`/deliveries/new?order=${order.id}`)}
                >
                  Schedule delivery
                </Button>
                <HelpTip text="Creates a new delivery from this order's items. The driver will see it on their dashboard and can start it when ready." className="ml-1" />
              </span>)}
              <ActionMenu
                label="Print"
                trigger={{ text: 'Print', variant: 'secondary', icon: <Printer className="h-4 w-4" aria-hidden="true" /> }}
                items={[
                  { id: 'summary', label: 'Order summary PDF', icon: <Printer className="h-4 w-4" />, disabled: printingSummary, onAction: () => void handlePrintSummary() },
                  { id: 'pick', label: 'Pick list PDF', icon: <ClipboardList className="h-4 w-4" />, disabled: printingPickList, onAction: () => void handlePrintPickList() },
                ]}
              />
              <ActionMenu
                label="More actions"
                items={[
                  { id: 'task', label: 'Create task', icon: <MessageSquarePlus className="h-4 w-4" />, onAction: () => setQuickTaskOpen(true) },
                  { id: 'payment', label: 'Record payment', icon: <DollarSign className="h-4 w-4" />, onAction: () => navigate('/payments') },
                  // #67: the only manual order-status transition the handler allows is → cancelled;
                  // fulfilled/partially_fulfilled are auto-derived when deliveries complete.
                  ...(isAdmin && (order.status === 'confirmed' || order.status === 'partially_fulfilled') ? [{
                    id: 'cancel', danger: true, icon: <X className="h-4 w-4" />,
                    label: order.status === 'partially_fulfilled' ? 'Cancel remaining quantity…' : 'Cancel order…',
                    // F1: no per-open reset. cancel_order takes only
                    // (p_order_id, p_performed_by, p_idempotency_key) — nothing varies
                    // between attempts, so reopening this dialog is the SAME intent and a
                    // fresh key would let an ambiguous first attempt cancel twice.
                    onAction: () => { setPendingStatus('cancelled'); setStatusConfirmOpen(true); },
                  }] : []),
                  ...(isAdmin && order.status === 'fulfilled' ? [{
                    id: 'void', danger: true, icon: <X className="h-4 w-4" />, label: 'Void order…', onAction: () => setVoidModalOpen(true),
                  }] : []),
                ]}
              />
            </>
          )}
        </div>
      </div>

      {/* Ship-now/price-later (#2): finalize pricing for a rush order */}
      {order.pricing_status === 'needs_pricing' && (role === 'admin' || role === 'sales_rep') && (
        <Card>
          <CardHeader title="Set Pricing" />
          <div className="p-5 space-y-3">
            <p className="text-sm text-secondary">
              This order shipped before pricing was finalized. Enter the final price per unit for each line — its invoice cannot be posted until pricing is complete.
            </p>
            {items.filter((i) => i.pricing_pending).map((i) => (
              <div key={i.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{i.product_name}</span>
                  <span className="text-xs text-secondary ml-2">{i.total_units_needed}{i.unit_size ? ` ${i.unit_size}` : ''}</span>
                </div>
                {i.suggested_price != null && (
                  <span className="text-xs text-secondary whitespace-nowrap">tier: {fmt(i.suggested_price)}</span>
                )}
                <input
                  type="number"
                  step="any"
                  min={0}
                  value={priceInputs[i.id] ?? ''}
                  onChange={(e) => setPriceInputs((p) => ({ ...p, [i.id]: e.target.value }))}
                  placeholder="price/unit"
                  aria-label={`Price per unit for ${i.product_name}`}
                  className="w-28 px-2 py-1 text-sm text-right border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
            ))}
            <div className="flex justify-end">
              <Button onClick={handlePriceOrder} loading={pricingOrder} icon={<DollarSign className="w-4 h-4" />} showChevron={false}>
                Finalize Pricing
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Active delivery banner — shows when scheduled/in_progress deliveries exist */}
      {(() => {
        const activeDeliveries = deliveries.filter((d) => d.status === 'scheduled' || d.status === 'in_progress');
        if (activeDeliveries.length === 0) return null;
        const scheduledCount = activeDeliveries.filter((d) => d.status === 'scheduled').length;
        const inProgressCount = activeDeliveries.filter((d) => d.status === 'in_progress').length;
        const parts: string[] = [];
        if (scheduledCount > 0) parts.push(`${scheduledCount} scheduled`);
        if (inProgressCount > 0) parts.push(`${inProgressCount} in progress`);
        return (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-blue-50 border border-blue-200">
            <Truck className="w-5 h-5 text-blue-600 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-800">
                {activeDeliveries.length} active {activeDeliveries.length === 1 ? 'delivery' : 'deliveries'} — {parts.join(', ')}
              </p>
              <div className="flex flex-wrap gap-2 mt-1">
                {activeDeliveries.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => navigate(`/deliveries/${d.id}`)}
                    className="text-xs text-blue-700 hover:text-blue-900 underline"
                  >
                    {d.delivery_number} — {parseLocalDate(d.scheduled_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {d.driver_name ? ` (${d.driver_name})` : ''}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* AR derived from linked invoices (single source of truth). Non-admins only see invoices they
          created or are the salesperson on (invoices RLS), so for them these totals can be partial or
          empty even when the order is billed and paid — never show a bare $0.00. */}
      <SaleMoneySummary
        saleTotal={order.total_price}
        invoiced={!isAdmin && invoices.length === 0 ? null : totalInvoiced}
        paid={totalPaid}
        balanceDue={balanceDue}
        balanceNote={balanceNote}
        writtenOff={writeOff}
        // Cost is admin-only (Mason, 2026-10-15): no profit/margin for reps or field staff.
        showProfit={isAdmin}
        profit={order.total_profit}
        marginPct={order.total_margin_pct}
        invoiceNote={isAdmin ? null : invoices.length === 0
          ? "You can't view any invoices for this order. Ask the office whether it has been billed or paid."
          : 'These totals include only the invoices you created or are the salesperson on. The office sees the full amounts.'}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* The rail comes first, so below lg it sits above Products. */}
        <div className="grid min-w-0 gap-4 md:grid-cols-2 md:items-start lg:col-start-2 lg:row-start-1 lg:grid-cols-1">
          {/* Keyed by sale: the page is reused across /orders/:id, so a dialog opened on one sale must not stay open on the next. */}
          <SaleInvoicesCard
            key={order.id}
            invoices={saleInvoices}
            canPost={canPostInvoices}
            onPostAll={handlePostAllDrafts}
            posting={postingAll}
            emptyText={isAdmin ? undefined : 'No invoices you can view on this sale.'}
          />

          {/* Who pays (the Bill Split card) */}
          {(shares.length > 0 || lineShares.length > 0 || canEditSplit) && (
            <WhoPaysCard
              mainCustomerName={customer?.farm_name || 'The main customer'}
              // Live, not the amount saved when the share was added: it follows price edits and line splits.
              // A share held by the main customer folds into the main row in cardLive, so it is worked out from its percent.
              shares={shares.map((sh) => ({
                id: sh.id,
                customerName: sh.customer_name,
                pct: sh.split_percentage,
                amount: sh.customer_id === order.customer_id ? undefined : (cardLive.get(sh.customer_id) ?? 0) / 100,
              }))}
              productsTotal={[...cardLive.values()].reduce((a, c) => a + c, 0) / 100}
              lock={splitLockNote}
              fieldSplitBills={hasAllocations}
              canEdit={canEditSplit}
              saving={savingShares}
              onAdd={handleAddShare}
              onRemove={(shareId) => void handleRemoveShare(shareId)}
              picked={newShareCustomerId ? { id: newShareCustomerId, name: newShareCustomerName } : null}
              someLinesOwnSplit={linesWithOwnSplit.size > 0}
              customerPicker={
                <CustomerSearchPicker
                  value={newShareCustomerId}
                  selectedLabel={newShareCustomerName}
                  onSelect={(c) => {
                    setNewShareCustomerId(c?.id ?? '');
                    setNewShareCustomerName(c?.farm_name ?? '');
                  }}
                  excludeIds={shares.map((s) => s.customer_id)}
                  placeholder="Search customer..."
                  ariaLabel="Bill split customer"
                  disabled={savingShares}
                  // A 44px touch target below md.
                  className="[&_input]:min-h-11 md:[&_input]:min-h-0"
                />
              }
              // Not when the field split failed to load: its lines would show an editor whose shares don't bill.
              lineSplit={!hasAllocations && !allocLoadFailed && items.length > 0 && (lineShares.length > 0 || (canEditSplit && !sharesLocked)) ? (
                <LineBillSplit
                  items={items}
                  lineShares={lineShares}
                  hasCard={shares.length > 0}
                  mainCustomerName={customer?.farm_name || 'the main customer'}
                  canEdit={canEditSplit}
                  locked={sharesLocked}
                  onChanged={() => fetchOrder()}
                  // The card's "Split by line" disclosure is the one click.
                  startOpen
                />
              ) : undefined}
            />
          )}

          <Card>
            <section aria-labelledby="billing-title" className="flex flex-col gap-2">
              <h2 id="billing-title" className="font-heading text-xl font-semibold text-nav-dark">Billing</h2>
              {/* The sales tax switch (billing plan M4a): an admin or the sale's own rep. The database applies it
                  to the sale's draft invoices; posted ones keep their tax. */}
              <Switch
                label="Charge sales tax"
                description={`${salesTaxRate ? `${salesTaxRate}%, set` : 'Set'} in Settings › Billing. Posted invoices keep the tax they had.`}
                isSelected={!!order.sales_tax}
                isDisabled={savingSalesTax || !canSetSalesTax}
                onChange={() => void handleToggleSalesTax()}
              />
              {standingDiscount > 0 && customer && (
                <div className="flex items-start justify-between gap-3 border-t border-gray-100 pt-3">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium text-nav-dark">Standing discount {standingDiscount}%</span>
                    <span className="text-sm text-secondary">{customer.farm_name}&apos;s rate, off products before tax</span>
                  </span>
                  <Link to={`/customers/${customer.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-crx-green underline hover:text-crx-green-hover md:min-h-0">
                    Customer
                  </Link>
                </div>
              )}
            </section>
          </Card>
        </div>

        <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1">
          <Card padding={false}>
            <section aria-labelledby="products-title">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3">
                <h2 id="products-title" className="font-heading text-xl font-semibold text-nav-dark">Products</h2>
                {!editing && deliveredPct !== null && (
                  <span className="flex items-center gap-2 text-sm font-medium text-crx-green">
                    <span role="img" aria-label={`${deliveredPct} percent delivered`} className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-gray-100 md:block">
                      <span className="block h-full rounded-full bg-crx-green" style={{ width: `${deliveredPct}%` }} />
                    </span>
                    {deliveredPct === 100 ? 'All delivered' : `${deliveredPct}% delivered`}
                  </span>
                )}
              </div>
              {/* A narrow main column at xl scrolls the table, never the page. */}
              <div className="xl:overflow-x-auto">
              <table className="block w-full text-sm xl:table">
                <thead className="hidden bg-cream/60 xl:table-header-group">
                  <tr>
                    <th scope="col" className="px-5 py-2.5 text-left font-medium text-secondary">Product</th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium text-secondary">Vendor</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium text-secondary">Price</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium text-secondary">Ordered</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium text-secondary">Delivered</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium text-secondary">Left</th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium text-secondary">Line total</th>
                    {editing && <th scope="col" className="w-10"><span className="sr-only">Remove</span></th>}
                  </tr>
                </thead>
                <tbody className="block xl:table-row-group">
                  {sections.map((section) => (
                    <Fragment key={section}>
                      {showSectionNames && (
                        <tr className="block border-t border-gray-100 xl:table-row">
                          <th scope="colgroup" colSpan={editing ? 8 : 7} className="block px-5 pt-3 pb-1 text-left text-xs font-semibold uppercase tracking-wide text-secondary xl:table-cell">
                            {section}
                          </th>
                        </tr>
                      )}
                      {displayItems
                        .filter((i) => (i.section_name || 'General') === section)
                        .map((item) => {
                          const units = item.total_units_needed;
                          const ppu = item.price_per_unit;
                          const left = units - item.quantity_delivered;
                          const name = item.product_name || 'Line';
                          const lineTotal = editing || item.total_price == null ? exactRound2([ppu, units]) : item.total_price;
                          return (
                            <tr key={item.id} className={rowClass}>
                              <td className={`min-w-0 ${cell} xl:pl-5`}>
                                <span className="block break-words font-medium text-nav-dark">{item.product_name}</span>
                                {(item.unit_size || item.vendor) && (
                                  <span className="block text-xs text-secondary">
                                    {item.unit_size}
                                    {item.vendor && <span className="xl:hidden">{item.unit_size ? ' · ' : ''}{item.vendor}</span>}
                                  </span>
                                )}
                                {!editing && (
                                  <span className="mt-1 block text-sm text-secondary xl:hidden">
                                    {`${units} at ${fmt(ppu)} · ${item.quantity_delivered} delivered`}
                                  </span>
                                )}
                              </td>
                              <td className={`hidden text-secondary ${cell}`}>{item.vendor || '-'}</td>
                              <td className={`${editCell} xl:text-right tabular-nums`}>
                                {editing ? (<>
                                  {mobileLabel('Price')}
                                  <input
                                    type="number"
                                    aria-label={`Price for ${name}`}
                                    value={ppu}
                                    disabled={saving}
                                    onChange={(e) => updateEditItem(item.id, 'price_per_unit', Number(e.target.value))}
                                    className={`${lineInput} max-w-32`}
                                    step="0.01"
                                  />
                                </>) : fmt(ppu)}
                              </td>
                              <td className={`${editCell} xl:text-right tabular-nums`}>
                                {editing ? (<>
                                  {mobileLabel('Ordered')}
                                  <input
                                    type="number"
                                    aria-label={`Quantity for ${name}`}
                                    value={units}
                                    disabled={saving}
                                    onChange={(e) => updateEditItem(item.id, 'total_units_needed', Number(e.target.value))}
                                    className={`${lineInput} max-w-32`}
                                  />
                                </>) : units}
                              </td>
                              <td className={`hidden xl:text-right tabular-nums ${cell}`}>{item.quantity_delivered}</td>
                              <td className={`hidden xl:text-right tabular-nums ${cell}`}>{left === 0 ? '—' : left}</td>
                              <td className={`${editing ? 'flex justify-between gap-3' : 'text-right'} font-semibold tabular-nums text-nav-dark ${cell} xl:pr-5 xl:text-right`}>
                                {editing && mobileLabel('Line total')}
                                {fmt(lineTotal)}
                              </td>
                              {editing && (
                                <td className={`${cell} self-end`}>
                                  <button
                                    type="button"
                                    aria-label={`Remove ${name}`}
                                    onClick={() => handleDeleteItem(item.id)}
                                    disabled={saving}
                                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-red-400 hover:text-red-600 md:h-9 md:w-9"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                    </Fragment>
                  ))}
                </tbody>
                {editing ? (
                  <tfoot className="block xl:table-footer-group">
                    {/* New items being added */}
                    {newItems.map((ni) => (
                      <tr key={ni._tempKey} className={`${rowClass} bg-green-50/40`}>
                        <td className={`${cell} xl:pl-5 font-medium text-nav-dark`}>
                          <div className="flex items-center gap-1">
                            <Plus className="w-3 h-3 text-crx-green" />
                            {ni.product_name}
                            <span className="text-xs text-crx-green font-normal">(new)</span>
                          </div>
                        </td>
                        <td className={`hidden text-secondary ${cell}`}>-</td>
                        <td className={`${editCell} xl:text-right`}>
                          {mobileLabel('Price')}
                          <input
                            type="number"
                            aria-label={`Price for ${ni.product_name}`}
                            value={ni.price_per_unit}
                            disabled={saving}
                            onChange={(e) => updateNewItem(ni._tempKey, 'price_per_unit', Number(e.target.value))}
                            className={`${lineInput} max-w-32`}
                            step="0.01"
                          />
                        </td>
                        <td className={`${editCell} xl:text-right`}>
                          {mobileLabel('Ordered')}
                          <input
                            type="number"
                            aria-label={`Quantity for ${ni.product_name}`}
                            value={ni.total_units_needed || ''}
                            disabled={saving}
                            onChange={(e) => updateNewItem(ni._tempKey, 'total_units_needed', Number(e.target.value))}
                            className={`${lineInput} max-w-32`}
                            placeholder="Qty"
                          />
                        </td>
                        <td className={`hidden xl:text-right text-secondary ${cell}`}>0</td>
                        <td className={`hidden xl:text-right text-secondary ${cell}`}>{ni.total_units_needed || 0}</td>
                        <td className={`flex justify-between gap-3 font-semibold tabular-nums text-nav-dark ${cell} xl:pr-5 xl:text-right`}>
                          {mobileLabel('Line total')}
                          {fmt(exactRound2([ni.price_per_unit, ni.total_units_needed]))}
                        </td>
                        <td className={`${cell} self-end`}>
                          <button
                            type="button"
                            aria-label={`Remove ${ni.product_name}`}
                            onClick={() => removeNewItem(ni._tempKey)}
                            disabled={saving}
                            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-red-400 hover:text-red-600 md:h-9 md:w-9"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {/* Add product button */}
                    <tr className="block border-t border-dashed border-gray-300 xl:table-row">
                      <td colSpan={8} className="block px-5 py-2 xl:table-cell">
                        <button
                          type="button"
                          onClick={() => { setShowProductModal(true); setProductSearch(''); }}
                          disabled={saving}
                          className="flex min-h-11 items-center gap-2 text-sm text-crx-green hover:text-crx-green/80 font-medium transition-colors md:min-h-0"
                        >
                          <Plus className="w-4 h-4" />
                          Add product
                        </button>
                      </td>
                    </tr>
                    {/* New total */}
                    <tr className="flex justify-between border-t border-gray-200 px-5 py-4 font-semibold text-nav-dark xl:table-row xl:p-0">
                      <td colSpan={6} className="xl:table-cell xl:px-5 xl:py-4">New total</td>
                      <td colSpan={2} className="tabular-nums xl:table-cell xl:px-5 xl:py-4 xl:text-right">
                        {/* Each line as the order functions store it, exact to the cent (To-Do 1.7). */}
                        {fmt(
                          [...editItems, ...newItems].reduce((cents, i) => cents + Math.round(exactRound2([i.price_per_unit, i.total_units_needed]) * 100), 0) / 100
                        )}
                      </td>
                    </tr>
                  </tfoot>
                ) : (
                  <tfoot className="block xl:table-footer-group">
                    <tr className="flex justify-between border-t border-gray-100 px-5 py-4 font-semibold text-nav-dark xl:table-row xl:p-0">
                      <td colSpan={6} className="xl:table-cell xl:px-5 xl:py-4">Products total</td>
                      <td className="tabular-nums xl:table-cell xl:px-5 xl:py-4 xl:text-right">{fmt(order.total_price)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
              </div>
            </section>
          </Card>

          {deliveries.length > 0 && (
            <Card padding={false}>
              <section aria-labelledby="deliveries-title">
                <h2 id="deliveries-title" className="px-5 pt-5 pb-3 font-heading text-xl font-semibold text-nav-dark">Deliveries</h2>
                <ul className="px-2 pb-2">
                  {deliveries.map((del) => (
                    <li key={del.id} className="border-t border-gray-100">
                      <Link to={`/deliveries/${del.id}`} className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-3 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green">
                        <Truck className="h-4 w-4 flex-none text-secondary" aria-hidden="true" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <strong className="font-semibold text-nav-dark">{del.delivery_number}</strong>
                          <span className="text-sm text-secondary">
                            {parseLocalDate(del.scheduled_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {del.driver_name || 'Unassigned'}
                          </span>
                        </span>
                        <Badge variant={statusToBadgeVariant[del.status] || 'default'} size="sm" normalCase>
                          {statusLabel(del.status)}
                        </Badge>
                        <ChevronRight className="h-4 w-4 flex-none text-secondary" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            </Card>
          )}

          {/* Split by field (multi-field split invoicing) */}
          {(hasAllocations || canEdit) && (
            <Card>
              <h2 className="mb-1 font-heading text-xl font-semibold text-nav-dark">Split by field</h2>
              <p className="text-sm text-secondary mb-3">
                Bill a line to the owners of the fields it went on, by acres. When a sale uses it, it decides who pays instead of Who pays.
                {allocLoadFailed
                  ? <span className="text-red-600"> Field details failed to load — refresh to try again.</span>
                  : allocFields.length === 0 && <span className="text-amber-600"> No active fields are set up yet.</span>}
              </p>

              <div className="space-y-3">
                {items.map((it) => {
                  const lineAllocs = allocations.filter((a) => a.order_item_id === it.id);
                  const used = new Set(lineAllocs.map((a) => a.field_id));
                  const isOpen = allocEditorItemId === it.id;
                  return (
                    <div key={it.id} className="border border-gray-100 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-nav-dark">{it.product_name || 'Line'}</div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-secondary">{fmt(it.total_price)}</span>
                          {/* Not while the split details failed to load: the line's existing fields are unknown. */}
                          {canEdit && !isOpen && !allocLoadFailed && (
                            <Button variant="ghost" size="sm" className="min-h-11 md:min-h-0" icon={<Plus className="w-4 h-4" />} showChevron={false}
                              onClick={() => { setAllocEditorItemId(it.id); setNewAllocFieldId(''); setNewAllocAcres(''); }}>
                              Field
                            </Button>
                          )}
                        </div>
                      </div>

                      {lineAllocs.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {lineAllocs.map((a) => {
                            const fld = allocFields.find((f) => f.id === a.field_id);
                            return (
                              <div key={a.id} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1">
                                <span className="text-nav-dark">{fld?.field_name || 'Field'} — {Number(a.acres)} ac</span>
                                {canEdit && (
                                  <button type="button" aria-label={`Remove ${fld?.field_name || 'field'}`} onClick={() => handleRemoveAllocation(a.id)} disabled={savingAlloc}
                                    className="inline-flex h-11 w-11 flex-none items-center justify-center text-red-400 hover:text-red-600 disabled:opacity-50 md:h-auto md:w-auto">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {isOpen && (
                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
                          <div className="sm:col-span-2">
                            <label className="text-[11px] font-medium text-secondary mb-1 block">Field</label>
                            <select value={newAllocFieldId} disabled={savingAlloc}
                              onChange={(e) => {
                                setNewAllocFieldId(e.target.value);
                                const f = allocFields.find((x) => x.id === e.target.value);
                                if (f && f.total_acres != null) setNewAllocAcres(String(f.total_acres));
                              }}
                              className="min-h-11 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green md:min-h-0">
                              <option value="">Select field...</option>
                              {allocFields.filter((f) => !used.has(f.id)).map((f) => (
                                <option key={f.id} value={f.id}>{f.field_name}{f.total_acres != null ? ` (${f.total_acres} ac)` : ' (no acres on file)'}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-[11px] font-medium text-secondary mb-1 block">Acres</label>
                            <input type="number" value={newAllocAcres} onChange={(e) => setNewAllocAcres(e.target.value)} disabled={savingAlloc}
                              min="0.01" step="0.01" placeholder="acres"
                              className="min-h-11 md:min-h-0 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" />
                          </div>
                          <div className="sm:col-span-3 flex items-center justify-end gap-2">
                            <Button variant="ghost" size="sm" className="min-h-11 md:min-h-0" onClick={() => setAllocEditorItemId(null)}>Cancel</Button>
                            <Button size="sm" className="min-h-11 md:min-h-0" loading={savingAlloc} disabled={!newAllocFieldId || !newAllocAcres}
                              onClick={() => handleAddAllocation(it.id)}>Add</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {splitPreview && splitPreview.length > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <div className="flex items-center gap-2 mb-2">
                    <DollarSign className="w-4 h-4 text-crx-green" />
                    <span className="text-xs font-semibold text-nav-dark">Projected split (approx.) — one invoice per customer</span>
                  </div>
                  <div className="space-y-1">
                    {splitPreview.map((p) => (
                      <div key={p.customer_id} className="flex items-center justify-between text-xs px-2 py-1 bg-green-50 rounded">
                        <span className="text-nav-dark">{p.name}</span>
                        <span className="font-semibold text-crx-green">{fmt(p.amount)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-secondary mt-2">Exact penny amounts are computed when you create the invoice.</p>
                </div>
              )}
            </Card>
          )}

          {order.notes && (
            <Card>
              <div className="flex items-start gap-3">
                <FileText className="w-4 h-4 text-secondary mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-secondary font-medium mb-1">Order notes <HelpTip text="Notes about this order that carry through to the load sheet and delivery. Use for special instructions like 'Call before delivering'." className="ml-1" /></p>
                  <p className="text-sm text-nav-dark whitespace-pre-wrap">{order.notes}</p>
                </div>
              </div>
            </Card>
          )}

          {/* Related Notes */}
          <RelatedNotes
            entityType={'order' as LinkedEntityType}
            entityId={id!}
            onCreateTask={() => setQuickTaskOpen(true)}
          />
        </div>
      </div>

      {/* Void Order Modal */}
      <Modal open={voidModalOpen} onClose={() => { setVoidModalOpen(false); setVoidReason(''); }} title="Void this order?">
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-red-50 rounded-lg border border-red-200">
            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div className="text-sm text-red-700 space-y-1">
              <p className="font-semibold">This action cannot be undone.</p>
              <ul className="list-disc list-inside space-y-0.5 text-red-600">
                <li>Inventory will be restored for all delivered items</li>
                <li>Draft invoices will be voided</li>
                <li>Pending commissions will be cancelled</li>
                <li>Posted invoices and paid commissions require manual review</li>
              </ul>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">
              Reason <span className="text-secondary font-normal">(optional)</span>
            </label>
            <textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. Customer cancelled, duplicate order, data entry error..."
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-400 resize-none"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => { setVoidModalOpen(false); setVoidReason(''); }} disabled={voiding}>
              Cancel
            </Button>
            <Button
              onClick={handleVoidOrder}
              loading={voiding}
              disabled={voiding}
              className="bg-red-600 hover:bg-red-700 text-white border-red-600 hover:border-red-700"
            >
              Void Order
            </Button>
          </div>
        </div>
      </Modal>

      {/* Add Product to Order Modal */}
      <Modal
        open={showProductModal}
        onClose={() => setShowProductModal(false)}
        title="Add Product to Order"
        size="large"
      >
        <div className="space-y-4">
          <Input
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            placeholder="Search products..."
          />

          <div className="max-h-96 overflow-y-auto space-y-2">
            {!productsLoading && filteredProducts.map((product) => {
              const tierNum = customer?.assigned_tier || 1;
              // Cascade: tier3 → tier2 → tier1 fallback
              const t1 = product.tier1_price || 0;
              const tierPrice =
                tierNum === 1
                  ? t1
                  : tierNum === 2
                    ? product.tier2_price || t1
                    : product.tier3_price || t1;
              const inv = inventoryByProduct[product.id];
              const onFloor = inv ? inv.available : 0;
              const netPos = inv ? inv.onOrder + inv.available - inv.prebooked : 0;

              // Check if product is already in order (existing or newly added)
              const alreadyInOrder = editItems.some((ei) => ei.product_id === product.id) ||
                newItems.some((ni) => ni.product_id === product.id);

              return (
                <button
                  key={product.id}
                  onClick={() => handleAddProduct(product)}
                  disabled={alreadyInOrder}
                  className={`w-full text-left p-3 border rounded-lg transition-colors ${
                    alreadyInOrder
                      ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                      : 'border-gray-200 hover:border-crx-green hover:bg-gray-50'
                  }`}
                >
                  <div className="font-medium text-nav-dark">
                    {product.product_name}
                    {alreadyInOrder && (
                      <span className="text-xs text-secondary ml-2">(already in order)</span>
                    )}
                  </div>
                  <ProductOptionDetails product={product} />
                  {product.manufacturer && (
                    <div className="text-xs text-secondary mt-1">{product.manufacturer}</div>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-secondary">
                    {product.unit_size && <span>Size: {product.unit_size}</span>}
                    {tierPrice > 0 && (
                      <span className="text-crx-green font-medium">
                        Price:{' '}
                        {new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD',
                        }).format(tierPrice)}
                      </span>
                    )}
                    <span className={onFloor > 0 ? 'text-blue-600' : 'text-gray-400'}>
                      On Floor: {onFloor.toLocaleString()}
                    </span>
                    <span className={netPos > 0 ? 'text-emerald-600' : netPos < 0 ? 'text-red-600' : 'text-gray-400'}>
                      Net: {netPos.toLocaleString()}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {productsLoading ? (
            <div role="status" className="text-center py-8 text-secondary">Loading products...</div>
          ) : productsLoadFailed ? (
            <div role="alert" className="text-center py-8 text-red-600">
              Products could not be loaded. Leave edit mode and edit again to retry.
            </div>
          ) : filteredProducts.length === 0 && (
            <div className="text-center py-8 text-secondary">No products found</div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={statusConfirmOpen}
        onClose={() => setStatusConfirmOpen(false)}
        onConfirm={executeStatusChange}
        title={order?.status === 'partially_fulfilled' ? 'Cancel the rest of this order?' : 'Cancel this order?'}
        message={
          order?.status === 'partially_fulfilled'
            ? 'Cancel only the undelivered remainder? Completed deliveries and their invoices stay intact, undelivered inventory is released, and pending commissions are recalculated to delivered profit. Paid or batched commissions must be voided first. This cannot be undone.'
            : 'Cancel this order? Inventory holds will be released, any draft invoices cancelled, and pending commissions zeroed. Posted invoices or paid commissions are flagged for manual review. This cannot be undone.'
        }
        variant="warning"
        confirmLabel={order?.status === 'partially_fulfilled' ? 'Cancel Remaining' : 'Cancel Order'}
        loading={changingStatus}
      />

      <QuickTaskModal
        open={quickTaskOpen}
        onClose={() => setQuickTaskOpen(false)}
        entityType={'order' as LinkedEntityType}
        entityId={id!}
        prefillTitle={`Follow up: ${order.order_number}`}
        prefillContent={`Customer: ${customer?.farm_name || 'Unknown'}`}
      />

    </div>
  );
}
