import { toSentryError } from '../lib/sentryError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Copy, DollarSign, ExternalLink, Plus, Search, Save } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Combobox from '../components/ui/Combobox';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import PhoneSection from '../components/ui/PhoneSection';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import PricingChangePreviewModal from '../components/products/PricingChangePreviewModal';
import ProductPriceHistory from '../components/products/ProductPriceHistory';
import ProductSellPriceHistory from '../components/products/ProductSellPriceHistory';
import ProductChangeHistory from '../components/products/ProductChangeHistory';
import ProductBrandsSection from '../components/products/ProductBrandsSection';
import CancelledRegistrationBanner from '../components/products/CancelledRegistrationBanner';
import { useCancelledRegistrations } from '../lib/epaRegistrationStatus';
import ProductVendorsSection from '../components/products/ProductVendorsSection';
import EpaLabelLink from '../components/products/EpaLabelLink';
import ProductMarginFloorCard from '../components/products/ProductMarginFloorCard';
import ProductStockCard from '../components/products/ProductStockCard';
import ProductRateCorrectionModal from '../components/products/ProductRateCorrectionModal';
import ProductParentPanel from '../components/products/ProductParentPanel';
import ProductWeightCard from '../components/products/ProductWeightCard';
import ProductChemistrySection from '../components/products/ProductChemistrySection';
import ToteFillCard from '../components/inventory/ToteFillCard';
import {
  addProductSize, createProductWithParent, getParentOfProduct, newSizeFields, SIZE_ROLE_LABELS,
  type ProductParent, type ProductSizeRole,
} from '../lib/productParents';
import { loadProductRateLock, PRODUCT_RATE_KEYS, rateLockSummary } from '../lib/productRateLock';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { logActivity } from '../lib/activityLogger';
import { sanitizeError, assertRpcResult, checkMutationResult, hasRpcCode, RpcErrorCodes, supabase, supabaseUntyped } from '../lib/db';
import { fetchAllRows, pageWithList } from '../lib/pagedRead';
import { localToday } from '../lib/dateUtils';
import { formatExactUSD } from '../lib/money';
import { lookupEpaRegistration } from '../lib/epaLookupClient';
import { Sentry } from '../lib/sentry';
import { unitOptionsForForm, rateUnitOptionsForProduct, isKnownUnit, PRODUCT_FORM_OPTIONS } from '../lib/units';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useLatestRef } from '../hooks/useLatestRef';
import { usePhoneSections } from '../hooks/usePhoneSections';
import type { CostHistory, EpaLookupResult, Product, ProductBrand, ProductRateLock, UnitConversion } from '../types';
import {
  applyProductPricingChangeSet,
  approvePricingChangeSet,
  defaultPricingMode,
  formatPricingMarginPercent,
  pricingDollarInputToCents,
  pricingMarginTextIsValid,
  previewProductPricingChanges,
  type PricingAcknowledgement,
  type PricingMode,
  type PricingPreviewInputRow,
  type PricingPreviewResult,
} from '../lib/productPricing';
import PricingSourceReasonModal, { type PricingSourceReason } from '../components/products/PricingSourceReasonModal';
import {
  getProductCostBasisWorkspace,
  formatCostBasisDollars,
  manualCostBasisPricingRow,
  purchaseCandidatePricingRow,
  supplierCandidatePricingRow,
  type CostBasisPricingBehavior,
  type ProductCostBasisWorkspace,
  type PurchaseCostBasisCandidate,
  type SupplierCostBasisCandidate,
} from '../lib/productCostBasis';
import { PRODUCT_COLUMNS, withAdminCost } from '../lib/costFields';
import {
  duplicateProductDraft, duplicateProductSource, listProductCategories, missingProductSetup, nearMatchNames, normalizedProductSetup,
  productSetupValidationMessage, visibleProductCategories, type DuplicateProductSource,
} from '../lib/productSetup';
import { listProductCropOptions, listProductUseTimingOptions } from '../lib/productUseTimings';
import UseTimingPicker from '../components/products/UseTimingPicker';
import UseTimingChoicesModal from '../components/products/UseTimingChoicesModal';
import { quoteLineChange } from '../lib/quoteNotes';
import type { CropOption, ProductCategory, UseTimingOption } from '../types';

const PRODUCT_NONPRICING_FIELDS = [
  'product_name', 'sku', 'category', 'vendor', 'manufacturer',
  'container_size', 'unit_size', 'suggested_rate', 'rate_per_acre', 'rate_unit',
  'notes', 'epa_registration', 'product_form', 'inventory_unit',
  'container_unit', 'container_type', 'is_rup', 'signal_word', 'internal_notes',
  'quoting_notes',
  'rei_hours', 'phi_days', 'max_label_rate', 'max_label_rate_unit', 'use_timings',
] as const satisfies ReadonlyArray<keyof Product>;

// Other screens write these (commit_label_draft writes the six label fields).
const PRODUCT_FIELDS_WRITTEN_ELSEWHERE = [
  'vendor', 'signal_word', 'rei_hours', 'phi_days', 'epa_registration', 'max_label_rate', 'max_label_rate_unit',
] as const satisfies ReadonlyArray<(typeof PRODUCT_NONPRICING_FIELDS)[number]>;

const PRODUCT_PRICING_FIELDS = [
  'current_cost', 'tier1_margin', 'tier2_margin', 'tier3_margin',
  'tier1_price', 'tier2_price', 'tier3_price',
] as const satisfies ReadonlyArray<keyof Product>;

type ProductPricingMoneyField = 'tier1_price' | 'tier2_price' | 'tier3_price';
type ProductPricingMoneyDrafts = Partial<Record<ProductPricingMoneyField, string>>;
type ProductPricingMarginField = 'tier1_margin' | 'tier2_margin' | 'tier3_margin';
type ProductPricingMarginDrafts = Partial<Record<ProductPricingMarginField, string>>;

// PAR-1: a grouped size's parent owns these; the page never sends them for one.
const PARENT_OWNED_FIELDS = ['category', 'use_timings', 'epa_registration', ...PRODUCT_RATE_KEYS] as const;

function nonpricingProductPayload(product: Partial<Product>, persisted?: Product, parentOwned = false): Record<string, unknown> {
  const payload: Record<string, unknown> = Object.fromEntries([
    ...PRODUCT_NONPRICING_FIELDS.map((field) => [field, product[field]] as const),
    ['updated_at', new Date().toISOString()],
  ]);
  if (parentOwned) for (const field of PARENT_OWNED_FIELDS) delete payload[field];
  // Send these only when edited here, so a page left open never re-saves an old value over one
  // changed elsewhere: the vendor by WP-PM-15 (preferred vendor's copy), the rest by Label Review's commit.
  // Rates too: a stale rate resent while rates are locked would refuse a details-only save.
  if (persisted) {
    for (const field of [...PRODUCT_FIELDS_WRITTEN_ELSEWHERE, ...PRODUCT_RATE_KEYS]) {
      if (payload[field] === (persisted[field] ?? null)) delete payload[field];
    }
  }
  return payload;
}

function pricingMoneyInput(
  product: Partial<Product>,
  drafts: ProductPricingMoneyDrafts,
  field: ProductPricingMoneyField,
): string {
  return drafts[field] ?? (product[field] == null ? '' : String(product[field]));
}

function pricingChanged(
  product: Partial<Product>,
  persisted: Product | null,
  moneyDrafts: ProductPricingMoneyDrafts,
): boolean {
  if (!persisted) return false;
  if (Object.keys(moneyDrafts).length > 0) return true;
  return PRODUCT_PRICING_FIELDS.some((field) => product[field] !== persisted[field]);
}

function productDetailsChanged(product: Partial<Product>, persisted: Product | null): boolean {
  if (!persisted) return false;
  return PRODUCT_NONPRICING_FIELDS.some((field) => field === 'use_timings'
    ? [...(product.use_timings ?? [])].sort().join('\u0000') !== [...(persisted.use_timings ?? [])].sort().join('\u0000')
    : product[field] !== persisted[field]);
}

