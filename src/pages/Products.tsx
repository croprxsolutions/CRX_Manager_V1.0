import { useEffect, useRef, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FileUp, Download, FileText, Eye, EyeOff, ChevronDown, FileSpreadsheet, Upload, Power, PowerOff } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import TypedBrandReview from '../components/products/TypedBrandReview';
import DeliveriesMissingBrands from '../components/deliveries/DeliveriesMissingBrands';
import EditableDataTable, { type EditableColumn } from '../components/ui/EditableDataTable';
import Badge from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import Modal from '../components/ui/Modal';
import CustomerSalesSheetModal from '../components/products/CustomerSalesSheetModal';
import BulkProductImport from '../components/products/BulkProductImport';
import ProductsMobileList from '../components/products/ProductsMobileList';
import QuickPriceChangeModal, { type QuickPriceFields } from '../components/products/QuickPriceChangeModal';
import PricingChangePreviewModal from '../components/products/PricingChangePreviewModal';
import PricingSourceReasonModal, { type PricingSourceReason } from '../components/products/PricingSourceReasonModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, supabaseUntyped, sanitizeError, checkMutationResult, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { isSetupIncomplete, listProductCategories, type SetupFilter } from '../lib/productSetup';
import { CriticalActionHandledError, runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, formatProductMoneyCSV } from '../lib/csvExport';
import { formatUSD as fmt } from '../lib/money';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { SkeletonTable } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import PageHeader from '../components/ui/PageHeader';
import ProductRateLockControl from '../components/products/ProductRateLockControl';
import ProductSetupWorkbookModal from '../components/products/ProductSetupWorkbookModal';
import RateReviewWorkbookModal from '../components/products/RateReviewWorkbookModal';
import { loadProductRateLock } from '../lib/productRateLock';
import type { Product, ProductCategory, ProductRateLock, SalesSheetFormat } from '../types';
import {
  applyProductPricingChangeSet,
  approvePricingChangeSet,
  createPricingWorkbookExport,
  defaultPricingMode,
  formatPricingMarginPercent,
  pricingDollarInputToCents,
  pricingMarginTextIsValid,
  previewProductPricingChanges,
  sha256Hex,
  type PricingAcknowledgement,
  type PricingMode,
  type PricingPreviewInputRow,
  type PricingPreviewResult,
  type PricingSourceFile,
} from '../lib/productPricing';
import {
  groupedUseTimingRefusal,
  MAX_PRICING_WORKBOOK_FILE_BYTES,
  MAX_PRICING_WORKBOOK_ROWS,
} from '../lib/productPricingWorkbook';
import {
  generateProductPricingWorkbookWithSupplierEvidence,
  parseProductPricingWorkbookWithSupplierEvidence,
} from '../lib/productPricingSupplierEvidenceWorkbook';
import { getSupplierMarketEvidence } from '../lib/supplierPricing';
import { PRODUCT_COLUMNS, withAdminCosts } from '../lib/costFields';
import {
  DEFAULT_STALE_COST_AGE_DAYS,
  costAgeDays,
  costAsOfDate,
  formatCostAsOfCSV,
  isCostStale,
} from '../lib/costFreshness';
import { parseLocalDate, todayInBusinessTz } from '../lib/dateUtils';
import {
  fetchMarginFloors,
  formatMarginFloorPercent,
  isMarginFloorRefusal,
  formatNetMarginPercent,
  isUnderMarginFloor,
  marginFloorErrorMessage,
  parseMarginFloorPercent,
  setMarginFloors,
  type MarginFloorChange,
  type SetMarginFloorsResult,
} from '../lib/marginFloors';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { isDefinitiveRpcRejection } from '../lib/idempotency';
import { matchesProductSearch } from '../lib/productSearch';
import { useProductParents } from '../lib/productParents';

const INLINE_PRICING_FIELDS = new Set([
  'pricing_mode',
  'current_cost',
  'tier1_margin_percent',
  'tier2_margin_percent',
  'tier3_margin_percent',
  'tier1_price',
  'tier2_price',
  'tier3_price',
]);

// The vendor is a copy of the preferred vendor (WP-PM-15b); it changes on the product page's Vendors section.
const INLINE_NONPRICING_FIELDS = new Set([
  'product_name',
  'category',
]);

type ActiveReviewEntry = { product_id: string; product_name: string; kind: string; number: string | null; message: string };
type ActiveReview = {
  products: Array<{ id: string; product_name: string; is_active: boolean }>;
  blockers: ActiveReviewEntry[];
  warnings: ActiveReviewEntry[];
  review_token: string;
};

// preview_product_active_change and set_product_active refuse more than 500 products per call.
const MAX_ACTIVE_CHANGE_PRODUCTS = 500;

// Floors live in product_margin_floors, not on the product: the list copies each one onto its row.
const MARGIN_FLOOR_FIELD = 'margin_floor_percent';
type ProductListRow = Product & { [MARGIN_FLOOR_FIELD]?: string };

const INTERNAL_IDENTITY_COLUMNS = [
  { key: 'product_name', header: 'Product Name' },
  { key: 'sku', header: 'SKU' },
  { key: 'category', header: 'Category' },
  { key: 'vendor', header: 'Vendor' },
  { key: 'manufacturer', header: 'Manufacturer' },
  { key: 'container_size', header: 'Container Size' },
  { key: 'unit_size', header: 'Unit' },
  { key: 'epa_registration', header: 'EPA Reg #' },
  { key: 'is_rup', header: 'RUP', format: (value: unknown) => value == null ? '' : value ? 'Yes' : 'No' },
  { key: 'signal_word', header: 'Signal Word' },
  { key: 'rei_hours', header: 'REI Hours' },
  { key: 'phi_days', header: 'PHI Days' },
  { key: 'product_form', header: 'Form' },
  { key: 'inventory_unit', header: 'Inventory Unit' },
  { key: 'container_unit', header: 'Container Unit' },
];

function inputDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim();
}

function storedMarginPercent(value: number | null | undefined): string | null {
  return value == null ? null : formatPricingMarginPercent(value);
}

/** A tier's net margin under its price; red with "under floor" when below the product's floor. */
function NetMarginNote({ margin, floor }: { margin: number; floor: number | undefined }) {
  const under = isUnderMarginFloor(margin, floor);
  return (
    <div className={`text-[11px] ${under ? 'font-semibold text-red-700' : 'text-gray-400'}`}>
      {formatNetMarginPercent(margin, floor)}% net{under ? ` · under ${formatMarginFloorPercent(floor)}% floor` : ''}
    </div>
  );
}