function pricingPreviewRow(
  product: Partial<Product>,
  persisted: Product,
  mode: PricingMode,
  note: PricingSourceReason,
  moneyDrafts: ProductPricingMoneyDrafts,
  marginDrafts: ProductPricingMarginDrafts,
  costOverride?: string,
): PricingPreviewInputRow {
  if (!Number.isInteger(persisted.pricing_version) || (persisted.pricing_version ?? 0) < 1) {
    throw new Error('This Product does not have a pricing version yet. Refresh after the Phase 1a database migration is available.');
  }
  const cost = costOverride ?? (product.current_cost == null ? '' : String(product.current_cost));
  if (cost === null || cost === '') throw new Error('Enter the Product cost before reviewing pricing.');
  const row: PricingPreviewInputRow = {
    product_id: persisted.id,
    product_name: persisted.product_name,
    sku: persisted.sku ?? '',
    row_version: persisted.pricing_version!,
    pricing_mode: mode,
    new_cost: cost,
    change_reason: note.reason.trim(),
    price_source: note.source.trim(),
  };
  if (mode === 'margin_driven') {
    for (const tier of [1, 2, 3] as const) {
      const value = product[`tier${tier}_margin` as const];
      if (value === null || value === undefined) {
        throw new Error('Margin-driven pricing requires all three net margins.');
      }
      const draft = marginDrafts[`tier${tier}_margin` as ProductPricingMarginField];
      if (draft && !pricingMarginTextIsValid(draft)) {
        throw new Error('Enter each net margin as a plain number below 100.');
      }
      row[`tier${tier}_margin_percent` as const] = draft ? draft : formatPricingMarginPercent(value);
    }
  } else {
    for (const tier of [1, 2, 3] as const) {
      const field = `tier${tier}_price` as ProductPricingMoneyField;
      const value = pricingMoneyInput(product, moneyDrafts, field);
      if (value === '') {
        throw new Error('Price-driven pricing requires all three tier prices.');
      }
      row[`tier${tier}_price` as const] = value;
    }
  }
  return row;
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function namesClearlyDiffer(productName: string | null | undefined, epaName: string | null): boolean {
  if (!hasText(productName) || !hasText(epaName)) return false;

  const normalize = (value: string) => value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const current = normalize(productName);
  const epa = normalize(epaName);
  const currentCompact = current.replace(/\s+/g, '');
  const epaCompact = epa.replace(/\s+/g, '');
  if (currentCompact === epaCompact
      || currentCompact.includes(epaCompact)
      || epaCompact.includes(currentCompact)) {
    return false;
  }

  const currentTokens = new Set(current.split(' ').filter((token) => token.length >= 3));
  const epaTokens = epa.split(' ').filter((token) => token.length >= 3);
  return !epaTokens.some((token) => currentTokens.has(token));
}

/** Points a read-only, parent-owned field at where it changes. */
function ParentOwnedHint({ parentName, identity = false }: { parentName?: string; identity?: boolean }) {
  return (
    <p className="mt-1 text-xs text-secondary">
      {parentName
        ? `Set on parent ${parentName}. Change it with ${identity ? 'Correct identity' : 'Edit parent'} in the Parent panel.`
        : 'Read-only until the parent loads.'}
    </p>
  );
}

export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const isNew = id === 'new';
  const isAdmin = role === 'admin';
  const [rateLock, setRateLock] = useState<ProductRateLock | null>(null);
  const [correctingRates, setCorrectingRates] = useState(false);
  const [rateLockFailed, setRateLockFailed] = useState(false);
  // Until the lock is known, rates stay read-only: a save that changed them could be refused.
  const ratesLocked = rateLock?.is_locked !== false;
  const loadRateLock = useCallback(() => {
    setRateLockFailed(false);
    loadProductRateLock().then(setRateLock).catch((error: unknown) => {
      Sentry.captureException(error);
      // An older "open" may be out of date: back to read-only.
      setRateLock(null);
      setRateLockFailed(true);
    });
  }, []);
  useEffect(loadRateLock, [loadRateLock]);
  // WP-PM-6b: a Duplicate arrives with its source's copied fields; a fresh create arrives flagged to prompt for prices.
  // PAR-1: "Add a size" also carries the parent the new size joins; "New product" carries none.
  const routeState = useLocation().state as {
    duplicateFrom?: DuplicateProductSource; addSizeTo?: ProductParent; justCreated?: boolean;
  } | null;
  const duplicateSource = isNew ? routeState?.duplicateFrom : undefined;
  // State, so a stale parent can be refreshed in place after the database refuses it.
  const [addSizeTo, setAddSizeTo] = useState<ProductParent | undefined>(isNew ? routeState?.addSizeTo : undefined);
  const justCreated = !isNew && routeState?.justCreated === true;
  // undefined while loading or after a failed load, null when the product has no parent.
  const [parent, setParent] = useState<ProductParent | null | undefined>(isNew ? null : undefined);
  const [parentLoadFailed, setParentLoadFailed] = useState(false);
  // DM-1: a weight save on this page re-reads cost per lb of active.
  const [weightSaves, setWeightSaves] = useState(0);
  const [parentReload, setParentReload] = useState(0);
  // Category, use timings, EPA number and rates belong to the parent; until the page knows there is
  // none, they stay read-only.
  const parentOwned = isNew ? Boolean(addSizeTo) : parent !== null;
  const shownParent = isNew ? addSizeTo ?? null : parent ?? null;
  // BLK-1a: a fixed tote with a Bulk fill source can be filled from that Bulk; the database rechecks everything else.
  const fillableTote = !isNew && Boolean(parent?.sizes.some((size) =>
    size.product_id === id && size.size_role === 'fixed_tote' && size.fill_source_product_id));
  const [stockReload, setStockReload] = useState(0);
  const [newParent, setNewParent] = useState({ name: '', nickname: '', formulation_type: '', safener: '' });
  const [sizeRole, setSizeRole] = useState<ProductSizeRole>('package');
  useEffect(() => {
    if (isNew || !id) return;
    let cancelled = false;
    setParentLoadFailed(false);
    getParentOfProduct(id)
      .then((loaded) => { if (!cancelled) setParent(loaded); })
      .catch((error: unknown) => {
        Sentry.captureException(error, { extra: { context: 'product_detail_parent' } });
        if (!cancelled) { setParent(undefined); setParentLoadFailed(true); }
      });
    return () => { cancelled = true; };
  }, [id, isNew, parentReload]);

  const [product, setProduct] = useState<Partial<Product>>(() => ({
    product_name: '',
    sku: '',
    category: '',
    use_timings: [],
    vendor: '',
    manufacturer: '',
    container_size: undefined,
    unit_size: '',
    epa_registration: '',
    is_rup: false,
    signal_word: null,
    rei_hours: null,
    phi_days: null,
    product_form: null,
    inventory_unit: null,
    container_unit: null,
    container_type: null,
    current_cost: undefined,
    tier1_price: undefined,
    tier2_price: undefined,
    tier3_price: undefined,
    suggested_rate: '',
    rate_per_acre: undefined,
    rate_unit: '',
    notes: '',
    quoting_notes: '',
    is_active: true,
    // ProductDetailRoute remounts this page per id, so Duplicate's /products/new runs this initializer afresh.
    ...(duplicateSource ? duplicateProductDraft(duplicateSource) : {}),
    // A new size shows its parent's values; the database copies them on save.
    ...(addSizeTo ? {
      category: addSizeTo.category ?? '', use_timings: addSizeTo.use_timings ?? [], product_form: addSizeTo.product_form as Product['product_form'],
      epa_registration: addSizeTo.generic_epa_registration ?? '',
    } : {}),
  }));
  const [costHistory, setCostHistory] = useState<CostHistory[]>([]);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<ProductCategory[]>([]);
  const [timingOptions, setTimingOptions] = useState<UseTimingOption[]>([]);
  const [cropOptions, setCropOptions] = useState<CropOption[]>([]);
  const [timingChoicesOpen, setTimingChoicesOpen] = useState(false);
  const [timingLoadFailed, setTimingLoadFailed] = useState(false);
  const [pendingCategory, setPendingCategory] = useState<string | null | undefined>(undefined);
  const [categoryLoadFailed, setCategoryLoadFailed] = useState(false);
  const [nameRequired, setNameRequired] = useState(false);
  const [reiDraft, setReiDraft] = useState('');
  const [phiDraft, setPhiDraft] = useState('');
  const [vendorOptions, setVendorOptions] = useState<string[]>([]);
  const [manufacturerOptions, setManufacturerOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [costModal, setCostModal] = useState(false);
  const [newCost, setNewCost] = useState('');
  const [persistedProduct, setPersistedProduct] = useState<Product | null>(null);
  const [pricingMode, setPricingMode] = useState<PricingMode | ''>('');
  const [pricingMoneyDrafts, setPricingMoneyDrafts] = useState<ProductPricingMoneyDrafts>({});
  const [pricingMarginDrafts, setPricingMarginDrafts] = useState<ProductPricingMarginDrafts>({});
  const [pricingPreview, setPricingPreview] = useState<PricingPreviewResult | null>(null);
  const [pricingPreviewTitle, setPricingPreviewTitle] = useState('Review Product Pricing');
  // A pricing change waiting for its source and reason before the preview.
  const [pendingPricingReview, setPendingPricingReview] = useState<
    { costOverride?: string } | null
  >(null);
  const [previewingPricing, setPreviewingPricing] = useState(false);
  const [applyingPricing, setApplyingPricing] = useState(false);
  const [pricingReloadRequired, setPricingReloadRequired] = useState(false);
  const [pricingReloading, setPricingReloading] = useState(false);
  const [costBasisWorkspace, setCostBasisWorkspace] = useState<ProductCostBasisWorkspace | null>(null);
  const [costBasisLoading, setCostBasisLoading] = useState(false);
  const [costBasisLoadFailed, setCostBasisLoadFailed] = useState(false);
  const [costBasisBusy, setCostBasisBusy] = useState(false);
  const [costBasisReason, setCostBasisReason] = useState('');
  const [manualBasisCost, setManualBasisCost] = useState('');
  const [costBasisPricingBehavior, setCostBasisPricingBehavior] = useState<CostBasisPricingBehavior>('keep_sell_prices');
  const [priceHistoryReloadToken, setPriceHistoryReloadToken] = useState(0);
  const [costHistoryLoaded, setCostHistoryLoaded] = useState(false);
  const [costHistoryLoadFailed, setCostHistoryLoadFailed] = useState(false);
  const pricingPreviewIntentRef = useRef<string | null>(null);
  const costBasisWorkspaceRequestRef = useRef(0);
  const pricingPreviewRequestRef = useRef(0);
  // Committed product id, read after awaits to drop results for a product the user has left.
  const productIdRef = useLatestRef(id);
  const [persistedLabelFields, setPersistedLabelFields] = useState<{
    signalWord: Product['signal_word'];
    epaRegistration: string | null;
  }>({ signalWord: null, epaRegistration: null });
  const [epaLookupResult, setEpaLookupResult] = useState<EpaLookupResult | null>(null);
  const [epaLookupRegNumber, setEpaLookupRegNumber] = useState('');
  const [epaLookupLoading, setEpaLookupLoading] = useState(false);
  const [epaDraftCreating, setEpaDraftCreating] = useState(false);
  const epaDraftKey = useIdempotencyKey('create_label_draft', profile?.id ?? '');
  const { getKeyFor: getCreateKeyFor, resetKeyFor: resetCreateKeyFor } = useIdempotencyKey('create_product_with_parent', profile?.id ?? '');
  const {
    getKey: getPreviewPricingKey,
    resetKey: resetPreviewPricingKey,
  } = useIdempotencyKey('preview_product_pricing_changes', profile?.id ?? '');
  const {
    getKeyFor: getApprovePricingKeyFor,
    resetKeyFor: resetApprovePricingKeyFor,
  } = useIdempotencyKey('approve_pricing_change_set', profile?.id ?? '');
  const {
    getKey: getApplyPricingKey,
    resetKey: resetApplyPricingKey,
  } = useIdempotencyKey('apply_product_pricing_change_set', profile?.id ?? '');

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(Boolean(duplicateSource));
  // The margin floor card saves on its own, so its unsaved edit is tracked apart from the form.
  const [marginFloorDirty, setMarginFloorDirty] = useState(false);
  // Lets the navigate() right after a successful save past the prompt (see useUnsavedChanges).
  const skipUnsavedPromptRef = useRef(false);
  const blocker = useUnsavedChanges(isDirty || marginFloorDirty, skipUnsavedPromptRef);
  // On phones the page folds. Pricing opens first; someone with no pricing to edit starts on the details.
  const { sectionProps, reveal: revealPhoneSection } = usePhoneSections(
    isNew || !isAdmin ? ['information', 'pricing'] : ['pricing'],
  );

  // Cancelled-registration warning (grand plan §8): the saved product number and its brands' numbers.
  const [brandRegistrations, setBrandRegistrations] = useState<{ label: string; epaRegistration: string | null }[]>([]);
  // A failed brand-list read is shown as "could not check", never as "no cancelled brands".
  const [brandsReadFailed, setBrandsReadFailed] = useState(false);
  const handleBrandsChange = useCallback((brands: ProductBrand[] | null) => {
    setBrandsReadFailed(brands === null);
    setBrandRegistrations((brands ?? []).map((b) => ({ label: `Brand ${b.brand_name}`, epaRegistration: b.epa_registration })));
  }, []);
  // Another product's brands never sit under this product's number.
  useEffect(() => { setBrandRegistrations([]); setBrandsReadFailed(false); }, [id]);
  const registrationSources = useMemo(() => (
    persistedProduct && persistedProduct.id === id
      ? [{ label: 'This product', epaRegistration: persistedProduct.epa_registration }, ...brandRegistrations]
      : []
  ), [persistedProduct, id, brandRegistrations]);
  const registrationStatus = useCancelledRegistrations(registrationSources.map((s) => s.epaRegistration));

  const fetchProduct = useCallback(async (reportError = true): Promise<boolean> => {
    const { data, error } = await supabase.from('products').select(PRODUCT_COLUMNS).eq('id', id!).maybeSingle();
    if (error) {
      Sentry.captureException(error);
      if (reportError) toast('error', 'Failed to load product');
      setLoading(false);
      return false;
    }
    // Cost is admin-only (Mason, 2026-10-15).
    let withCost: Product | null;
    try {
      withCost = await withAdminCost('products', data as Product | null, isAdmin);
    } catch (costError) {
      Sentry.captureException(costError);
      if (reportError) toast('error', 'Failed to load product');
      setLoading(false);
      return false;
    }
    // The admin cost read is a second await: an older load must not install its product.
    if (productIdRef.current !== id) return false;
    if (withCost) {
      const loadedProduct = withCost;
      setProduct(loadedProduct);
      setNameRequired(false);
      setReiDraft(loadedProduct.rei_hours == null ? '' : String(loadedProduct.rei_hours));
      setPhiDraft(loadedProduct.phi_days == null ? '' : String(loadedProduct.phi_days));
      setPersistedProduct(loadedProduct);
      setPricingMode(defaultPricingMode(loadedProduct));
      setPricingMoneyDrafts({});
      setPricingMarginDrafts({});
      setPricingReloadRequired(false);
      setIsDirty(false);
      setPersistedLabelFields({
        signalWord: loadedProduct.signal_word,
        epaRegistration: loadedProduct.epa_registration,
      });
    }
    setLoading(false);
    return data !== null;
  }, [id, isAdmin, productIdRef, toast]);

  const fetchCostHistory = useCallback(async (reportError = true): Promise<boolean> => {
    // cost_history is admin-only under RLS; a non-admin fetch would just be a
    // denied round-trip (the history panel below only renders for admins).
    if (!isAdmin) return true;
    setCostHistoryLoaded(false);
    setCostHistoryLoadFailed(false);
    const { data, error } = await supabase
      .from('cost_history')
      .select('*')
      .eq('product_id', id!)
      // The starting snapshot (20261026140000) records no change; the Sell Price History card shows it.
      .neq('change_source', 'starting_snapshot')
      .order('changed_at', { ascending: false })
      .limit(20);
    if (error) {
      Sentry.captureException(error);
      setCostHistoryLoadFailed(true);
      if (reportError) toast('error', 'Failed to load pricing history');
      return false;
    }
    setCostHistory((data || []) as CostHistory[]);
    setCostHistoryLoaded(true);
    return true;
  }, [id, isAdmin, toast]);

  const fetchCostBasisWorkspace = useCallback(async (reportError = true): Promise<boolean> => {
    const requestId = ++costBasisWorkspaceRequestRef.current;
    if (!isAdmin || !id || isNew) return true;
    setCostBasisWorkspace(null);
    setCostBasisLoadFailed(false);
    setCostBasisLoading(true);
    try {
      const workspace = await getProductCostBasisWorkspace(id);
      if (costBasisWorkspaceRequestRef.current !== requestId) return false;
      if (workspace.product.id !== id) {
        throw new Error('Cost-basis workspace returned the wrong Product.');
      }
      setCostBasisWorkspace(workspace);
      return true;
    } catch (error) {
      if (costBasisWorkspaceRequestRef.current !== requestId) return false;
      setCostBasisWorkspace(null);
      setCostBasisLoadFailed(true);
      Sentry.captureException(error);
      if (reportError) toast('error', 'Failed to load governed cost-basis options');
      return false;
    } finally {
      if (costBasisWorkspaceRequestRef.current === requestId) setCostBasisLoading(false);
    }
  }, [id, isAdmin, isNew, toast]);

  useEffect(() => {
    if (!isNew && id) {
      void fetchProduct();
      void fetchCostHistory();
      void fetchCostBasisWorkspace();
    }
  }, [id, isNew, fetchProduct, fetchCostHistory, fetchCostBasisWorkspace]);

  useEffect(() => {
    pricingPreviewRequestRef.current += 1;
    setPricingPreview(null);
    setPricingPreviewTitle('Review Product Pricing');
    resetPreviewPricingKey();
    resetApplyPricingKey();
    setCostBasisReason('');
    setManualBasisCost('');
    setCostBasisPricingBehavior('keep_sell_prices');
    pricingPreviewIntentRef.current = null;
  }, [id, resetApplyPricingKey, resetPreviewPricingKey]);

  useEffect(() => {
    supabase.from('unit_conversions').select('*').order('unit').then(({ data, error }) => {
      if (error) { Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_unit_conversions' } }); return; }
      setUnitConversions((data || []) as UnitConversion[]);
    });
    listProductCategories().then(setCategoryOptions).catch((error: unknown) => {
      Sentry.captureException(error);
      setCategoryLoadFailed(true);
      toast('error', 'Could not load product categories. Refresh before saving a category.');
    });
    listProductUseTimingOptions().then(setTimingOptions).catch(() => {
      setTimingLoadFailed(true);
      toast('error', 'Could not load use timings. Refresh before changing them.');
    });
    // Crop names only label the picker's groups; without them each group shows its crop code.
    listProductCropOptions().then(setCropOptions).catch(() => undefined);
    // Vendor and manufacturer remain free-text choices.
    // Every product's choices, page by page (Goal 4): one read stops silently at 1000 rows.
    void fetchAllRows((from, to) => pageWithList(supabase.from('products').select('id, vendor, manufacturer', { count: 'exact' }).order('id').range(from, to))).then(({ data, error }) => {
      if (error) { Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_product_options' } }); return; }
      if (!data) return;
      const vends = [...new Set(data.map((p) => p.vendor).filter(Boolean) as string[])].sort();
      const mfrs = [...new Set(data.map((p) => p.manufacturer).filter(Boolean) as string[])].sort();
      setVendorOptions(vends);
      setManufacturerOptions(mfrs);
    });
  }, [toast]);

  const saveExistingProductDetails = async () => {
    const validation = productSetupValidationMessage(product, reiDraft, phiDraft, persistedProduct);
    if (validation) throw new Error(validation);
    if ((persistedProduct?.product_form && product.product_form !== persistedProduct.product_form)
      || (persistedProduct?.container_unit && product.container_unit !== persistedProduct.container_unit)
      || (persistedProduct?.inventory_unit && product.inventory_unit !== persistedProduct.inventory_unit)) {
      throw new Error("This can't change on a saved product yet; it waits for the reviewed unit change.");
    }
    if (!persistedProduct || persistedProduct.id !== id || !Number.isInteger(persistedProduct.pricing_version)) {
      throw new Error('Reload this Product before saving details.');
    }
    const result = await supabaseUntyped
      .from('products')
      .update(nonpricingProductPayload(normalizedProductSetup(product, reiDraft, phiDraft, persistedProduct), persistedProduct, parentOwned))
      .eq('id', id!)
      .eq('pricing_version', persistedProduct.pricing_version)
      .select('id');
    if (!result.error && Array.isArray(result.data) && result.data.length === 0) {
      throw new Error('Product details changed after this page loaded. Reload before saving.');
    }
    checkMutationResult(result, 'Update product details');
    setPersistedLabelFields({
      signalWord: product.signal_word ?? null,
      epaRegistration: product.epa_registration?.trim() || null,
    });
  };

  // The preview row for this page's pricing change; throws the first thing that blocks a review.
  const buildPricingReviewRow = (note: PricingSourceReason, costOverride?: string) => {
    if (pricingReloadRequired) {
      throw new Error('Reload this Product before making another change.');
    }
    if (!profile || !persistedProduct) throw new Error('Reload this Product before changing pricing.');
    if (productDetailsChanged(product, persistedProduct)) {
      throw new Error('Save or discard the unsaved Product details before reviewing a pricing change.');
    }
    if (pricingMode !== 'margin_driven' && pricingMode !== 'price_driven') {
      throw new Error('Choose margin-driven or price-driven before reviewing pricing.');
    }
    return pricingPreviewRow(product, persistedProduct, pricingMode, note, pricingMoneyDrafts, pricingMarginDrafts, costOverride);
  };

  // Check everything but the source and reason before asking for them, so nobody types them for nothing.
  const openPricingReview = (costOverride?: string) => {
    buildPricingReviewRow({ source: '', reason: '' }, costOverride);
    setPendingPricingReview({ costOverride });
  };

  const requestPricingReview = async ({
    costOverride,
    note,
  }: {
    costOverride?: string;
    note: PricingSourceReason;
  }) => {
    const row = buildPricingReviewRow(note, costOverride);
    if (!profile || !persistedProduct) return;
    const intent = JSON.stringify(row);
    if (pricingPreviewIntentRef.current !== intent) {
      resetPreviewPricingKey();
      pricingPreviewIntentRef.current = intent;
    }
    const targetProductId = persistedProduct.id;
    const requestId = ++pricingPreviewRequestRef.current;
    const preview = await previewProductPricingChanges({
      source: 'product_page',
      rows: [row],
      performedBy: profile.id,
      idempotencyKey: getPreviewPricingKey(),
    });
    if (pricingPreviewRequestRef.current !== requestId
        || productIdRef.current !== targetProductId) return;
    resetPreviewPricingKey();
    pricingPreviewIntentRef.current = null;

    setPricingPreviewTitle('Review Product Pricing');
    setPricingPreview(preview);
  };

  const costBasisRowOptions = () => {
    const reason = costBasisReason.trim();
    if (!reason) throw new Error('Enter a reason before selecting a cost basis.');
    if (!persistedProduct) throw new Error('Reload this Product before selecting a cost basis.');
    return {
      reason,
      basisSource: 'product_detail' as const,
      pricingBehavior: costBasisPricingBehavior,
      currentTierPrices: {
        tier1: pricingMoneyInput(persistedProduct, {}, 'tier1_price'),
        tier2: pricingMoneyInput(persistedProduct, {}, 'tier2_price'),
        tier3: pricingMoneyInput(persistedProduct, {}, 'tier3_price'),
      },
    };
  };

  const previewCostBasisRow = async (row: PricingPreviewInputRow, label: string) => {
    if (!profile || !costBasisWorkspace) return;
    const intent = JSON.stringify(row);
    if (pricingPreviewIntentRef.current !== intent) {
      resetPreviewPricingKey();
      pricingPreviewIntentRef.current = intent;
    }
    const requestId = ++pricingPreviewRequestRef.current;
    const preview = await previewProductPricingChanges({
      // p_source identifies the single-Product change-set route. The row's
      // basis_source separately records that the choice came from Product Detail.
      source: 'product_page',
      rows: [row],
      performedBy: profile.id,
      idempotencyKey: getPreviewPricingKey(),
    });
    if (pricingPreviewRequestRef.current !== requestId
        || productIdRef.current !== row.product_id) return;
    resetPreviewPricingKey();
    pricingPreviewIntentRef.current = null;
    setPricingPreviewTitle(`Review cost basis — ${label}`);
    setPricingPreview(preview);
  };

  const ensureCostBasisSelectionReady = () => {
    if (!costBasisWorkspace?.enabled) {
      throw new Error('Choosing a cost basis is turned off for now.');
    }
    if (pricingReloadRequired) throw new Error('Reload this Product before making another change.');
    if (!id || costBasisWorkspace.product.id !== id || persistedProduct?.id !== id) {
      throw new Error('Reload this Product before selecting a cost basis.');
    }
    if (costBasisWorkspace.product.pricing_version !== persistedProduct.pricing_version) {
      throw new Error('Product pricing changed while this cost-basis workspace loaded. Reload before selecting a cost basis.');
    }
    if (isDirty || productDetailsChanged(product, persistedProduct)
        || pricingChanged(product, persistedProduct, pricingMoneyDrafts)) {
      throw new Error('Save or discard unsaved Product changes before selecting a cost basis.');
    }
  };

  const handleSupplierBasisSelection = async (candidate: SupplierCostBasisCandidate) => {
    if (!costBasisWorkspace) return;
    setCostBasisBusy(true);
    try {
      ensureCostBasisSelectionReady();
      await previewCostBasisRow(
        supplierCandidatePricingRow(costBasisWorkspace, candidate, costBasisRowOptions()),
        `${candidate.vendor_name} at $${formatCostBasisDollars(candidate.normalized_cost_cents)}`,
      );
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setCostBasisBusy(false);
    }
  };

  const handlePurchaseBasisSelection = async (candidate: PurchaseCostBasisCandidate) => {
    if (!costBasisWorkspace) return;
    setCostBasisBusy(true);
    try {
      ensureCostBasisSelectionReady();
      await previewCostBasisRow(
        purchaseCandidatePricingRow(costBasisWorkspace, candidate, costBasisRowOptions()),
        `${candidate.po_number} received PO cost`,
      );
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setCostBasisBusy(false);
    }
  };

  const handleManualBasisSelection = async () => {
    if (!costBasisWorkspace) return;
    const costCents = pricingDollarInputToCents(manualBasisCost);
    if (costCents === null) {
      toast('error', 'Enter a non-negative cost with no more than two decimal places');
      return;
    }
    setCostBasisBusy(true);
    try {
      ensureCostBasisSelectionReady();
      await previewCostBasisRow(
        manualCostBasisPricingRow(costBasisWorkspace, costCents, costBasisRowOptions()),
        `manual cost $${formatCostBasisDollars(costCents)}`,
      );
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setCostBasisBusy(false);
    }
  };

  const handleSave = async () => {
    if (pricingReloadRequired) {
      toast('error', 'Reload this Product before making another change.');
      return;
    }
    for (const [field, label] of [
      ['tier1_price', 'Tier 1 price'],
      ['tier2_price', 'Tier 2 price'],
      ['tier3_price', 'Tier 3 price'],
    ] as const) {
      const value = pricingMoneyInput(product, pricingMoneyDrafts, field);
      if (value !== '' && pricingDollarInputToCents(value) === null) {
        toast('error', `${label} must be a non-negative dollar amount with no more than two decimal places`);
        revealPhoneSection('pricing');
        return;
      }
    }

    // Warn (but allow) if price < cost. The server preview remains authoritative.
    const costCents = pricingDollarInputToCents(String(product.current_cost ?? 0)) ?? 0n;
    const priceCents = (['tier1_price', 'tier2_price', 'tier3_price'] as const)
      .map((field) => pricingDollarInputToCents(pricingMoneyInput(product, pricingMoneyDrafts, field)))
      .filter((value): value is bigint => value !== null && value > 0n);
    if (costCents > 0n && priceCents.some((price) => price < costCents)) {
      toast('warning', 'Warning: One or more tier prices are below cost (negative margin)');
    }

    const hasPricingChanges = !isNew && pricingChanged(product, persistedProduct, pricingMoneyDrafts);
    const hasProductDetailChanges = !isNew && productDetailsChanged(product, persistedProduct);
    if (hasPricingChanges && hasProductDetailChanges) {
      toast('error', 'Fix and save the product details first, then change the price.');
      revealPhoneSection('information');
      return;
    }
    if (hasPricingChanges) {
      try { openPricingReview(); } catch (error) { toast('error', sanitizeError(error)); }
      return;
    }
    const setupError = productSetupValidationMessage(product, reiDraft, phiDraft, persistedProduct);
    if (setupError) {
      setNameRequired(setupError === 'Enter a product name.');
      toast('error', setupError);
      revealPhoneSection('information');
      return;
    }
    if (categoryLoadFailed && Boolean(product.category) && product.category !== persistedProduct?.category) {
      toast('error', 'Could not load product categories. Refresh before saving a category.');
      revealPhoneSection('information');
      return;
    }
    if ((persistedProduct?.product_form && product.product_form !== persistedProduct.product_form)
      || (persistedProduct?.container_unit && product.container_unit !== persistedProduct.container_unit)
      || (persistedProduct?.inventory_unit && product.inventory_unit !== persistedProduct.inventory_unit)) {
      toast('error', "This can't change on a saved product yet; it waits for the reviewed unit change.");
      revealPhoneSection('information');
      return;
    }

    // A new parent needs its form; a new size takes its parent's form.
    if (isNew && !addSizeTo && !product.product_form) {
      toast('error', 'Choose a product form (liquid, dry, seed or each) before saving.');
      revealPhoneSection('information');
      return;
    }

    // Container size must be positive if set
    if (product.container_size != null && product.container_size <= 0
      && (!persistedProduct || product.container_size !== persistedProduct.container_size)) {
      toast('error', 'Container size must be greater than 0');
      revealPhoneSection('information');
      return;
    }

    // Label intervals must be non-negative (printed on WPS compliance notices)
    if (product.rei_hours != null && product.rei_hours < 0
      && (!persistedProduct || product.rei_hours !== persistedProduct.rei_hours)) {
      toast('error', 'REI (hours) cannot be negative');
      revealPhoneSection('information');
      return;
    }
    if (product.phi_days != null && product.phi_days < 0
      && (!persistedProduct || product.phi_days !== persistedProduct.phi_days)) {
      toast('error', 'PHI (days) cannot be negative');
      revealPhoneSection('information');
      return;
    }

    setSaving(true);
    try {
      if (isNew) {
        // PAR-1: every new product is a size of a parent, created through the database's checked path.
        const normalized = normalizedProductSetup(product, reiDraft, phiDraft);
        // The notes are not setup fields, but the database saves them in the same step as the size.
        const notes = Object.fromEntries((['quoting_notes', 'internal_notes'] as const)
          .filter((field) => (normalized[field] ?? '').trim() !== '').map((field) => [field, normalized[field]]));
        const size = { ...newSizeFields(normalized as Record<string, unknown>, sizeRole), ...notes };
        const addSize = addSizeTo ? { ...size, epa_registration: null } : null;
        const newParentFields = {
          name: newParent.name.trim() || normalized.product_name, nickname: newParent.nickname,
          product_form: normalized.product_form ?? null, formulation_type: newParent.formulation_type,
          safener: newParent.safener, generic_epa_registration: normalized.epa_registration ?? null,
          category: normalized.category ?? null, use_timings: normalized.use_timings ?? [],
        };
        // The key is tied to exactly this request, so an edited retry is a new request.
        const scope = JSON.stringify(addSizeTo ? [addSizeTo.id, addSizeTo.parent_version, addSize] : [newParentFields, size]);
        const created = addSizeTo && addSize
          ? await addProductSize(addSizeTo.id, addSizeTo.parent_version, addSize, getCreateKeyFor(scope))
          : await createProductWithParent(newParentFields, size, getCreateKeyFor(scope));
        resetCreateKeyFor(scope);
        const newProductId = created.product_id;
        setIsDirty(false);
        logActivity({ event: 'product_created', description: `Product ${product.product_name} created`, performedBy: profile!.id, entityType: 'product', entityId: newProductId });
        skipUnsavedPromptRef.current = true;
        if (!newProductId) {
          // Saved, but the id did not come back: the list still shows the new product.
          toast('success', 'Product created');
          navigate('/products');
          return;
        }
        toast('success', isAdmin ? 'Product created. Now set its prices.' : 'Product created');
        navigate(`/products/${newProductId}`, { state: { justCreated: true } });
        return;
      }

      await saveExistingProductDetails();
      await fetchProduct();
      setPriceHistoryReloadToken((current) => current + 1);
      setIsDirty(false);
      toast('success', 'Product updated');
      logActivity({ event: 'product_updated', description: `Product ${product.product_name} updated`, performedBy: profile!.id, entityType: 'product', entityId: id });
    } catch (err: unknown) {
      Sentry.captureException(toSentryError(err), { extra: { context: 'save_product' } });
      toast('error', sanitizeError(err));
      if (addSizeTo && hasRpcCode(err, RpcErrorCodes.PRODUCT_PARENT_STALE) && addSizeTo.sizes[0]) {
        // The parent changed since "Add a size" opened: show its current values; the next save uses them.
        void getParentOfProduct(addSizeTo.sizes[0].product_id).then((fresh) => {
          if (!fresh) return;
          if (fresh.id !== addSizeTo.id) {
            toast('error', 'That size moved to another parent. Reopen "Add a size" from the parent you want.');
            return;
          }
          setAddSizeTo(fresh);
          setProduct((current) => ({ ...current, category: fresh.category ?? '', use_timings: fresh.use_timings ?? [],
            epa_registration: fresh.generic_epa_registration ?? '' }));
        }).catch((reloadError: unknown) => Sentry.captureException(reloadError));
      }
      if (hasRpcCode(err, RpcErrorCodes.PRODUCT_RATES_LOCKED)) {
        // Rates were locked meanwhile: put the saved rates back so the rest of the edit can save.
        // Forget the stale open lock first, so a failed refresh still leaves the rates read-only.
        setRateLock(null);
        loadRateLock();
        setProduct((current) => ({ ...current, rate_per_acre: persistedProduct?.rate_per_acre ?? null,
          rate_unit: persistedProduct?.rate_unit ?? null, suggested_rate: persistedProduct?.suggested_rate ?? null }));
      }
      revealPhoneSection(pricingChanged(product, persistedProduct, pricingMoneyDrafts) ? 'pricing' : 'information');
    } finally {
      setSaving(false);
    }
  };

  const handleCostUpdate = () => {
    if (pricingReloadRequired) {
      toast('error', 'Reload this Product before making another change.');
      return;
    }
    const costCents = pricingDollarInputToCents(newCost);
    if (costCents === null) {
      toast('error', 'Enter a non-negative cost with no more than two decimal places');
      return;
    }
    if (pricingMode === 'margin_driven' && costCents === 0n) {
      toast('error', 'Margin-driven pricing requires a cost greater than $0. No prices were changed.');
      return;
    }
    try {
      openPricingReview(newCost);
      setCostModal(false);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
  };

  const submitPricingReview = async (note: PricingSourceReason) => {
    if (!pendingPricingReview) return;
    setPreviewingPricing(true);
    try {
      await requestPricingReview({ costOverride: pendingPricingReview.costOverride, note });
      setPendingPricingReview(null);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    } finally {
      setPreviewingPricing(false);
    }
  };

  const handleApplyPricing = async (acknowledgements: PricingAcknowledgement[]) => {
    if (!pricingPreview || !profile) return;
    const previewProductIds = [...new Set(
      pricingPreview.rows.map((row) => row.product_id).filter((productId): productId is string => Boolean(productId)),
    )];
    if (!id || previewProductIds.length !== 1 || previewProductIds[0] !== id) {
      setPricingPreview(null);
      resetApplyPricingKey();
      toast('error', 'This preview belongs to a different Product. Reload before applying.');
      return;
    }
    setApplyingPricing(true);
    try {
      // The database applies only an approved preview, with every warning acknowledged. One key per
      // exact approval: a corrected reason is a new request (a re-approval replaces the receipt).
      const approveIntent = JSON.stringify([pricingPreview.change_set_id, acknowledgements]);
      await approvePricingChangeSet({
        changeSetId: pricingPreview.change_set_id,
        requestFingerprint: pricingPreview.request_fingerprint,
        acknowledgements,
        sourceFile: null,
        performedBy: profile.id,
        idempotencyKey: getApprovePricingKeyFor(approveIntent),
      });
      const result = await applyProductPricingChangeSet({
        changeSetId: pricingPreview.change_set_id,
        requestFingerprint: pricingPreview.request_fingerprint,
        performedBy: profile.id,
        idempotencyKey: getApplyPricingKey(),
      });
      // Both keys are kept until the apply is confirmed: if its answer is lost, a retry replays the
      // approval (the database checks the key before refusing an applied change set) and then the apply.
      resetApprovePricingKeyFor(approveIntent);
      resetApplyPricingKey();
      setPricingReloadRequired(true);
      setIsDirty(true);
      setPricingPreview(null);
      setNewCost('');
      setCostBasisReason('');
      setManualBasisCost('');
      setCostBasisPricingBehavior('keep_sell_prices');
      const [productReloaded, historyReloaded, basisReloaded] = await Promise.all([
        fetchProduct(false),
        fetchCostHistory(false),
        fetchCostBasisWorkspace(false),
      ]);
      setPriceHistoryReloadToken((current) => current + 1);
      const basisAppliedCount = result.cost_basis_rows?.length ?? 0;
      const pricingAppliedCount = result.applied_count;
      const successMessage = basisAppliedCount > 0 && pricingAppliedCount > 0
        ? `Selected cost basis and applied pricing to ${pricingAppliedCount} Product.`
        : basisAppliedCount > 0
          ? `Selected cost basis for ${basisAppliedCount} Product.`
          : `Applied pricing to ${pricingAppliedCount} Product.`;
      const activityDescription = basisAppliedCount > 0 && pricingAppliedCount > 0
        ? 'Product cost basis and pricing updated through approved preview'
        : basisAppliedCount > 0
          ? 'Product cost basis selected through approved preview'
          : 'Product pricing updated through approved preview';
      if (productReloaded && historyReloaded && basisReloaded) {
        toast('success', successMessage);
      } else {
        toast('warning', `${successMessage} The latest Product values could not be reloaded. Refresh this page before making another change.`);
      }
      logActivity({
        event: 'product_cost_updated',
        description: activityDescription,
        performedBy: profile.id,
        entityType: 'product',
        entityId: id,
      });
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    } finally {
      setApplyingPricing(false);
    }
  };

  const handlePricingReload = async () => {
    setPricingReloading(true);
    const [productReloaded, historyReloaded, basisReloaded] = await Promise.all([
      fetchProduct(false),
      fetchCostHistory(false),
      fetchCostBasisWorkspace(false),
    ]);
    setPriceHistoryReloadToken((current) => current + 1);
    if (productReloaded) {
      toast(
        historyReloaded && basisReloaded ? 'success' : 'warning',
        historyReloaded && basisReloaded
          ? 'Product pricing reloaded.'
          : 'Product pricing reloaded, but pricing history or governed cost-basis options are not available yet.',
      );
    } else {
      toast('error', 'Product pricing could not be reloaded. Try again before making another change.');
    }
    setPricingReloading(false);
  };

  const handleEpaLookup = async () => {
    const regNumber = product.epa_registration?.trim() ?? '';
    if (!regNumber) {
      toast('warning', 'Enter an EPA registration number first.');
      return;
    }

    setEpaLookupLoading(true);
    setEpaLookupResult(null);
    setEpaLookupRegNumber('');
    try {
      const data = await lookupEpaRegistration(regNumber);
      if (!data) return;

      setEpaLookupResult(data);
      setEpaLookupRegNumber(regNumber);
      if (data.transferredTo) {
        toast('warning', `EPA moved registration ${regNumber} to ${data.transferredTo}.`);
      } else if (!data.found) {
        toast('warning', `EPA did not find registration ${regNumber}.`);
      }
    } catch (err) {
      Sentry.captureException(toSentryError(err), {
        tags: { source: 'edge_function', action: 'epa_lookup' },
      });
      toast('error', err instanceof Error ? err.message : 'EPA lookup failed. Please try again.');
    } finally {
      setEpaLookupLoading(false);
    }
  };

  const handleCreateEpaDraft = async () => {
    if (!profile || !id || isNew || !epaLookupResult?.found) return;

    const currentRegNumber = product.epa_registration?.trim() ?? '';
    if (!currentRegNumber || currentRegNumber !== epaLookupRegNumber) {
      toast('warning', 'The EPA registration changed after lookup. Look it up again before applying.');
      return;
    }

    const validatedRegNumber = epaLookupResult.eparegno?.trim();
    if (!validatedRegNumber) {
      toast('error', 'EPA did not return a validated registration number.');
      return;
    }

    const existingSignalWord = hasText(persistedLabelFields.signalWord)
      ? persistedLabelFields.signalWord.trim()
      : null;
    const existingRegistration = hasText(persistedLabelFields.epaRegistration)
      ? persistedLabelFields.epaRegistration.trim()
      : null;

    // A product's label data may only be filled from a lookup of ITS OWN saved
    // registration number. If it already has a (different) saved registration,
    // applying data from an unrelated lookup would attach the wrong hazard word
    // to it — empty-fields-only keeps the saved (mismatched) registration while
    // still filling the signal word from the unrelated lookup. Block that.
    // (Codex ship-gate blocker, 2026-07-10 — regulatory-data corruption.)
    if (existingRegistration && existingRegistration !== validatedRegNumber) {
      toast(
        'warning',
        "This lookup is for a different registration number than the one saved on this product. To fill its label data, look up the product's own saved registration number, or correct the saved number first.",
      );
      return;
    }

    const proposedSignalWord = !existingSignalWord && !epaLookupResult.needsManual
      ? epaLookupResult.signalWordCanonical
      : null;
    const proposedRegistration = !existingRegistration ? validatedRegNumber : null;

    if (!proposedSignalWord && !proposedRegistration && !epaLookupResult.needsManual) {
      toast('warning', 'Nothing to apply — the supported product fields are already filled.');
      return;
    }

    const sourceNotes = [`EPA PPLS lookup ${validatedRegNumber} ${localToday()}`];
    if (epaLookupResult.needsManual) {
      sourceNotes.push('EPA signal word was unrecognized and was omitted for manual review.');
    } else if (existingSignalWord && epaLookupResult.signalWordCanonical
        && existingSignalWord !== epaLookupResult.signalWordCanonical) {
      sourceNotes.push(
        `Signal word differs: product has ${existingSignalWord}; EPA reports ${epaLookupResult.signalWordCanonical}. Omitted per empty-fields-only policy.`,
      );
    }
    if (existingRegistration && existingRegistration !== validatedRegNumber) {
      sourceNotes.push(
        `EPA registration differs: product has ${existingRegistration}; EPA validated ${validatedRegNumber}. Omitted per empty-fields-only policy.`,
      );
    }

    setEpaDraftCreating(true);
    try {
      const { data, error } = await supabaseUntyped.rpc('create_label_draft', {
        p_product_id: id,
        p_signal_word: proposedSignalWord,
        p_epa_registration: proposedRegistration,
        p_source_note: sourceNotes.join(' '),
        p_confidence: epaLookupResult.needsManual ? 'medium' : 'high',
        p_status: epaLookupResult.needsManual ? 'needs_manual' : 'pending',
        p_idempotency_key: epaDraftKey.getKey(),
      });
      if (error) throw error;
      const draftId = assertRpcResult<string>(data, 'create_label_draft');
      await logActivity({
        event: 'label_draft_created',
        description: `Created EPA label draft ${draftId} for product ${id}`,
        performedBy: profile.id,
        entityType: 'product',
        entityId: id,
      });
      epaDraftKey.resetKey();
      toast('success', 'EPA draft created — review it before applying any product changes.');
      navigate('/label-review');
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : String(err);
      toast('error', `Could not create EPA draft: ${message}`);
    } finally {
      setEpaDraftCreating(false);
    }
  };

  const update = (field: string, value: unknown) => {
    if (pricingReloadRequired) return;
    if (field === 'product_name') setNameRequired(false);
    setProduct((p) => ({ ...p, [field]: value }));
    setIsDirty(true);
    if (field === 'epa_registration'
        && (typeof value !== 'string' || value.trim() !== epaLookupRegNumber)) {
      setEpaLookupResult(null);
      setEpaLookupRegNumber('');
    }
  };

  const changeCategory = (next: string | null) => {
    if (next !== product.category && (product.use_timings?.length ?? 0) > 0
      && (next !== 'Herbicide' && next !== 'Foliar Fertilizer'
        || (product.use_timings ?? []).some((code) => timingOptions.find((option) => option.code === code)?.category !== next))) {
      setPendingCategory(next);
      return;
    }
    update('category', next);
  };


  const updatePricingMargin = (field: ProductPricingMarginField, text: string) => {
    if (pricingReloadRequired) return;
    setPricingMarginDrafts((drafts) => ({ ...drafts, [field]: text }));
    update(field, text ? parseFloat(text) / 100 : null);
  };

  const updatePricingMoney = (field: ProductPricingMoneyField, value: string) => {
    if (pricingReloadRequired) return;
    const persistedValue = persistedProduct?.[field] ?? product[field];
    const original = persistedValue == null ? '' : String(persistedValue);
    setPricingMoneyDrafts((drafts) => {
      const next = { ...drafts };
      if (value === original) delete next[field];
      else next[field] = value;
      return next;
    });
    setIsDirty(true);
  };

  const changePricingMode = (mode: PricingMode | '') => {
    if (mode === 'price_driven') {
      setPricingMarginDrafts({});
      if (persistedProduct) {
        setProduct((current) => ({
          ...current,
          tier1_margin: persistedProduct.tier1_margin,
          tier2_margin: persistedProduct.tier2_margin,
          tier3_margin: persistedProduct.tier3_margin,
        }));
      }
    } else if (mode === 'margin_driven') {
      setPricingMoneyDrafts({});
    }
    setPricingMode(mode);
  };

  if (loading) {
    return <div className="animate-pulse space-y-4"><div className="h-8 bg-gray-200 rounded w-1/3" /><div className="h-64 bg-gray-200 rounded" /></div>;
  }

  if (!isNew && !product.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-4">
        <p className="text-secondary text-lg">Product not found</p>
        <Button variant="secondary" onClick={() => navigate('/products')}>Back to Products</Button>
      </div>
    );
  }

  const epaNameMismatch = Boolean(
    epaLookupResult?.found
      && epaLookupResult.regType !== 'distributor'
      && namesClearlyDiffer(product.product_name, epaLookupResult.productname),
  );
  const epaRupValue = epaLookupResult?.rupYn === 'Yes'
    ? true
    : epaLookupResult?.rupYn === 'No'
      ? false
      : null;
  const epaRupMismatch = epaLookupResult?.found
    && epaRupValue !== null
    && epaRupValue !== Boolean(product.is_rup);
  const persistedSignalWord = hasText(persistedLabelFields.signalWord)
    ? persistedLabelFields.signalWord.trim()
    : null;
  const persistedRegistration = hasText(persistedLabelFields.epaRegistration)
    ? persistedLabelFields.epaRegistration.trim()
    : null;

  const missingSetup = missingProductSetup(product);
  // What a new quote line will show once this edit saves; existing quote lines keep their copied note.
  const quoteLine = !isNew && persistedProduct && persistedProduct.id === product.id ? quoteLineChange(persistedProduct, product) : null;

  return (
    <div className={`phone-touch space-y-4 ${isAdmin ? 'max-md:pb-10' : ''}`}>
      <div className="flex items-center gap-3">
        <button aria-label="Back to products" onClick={() => navigate('/products')} className="p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all text-secondary">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold font-heading text-nav-dark">
          {isNew ? 'New Product' : product.product_name}
        </h2>
        {missingSetup.length > 0 && <Badge variant="warning">Incomplete setup</Badge>}
        {isAdmin && !isNew && persistedProduct?.id === id && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="w-4 h-4" />}
              showChevron={false}
              disabled={pricingReloadRequired || !parent || !parent.is_active}
              title={parent === null ? 'This product has no parent yet, so it has no sizes to add to. Use New product.' : undefined}
              onClick={() => parent && navigate('/products/new', { state: { duplicateFrom: duplicateProductSource(persistedProduct!), addSizeTo: parent } })}
            >
              Add a size
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Copy className="w-4 h-4" />}
              showChevron={false}
              disabled={pricingReloadRequired}
              onClick={() => navigate('/products/new', { state: { duplicateFrom: duplicateProductSource(persistedProduct!) } })}
            >
              New product
            </Button>
          </div>
        )}
      </div>
      {missingSetup.length > 0 && (
        <p className="text-sm text-secondary" data-testid="product-setup-missing">
          Still needed for complete setup: {missingSetup.join(', ')}.{isAdmin ? ' You can still save and price this product.' : ''}
        </p>
      )}
      {!isNew && (
        <CancelledRegistrationBanner sources={registrationSources} cancelled={registrationStatus.cancelled} failed={registrationStatus.failed || brandsReadFailed} />
      )}

      {duplicateSource && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900" role="status">
          <p className="font-medium">
            {addSizeTo
              ? `New size of ${addSizeTo.name}, started from ${duplicateSource.product_name}. Nothing is saved until you create it.`
              : `New product started from ${duplicateSource.product_name}. Nothing is saved until you create it.`}
          </p>
          {addSizeTo && <p className="mt-1">Category, use timing, EPA number and rates come from the parent.</p>}
          <p className="mt-1">Copied: category, vendor, manufacturer, product form and inventory unit.</p>
          <p className="mt-1">
            {addSizeTo
              ? 'Not copied, enter them for this size: SKU, container size, label details (RUP, signal word, REI, PHI), notes, brands, cost and prices.'
              : 'Not copied, enter them for this product: SKU, container size, EPA number and label details (RUP, signal word, REI, PHI), rates, use timings, notes, brands, cost and prices.'}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {pricingReloadRequired && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4" role="alert">
              <p className="text-sm text-amber-900">
                Pricing was applied, but the saved Product could not be reloaded. Editing is locked until the latest values load.
              </p>
              <Button
                type="button"
                variant="secondary"
                loading={pricingReloading}
                onClick={() => void handlePricingReload()}
              >
                Reload Product
              </Button>
            </div>
          )}
          {/* PAR-1: the parent this size belongs to, or the parent a new product creates. */}
          {!isNew && parent && profile && (
            <ProductParentPanel
              parent={parent}
              productId={id!}
              isAdmin={isAdmin}
              profileId={profile.id}
              ratesLocked={rateLock ? rateLock.is_locked : null}
              categoryOptions={categoryOptions}
              timingOptions={timingOptions}
              cropOptions={cropOptions}
              rateUnitOptions={rateUnitOptionsForProduct(unitConversions, parent.product_form, product.inventory_unit).map((uc) => uc.unit)}
              busy={isDirty || pricingReloadRequired || saving}
              onChanged={() => {
                setParentReload((current) => current + 1);
                loadRateLock();
                void fetchProduct();
                setPriceHistoryReloadToken((current) => current + 1);
              }}
            />
          )}
          {/* DM-2: weight per gallon (on the parent) or per pack; re-read when the product or its parent is saved. */}
          {!isNew && persistedProduct && persistedProduct.id === id && profile && (
            <ProductWeightCard
              productId={id!}
              isAdmin={isAdmin}
              profileId={profile.id}
              busy={isDirty || pricingReloadRequired || saving}
              reloadKey={JSON.stringify([persistedProduct.updated_at, persistedProduct.product_form, persistedProduct.inventory_unit,
                persistedProduct.container_size, persistedProduct.container_unit, persistedProduct.container_type, persistedProduct.unit_size,
                parent?.id ?? null, parent?.parent_version ?? null])}
              onSaved={() => setWeightSaves((n) => n + 1)}
            />
          )}
          {/* DM-1: the parent's chemistry, shared by every size; an ungrouped size has none. */}
          {!isNew && parent && profile && (
            <ProductChemistrySection
              parentId={parent.id}
              parentVersion={parent.parent_version}
              refreshKey={JSON.stringify([persistedProduct?.updated_at ?? null, persistedProduct?.pricing_version ?? null, weightSaves])}
              isAdmin={isAdmin}
              profileId={profile.id}
              busy={isDirty || pricingReloadRequired || saving}
            />
          )}
          {!isNew && parent === null && (
            <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-secondary">
              Put this product in a parent to record its chemistry.
            </p>
          )}
          {!isNew && parentLoadFailed && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-secondary" role="alert">
              <span>Couldn&apos;t load this product&apos;s parent, so its category, use timing, EPA number and rates are read-only for now.</span>
              <Button size="sm" variant="secondary" onClick={() => setParentReload((current) => current + 1)}>Retry</Button>
            </div>
          )}
          {isNew && isAdmin && (
            <Card>
              <CardHeader title="Parent" accent={addSizeTo ? addSizeTo.name : 'New'} />
              <fieldset disabled={saving} className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="product-new-parent">
                {addSizeTo ? (
                  <p className="text-sm text-secondary sm:col-span-2">
                    This size joins {addSizeTo.name} ({addSizeTo.sizes.length} size(s) now). Its category, use timing, EPA number and rates come from the parent.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-secondary sm:col-span-2">
                      Creates the product and its parent together. The parent holds the category, use timing, EPA number and rates every later size shares.
                    </p>
                    <Input label="Parent name" value={newParent.name} placeholder={product.product_name || 'Same as the product name'}
                      onChange={(event) => setNewParent((current) => ({ ...current, name: event.target.value }))} />
                    <Input label="Nickname" value={newParent.nickname}
                      onChange={(event) => setNewParent((current) => ({ ...current, nickname: event.target.value }))} />
                    <Input label="Formulation type" value={newParent.formulation_type}
                      onChange={(event) => setNewParent((current) => ({ ...current, formulation_type: event.target.value }))} />
                    <Input label="Safener" value={newParent.safener}
                      onChange={(event) => setNewParent((current) => ({ ...current, safener: event.target.value }))} />
                  </>
                )}
                <div>
                  <label htmlFor="new-size-role" className="mb-1 block text-sm font-medium text-secondary">Size role</label>
                  <select id="new-size-role" value={sizeRole} onChange={(event) => setSizeRole(event.target.value as ProductSizeRole)}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-nav-dark focus-visible:ring-2 focus-visible:ring-crx-green">
                    {(Object.keys(SIZE_ROLE_LABELS) as ProductSizeRole[]).map((role) => <option key={role} value={role}>{SIZE_ROLE_LABELS[role]}</option>)}
                  </select>
                </div>
              </fieldset>
            </Card>
          )}
          <fieldset disabled={pricingReloadRequired || (isNew && saving)} className="contents">
          {/* The fieldset disables these toggles too, so a locked page keeps every section open. */}
          <PhoneSection title="Product Information" {...sectionProps('information', pricingReloadRequired)}>
          <Card>
            <CardHeader title="Product" accent="Information" />

            {/* Basic Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Product Name" required value={product.product_name || ''} onChange={(e) => update('product_name', e.target.value)} disabled={!isAdmin} error={nameRequired ? 'Product name is required' : undefined} />
              <Input label="SKU" value={product.sku || ''} onChange={(e) => update('sku', e.target.value)} disabled={!isAdmin} />
              <div>
                <label htmlFor="product-category" className="block text-sm font-medium text-secondary mb-1">Category</label>
                <select id="product-category" value={product.category || ''}
                  onChange={(e) => changeCategory(e.target.value || null)}
                  disabled={!isAdmin || categoryLoadFailed || parentOwned}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white text-nav-dark focus-visible:ring-2 focus-visible:ring-crx-green disabled:opacity-50">
                  <option value="">-- Select --</option>
                  {visibleProductCategories(categoryOptions, product.category).map((item) => (
                    <option key={item.name} value={item.name}>{item.name}{item.is_active ? '' : ' (retired)'}</option>
                  ))}
                </select>
                {parentOwned && <ParentOwnedHint parentName={shownParent?.name} />}
              </div>
              {(product.category === 'Herbicide' || product.category === 'Foliar Fertilizer'
                || (timingLoadFailed && ((product.use_timings?.length ?? 0) > 0 || Boolean(product.use_timing)))) && (
                <fieldset>
                  <legend className="mb-1 text-sm font-medium text-secondary">Use Timing</legend>
                  <div className="rounded-lg border border-gray-200 bg-white p-2 space-y-1">
                    {timingLoadFailed ? (
                      <>
                        <p className="px-2 text-sm text-secondary">Use timings could not be loaded. Refresh before changing them.</p>
                        <p className="px-2 text-sm text-nav-dark">{product.use_timing || 'No saved use timings'}</p>
                      </>
                    ) : (
                      <UseTimingPicker
                        options={timingOptions}
                        crops={cropOptions}
                        category={product.category}
                        selected={product.use_timings ?? []}
                        held={persistedProduct?.use_timings ?? []}
                        disabled={!isAdmin || parentOwned}
                        onChange={(next) => update('use_timings', next)}
                      />
                    )}
                    {!timingLoadFailed && timingOptions.length === 0 && <p className="px-2 text-sm text-secondary">Loading use timings...</p>}
                  </div>
                  {isAdmin && !timingLoadFailed && (
                    <button type="button" onClick={() => setTimingChoicesOpen(true)}
                      className="mt-1 min-h-8 text-sm font-medium text-crx-green hover:underline focus-visible:ring-2 focus-visible:ring-crx-green">
                      Manage crop and timing choices
                    </button>
                  )}
                </fieldset>
              )}
              <div>
                <Combobox label="Vendor" value={product.vendor || ''} onChange={(v) => update('vendor', v)} options={vendorOptions} disabled={!isAdmin || !isNew} placeholder="Type or select..." />
                {isAdmin && isNew && <NearMatchWarning kind="vendor" matches={nearMatchNames(product.vendor, vendorOptions)} onPick={(name) => update('vendor', name)} />}
              </div>
              <div>
                <Combobox label="Manufacturer" value={product.manufacturer || ''} onChange={(v) => update('manufacturer', v)} options={manufacturerOptions} disabled={!isAdmin} placeholder="Type or select..." />
                {isAdmin && <NearMatchWarning kind="manufacturer" matches={nearMatchNames(product.manufacturer, manufacturerOptions)} onPick={(name) => update('manufacturer', name)} />}
              </div>
              <div>
                <div className="flex items-end gap-2">
                  <Input
                    label="EPA Registration"
                    value={product.epa_registration || ''}
                    onChange={(e) => update('epa_registration', e.target.value)}
                    disabled={!isAdmin || parentOwned}
                    placeholder="e.g., 34704-69"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    showChevron={false}
                    icon={<Search className="w-4 h-4" />}
                    loading={epaLookupLoading}
                    disabled={!isAdmin}
                    onClick={() => void handleEpaLookup()}
                    className="mb-px shrink-0"
                  >
                    Look up EPA
                  </Button>
                </div>
                <div className="mt-1">
                  <EpaLabelLink epaRegistration={product.epa_registration} showHint />
                </div>
                {parentOwned && <ParentOwnedHint parentName={shownParent?.name} identity />}
                {isNew && (
                  <p className="mt-1 text-xs text-secondary">
                    You can preview EPA data now, but save the product before creating a review draft.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={product.is_rup || false}
                    onChange={(e) => update('is_rup', e.target.checked)}
                    disabled={!isAdmin}
                    className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                  />
                  <span className="text-sm font-medium text-nav-dark">Restricted Use (RUP)</span>
                </label>
              </div>
              <div>
                <label htmlFor="product-signal-word" className="block text-sm font-medium text-secondary mb-1">Signal Word</label>
                <select
                  id="product-signal-word"
                  value={product.signal_word || ''}
                  onChange={(e) => update('signal_word', e.target.value || null)}
                  disabled={!isAdmin}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">None</option>
                  <option value="Danger">Danger</option>
                  <option value="Warning">Warning</option>
                  <option value="Caution">Caution</option>
                </select>
              </div>
              <Input
                label="REI (hours)"
                type="number"
                min={0}
                step={1}
                value={reiDraft}
                onChange={(e) => {
                  if (pricingReloadRequired) return;
                  setReiDraft(e.target.value);
                  update('rei_hours', /^\d+$/.test(e.target.value) ? Number(e.target.value) : null);
                }}
                disabled={!isAdmin}
                placeholder="From label, e.g. 12"
              />
              <Input
                label="PHI (days)"
                type="number"
                min={0}
                step={1}
                value={phiDraft}
                onChange={(e) => {
                  if (pricingReloadRequired) return;
                  setPhiDraft(e.target.value);
                  update('phi_days', /^\d+$/.test(e.target.value) ? Number(e.target.value) : null);
                }}
                disabled={!isAdmin}
                placeholder="From label, e.g. 30"
              />
            </div>

            {epaLookupResult && (
              <div className="mt-5 border-t border-gray-100 pt-5" aria-live="polite">
                {!epaLookupResult.found ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <div className="flex items-start gap-2 text-amber-900">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                      <div>
                        {epaLookupResult.transferredTo ? (
                          <>
                            <p className="font-semibold">Registration moved</p>
                            <p className="mt-1 text-sm">
                              EPA moved {epaLookupRegNumber} to {epaLookupResult.transferredTo}{epaLookupResult.productname ? ` (${epaLookupResult.productname})` : ''}. Look up the new number to use its label details.
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="font-semibold">No EPA registration found</p>
                            <p className="mt-1 text-sm">
                              EPA returned no record for {epaLookupRegNumber}. Check the number and try again.
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-nav-dark">EPA lookup preview</h3>
                        <p className="text-xs text-secondary">
                          Report-only details stay here; only eligible empty fields enter Label Review.
                        </p>
                      </div>
                      {epaLookupResult.latestLabelPdfUrl && (
                        <a
                          href={epaLookupResult.latestLabelPdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm font-medium text-crx-green hover:underline"
                        >
                          Latest label PDF
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                    </div>

                    {(epaNameMismatch
                      || epaLookupResult.isCancelled
                      || epaLookupResult.regType === 'distributor'
                      || epaRupMismatch
                      || epaLookupResult.needsManual) && (
                      <div className="space-y-2" aria-label="EPA lookup warnings">
                        {epaLookupResult.isCancelled && (
                          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>Cancelled registration:</strong> informational only; no product status is changed.</span>
                          </div>
                        )}
                        {epaLookupResult.regType === 'distributor' && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>Distributor sub-registration:</strong> a different trade name is expected and is not treated as a mismatch.</span>
                          </div>
                        )}
                        {epaNameMismatch && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>Suspected product mismatch:</strong> EPA calls this “{epaLookupResult.productname}”; verify the registration before proceeding.</span>
                          </div>
                        )}
                        {epaRupMismatch && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>RUP differs:</strong> EPA reports {epaLookupResult.rupYn}, while this product is marked {product.is_rup ? 'Yes' : 'No'}. No automatic change will be made.</span>
                          </div>
                        )}
                        {epaLookupResult.needsManual && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>Signal word needs manual review:</strong> no unrecognized EPA value will be placed in the draft.</span>
                          </div>
                        )}
                      </div>
                    )}

                    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">EPA product name</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.productname ?? 'Not provided'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Signal word</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.needsManual ? 'Needs manual review' : epaLookupResult.signalWordCanonical ?? 'No signal word'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Manufacturer</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.manufacturer ?? 'Not provided'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Restricted use (RUP)</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.rupYn ?? 'Not provided'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Product status</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.productStatus ?? 'Not provided'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Registration type</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.regType === 'distributor' ? 'Distributor sub-registration' : 'Section 3'}</dd></div>
                    </dl>

                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-secondary">Active ingredients</p>
                      {epaLookupResult.activeIngredients.length > 0 ? (
                        <ul className="mt-1 space-y-1 text-sm text-nav-dark">
                          {epaLookupResult.activeIngredients.map((ingredient) => (
                            <li key={`${ingredient.name}-${ingredient.pcCode ?? ingredient.casNumber ?? 'unknown'}`}>
                              {ingredient.name}{ingredient.percent != null ? ` — ${ingredient.percent}%` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-sm text-secondary">Not provided</p>
                      )}
                    </div>

                    <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
                      <p className="font-semibold text-nav-dark">Draft preview (empty fields only)</p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div>
                          <span className="text-secondary">Signal word: </span>
                          {persistedSignalWord
                            ? persistedSignalWord === epaLookupResult.signalWordCanonical
                              ? 'Already set — not included in draft'
                              : 'Differs — review in Label Review'
                            : epaLookupResult.needsManual
                              ? 'Omitted — manual review required'
                              : epaLookupResult.signalWordCanonical ?? 'Verified as no signal word'}
                        </div>
                        <div>
                          <span className="text-secondary">EPA registration: </span>
                          {persistedRegistration
                            ? persistedRegistration === epaLookupResult.eparegno
                              ? 'Already set — not included in draft'
                              : 'Differs — review in Label Review'
                            : epaLookupResult.eparegno}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="max-w-2xl text-xs text-secondary">
                        This creates a draft only. The product is not changed until an admin reviews and commits it in Label Review.
                      </p>
                      <Button
                        type="button"
                        onClick={() => void handleCreateEpaDraft()}
                        loading={epaDraftCreating}
                        disabled={isNew}
                      >
                        Apply to product
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Product Form */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label htmlFor="product-form" className="block text-xs font-semibold text-secondary uppercase tracking-wide">Product Form</label>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">Determines which units are available below</p>
              <div className="max-w-xs">
                <select
                  id="product-form"
                  value={product.product_form || ''}
                  onChange={(e) => {
                    const form = (e.target.value || null) as Product['product_form'];
                    if (pricingReloadRequired) return;
                    setProduct((current) => {
                      const inventoryUnit = current.inventory_unit === persistedProduct?.inventory_unit || isKnownUnit(unitConversions, form, current.inventory_unit)
                        ? current.inventory_unit : null;
                      return {
                        ...current,
                        product_form: form,
                        container_unit: current.container_unit === persistedProduct?.container_unit || isKnownUnit(unitConversions, form, current.container_unit) ? current.container_unit : null,
                        inventory_unit: inventoryUnit,
                        rate_unit: (form === 'seed' || form === 'each') && current.rate_unit?.trim()
                          && current.rate_unit.trim().toLowerCase() !== inventoryUnit?.trim().toLowerCase()
                          ? '' : current.rate_unit,
                      };
                    });
                    setIsDirty(true);
                  }}
                  disabled={!isAdmin || Boolean(persistedProduct?.product_form)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">-- Select --</option>
                  {PRODUCT_FORM_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                {persistedProduct?.product_form && (
                  <p className="mt-1 text-xs text-secondary">This can't change on a saved product yet; it waits for the reviewed unit change.</p>
                )}
              </div>
            </div>

            {/* Container — grouped as one row */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Container</p>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">Size, unit, and type (e.g. 2.5 Gal Jug)</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="Size" type="number" value={product.container_size ?? ''} onChange={(e) => update('container_size', e.target.value ? parseFloat(e.target.value) : null)} disabled={!isAdmin} placeholder="e.g. 2.5" />
                <div>
                  <label htmlFor="product-container-unit" className="block text-sm font-medium text-secondary mb-1">Unit</label>
                  <select
                    id="product-container-unit"
                    value={product.container_unit || ''}
                    onChange={(e) => update('container_unit', e.target.value || null)}
                    disabled={!isAdmin || Boolean(persistedProduct?.container_unit)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                  >
                    <option value="">-- Select --</option>
                    {product.container_unit && !isKnownUnit(unitConversions, product.product_form, product.container_unit) && (
                      <option value={product.container_unit}>{product.container_unit} (existing)</option>
                    )}
                    {unitOptionsForForm(unitConversions, product.product_form)
                      .map((uc) => (
                        <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                      ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="product-container-type" className="block text-sm font-medium text-secondary mb-1">Type</label>
                  <select
                    id="product-container-type"
                    value={product.container_type || ''}
                    onChange={(e) => update('container_type', e.target.value || null)}
                    disabled={!isAdmin}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                  >
                    <option value="">-- Select --</option>
                    <option value="Jug">Jug</option>
                    <option value="Drum">Drum</option>
                    <option value="Pallet">Pallet</option>
                    <option value="Mini-Bulk">Mini-Bulk</option>
                    <option value="Shuttle">Shuttle</option>
                    <option value="Bag">Bag</option>
                    <option value="Tote">Tote</option>
                    <option value="Jar">Jar</option>
                    <option value="Ea">Ea</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Inventory Unit */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label htmlFor="product-inventory-unit" className="block text-xs font-semibold text-secondary uppercase tracking-wide">Inventory Unit</label>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">Unit used for tracking inventory quantities (e.g. Gal, Lb)</p>
              <div className="max-w-xs">
                <select
                  id="product-inventory-unit"
                  value={product.inventory_unit || ''}
                  onChange={(e) => {
                    const inventoryUnit = e.target.value || null;
                    if (pricingReloadRequired) return;
                    setProduct((current) => ({
                      ...current,
                      inventory_unit: inventoryUnit,
                      rate_unit: (current.product_form === 'seed' || current.product_form === 'each')
                        && current.rate_unit?.trim()
                        && current.rate_unit.trim().toLowerCase() !== inventoryUnit?.trim().toLowerCase()
                        ? '' : current.rate_unit,
                    }));
                    setIsDirty(true);
                  }}
                  disabled={!isAdmin || Boolean(persistedProduct?.inventory_unit)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">-- Select --</option>
                  {/* WaveB: grandfather a legacy value the form filter would otherwise hide, so a save can't blank it */}
                  {product.inventory_unit && !isKnownUnit(unitConversions, product.product_form, product.inventory_unit) && (
                    <option value={product.inventory_unit}>{product.inventory_unit} (existing)</option>
                  )}
                  {unitOptionsForForm(unitConversions, product.product_form).map((uc) => (
                    <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Application Rates */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Application Rates</p>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">Per-acre application information</p>
              {rateLockFailed && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-secondary" role="alert">
                  <span>Couldn&apos;t check whether rates are locked, so rates are read-only for now.</span>
                  <Button size="sm" variant="secondary" onClick={loadRateLock}>Retry</Button>
                </div>
              )}
              {ratesLocked && rateLock && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-secondary" data-testid="product-rates-locked">
                  <span>Rates are locked. {rateLockSummary(rateLock)}</span>
                  {isAdmin && !isNew && persistedProduct && parent === null && (
                    <Button size="sm" variant="secondary" onClick={() => setCorrectingRates(true)} disabled={isDirty}
                      title={isDirty ? 'Save or discard your other changes first' : undefined}>
                      Correct rates
                    </Button>
                  )}
                </div>
              )}
              {(parentOwned || isNew) && (
                <p className="mb-3 text-sm text-secondary" data-testid="product-rates-parent">
                  {shownParent
                    ? <>Set on parent {shownParent.name}. Change them with {ratesLocked ? 'Correct parent rates' : 'Parent rates'} in the Parent panel.</>
                    : isNew ? 'Set on the parent after you create the product, in its Parent panel.' : 'Read-only until the parent loads.'}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <Input label="Suggested Rate" value={product.suggested_rate || ''} onChange={(e) => update('suggested_rate', e.target.value)} disabled={!isAdmin || ratesLocked || parentOwned || isNew} />
                  <p className="mt-1 text-xs text-secondary">Free text shown on quote lines and the quote PDF, such as a rate range. Not used in any calculation.</p>
                </div>
                <div>
                  <Input label="Rate Per Acre" type="number" value={product.rate_per_acre ?? ''} onChange={(e) => update('rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)} disabled={!isAdmin || ratesLocked || parentOwned || isNew} />
                  <p className="mt-1 text-xs text-secondary">The product's default rate, in the Rate Unit. Zero or more.</p>
                </div>
                <div>
                  <label htmlFor="product-rate-unit" className="block text-sm font-medium text-secondary mb-1">Rate Unit</label>
                  <select
                    id="product-rate-unit"
                    value={product.rate_unit || ''}
                    onChange={(e) => update('rate_unit', e.target.value)}
                    disabled={!isAdmin || ratesLocked || parentOwned || isNew}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                  >
                    <option value="">-- Select --</option>
                    {/* WaveB: grandfather a legacy value the form filter would otherwise hide, so a save can't blank it */}
                    {product.rate_unit && !rateUnitOptionsForProduct(unitConversions, product.product_form, product.inventory_unit)
                      .some((uc) => uc.unit === product.rate_unit) && (
                      <option value={product.rate_unit || ''}>{product.rate_unit} (existing)</option>
                    )}
                    {rateUnitOptionsForProduct(unitConversions, product.product_form, product.inventory_unit).map((uc) => (
                      <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-3">
                <dl>
                  <dt id="product-max-label-rate-label" className="text-sm font-medium text-secondary">Max Label Rate</dt>
                  <dd className="text-sm text-nav-dark" data-testid="product-max-label-rate" aria-labelledby="product-max-label-rate-label">
                    {product.max_label_rate != null ? `${product.max_label_rate} ${product.max_label_rate_unit ?? ''}`.trim() : 'Not recorded'}
                  </dd>
                </dl>
                <p className="mt-1 text-xs text-secondary">
                  The highest rate the label allows, read only here. Update it through{' '}
                  {isAdmin ? <button type="button" onClick={() => navigate('/label-review')} className="text-crx-green underline hover:text-crx-green-dark">Label Review</button> : 'Label Review'}.
                </p>
              </div>
            </div>

            {/* Grower Description (existing notes field) */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label htmlFor="grower-description" className="block text-sm font-medium text-secondary mb-1">Grower Description</label>
              <p className="text-xs text-gray-500 mb-1">Shown to growers on quotes and PDFs. Describe what the product does, application tips, etc.</p>
              <textarea
                id="grower-description"
                value={product.notes || ''}
                onChange={(e) => update('notes', e.target.value)}
                disabled={!isAdmin}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
              />
            </div>

            {/* Internal Notes */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label htmlFor="internal-notes" className="block text-sm font-medium text-secondary mb-1">Internal Notes</label>
              <p className="text-xs text-gray-500 mb-1">Internal only — never shown to growers.</p>
              <textarea
                id="internal-notes"
                value={product.internal_notes || ''}
                onChange={(e) => update('internal_notes', e.target.value)}
                disabled={!isAdmin}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
              />
            </div>

            {/* Quoting Notes */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label htmlFor="quoting-notes" className="block text-sm font-medium text-secondary mb-1">Quoting Notes</label>
              <p className="text-xs text-gray-500 mb-1">Customer-facing guidance automatically added to the quote line and shown on the quote PDF.</p>
              <textarea
                id="quoting-notes"
                value={product.quoting_notes || ''}
                onChange={(e) => update('quoting_notes', e.target.value)}
                disabled={!isAdmin}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
              />
              {quoteLine && (
                <p className="mt-1 text-xs text-amber-800" role="status">
                  New quote lines will show: {quoteLine.after ? `"${quoteLine.after}"` : '(blank)'}. Existing quotes keep their notes.
                </p>
              )}
            </div>
          </Card>
          </PhoneSection>

          {!isNew && id && persistedProduct?.id === id && (isAdmin || role === 'sales_rep') && (
            <PhoneSection title="Vendors" {...sectionProps('vendors', pricingReloadRequired)}>
              <ProductVendorsSection
                key={id}
                productId={id}
                productName={persistedProduct.product_name}
                isAdmin={isAdmin}
                userId={profile?.id ?? null}
                // The database copied the name onto the product; mirror it so a later save does not resend the old one.
                onPreferredChanged={(vendorName) => {
                  setProduct((p) => ({ ...p, vendor: vendorName }));
                  setPersistedProduct((p) => (p ? { ...p, vendor: vendorName } : p));
                }}
              />
            </PhoneSection>
          )}

          {!isNew && id && persistedProduct?.id === id && (
            <PhoneSection title="Brands" {...sectionProps('brands', pricingReloadRequired)}>
              <ProductBrandsSection
                // Shown only once this page's own product has loaded, and remounted for each product, so one
                // product's name, brands, open form or copy picker never reach (or get saved onto) the next.
                key={id}
                productId={id}
                productName={persistedProduct.product_name}
                isAdmin={isAdmin}
                userId={profile?.id ?? null}
                cancelled={registrationStatus.cancelled}
                onBrandsChange={handleBrandsChange}
              />
            </PhoneSection>
          )}

          {isAdmin && (
            <PhoneSection title="Pricing & Margins" {...sectionProps('pricing', pricingReloadRequired)}>
            <Card>
              <CardHeader title="Pricing" accent="& Margins" />
              {justCreated && persistedProduct?.tier1_price == null && persistedProduct?.tier2_price == null && persistedProduct?.tier3_price == null && (
                <div className="p-3 mb-4 bg-green-50 border border-green-200 rounded-lg text-sm text-green-900" role="status">
                  Product created. Now set its prices: choose a pricing mode, enter them, and Apply. Until then it has no price, and quotes, jobs and orders refuse it.
                </div>
              )}
              {isNew ? (
                <div className="p-3 mb-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
                  Create the Product details first. Pricing is added afterward through a reviewed change so a new Product can never bypass approval.
                </div>
              ) : (
                <div className="mb-4">
                  <label htmlFor="product-pricing-mode" className="block text-sm font-medium text-secondary mb-1">Pricing mode</label>
                  <select
                    id="product-pricing-mode"
                    value={pricingMode}
                    onChange={(event) => changePricingMode(event.target.value as PricingMode | '')}
                    className="w-full sm:max-w-xs px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">Choose a mode</option>
                    <option value="margin_driven">Margin-driven — cost + margins set prices</option>
                    <option value="price_driven">Price-driven — cost + prices set margins</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">Only the selected input family is editable. The server shows every resulting price before Apply. A product with all three prices saved opens price-driven, and nothing changes until you edit.</p>
                </div>
              )}
              <div className="p-3 mb-4 bg-blue-50 border border-blue-100 rounded-lg">
                <p className="text-xs text-secondary mb-2">
                  <span className="font-medium">All prices are per inventory unit</span> (e.g., per gallon, per pound). Margin-driven mode keeps your three net margins and recalculates prices; price-driven mode keeps your three entered prices and reconciles the margins.
                </p>
                <div className="text-xs text-gray-600 space-y-1">
                  <p><span className="font-medium">Net margin</span> = Profit as a % of price (e.g., 20% net → $100 price on $80 cost)</p>
                  <p><span className="font-medium">Markup %</span> = Profit as a % of cost (auto-calculated, e.g., 25%)</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Cost</h4>
                  <div className="flex items-center gap-2">
                    <div className="w-full">
                      <label htmlFor="product-current-cost" className="block text-sm font-medium text-secondary mb-1">Current Cost</label>
                      <output id="product-current-cost" aria-live="off" className="block rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-nav-dark">
                        {product.current_cost == null ? 'N/A' : formatExactUSD(product.current_cost)}
                      </output>
                    </div>
                    {!isNew && (
                      <Button variant="secondary" size="sm" icon={<DollarSign className="w-3 h-3" />} showChevron={false} onClick={() => setCostModal(true)} aria-label="Update cost" className="mt-5">
                        Update
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 1</h4>
                  <Input id="tier1-price" aria-label="Tier 1 price" label="Price" type="number" value={pricingMoneyInput(product, pricingMoneyDrafts, 'tier1_price')} onChange={(e) => updatePricingMoney('tier1_price', e.target.value)} disabled={isNew || pricingMode !== 'price_driven'} />
                  <Input id="tier1-net-margin" aria-label="Tier 1 net margin percent" label="Net margin %" type="number" value={pricingMarginDrafts.tier1_margin ?? (product.tier1_margin != null ? (product.tier1_margin * 100).toFixed(1) : '')} onChange={(e) => updatePricingMargin('tier1_margin', e.target.value)} placeholder="e.g., 20 for 20%" disabled={isNew || pricingMode !== 'margin_driven'} />
                  {product.tier1_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Markup %: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier1_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                  {product.tier1_price_per_acre != null && (
                    <div
                      className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100"
                      title="Auto-calculated from the tier price and the product's label rate. Refreshes when you save."
                    >
                      <span className="text-xs text-gray-500">Per acre (label rate): </span>
                      <span className="text-sm font-medium text-secondary">${product.tier1_price_per_acre.toFixed(2)} / acre</span>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 2</h4>
                  <Input id="tier2-price" aria-label="Tier 2 price" label="Price" type="number" value={pricingMoneyInput(product, pricingMoneyDrafts, 'tier2_price')} onChange={(e) => updatePricingMoney('tier2_price', e.target.value)} disabled={isNew || pricingMode !== 'price_driven'} />
                  <Input id="tier2-net-margin" aria-label="Tier 2 net margin percent" label="Net margin %" type="number" value={pricingMarginDrafts.tier2_margin ?? (product.tier2_margin != null ? (product.tier2_margin * 100).toFixed(1) : '')} onChange={(e) => updatePricingMargin('tier2_margin', e.target.value)} placeholder="e.g., 25 for 25%" disabled={isNew || pricingMode !== 'margin_driven'} />
                  {product.tier2_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Markup %: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier2_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                  {product.tier2_price_per_acre != null && (
                    <div
                      className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100"
                      title="Auto-calculated from the tier price and the product's label rate. Refreshes when you save."
                    >
                      <span className="text-xs text-gray-500">Per acre (label rate): </span>
                      <span className="text-sm font-medium text-secondary">${product.tier2_price_per_acre.toFixed(2)} / acre</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
                <div />
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 3</h4>
                  <Input id="tier3-price" aria-label="Tier 3 price" label="Price" type="number" value={pricingMoneyInput(product, pricingMoneyDrafts, 'tier3_price')} onChange={(e) => updatePricingMoney('tier3_price', e.target.value)} disabled={isNew || pricingMode !== 'price_driven'} />
                  <Input id="tier3-net-margin" aria-label="Tier 3 net margin percent" label="Net margin %" type="number" value={pricingMarginDrafts.tier3_margin ?? (product.tier3_margin != null ? (product.tier3_margin * 100).toFixed(1) : '')} onChange={(e) => updatePricingMargin('tier3_margin', e.target.value)} placeholder="e.g., 30 for 30%" disabled={isNew || pricingMode !== 'margin_driven'} />
                  {product.tier3_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Markup %: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier3_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                  {product.tier3_price_per_acre != null && (
                    <div
                      className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100"
                      title="Auto-calculated from the tier price and the product's label rate. Refreshes when you save."
                    >
                      <span className="text-xs text-gray-500">Per acre (label rate): </span>
                      <span className="text-sm font-medium text-secondary">${product.tier3_price_per_acre.toFixed(2)} / acre</span>
                    </div>
                  )}
                </div>
              </div>
            </Card>
            </PhoneSection>
          )}

          {isAdmin && (
            // On phones this sits on top of the bottom navigation, so saving is always in reach.
            <div
              data-testid="product-save-bar"
              className="flex justify-end max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(2.75rem+env(safe-area-inset-bottom))] max-md:z-20 max-md:border-t max-md:border-gray-200 max-md:bg-white max-md:px-4 max-md:py-2"
            >
              <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving} className="max-md:w-full">
                {isNew ? 'Create Product' : 'Save Changes'}
              </Button>
            </div>
          )}

          {/* Below Save Changes: the floor saves on its own, with its own button. */}
          {/* Only once this product has loaded: until then persistedProduct is still the last
              product, whose tier margins would be judged against this product's floor. */}
          {isAdmin && !isNew && id && profile && persistedProduct?.id === id && (
            // Keyed by product: moving to another product starts a fresh card, so nothing from the
            // last product's floor, history or in-flight save carries over. Prefixed so it never
            // shares a key with ProductBrandsSection, its sibling in this fieldset.
            <PhoneSection title="Margin Floor" {...sectionProps('floor', pricingReloadRequired)}>
              <ProductMarginFloorCard
                key={`margin-floor-${id}`}
                productId={id}
                tierMargins={[persistedProduct?.tier1_margin, persistedProduct?.tier2_margin, persistedProduct?.tier3_margin]}
                userId={profile.id}
                onDirtyChange={setMarginFloorDirty}
              />
            </PhoneSection>
          )}
          </fieldset>
        </div>

        {!isNew && id && (
          <div className="space-y-4 max-md:space-y-0">
            <PhoneSection title="Stock & Reorder" {...sectionProps('stock')}>
              <ProductStockCard key={`${id}-${stockReload}`} productId={id} isActive={product.is_active !== false} />
            </PhoneSection>
            {isAdmin && profile && fillableTote && (
              <PhoneSection title="Tote Fill" {...sectionProps('tote-fill')}>
                <ToteFillCard
                  key={id}
                  toteProductId={id}
                  toteName={persistedProduct?.product_name ?? ''}
                  profileId={profile.id}
                  onStockChanged={() => setStockReload((n) => n + 1)}
                />
              </PhoneSection>
            )}
            {isAdmin && (
              <PhoneSection title="Cost Basis" {...sectionProps('basis')}>
              <Card>
                <CardHeader title="Select" accent="Cost Basis" />
                {costBasisLoading ? (
                  <p className="text-sm text-secondary">Loading governed cost-basis options…</p>
                ) : costBasisWorkspace ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 rounded-lg border border-gray-200 p-4 sm:grid-cols-3">
                      <div>
                        <p className="text-xs text-secondary">Current selected basis</p>
                        <p className="font-semibold">{costBasisWorkspace.current_basis?.basis_type.replace(/_/g, ' ') ?? 'No baseline'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-secondary">Selected cost</p>
                        <p className="font-semibold tabular-nums">
                          {costBasisWorkspace.current_basis
                            ? `$${formatCostBasisDollars(costBasisWorkspace.current_basis.cost_cents)}`
                            : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-secondary">Reason</p>
                        <p className="text-sm">{costBasisWorkspace.current_basis?.reason ?? '—'}</p>
                      </div>
                    </div>

                    {!costBasisWorkspace.enabled && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        Choosing a cost basis is turned off for now. You can review evidence below, but selection controls remain disabled.
                      </div>
                    )}

                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label htmlFor="cost-basis-pricing-behavior" className="mb-1 block text-sm font-medium text-secondary">Pricing behavior</label>
                        <select
                          id="cost-basis-pricing-behavior"
                          value={costBasisPricingBehavior}
                          onChange={(event) => setCostBasisPricingBehavior(event.target.value as CostBasisPricingBehavior)}
                          disabled={!costBasisWorkspace.enabled || costBasisBusy || pricingReloadRequired}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
                        >
                          <option value="keep_sell_prices">Keep current sell prices; recalculate margins</option>
                          <option value="keep_margins_and_reprice">Keep current margins; recalculate sell prices</option>
                        </select>
                      </div>
                      <Input
                        label="Cost basis reason"
                        value={costBasisReason}
                        onChange={(event) => setCostBasisReason(event.target.value)}
                        placeholder="Why this evidence is the right basis"
                        disabled={!costBasisWorkspace.enabled || costBasisBusy || pricingReloadRequired}
                      />
                    </div>
                    <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                      <Input
                        label="Manual replacement cost"
                        type="number"
                        min="0"
                        step="0.01"
                        value={manualBasisCost}
                        onChange={(event) => setManualBasisCost(event.target.value)}
                        placeholder="0.00"
                        disabled={!costBasisWorkspace.enabled || costBasisBusy || pricingReloadRequired}
                      />
                      <Button
                        type="button"
                        disabled={!costBasisWorkspace.enabled || costBasisBusy || pricingReloadRequired}
                        onClick={() => void handleManualBasisSelection()}
                      >
                        Preview manual basis
                      </Button>
                    </div>
                    <p className="text-xs text-secondary">
                      Eligible supplier and received-PO evidence below has a Select as cost basis action. Every choice still requires preview and explicit approval.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-secondary">Governed cost-basis options are unavailable for this Product.</p>
                )}
              </Card>
              </PhoneSection>
            )}
            {isAdmin && (
              <PhoneSection title="Price & Cost History" {...sectionProps('history')}>
              <ProductPriceHistory
                productId={id}
                costBasisWorkspace={costBasisWorkspace}
                costBasisBusy={costBasisBusy}
                reloadToken={priceHistoryReloadToken}
                onSelectSupplierBasis={(candidate) => void handleSupplierBasisSelection(candidate)}
                onSelectPurchaseBasis={(candidate) => void handlePurchaseBasisSelection(candidate)}
              />
              {/* To-Do 0.4: sell prices over time. Admin-only, like all price history. */}
              <ProductSellPriceHistory productId={id} reloadToken={priceHistoryReloadToken} />
              <Card>
                <CardHeader title="Cost" accent="History" />
                {!costHistoryLoaded && !costHistoryLoadFailed ? (
                  <p className="text-sm text-secondary">Loading cost history…</p>
                ) : costHistoryLoadFailed ? (
                  <p className="text-sm text-secondary">Cost history could not be loaded. Reload to try again.</p>
                ) : costHistory.length > 0 ? (
                  <div className="space-y-3">
                    {costHistory.map((ch) => (
                      <div key={ch.id} className="border-b border-gray-50 pb-3 last:border-0">
                        <div className="flex justify-between text-sm">
                          <span className="text-red-500 line-through">${ch.old_cost?.toFixed(2)}</span>
                          <span className="text-crx-green font-medium">${ch.new_cost?.toFixed(2)}</span>
                        </div>
                        {ch.change_note && <p className="text-xs text-secondary mt-1">{ch.change_note}</p>}
                        <p className="text-xs text-gray-500 mt-1">{new Date(ch.changed_at).toLocaleDateString()}</p>
                      </div>
                    ))}
                  </div>
                ) : costBasisLoading ? (
                  <p className="text-sm text-secondary">Loading governed cost-basis details…</p>
                ) : (
                  <div className="space-y-2 text-sm text-secondary">
                    <p>No legacy cost changes recorded.</p>
                    {costBasisWorkspace?.current_basis ? (
                      costBasisWorkspace.current_basis.selection_source === 'migration_baseline' ? (
                        <p>
                          Current governed cost baseline:{' '}
                          <strong className="text-nav-dark">
                            ${formatCostBasisDollars(costBasisWorkspace.current_basis.cost_cents)}
                          </strong>{' '}
                          (migration baseline) recorded on{' '}
                          {new Date(costBasisWorkspace.current_basis.selected_at).toLocaleDateString()}. This
                          baseline was captured from the existing Product cost and is not independently verified
                          against supplier evidence. It is current cost provenance, not a backfilled historical
                          price-change event.
                        </p>
                      ) : (
                        <p>
                          Current governed cost-basis record:{' '}
                          <strong className="text-nav-dark">
                            ${formatCostBasisDollars(costBasisWorkspace.current_basis.cost_cents)}
                          </strong>{' '}
                          ({costBasisWorkspace.current_basis.basis_type.replace(/_/g, ' ')}) selected on{' '}
                          {new Date(costBasisWorkspace.current_basis.selected_at).toLocaleDateString()}. This is
                          current cost provenance, not a backfilled historical price-change event.
                        </p>
                      )
                    ) : costBasisLoadFailed ? (
                      <p>Current governed cost-basis details could not be loaded. Reload to try again.</p>
                    ) : product.current_cost != null ? (
                      <p>
                        This Product has a current cost, but no current governed cost-basis record is available.
                      </p>
                    ) : null}
                  </div>
                )}
              </Card>
              </PhoneSection>
            )}
            <ProductChangeHistory productId={id} reloadToken={priceHistoryReloadToken} />
          </div>
        )}
      </div>

      <Modal open={costModal} onClose={() => setCostModal(false)} title="Update" accent="Cost">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Current cost: <strong>{product.current_cost == null ? 'N/A' : formatExactUSD(product.current_cost)}</strong>
          </p>
          <Input label="New Cost" type="number" value={newCost} onChange={(e) => setNewCost(e.target.value)} placeholder="0.00" disabled={pricingReloadRequired} />
          <div>
            <label htmlFor="cost-update-pricing-mode" className="block text-sm font-medium text-secondary mb-1">Pricing mode</label>
            <select
              id="cost-update-pricing-mode"
              value={pricingMode}
              onChange={(event) => changePricingMode(event.target.value as PricingMode | '')}
              disabled={pricingReloadRequired}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Choose a mode</option>
              <option value="margin_driven">Keep margins; recalculate prices</option>
              <option value="price_driven">Keep entered prices; reconcile margins</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" showChevron={false} onClick={() => setCostModal(false)}>Cancel</Button>
            <Button onClick={handleCostUpdate} disabled={pricingReloadRequired}>Review Cost Change</Button>
          </div>
        </div>
      </Modal>

      <PricingChangePreviewModal
        open={pricingPreview !== null}
        preview={pricingPreview}
        applying={applyingPricing}
        title={pricingPreviewTitle}
        onClose={() => {
          setPricingPreview(null);
          resetApplyPricingKey();
        }}
        onApprove={(acknowledgements) => void handleApplyPricing(acknowledgements)}
      />

      <PricingSourceReasonModal
        key={pendingPricingReview ? 'open' : 'closed'}
        open={pendingPricingReview !== null}
        busy={previewingPricing}
        productCount={1}
        onCancel={() => setPendingPricingReview(null)}
        onSubmit={(value) => void submitPricingReview(value)}
      />

      {correctingRates && persistedProduct && (
        <ProductRateCorrectionModal
          open
          product={persistedProduct}
          profileId={profile?.id ?? ''}
          unitOptions={rateUnitOptionsForProduct(unitConversions, persistedProduct.product_form, persistedProduct.inventory_unit).map((uc) => uc.unit)}
          onClose={() => setCorrectingRates(false)}
          // A correction bumps pricing_version, so reload the cost-basis workspace and histories too;
          // the window stays over the form until then, so no edit is lost to the reload.
          // Until the product reloads, edits stay blocked and Reload Product stays offered.
          onCorrected={() => {
            setPricingReloadRequired(true);
            loadRateLock();
            void handlePricingReload().then(() => setCorrectingRates(false));
          }}
        />
      )}
      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
      <ConfirmModal
        open={pendingCategory !== undefined}
        title="Clear use timings?"
        message="This product has use timings. Changing the category clears them."
        confirmLabel="Change Category"
        variant="warning"
        onClose={() => setPendingCategory(undefined)}
        onConfirm={() => {
          update('use_timings', []);
          update('category', pendingCategory ?? null);
          setPendingCategory(undefined);
        }}
      />
      {timingChoicesOpen && profile && (
        <UseTimingChoicesModal
          options={timingOptions}
          crops={cropOptions}
          defaultCategory={product.category}
          profileId={profile.id}
          onReload={async () => {
            const fresh = await listProductUseTimingOptions();
            setTimingOptions(fresh);
            return fresh;
          }}
          onClose={() => setTimingChoicesOpen(false)}
        />
      )}
    </div>
  );
}

function NearMatchWarning({ kind, matches, onPick }: { kind: 'vendor' | 'manufacturer'; matches: string[]; onPick: (name: string) => void }) {
  if (matches.length === 0) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-amber-800" role="status">
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      This creates a new {kind}. Did you mean
      {matches.map((name, index) => (
        <span key={name}>
          <button type="button" onClick={() => onPick(name)} className="font-semibold underline hover:text-amber-900">{name}</button>
          {index < matches.length - 1 ? ',' : '?'}
        </span>
      ))}
    </p>
  );
}