export default function Products() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [products, setProducts] = useState<ProductListRow[]>([]);
  // Grouped sizes take category from their parent (PAR-1); a parent's name or nickname finds its sizes.
  const [parentsReload, setParentsReload] = useState(0);
  const { byProduct: parentByProduct, index: parentIndex } = useProductParents(parentsReload);
  // Product id → parent name, for the pricing workbook's grouped rows.
  const groupedParentNames = useMemo(
    () => new Map([...parentByProduct].map(([productId, parent]) => [productId, parent.name])),
    [parentByProduct],
  );
  const searchProducts = useCallback((row: ProductListRow, search: string) => matchesProductSearch(row, search, parentIndex), [parentIndex]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [rateLock, setRateLock] = useState<ProductRateLock | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [setupFilter, setSetupFilter] = useState<SetupFilter>('');
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryChoices, setCategoryChoices] = useState<ProductCategory[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [bulkProductImportOpen, setBulkProductImportOpen] = useState(false);
  const [setupWorkbookOpen, setSetupWorkbookOpen] = useState(false);
  const [rateReviewOpen, setRateReviewOpen] = useState(false);
  const [activeReview, setActiveReview] = useState<{ ids: string[]; active: boolean; scope: string; result: ActiveReview } | null>(null);
  const activeReviewSeq = useRef(0);
  const [deactivating, setDeactivating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);
  const [showCompliance, setShowCompliance] = useState(false);
  // Once per render, not per row: the "Cost as of" column dates every product against it.
  const costFreshnessToday = todayInBusinessTz();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [salesSheetFormat, setSalesSheetFormat] = useState<SalesSheetFormat | null>(null);
  const [pricingPreview, setPricingPreview] = useState<PricingPreviewResult | null>(null);
  // The uploaded price sheet a workbook preview came from; its approval must name it.
  const [pricingSourceFile, setPricingSourceFile] = useState<PricingSourceFile | null>(null);
  // Inline price edits waiting for their source and reason before the preview.
  const [pendingInlineRows, setPendingInlineRows] = useState<PricingPreviewInputRow[] | null>(null);
  const [previewingInline, setPreviewingInline] = useState(false);
  const [quickPriceProductId, setQuickPriceProductId] = useState<string | null>(null);
  const [applyingPricing, setApplyingPricing] = useState(false);
  const [workbookBusy, setWorkbookBusy] = useState(false);
  const [tableRevision, setTableRevision] = useState(0);
  const [isEditingProducts, setIsEditingProducts] = useState(false);
  const pricingWorkbookInputRef = useRef<HTMLInputElement>(null);

  const previewPricingIdem = useIdempotencyKey('preview_product_pricing_changes', profile?.id || '');
  const approvePricingIdem = useIdempotencyKey('approve_pricing_change_set', profile?.id || '');
  const applyPricingIdem = useIdempotencyKey('apply_product_pricing_change_set', profile?.id || '');
  const exportPricingIdem = useIdempotencyKey('create_pricing_workbook_export', profile?.id || '');
  const marginFloorIdem = useIdempotencyKey('set_product_margin_floors', profile?.id || '');
  const productActiveIdem = useIdempotencyKey('set_product_active', profile?.id || '');
  const [marginFloors, setMarginFloorsByProduct] = useState<Map<string, number>>(new Map());
  const [marginFloorsLoadFailed, setMarginFloorsLoadFailed] = useState(false);
  // Products whose floor this page just saved, so it is known even while the floors failed to load.
  const [marginFloorsKnownFromSave, setMarginFloorsKnownFromSave] = useState<Set<string>>(new Set());

  const canBulkAction = role === 'admin' || role === 'sales_rep';
  const isAdmin = role === 'admin';

  // Only the newest load may install rows: a role change re-runs the loader while an older
  // (possibly cost-less) load is still in flight (Luna round 2).
  const loadSeqRef = useRef(0);
  const fetchProducts = useCallback(async (reportError = true): Promise<boolean> => {
    const seq = ++loadSeqRef.current;
    // A failed load hides the rows, so an open Deactivate dialog for a hidden selection closes too.
    const failLoad = () => {
      setLoadError(true);
      activeReviewSeq.current += 1;
      setActiveReview(null);
    };
    // Paginate so the master catalog never silently truncates as the catalog grows.
    // PostgREST caps a single response (default 1000), so we page through with .range().
    const PAGE_SIZE = 1000;
    const all: Product[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('products')
        .select(PRODUCT_COLUMNS)
        .order('product_name')
        .order('id')
        .range(from, from + PAGE_SIZE - 1);
      if (seq !== loadSeqRef.current) return false;
      if (error) {
        Sentry.captureException(error);
        // A silent reload's caller keeps the rows on screen and explains the failure itself.
        if (reportError) toast('error', 'Failed to load products. Please try again.');
        if (reportError) failLoad();
        setLoading(false);
        return false;
      }
      const batch = (data || []) as Product[];
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    // Cost is admin-only (Mason, 2026-10-15).
    let prods: Product[];
    try {
      prods = await withAdminCosts('products', all, isAdmin);
    } catch (costError) {
      Sentry.captureException(costError);
      if (seq !== loadSeqRef.current) return false;
      if (reportError) toast('error', 'Failed to load products. Please try again.');
      if (reportError) failLoad();
      setLoading(false);
      return false;
    }
    // Margin floors (admin-only) only add warnings: a failed read keeps the catalog and says so.
    let floors = new Map<string, number>();
    let floorsFailed = false;
    if (isAdmin) {
      try {
        floors = await fetchMarginFloors();
      } catch (floorError) {
        Sentry.captureException(floorError, { extra: { context: 'load_product_margin_floors' } });
        floorsFailed = true;
      }
    }
    if (seq !== loadSeqRef.current) return false;
    // The floor rides on each row as typed text, so the inline editor can tell a real edit from
    // the stored value (clearing a floor included).
    setProducts(prods.map((p) => ({ ...p, [MARGIN_FLOOR_FIELD]: formatMarginFloorPercent(floors.get(p.id)) })));
    setMarginFloorsByProduct(floors);
    setMarginFloorsKnownFromSave(new Set());
    setMarginFloorsLoadFailed(floorsFailed);
    if (floorsFailed && reportError) toast('warning', 'Margin floors could not be loaded. Floor warnings are hidden until you refresh.');
    setLoadError(false);

    const cats = [...new Set(prods.map((p) => p.category).filter(Boolean))] as string[];
    const vends = [...new Set(prods.map((p) => p.vendor).filter(Boolean))] as string[];
    setCategories(cats.sort());
    setVendors(vends.sort());
    setLoading(false);
    // The rows are installed either way, but a silent reload's caller must still say the floors
    // are missing (its own warning), so a failed floor read is not reported as a clean reload.
    return !floorsFailed;
  }, [isAdmin, toast]);

  useEffect(() => {
    void fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    listProductCategories().then(setCategoryChoices).catch((error: unknown) => {
      Sentry.captureException(error);
      toast('error', 'Could not load product categories. Refresh before editing a category.');
    });
  }, [toast]);

  const [rateLockFailed, setRateLockFailed] = useState(false);
  const loadRateLock = useCallback(() => {
    setRateLockFailed(false);
    loadProductRateLock().then(setRateLock).catch((error: unknown) => {
      Sentry.captureException(error);
      // An older state may be out of date: show "Couldn't check" instead.
      setRateLock(null);
      setRateLockFailed(true);
    });
  }, []);
  useEffect(loadRateLock, [loadRateLock]);

  const retryProducts = () => {
    setLoading(true);
    void fetchProducts();
  };

  const listFiltered = products.filter((p) => {
    if (categoryFilter && p.category !== categoryFilter) return false;
    if (vendorFilter && p.vendor !== vendorFilter) return false;
    if (statusFilter === 'active' && !p.is_active) return false;
    if (statusFilter === 'inactive' && p.is_active) return false;
    return true;
  });
  const incompleteCount = listFiltered.filter(isSetupIncomplete).length;
  const filtered = setupFilter === 'incomplete' ? listFiltered.filter(isSetupIncomplete) : listFiltered;

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (p) => p.id,
      isSelectable: (p) => isAdmin || p.is_active,
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<Product>(selected, toggleSelect, (p) => p.id, (p) => isAdmin || p.is_active),
    [selected, toggleSelect, isAdmin]
  );

  // Exports of selected rows leave turned-off products out; say how many were skipped.
  const skippedInactiveNote = () => {
    const skipped = selectedRows.filter((p) => !p.is_active).length;
    return skipped ? ` (${skipped} turned-off product(s) left out)` : '';
  };

  const handleExportCSV = () => {
    const rows = selectedRows.filter((p) => p.is_active);
    if (rows.length === 0) {
      toast('warning', `No active products selected${skippedInactiveNote()}.`);
      return;
    }
    const fmtMargin = (v: unknown) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '';
    const showCostMargin = isAdmin && showSensitive;
    const priceCols = showCostMargin
      ? [
          { key: 'current_cost', header: 'Cost', format: formatProductMoneyCSV },
          { key: 'cost_updated_date', header: 'Cost As Of', format: formatCostAsOfCSV },
          { key: 'tier1_price', header: 'T1 Price', format: formatProductMoneyCSV },
          { key: 'tier1_margin', header: 'T1 Margin %', format: fmtMargin },
          { key: 'tier2_price', header: 'T2 Price', format: formatProductMoneyCSV },
          { key: 'tier2_margin', header: 'T2 Margin %', format: fmtMargin },
          { key: 'tier3_price', header: 'T3 Price', format: formatProductMoneyCSV },
          { key: 'tier3_margin', header: 'T3 Margin %', format: fmtMargin },
        ]
      : [
          { key: 'tier1_price', header: 'T1 Price', format: formatProductMoneyCSV },
          { key: 'tier2_price', header: 'T2 Price', format: formatProductMoneyCSV },
          { key: 'tier3_price', header: 'T3 Price', format: formatProductMoneyCSV },
        ];
    exportToCSV(rows as unknown as Record<string, unknown>[], [
      ...INTERNAL_IDENTITY_COLUMNS,
      ...priceCols,
      { key: 'is_active', header: 'Status', format: (v: unknown) => v ? 'Active' : 'Inactive' },
    ], 'products-internal');
    toast('success', `Exported ${rows.length} product(s) to CSV${skippedInactiveNote()}`);
  };

  const handleExportPDF = async () => {
    const rows = selectedRows.filter((p) => p.is_active);
    if (rows.length === 0) {
      toast('warning', `No active products selected${skippedInactiveNote()}.`);
      return;
    }
    setExporting(true);
    try {
      const fmtMarginPdf = (v: unknown) => v != null ? String(v) : '';
      // Preprocess data with synthetic margin strings (reportPdf format only gets value, not row)
      const pdfData = rows.map((p) => ({
        ...p,
        _t1_margin_str: p.tier1_margin != null ? `${(p.tier1_margin * 100).toFixed(1)}%` : '',
        _t2_margin_str: p.tier2_margin != null ? `${(p.tier2_margin * 100).toFixed(1)}%` : '',
        _t3_margin_str: p.tier3_margin != null ? `${(p.tier3_margin * 100).toFixed(1)}%` : '',
      }));
      const basePdfCols: ReportPdfColumn[] = [
        { header: 'Product', key: 'product_name' },
        { header: 'SKU', key: 'sku', format: (v) => String(v || '-') },
        { header: 'Category', key: 'category', format: (v) => String(v || '-') },
        { header: 'Size', key: 'container_size', format: (v) => v != null ? String(v) : '-' },
        { header: 'Unit', key: 'unit_size', format: (v) => String(v || '-') },
      ];
      const showCostMarginPdf = isAdmin && showSensitive;
      const pricePdfCols: ReportPdfColumn[] = showCostMarginPdf
        ? [
            { header: 'Cost', key: 'current_cost', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Margin', key: '_t1_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T2 Margin', key: '_t2_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T3 Margin', key: '_t3_margin_str', align: 'right', format: fmtMarginPdf },
          ]
        : [
            { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
          ];
      await downloadReportPdf({
        title: 'Products — Internal',
        subtitle: `${rows.length} product(s) selected`,
        columns: [...basePdfCols, ...pricePdfCols, { header: 'Status', key: 'is_active', format: (v) => v ? 'Active' : 'Inactive' }],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: showCostMarginPdf ? 'landscape' : 'portrait',
      });
      toast('success', `Downloaded PDF with ${rows.length} product(s)${skippedInactiveNote()}`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  // --- Download All (filtered) ---
  const handleOpenSalesSheet = (format: SalesSheetFormat) => {
    setExportMenuOpen(false);
    if (!filtered.some((p) => p.is_active)) {
      toast('warning', 'No active products to include on the sales sheet.');
      return;
    }
    setSalesSheetFormat(format);
  };

  const handleDownloadInternalCSV = () => {
    if (!isAdmin) return;
    const rows = filtered;
    const fmtMargin = (v: unknown) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '';
    const priceCols = [
      { key: 'current_cost', header: 'Cost', format: formatProductMoneyCSV },
      { key: 'cost_updated_date', header: 'Cost As Of', format: formatCostAsOfCSV },
      { key: 'tier1_price', header: 'T1 Price', format: formatProductMoneyCSV },
      { key: 'tier1_margin', header: 'T1 Margin %', format: fmtMargin },
      { key: 'tier2_price', header: 'T2 Price', format: formatProductMoneyCSV },
      { key: 'tier2_margin', header: 'T2 Margin %', format: fmtMargin },
      { key: 'tier3_price', header: 'T3 Price', format: formatProductMoneyCSV },
      { key: 'tier3_margin', header: 'T3 Margin %', format: fmtMargin },
    ];
    exportToCSV(rows as unknown as Record<string, unknown>[], [
      ...INTERNAL_IDENTITY_COLUMNS,
      ...priceCols,
      { key: 'is_active', header: 'Status', format: (v: unknown) => v ? 'Active' : 'Inactive' },
    ], 'product-price-sheet-internal');
    toast('success', `Exported ${rows.length} product(s) to CSV`);
    setExportMenuOpen(false);
  };

  const handleDownloadInternalPDF = async () => {
    if (!isAdmin) return;
    const rows = filtered;
    setExporting(true);
    setExportMenuOpen(false);
    try {
      const fmtMarginPdf = (v: unknown) => v != null ? String(v) : '';
      const pdfData = rows.map((p) => ({
        ...p,
        _t1_margin_str: p.tier1_margin != null ? `${(p.tier1_margin * 100).toFixed(1)}%` : '',
        _t2_margin_str: p.tier2_margin != null ? `${(p.tier2_margin * 100).toFixed(1)}%` : '',
        _t3_margin_str: p.tier3_margin != null ? `${(p.tier3_margin * 100).toFixed(1)}%` : '',
      }));
      const basePdfCols: ReportPdfColumn[] = [
        { header: 'Product', key: 'product_name' },
        { header: 'SKU', key: 'sku', format: (v) => String(v || '-') },
        { header: 'Category', key: 'category', format: (v) => String(v || '-') },
        { header: 'Size', key: 'container_size', format: (v) => v != null ? String(v) : '-' },
        { header: 'Unit', key: 'unit_size', format: (v) => String(v || '-') },
      ];
      const pricePdfCols: ReportPdfColumn[] = [
        { header: 'Cost', key: 'current_cost', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
        { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
        { header: 'T1 Margin', key: '_t1_margin_str', align: 'right', format: fmtMarginPdf },
        { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
        { header: 'T2 Margin', key: '_t2_margin_str', align: 'right', format: fmtMarginPdf },
        { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
        { header: 'T3 Margin', key: '_t3_margin_str', align: 'right', format: fmtMarginPdf },
      ];
      const statusPdfCols: ReportPdfColumn[] = [{ header: 'Status', key: 'is_active', format: (v) => v ? 'Active' : 'Inactive' }];
      await downloadReportPdf({
        title: 'Product & Pricing — Internal',
        subtitle: `${rows.length} product(s) — ${new Date().toLocaleDateString()}`,
        columns: [...basePdfCols, ...pricePdfCols, ...statusPdfCols],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded internal price sheet PDF with ${rows.length} product(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const startActiveReview = async (ids: string[], active: boolean) => {
    if (!isAdmin || loadError || isEditingProducts || ids.length === 0) return;
    if (ids.length > MAX_ACTIVE_CHANGE_PRODUCTS) {
      toast('error', `Turn on or off at most ${MAX_ACTIVE_CHANGE_PRODUCTS} Products at a time. Narrow the filters or select a smaller batch.`);
      return;
    }
    const seq = ++activeReviewSeq.current;
    try {
      const { data, error } = await supabaseUntyped.rpc('preview_product_active_change', {
        p_product_ids: ids, p_active: active,
      });
      if (error) throw error;
      const result = assertRpcResult<ActiveReview>(data, 'preview_product_active_change');
      if (seq !== activeReviewSeq.current) return;
      if (!result || !Array.isArray(result.blockers) || !Array.isArray(result.warnings) || !result.review_token) {
        throw new Error('Product review was incomplete. Try again.');
      }
      const scope = JSON.stringify([ids.slice().sort(), active, result.review_token]);
      setActiveReview({ ids, active, scope, result });
    } catch (err) {
      if (seq !== activeReviewSeq.current) return;
      Sentry.captureException(err, { extra: { context: 'preview_product_active_change' } });
      toast('error', sanitizeError(err));
    }
  };

  const closeActiveReview = () => {
    activeReviewSeq.current += 1;
    setActiveReview(null);
  };

  const applyActiveReview = async () => {
    if (!activeReview || activeReview.result.blockers.length > 0 || loadError || deactivating) return;
    const { ids, active, scope, result } = activeReview;
    await runCriticalAction({
      action: async () => {
        const response = await supabaseUntyped.rpc('set_product_active', {
          p_product_ids: ids, p_active: active, p_review_token: result.review_token,
          p_idempotency_key: productActiveIdem.getKeyFor(scope),
        });
        if (response.error) {
          const rpcError = response.error;
          if (hasRpcCode(response.error, RpcErrorCodes.PRODUCT_ACTIVE_REVIEW_STALE)
            || hasRpcCode(response.error, RpcErrorCodes.PRODUCT_DEACTIVATION_BLOCKED)) {
            // A raised refusal committed nothing, so the key is retired for a fresh review.
            if (isDefinitiveRpcRejection(rpcError)) productActiveIdem.resetKeyFor(scope);
            closeActiveReview();
            toast('warning', hasRpcCode(rpcError, RpcErrorCodes.PRODUCT_DEACTIVATION_BLOCKED)
              ? sanitizeError(rpcError)
              : 'Product details changed since this review. Review the selection again.');
            void startActiveReview(ids, active);
            throw new CriticalActionHandledError('Product review changed');
          }
          if (hasRpcCode(response.error, RpcErrorCodes.PRODUCT_INACTIVE)) {
            // A raised refusal committed nothing, so the key is retired for a fresh review.
            if (isDefinitiveRpcRejection(rpcError)) productActiveIdem.resetKeyFor(scope);
            toast('error', sanitizeError(response.error));
            throw new CriticalActionHandledError('Product is inactive');
          }
          if (hasRpcCode(response.error, RpcErrorCodes.NOT_AUTHORIZED)
            || hasRpcCode(response.error, RpcErrorCodes.AUTH_REQUIRED)) {
            // A raised refusal committed nothing, so the key is retired for a fresh review.
            if (isDefinitiveRpcRejection(rpcError)) productActiveIdem.resetKeyFor(scope);
            closeActiveReview();
            toast('error', 'Your admin access changed. Sign in again, then review the products.');
            throw new CriticalActionHandledError('Admin access changed');
          }
          throw response.error;
        }
        assertRpcResult(response.data, 'set_product_active');
      },
      toast,
      setLoading: setDeactivating,
      successMessage: `${active ? 'Reactivated' : 'Deactivated'} ${ids.length} product(s)`,
      sentryTag: 'set_product_active',
      onSuccess: () => {
        productActiveIdem.resetKeyFor(scope);
        clearSelection();
        fetchProducts();
        closeActiveReview();
      },
    });
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    ...(isAdmin && selectedRows.some((p) => p.is_active) ? [{ key: 'deactivate', label: 'Deactivate', icon: <PowerOff className="w-4 h-4" />, onClick: () => void startActiveReview(selectedRows.filter((p) => p.is_active).map((p) => p.id), false), variant: 'danger' as const }] : []),
    ...(isAdmin && selectedRows.some((p) => !p.is_active) ? [{ key: 'reactivate', label: 'Reactivate', icon: <Power className="w-4 h-4" />, onClick: () => void startActiveReview(selectedRows.filter((p) => !p.is_active).map((p) => p.id), true) }] : []),
  ];

  const filterCategoryNames = [...new Set([...categories, ...categoryChoices.filter((choice) => choice.is_active).map((choice) => choice.name)])].sort();

  /** Render the one input family selected for this row. The server computes every effect. */
  const createTierEditRender = (tierNum: 1 | 2 | 3) => {
    const marginKey = `tier${tierNum}_margin` as keyof Product & string;
    const marginPercentKey = `tier${tierNum}_margin_percent`;
    const priceKey = `tier${tierNum}_price` as keyof Product & string;

    return (
      row: Product,
      getCellValue: (colKey: string) => unknown,
      setCellValue: (colKey: string, value: unknown) => void
    ) => {
      const mode = (getCellValue('pricing_mode') as PricingMode | undefined) || defaultPricingMode(row);
      if (mode === 'price_driven') {
        const price = getCellValue(priceKey);
        return (
          <input
            type="number"
            aria-label={`Tier ${tierNum} price for ${row.product_name}`}
            value={price != null ? String(price) : ''}
            min={0}
            step="0.01"
            onChange={(e) => {
              const raw = e.target.value;
              setCellValue(priceKey, raw);
            }}
            className="w-full px-2 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
          />
        );
      }

      if (mode === 'margin_driven') {
        const dirtyValue = getCellValue(marginPercentKey);
        const value = dirtyValue ?? storedMarginPercent(row[marginKey] as number | null) ?? '';
        return (
          <div className="flex items-center gap-1">
            <input
              type="number"
              aria-label={`Tier ${tierNum} net margin percent for ${row.product_name}`}
              value={String(value)}
              min={0}
              max={99.999999}
              step="0.1"
              onChange={(e) => setCellValue(marginPercentKey, e.target.value)}
              className="w-20 px-1 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
            />
            <span className="text-xs text-gray-400">%</span>
          </div>
        );
      }

      return <span className="text-xs text-amber-700">Select a pricing mode</span>;
    };
  };

  const saveMarginFloors = async (changes: Map<string, Record<string, unknown>>): Promise<boolean> => {
    if (!profile) throw new Error('Your user profile is not available. Refresh and try again.');
    const floorChanges: MarginFloorChange[] = [];
    for (const [productId, fields] of changes) {
      if (!(MARGIN_FLOOR_FIELD in fields)) continue;
      const original = products.find((product) => product.id === productId);
      if (!original) throw new Error('A Product changed while you were editing. Refresh and try again.');
      let percent: number | null;
      try {
        percent = parseMarginFloorPercent(String(fields[MARGIN_FLOOR_FIELD] ?? ''));
      } catch (err) {
        throw new Error(`${original.product_name}: ${err instanceof Error ? err.message : 'invalid margin floor'}`);
      }
      floorChanges.push({ productId, marginFloorPercent: percent });
    }
    // One key per exact request: a retry of the same save replays; a changed one is a new save.
    const scope = JSON.stringify(floorChanges);
    let result: SetMarginFloorsResult;
    try {
      result = await setMarginFloors({
        changes: floorChanges,
        reason: '',
        performedBy: profile.id,
        idempotencyKey: marginFloorIdem.getKeyFor(scope),
      });
    } catch (err) {
      if (!isMarginFloorRefusal(err)) Sentry.captureException(err, { extra: { context: 'set_product_margin_floors_inline' } });
      throw new Error(marginFloorErrorMessage(err));
    }
    marginFloorIdem.resetKeyFor(scope);
    const reloaded = await fetchProducts(false);
    if (!reloaded) {
      // Show what was saved rather than the old floors, so nobody re-enters them. Only the saved
      // products change: the rest keep whatever the failed reload left (the earlier floors if the
      // products failed, none if the floors failed, where they show "?" and stay read-only).
      const changedIds = new Set(floorChanges.map((change) => change.productId));
      const savedPercent = new Map(floorChanges.map((change) => [change.productId, change.marginFloorPercent]));
      const savedFloor = (productId: string) => {
        const percent = savedPercent.get(productId);
        return percent == null ? undefined : percent / 100;
      };
      setMarginFloorsByProduct((current) => {
        const next = new Map([...current].filter(([productId]) => !changedIds.has(productId)));
        for (const productId of changedIds) {
          const floor = savedFloor(productId);
          if (floor !== undefined) next.set(productId, floor);
        }
        return next;
      });
      setMarginFloorsKnownFromSave(changedIds);
      setProducts((rows) => rows.map((p) => (changedIds.has(p.id)
        ? { ...p, [MARGIN_FLOOR_FIELD]: formatMarginFloorPercent(savedFloor(p.id)) }
        : p)));
      toast('warning', 'Margin floors were saved, but the list could not be reloaded. Refresh this page.');
    } else if (result.changed_count === 0) {
      toast('info', 'The margin floors are unchanged.');
    } else {
      toast('success', `Updated ${result.changed_count} margin floor(s).`);
    }
    return true;
  };

  const handleBulkSave = async (changes: Map<string, Record<string, unknown>>): Promise<void | boolean> => {
    try {
      let hasPricing = false;
      let hasNonpricing = false;
      let hasFloor = false;
      for (const fields of changes.values()) {
        hasPricing ||= Object.keys(fields).some((key) => INLINE_PRICING_FIELDS.has(key));
        hasNonpricing ||= Object.keys(fields).some((key) => INLINE_NONPRICING_FIELDS.has(key));
        hasFloor ||= MARGIN_FLOOR_FIELD in fields;
      }
      for (const [productId, fields] of changes) {
        const original = products.find((item) => item.id === productId);
        const parent = parentByProduct.get(productId);
        if ('category' in fields && original && parent && (fields.category || null) !== original.category) {
          throw new Error(`${original.product_name}'s category is set on parent "${parent.name}". Change it on the product page's Parent panel.`);
        }
        if ('category' in fields && original && (original.use_timings?.length ?? 0) > 0
          && (fields.category || null) !== original.category) {
          throw new Error('This product has use timings. Change its category on the product page.');
        }
      }

      if (hasFloor && (hasPricing || hasNonpricing)) {
        throw new Error('Save margin floors on their own. Cancel, change only the floors, then save again.');
      }
      if (hasFloor) {
        return await saveMarginFloors(changes);
      }

      if (hasPricing && hasNonpricing) {
        throw new Error('Save product details and pricing in separate review steps. Cancel, make one kind of change, then save again.');
      }

      if (hasPricing) {
        if (!profile) throw new Error('Your user profile is not available. Refresh and try again.');
        const pricingRows: PricingPreviewInputRow[] = [];
        for (const [productId, fields] of changes) {
          if (!Object.keys(fields).some((key) => INLINE_PRICING_FIELDS.has(key))) continue;
          const original = products.find((product) => product.id === productId);
          if (!original) throw new Error('A Product changed while you were editing. Refresh and try again.');
          const mode = (fields.pricing_mode as PricingMode | undefined) || defaultPricingMode(original);
          if (mode !== 'margin_driven' && mode !== 'price_driven') {
            throw new Error(`Choose margin-driven or price-driven for ${original.product_name}.`);
          }
          const newCost = inputDecimal('current_cost' in fields ? fields.current_cost : original.current_cost);
          if (newCost === null) throw new Error(`Enter a cost for ${original.product_name}.`);
          if (mode === 'margin_driven' && pricingDollarInputToCents(newCost) === 0n) {
            throw new Error(`Margin-driven pricing requires a cost greater than $0 for ${original.product_name}. No prices were changed.`);
          }
          if (!Number.isInteger(original.pricing_version) || (original.pricing_version ?? 0) < 1) {
            throw new Error(`${original.product_name} does not have a pricing version yet. Refresh after the Phase 1a database migration is available.`);
          }

          const row: PricingPreviewInputRow = {
            product_id: original.id,
            product_name: original.product_name,
            sku: original.sku ?? '',
            row_version: original.pricing_version!,
            pricing_mode: mode,
            new_cost: newCost,
          };
          if (mode === 'margin_driven') {
            for (const tier of [1, 2, 3] as const) {
              const field = `tier${tier}_margin_percent` as const;
              const stored = original[`tier${tier}_margin` as const];
              const value = inputDecimal(fields[field] ?? storedMarginPercent(stored));
              if (value === null || !pricingMarginTextIsValid(value)) {
                throw new Error(`Enter each net margin for ${original.product_name} as a plain number below 100.`);
              }
              row[field] = value;
            }
          } else {
            for (const tier of [1, 2, 3] as const) {
              const field = `tier${tier}_price` as const;
              const value = inputDecimal(fields[field] ?? original[field]);
              if (value === null) {
                throw new Error(`Enter all three tier prices for ${original.product_name}.`);
              }
              row[field] = value;
            }
          }
          pricingRows.push(row);
        }

        // Ask where the new numbers came from and why; the preview runs from that prompt.
        setPendingInlineRows(pricingRows);
        return false;
      }

      for (const [productId, fields] of changes) {
        const nonpricingFields = Object.fromEntries(
          Object.entries(fields).filter(([key]) => INLINE_NONPRICING_FIELDS.has(key)),
        );
        if ('product_name' in nonpricingFields) {
          const name = String(nonpricingFields.product_name ?? '').trim();
          if (!name) throw new Error('Enter a product name before saving.');
          nonpricingFields.product_name = name;
        }
        if (nonpricingFields.category === '') nonpricingFields.category = null;
        const updateResult = await supabase
          .from('products')
          .update({ ...nonpricingFields, updated_at: new Date().toISOString() })
          .eq('id', productId)
          .select('id');
        checkMutationResult(updateResult, 'Update product');
      }

      toast('success', `Updated ${changes.size} product(s)`);
      if (profile) {
        logActivity({ event: 'products_bulk_updated', description: `${changes.size} product(s) updated via inline edit`, performedBy: profile.id, entityType: 'product' });
      }
      fetchProducts();
      setParentsReload((n) => n + 1);
      return true;
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
      throw err; // re-throw so EditableDataTable stays in edit mode
    }
  };

  // A phone's one-product change is an Edit table save of one row, so it gets the same row checks and review.
  // handleBulkSave shows its own refusal, and the modal stays open to fix it.
  const submitQuickPrice = (productId: string, fields: QuickPriceFields) => {
    handleBulkSave(new Map([[productId, { ...fields, pricing_mode: 'price_driven' }]]))
      .then(() => setQuickPriceProductId(null), () => undefined);
  };

  const previewInlinePricing = async ({ source, reason }: PricingSourceReason) => {
    if (!profile || !pendingInlineRows) return;
    setPreviewingInline(true);
    try {
      const rows = pendingInlineRows.map((row) => ({ ...row, change_reason: reason, price_source: source }));
      // One key per exact request: a retry after changing the source or reason is a new request, so it
      // must not reuse the key of one whose outcome is unknown (the server refuses a changed payload).
      const intent = JSON.stringify(rows);
      const preview = await previewProductPricingChanges({
        source: 'products_inline',
        rows,
        performedBy: profile.id,
        idempotencyKey: previewPricingIdem.getKeyFor(intent),
      });
      previewPricingIdem.resetKeyFor(intent);
      setPendingInlineRows(null);
      setPricingSourceFile(null);
      setPricingPreview(preview);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setPreviewingInline(false);
    }
  };

  // fullSheet: every active product, whatever the filters or selection (To-Do 0.1).
  const handleExportPricingWorkbook = async (fullSheet: boolean) => {
    if (!profile) return;
    const productIds = (fullSheet ? products : selectedRows.length > 0 ? selectedRows : filtered)
      .filter((product) => product.is_active)
      .map((product) => product.id);
    if (productIds.length === 0) {
      toast('warning', 'Select at least one active Product to export.');
      return;
    }
    if (productIds.length > MAX_PRICING_WORKBOOK_ROWS) {
      toast(
        'error',
        `Pricing workbooks are limited to ${MAX_PRICING_WORKBOOK_ROWS.toLocaleString()} Products. Narrow the filters or select a smaller batch.`,
      );
      return;
    }
    // The database binds the key to this exact product list, so a filtered export and the full
    // price sheet each keep their own key; a retry of the same list replays the same export.
    const exportIntent = JSON.stringify(productIds);
    setWorkbookBusy(true);
    try {
      const pricingExport = await createPricingWorkbookExport({
        productIds,
        performedBy: profile.id,
        idempotencyKey: exportPricingIdem.getKeyFor(exportIntent),
      });
      const supplierEvidence = await getSupplierMarketEvidence(productIds);
      const blob = await generateProductPricingWorkbookWithSupplierEvidence(
        pricingExport,
        supplierEvidence,
        { groupedParents: groupedParentNames },
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `crx-product-pricing-${new Date().toISOString().slice(0, 10)}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
      exportPricingIdem.resetKeyFor(exportIntent);
      toast('success', `Exported ${productIds.length} Product pricing row(s).`);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setWorkbookBusy(false);
    }
  };

  const handlePricingWorkbookUpload = async (file: File) => {
    if (!profile) return;
    if (file.size > MAX_PRICING_WORKBOOK_FILE_BYTES) {
      toast(
        'error',
        `Pricing workbooks must be ${MAX_PRICING_WORKBOOK_FILE_BYTES / 1024 / 1024} MB or smaller.`,
      );
      if (pricingWorkbookInputRef.current) pricingWorkbookInputRef.current.value = '';
      return;
    }
    setWorkbookBusy(true);
    try {
      const parsed = await parseProductPricingWorkbookWithSupplierEvidence(await file.arrayBuffer());
      const sourceFile: PricingSourceFile = { name: file.name, sha256: await sha256Hex(file) };
      // One key per exact request (the file's bytes decide the rows), as for the inline preview.
      const intent = JSON.stringify(['workbook', sourceFile.sha256]);
      const preview = await previewProductPricingChanges({
        source: 'pricing_worksheet',
        exportId: parsed.exportId,
        rows: parsed.rows,
        performedBy: profile.id,
        idempotencyKey: previewPricingIdem.getKeyFor(intent),
      });
      previewPricingIdem.resetKeyFor(intent);
      // A grouped size's use timing is set on its parent; the database refuses it too.
      const groupedRefusal = groupedUseTimingRefusal(preview, groupedParentNames);
      if (groupedRefusal) {
        toast('error', groupedRefusal);
        return;
      }
      setPricingSourceFile(sourceFile);
      setPricingPreview(preview);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setWorkbookBusy(false);
      if (pricingWorkbookInputRef.current) pricingWorkbookInputRef.current.value = '';
    }
  };

  const handleApplyPricing = async (acknowledgements: PricingAcknowledgement[]) => {
    if (!pricingPreview || !profile) return;
    setApplyingPricing(true);
    try {
      // The database applies only an approved preview: every warning acknowledged, the file named.
      const sourceFile = pricingPreview.source === 'pricing_worksheet' ? pricingSourceFile : null;
      // One key per exact approval: a corrected reason is a new request (a re-approval replaces the receipt).
      const approveIntent = JSON.stringify([pricingPreview.change_set_id, acknowledgements, sourceFile]);
      await approvePricingChangeSet({
        changeSetId: pricingPreview.change_set_id,
        requestFingerprint: pricingPreview.request_fingerprint,
        acknowledgements,
        sourceFile,
        performedBy: profile.id,
        idempotencyKey: approvePricingIdem.getKeyFor(approveIntent),
      });
      const result = await applyProductPricingChangeSet({
        changeSetId: pricingPreview.change_set_id,
        requestFingerprint: pricingPreview.request_fingerprint,
        performedBy: profile.id,
        idempotencyKey: applyPricingIdem.getKey(),
      });
      // Both keys are kept until the apply is confirmed: if its answer is lost, a retry replays the
      // approval (the database checks the key before refusing an applied change set) and then the apply.
      approvePricingIdem.resetKeyFor(approveIntent);
      applyPricingIdem.resetKey();
      setPricingPreview(null);
      setPricingSourceFile(null);
      setTableRevision((revision) => revision + 1);
      const reloaded = await fetchProducts(false);
      if (reloaded) {
        toast('success', `Applied pricing to ${result.applied_count} Product(s).`);
      } else {
        toast('warning', 'Pricing was applied, but the latest Product values could not be reloaded. Refresh this page before making another change.');
      }
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setApplyingPricing(false);
    }
  };

  const dataColumns: EditableColumn<Product>[] = [
    {
      key: 'product_name',
      header: 'Product Name',
      sortable: true,
      editable: isAdmin,
      editType: 'text',
      render: (row) => (
        <div className="max-w-xs">
          <p className="font-medium text-nav-dark truncate">{row.product_name}</p>
          {row.sku && <p className="text-xs text-gray-400">{row.sku}</p>}
          {isSetupIncomplete(row) && <Badge variant="warning" className="mt-1">Incomplete setup</Badge>}
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortable: true,
      editable: isAdmin,
      editType: 'select',
      editRender: (row, getCellValue, setCellValue) => parentByProduct.has(row.id) ? (
        <span className="text-sm text-nav-dark" title={`Set on parent ${parentByProduct.get(row.id)?.name}`}>
          {row.category ?? '—'} <span className="block text-xs text-secondary">Set on parent {parentByProduct.get(row.id)?.name}</span>
        </span>
      ) : (
        <select aria-label="Category" value={String(getCellValue('category') ?? '')}
          onChange={(event) => setCellValue('category', event.target.value || null)}
          disabled={categoryChoices.length === 0}
          className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-nav-dark focus-visible:ring-2 focus-visible:ring-crx-green disabled:opacity-50">
          <option value="">—</option>
          {categoryChoices.filter((choice) => choice.is_active || choice.name === row.category).map((choice) => (
            <option key={choice.name} value={choice.name}>
              {choice.name}{choice.is_active ? '' : ' (retired)'}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: 'vendor',
      header: 'Vendor',
      sortable: true,
    },
    ...(isAdmin && showSensitive
      ? [
          {
            key: 'current_cost',
            header: 'Cost',
            sortable: true,
            editable: true,
            editType: 'decimal' as const,
            editMin: 0,
            editStep: '0.01',
            editAriaLabel: (row: Product) => `Cost for ${row.product_name}`,
            render: (row: Product) => (
              <span className="font-mono text-sm">
                {row.current_cost != null ? `$${Number(row.current_cost).toFixed(2)}` : '-'}
              </span>
            ),
          } satisfies EditableColumn<Product>,
          {
            // When the cost last changed (To-Do 0.7); Reports > Operational > Stale Costs lists the old ones.
            key: 'cost_updated_date',
            header: 'Cost as of',
            sortable: true,
            render: (row: Product) => {
              const asOf = costAsOfDate(row.cost_updated_date);
              const stale = isCostStale(costAgeDays(asOf, costFreshnessToday), DEFAULT_STALE_COST_AGE_DAYS);
              const note = !asOf
                ? 'No cost change date is recorded for this product'
                : stale ? `No cost change in the last ${DEFAULT_STALE_COST_AGE_DAYS} days` : undefined;
              return (
                <span className={`text-sm ${stale ? 'text-amber-700' : 'text-secondary'}`} title={note}>
                  {asOf ? parseLocalDate(asOf).toLocaleDateString() : 'Unknown'}
                  {asOf && stale && <span aria-hidden="true"> (old)</span>}
                  {note && <span className="sr-only">. {note}</span>}
                </span>
              );
            },
          } satisfies EditableColumn<Product>,
          {
            key: MARGIN_FLOOR_FIELD,
            header: 'Floor %',
            // Read-only while the floors failed to load: an edit would be made against unknown values.
            editable: !marginFloorsLoadFailed,
            editRender: (row: Product, getCellValue: (colKey: string) => unknown, setCellValue: (colKey: string, value: unknown) => void) => {
              const value = getCellValue(MARGIN_FLOOR_FIELD) ?? '';
              return (
                <div className="flex items-center gap-1">
                  {/* Text, not number: a number box reports text it cannot read as "", which would clear the floor. */}
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`Margin floor percent for ${row.product_name}`}
                    value={String(value)}
                    placeholder="None"
                    onChange={(e) => setCellValue(MARGIN_FLOOR_FIELD, e.target.value)}
                    className="w-20 px-1 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
                  />
                  <span className="text-xs text-gray-400">%</span>
                </div>
              );
            },
            render: (row: Product) => {
              if (marginFloorsLoadFailed && !marginFloorsKnownFromSave.has(row.id)) {
                return <span className="text-xs text-amber-700" title="Margin floors could not be loaded">?</span>;
              }
              const floor = marginFloors.get(row.id);
              return (
                <span className="font-mono text-sm">{floor != null ? `${formatMarginFloorPercent(floor)}%` : '-'}</span>
              );
            },
          } satisfies EditableColumn<Product>,
        ]
      : []),
    ...(isAdmin
      ? [{
          key: 'pricing_mode',
          header: 'Pricing Mode',
          editable: true,
          editAriaLabel: (row) => `Pricing mode for ${row.product_name}`,
          editRender: (row, getCellValue, setCellValue) => (
            <select
              aria-label={`Pricing mode for ${row.product_name}`}
              value={(getCellValue('pricing_mode') as PricingMode | undefined) || defaultPricingMode(row)}
              onChange={(event) => setCellValue('pricing_mode', event.target.value)}
              className="w-full px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 bg-white"
            >
              {defaultPricingMode(row) === '' && <option value="">Choose a mode</option>}
              <option value="margin_driven">Margin-driven</option>
              <option value="price_driven">Price-driven</option>
            </select>
          ),
          render: () => <span className="text-xs text-gray-400">Choose while editing</span>,
        } satisfies EditableColumn<Product>]
      : []),
    {
      key: 'tier1_price',
      header: 'T1 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(1) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier1_price != null ? `$${Number(row.tier1_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier1_margin != null && (
            <NetMarginNote margin={row.tier1_margin} floor={marginFloors.get(row.id)} />
          )}
        </div>
      ),
    },
    {
      key: 'tier2_price',
      header: 'T2 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(2) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier2_price != null ? `$${Number(row.tier2_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier2_margin != null && (
            <NetMarginNote margin={row.tier2_margin} floor={marginFloors.get(row.id)} />
          )}
        </div>
      ),
    },
    {
      key: 'tier3_price',
      header: 'T3 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(3) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier3_price != null ? `$${Number(row.tier3_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier3_margin != null && (
            <NetMarginNote margin={row.tier3_margin} floor={marginFloors.get(row.id)} />
          )}
        </div>
      ),
    },
    ...(showCompliance
      ? [
          {
            key: 'is_rup',
            header: 'RUP',
            render: (row: Product) => row.is_rup == null ? '-' : row.is_rup ? 'Yes' : 'No',
          } satisfies EditableColumn<Product>,
          {
            key: 'signal_word',
            header: 'Signal Word',
            render: (row: Product) => row.signal_word || '-',
          } satisfies EditableColumn<Product>,
          {
            key: 'product_form',
            header: 'Form',
            render: (row: Product) => row.product_form || '-',
          } satisfies EditableColumn<Product>,
          {
            key: 'inventory_unit',
            header: 'Inventory Unit',
            render: (row: Product) => row.inventory_unit || row.unit_size || '-',
          } satisfies EditableColumn<Product>,
        ]
      : []),
    {
      key: 'is_active',
      header: 'Status',
      render: (row) => (
        <div className="flex items-center gap-2">
          <Badge variant={row.is_active ? 'success' : 'default'}>{row.is_active ? 'Active' : 'Inactive'}</Badge>
          {isAdmin && <button type="button" disabled={isEditingProducts}
            className="min-h-8 rounded px-2 text-xs font-medium text-crx-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-crx-green"
            onClick={(event) => { event.stopPropagation(); void startActiveReview([row.id], !row.is_active); }}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}>
            {row.is_active ? 'Deactivate' : 'Reactivate'}
          </button>}
        </div>
      ),
    },
  ];

  const columns: EditableColumn<Product>[] = canBulkAction
    ? [checkboxCol as unknown as EditableColumn<Product>, ...dataColumns]
    : dataColumns;

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  const quickPriceProduct = products.find((product) => product.id === quickPriceProductId);

  return (
    <div className="phone-touch space-y-4">
      <PageHeader
        title="Products"
        subtitle={<HelpTip text="Your product master list. Set tier pricing (1/2/3) for customer-specific pricing, mark products as RUP for compliance tracking, and manage unit sizes. Edit inline by clicking any editable cell." />}
        actions={(
          <>
          {/* Bulk actions act on the selection, so they wait while the rows are hidden by a failed load. */}
          {canBulkAction && !loadError && (
            <div className="hidden md:block">
              <BulkActionBar
                selectedCount={selectedCount}
                actions={bulkActions}
                onDeselectAll={clearSelection}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
          <ProductRateLockControl lock={rateLock} loadFailed={rateLockFailed} onRetry={loadRateLock} isAdmin={isAdmin} profileId={profile?.id ?? ''} onChanged={setRateLock} />
          {/* Download All dropdown. Exports wait while a failed load hides the rows: they would
              export the old catalog as if it were current. */}
          <div className="relative">
            <Button
              variant="secondary"
              icon={<Download className="w-4 h-4" />}
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={exporting || loadError || filtered.length === 0}
            >
              {exporting ? 'Exporting...' : 'Download'} <ChevronDown className="w-3 h-3 ml-1 inline" />
            </Button>
            {exportMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" role="presentation" onClick={() => setExportMenuOpen(false)} onKeyDown={() => setExportMenuOpen(false)} />
                <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
                  <p className="px-3 py-1.5 text-xs font-semibold text-secondary uppercase tracking-wide">PDF</p>
                  <button onClick={() => handleOpenSalesSheet('pdf')} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-gray-400" /> Customer Sales Sheet
                  </button>
                  {isAdmin && (
                    <button onClick={() => void handleDownloadInternalPDF()} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                      <FileText className="w-4 h-4 text-gray-400" /> Internal (cost + margin)
                    </button>
                  )}
                  <div className="border-t border-gray-100 my-1" />
                  <p className="px-3 py-1.5 text-xs font-semibold text-secondary uppercase tracking-wide">CSV</p>
                  <button onClick={() => handleOpenSalesSheet('csv')} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Download className="w-4 h-4 text-gray-400" /> Customer Sales Sheet
                  </button>
                  {isAdmin && (
                    <button onClick={handleDownloadInternalCSV} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                      <Download className="w-4 h-4 text-gray-400" /> Internal (cost + margin)
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          {isAdmin && (
            <div className="hidden flex-wrap items-center gap-2 md:flex">
              <Button
                variant="secondary"
                icon={<FileSpreadsheet className="w-4 h-4" />}
                onClick={() => void handleExportPricingWorkbook(true)}
                loading={workbookBusy}
                disabled={loadError || products.length === 0}
                title="Every active product, ignoring filters and selection"
              >
                Full price sheet
              </Button>
              <Button
                variant="secondary"
                icon={<FileSpreadsheet className="w-4 h-4" />}
                onClick={() => void handleExportPricingWorkbook(false)}
                loading={workbookBusy}
                disabled={loadError || filtered.length === 0}
                title="The selected products, or every active product the filters show"
              >
                Pricing .xlsx
              </Button>
              <Button
                variant="secondary"
                icon={<Upload className="w-4 h-4" />}
                onClick={() => pricingWorkbookInputRef.current?.click()}
                disabled={workbookBusy}
              >
                Review Pricing File
              </Button>
              <input
                ref={pricingWorkbookInputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handlePricingWorkbookUpload(file);
                }}
              />
              <Button
                variant="secondary"
                icon={<FileUp className="w-4 h-4" />}
                onClick={() => setBulkProductImportOpen(true)}
              >
                Import Products
              </Button>
              <Button
                variant="secondary"
                icon={<FileSpreadsheet className="w-4 h-4" />}
                onClick={() => setSetupWorkbookOpen(true)}
                title="Product details and rates, separate from the price sheet"
              >
                Setup Workbook
              </Button>
              <Button
                variant="secondary"
                icon={<FileSpreadsheet className="w-4 h-4" />}
                onClick={() => setRateReviewOpen(true)}
                title="Approve draft per-acre rates and record one outcome per parent"
              >
                Rate Review
              </Button>
            </div>
          )}
          </div>
          {isAdmin && (
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
              Add Product
            </Button>
          )}
          </>
        )}
      />

      <Card padding={false}>
        <div
          data-testid="products-mobile-layout"
          className={isEditingProducts ? 'hidden' : 'md:hidden'}
        >
          <ProductsMobileList
            products={products}
            categories={filterCategoryNames}
            vendors={vendors}
            categoryFilter={categoryFilter}
            vendorFilter={vendorFilter}
            statusFilter={statusFilter}
            onCategoryFilterChange={setCategoryFilter}
            onVendorFilterChange={setVendorFilter}
            onStatusFilterChange={setStatusFilter}
            setupFilter={setupFilter}
            onSetupFilterChange={setSetupFilter}
            onOpenProduct={(product) => navigate(`/products/${product.id}`)}
            onChangePrice={isAdmin ? (product) => setQuickPriceProductId(product.id) : undefined}
            loadError={loadError}
            onRetry={retryProducts}
            parentIndex={parentIndex}
          />
        </div>
        <div
          data-testid="products-table-layout"
          className={isEditingProducts ? 'block p-5' : 'hidden p-5 md:block'}
        >
          <EditableDataTable<ProductListRow>
            key={tableRevision}
            data={filtered}
            columns={columns}
            rowKey="id"
            searchable
            searchPlaceholder="Search products..."
            searchMatcher={searchProducts}
            onRowClick={(row) => navigate(`/products/${row.id}`)}
            emptyTitle={products.length > 0 ? 'No matching products' : 'No products yet'}
            emptyDescription={products.length > 0 ? 'Try a different search or filter' : 'Add your first product to get started'}
            emptyAction={
              products.length === 0 && isAdmin ? (
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
                  Add Product
                </Button>
              ) : undefined
            }
            loading={loading}
            loadError={loadError}
            onRetry={retryProducts}
            canEdit={isAdmin}
            onEditModeChange={setIsEditingProducts}
            onSave={handleBulkSave}
            headerActions={(
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={showCompliance ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  onClick={() => setShowCompliance((v) => !v)}
                >
                  {showCompliance ? 'Hide details' : 'Details'}
                </Button>
                {isAdmin && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={showSensitive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    onClick={() => setShowSensitive((v) => !v)}
                  >
                    {showSensitive ? 'Hide' : 'Margins'}
                  </Button>
                )}
              </>
            )}
            filters={
              <>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filter by category"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Categories</option>
                  {filterCategoryNames.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  value={vendorFilter}
                  onChange={(e) => setVendorFilter(e.target.value)}
                  aria-label="Filter by vendor"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Vendors</option>
                  {vendors.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'active' | 'inactive' | 'all')}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="all">All statuses</option>
                </select>
                <select
                  value={setupFilter}
                  onChange={(e) => setSetupFilter(e.target.value as SetupFilter)}
                  aria-label="Filter by setup"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">Any setup</option>
                  <option value="incomplete">Incomplete setup ({incompleteCount})</option>
                </select>
                {canBulkAction && !loadError && filtered.some((p) => isAdmin || p.is_active) && (
                  <button
                    onClick={toggleAll}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </>
            }
          />
        </div>
      </Card>

      {isAdmin && <TypedBrandReview />}
      {isAdmin && <DeliveriesMissingBrands />}

      {isAdmin && (
        <ProductSetupWorkbookModal
          open={setupWorkbookOpen}
          profileId={profile?.id ?? ''}
          onClose={() => setSetupWorkbookOpen(false)}
          onSaved={() => { void fetchProducts(); }}
        />
      )}
      {isAdmin && (
        <RateReviewWorkbookModal open={rateReviewOpen} profileId={profile?.id ?? ''} onClose={() => setRateReviewOpen(false)} />
      )}

      <BulkProductImport
        open={bulkProductImportOpen}
        onClose={() => setBulkProductImportOpen(false)}
        onSuccess={() => {
          fetchProducts();
          setBulkProductImportOpen(false);
        }}
      />

      {quickPriceProduct && (
        <QuickPriceChangeModal
          key={quickPriceProduct.id}
          product={quickPriceProduct}
          onClose={() => setQuickPriceProductId(null)}
          onSubmit={(fields) => submitQuickPrice(quickPriceProduct.id, fields)}
        />
      )}

      <PricingChangePreviewModal
        open={pricingPreview !== null}
        preview={pricingPreview}
        applying={applyingPricing}
        title="Review Product Pricing"
        onClose={() => {
          setPricingPreview(null);
          setPricingSourceFile(null);
          applyPricingIdem.resetKey();
        }}
        onApprove={(acknowledgements) => void handleApplyPricing(acknowledgements)}
      />

      <PricingSourceReasonModal
        key={pendingInlineRows ? 'open' : 'closed'}
        open={pendingInlineRows !== null}
        busy={previewingInline}
        productCount={pendingInlineRows?.length ?? 0}
        onCancel={() => setPendingInlineRows(null)}
        onSubmit={(value) => void previewInlinePricing(value)}
      />

      {salesSheetFormat && (
        <CustomerSalesSheetModal
          format={salesSheetFormat}
          products={filtered.filter((p) => p.is_active)}
          onClose={() => setSalesSheetFormat(null)}
        />
      )}

      <Modal open={activeReview !== null && activeReview.result.blockers.length > 0}
        onClose={closeActiveReview} title="Cannot deactivate products"
        footer={<Button variant="secondary" onClick={closeActiveReview}>Close</Button>}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-red-800">
          {activeReview?.result.blockers.map((entry, index) => <li key={`${entry.product_id}-${entry.kind}-${entry.number}-${index}`}>{entry.message}</li>)}
        </ul>
      </Modal>
      <Modal open={activeReview !== null && activeReview.result.blockers.length === 0}
        onClose={closeActiveReview} closeDisabled={deactivating}
        title={activeReview?.active ? 'Reactivate products' : 'Deactivate products'}
        footer={<div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={closeActiveReview} disabled={deactivating}>Cancel</Button>
          <Button variant={activeReview?.active ? 'primary' : 'danger'} onClick={() => void applyActiveReview()}
            loading={deactivating}>{activeReview?.active ? 'Reactivate' : 'Deactivate'}</Button>
        </div>}>
        <p className="text-sm text-nav-dark">{activeReview?.active ? 'Reactivate' : 'Deactivate'} these products:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-nav-dark">
          {activeReview?.result.products.map((product) => <li key={product.id}>{product.product_name}</li>)}
        </ul>
        {activeReview && activeReview.result.warnings.length > 0 && <>
          <p className="mt-4 text-sm font-semibold text-amber-800">Review before continuing:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
            {activeReview.result.warnings.map((entry, index) =>
              <li key={`${entry.product_id}-${entry.kind}-${entry.number}-${index}`}>{entry.message}</li>)}
          </ul>
        </>}
      </Modal>
    </div>
  );
}
