import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Save,
  Send,
  ShoppingCart,
  Plus,
  Trash2,
  Search,
  ChevronDown,
  ChevronRight,
  Download,
  AlertTriangle,
  Pencil,
  RotateCcw,
  Eye,
  EyeOff,
  Check,
  CheckCircle,
  Copy,
  CalendarClock,
  PackageOpen,
  XCircle,
  Ban,
  Undo2,
  ArrowLeft,
  Clock,
  Lock,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Tabs from '../components/ui/Tabs';
import { LastChargedPricesCard } from '../components/quotes/LastChargedPrices';
import PdfPagePreview from '../components/quotes/PdfPagePreview';
import { useLastChargedPrices } from '../hooks/useLastChargedPrices';
import { LoadFailedState } from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import { QuoteCreditStatus, TierMismatchNote } from '../components/quotes/QuoteCustomerChecks';
import { readAssignedTier } from '../lib/customerTier';

// Ties a "quote at this tier anyway" tick to one quote, customer and pair of tiers, so opening another
// quote, or the customer's assigned tier changing, never inherits it.
const tierChoiceKey = (quoteId: string | null | undefined, customerId: string, tier: number, assignedTier: number) =>
  `${quoteId ?? 'new'}:${customerId}:${tier}:${assignedTier}`;
import CustomerSearchPicker, { CUSTOMER_SEARCH_SELECT, type CustomerSearchResult } from '../components/customers/CustomerSearchPicker';
import FieldSearchPicker, { FIELD_SEARCH_SELECT, type FieldSearchResult } from '../components/fields/FieldSearchPicker';
import { fetchAllRows, pageWithList } from '../lib/pagedRead';
import { billableAcres } from '../lib/fieldGeometry';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import RecordVersionConflictDialog from '../components/ui/RecordVersionConflictDialog';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useLatestRef } from '../hooks/useLatestRef';
import { sanitizeError, supabase, supabaseUntyped, assertRpcResult, checkMutationResult, hasRpcCode, rpcAuthErrorMessage, RpcErrorCodes } from '../lib/db';
import {
  convertQuoteToOrderWithRowVersion,
  createQuoteVersionWithRowVersion,
  restoreQuoteVersionWithRowVersion,
} from '../lib/quoteLifecycleRpc';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { getIdempotencyBindingRejection, getIdempotencyMismatchResult, isDefinitiveRpcRejection } from '../lib/idempotency';
import { clearPendingRetry, loadPendingRetry, markPendingRetryForCheck, savePendingRetry, type PendingRetry } from '../lib/pendingRetry';
import { logActivity } from '../lib/activityLogger';
import { PRODUCT_COLUMNS, QUOTE_COLUMNS, QUOTE_ITEM_COLUMNS, fetchAdminCostFields, withAdminCost, withAdminCosts, withAdminNestedCosts } from '../lib/costFields';
import { formatUSD, formatCents } from '../lib/money';
import { BelowCostApprovalHandledError, isBelowCostApprovalHandledError, withBelowCostReason } from '../lib/belowCostApproval';
import { catalogPricePerAcre, computeQuoteTotals, getQuoteTierPrice, isTierPriceMissing, recalcItem as recalcQuoteLine, validateCommissionSplits } from '../lib/quoteCalc';
import { buildCommissionSplitPatch, nextLoadedSplitSnapshot } from '../lib/commissionSplitConcurrency';
import {
  buildRowVersionPatch,
  readRowVersion,
  resolveAuthoritativeSaveRowVersion,
  resolveDirectMutationRowVersion,
  hasReceiptId,
  NON_SAVE_RECOVERY,
  type StaleSaveConflictOrigin,
} from '../lib/recordVersionConcurrency';
import { notifyLargeOrder, notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { warnIfOverCreditLimit } from '../lib/creditLimit';
import { sendOrderConfirmedEmail } from '../lib/orderConfirmedEmail';
import { trackBusinessEvent } from '../lib/metrics';
import { localDatePlusDays, localToday, parseLocalDate, todayInBusinessTz } from '../lib/dateUtils';
import { computeSeason, seasonEndDate } from '../utils/season';
import { loadQuoteValidDays, pickedExpiryStart } from '../lib/appSettingDefaults';
import { downloadQuotePdf, generateQuotePdf } from '../lib/quotePdf';
import { sendEmail, pdfToBase64, buildEmailHtml } from '../lib/emailService';
import { escapeHtml } from '../lib/proofNotification';
import { checkRUPCompliance } from '../lib/rupCompliance';
import { preferredQuoteNotes } from '../lib/quoteNotes';
import { adaptQuoteVersionList, orderedQuoteVersionHistory, type QuoteVersionRow, type UnreadableQuoteVersion } from '../lib/quoteVersionAdapter';
import { resendRequiredMessage, samePrice, sentItemsOf, sentLineState, unsentQuoteChange, type PriceLockLine, type QuotePriceChange } from '../lib/quotePriceLock';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import HelpTip from '../components/ui/HelpTip';
import Dropdown from '../components/ui/Dropdown';
import DatePicker from '../components/ui/DatePicker';
import Switch from '../components/ui/Switch';
import TransactionThread from '../components/ui/TransactionThread';
import ActionMenu, { type ActionMenuItem } from '../components/ui/ActionMenu';
import { useIsBelowXl, useIsPhone } from '../hooks/useIsPhone';
import { lineNeedsRemoveConfirm, primaryAction, todaysPricesMessage } from '../lib/quoteBuilderView';
import { formatChargedOn } from '../lib/lastChargedPrices';
import { quoteBadgeVariant, quoteStatusLabel } from '../lib/quoteStatusLabel';
import CommissionSplitEditor from '../components/ui/CommissionSplitEditor';
import QuoteSplitNote, { type SplitNote } from '../components/quotes/QuoteSplitNote';
import { customerSplit, sameSplit } from '../lib/commissionSplitSource';
import { useStaleQuoteCheck } from '../hooks/useGuardrails';
import GuardrailBanner from '../components/ui/GuardrailBanner';
import { FullToteOnlyBadge, PolicyBadge, normalizeReturnPolicy, productPackageText, type ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import { ProductSearchResultRow } from '../components/products/ProductSearchResultRow';
import { rateUnitOptionsForProduct } from '../lib/units';
import { useProductParents } from '../lib/productParents';
import { QuoteLineCost } from '../components/quotes/QuoteLineCost';
import QuoteLineAdjuvants from '../components/quotes/QuoteLineAdjuvants';
import { useCancelledRegistrations } from '../lib/epaRegistrationStatus';
import type {
  Quote,
  QuoteSection,
  QuoteItem,
  QuoteVersion,
  QuotePdfTemplate,
  QuoteTemplate,
  Product,
  Customer,
  UnitConversion,
  CommissionSplit,
  QuoteStatus,
  BookingSettlement,
  JobStatus,
} from '../types';
import type { Json } from '../types/supabase';

interface LocalSection {
  _key: string;
  id?: string;
  section_name: string;
  sort_order: number;
  section_notes: string | null;
  section_header_notes: string | null;
  needed_by_date: string | null;
  field_id: string | null;
  items: LocalItem[];
}

type CalcMode = 'rate_acres' | 'units_direct';

// Keeps the reason-bearing retry key safely below PostgreSQL B-tree entry limits.
// The server independently fingerprints the full request, so the exact reason
// remains bound to the idempotency receipt rather than being trusted from the key.
const MAX_REVERT_REASON_LENGTH = 500;
const DRAFT_EDIT_PERMISSION_MESSAGE = 'Only this draft’s creator or an admin can edit it.';

interface LocalItem {
  _key: string;
  id?: string;
  product_id: string;
  sort_order: number;
  notes: string | null;
  price_per_unit: number;
  price_override: number | null;
  current_cost: number;
  // The cost save_quote recorded when this saved line was quoted (cost_at_quote_cents), with the
  // saved row and product it belongs to. The server keeps that cost while the line keeps that row
  // and product, so the page prices the line from it instead of today's product cost; a new line,
  // or one saved as a replacement row after a product switch, takes today's cost, as the server
  // stamps it. Absent for non-admins.
  quoted_cost?: { rowId: string; productId: string; cost: number };
  // "Use today's price" (20261027040000): once the quote has been sent, a saved line keeps its
  // stored price (savedLineIdsRef) unless it has a manual price or this asks for today's price.
  use_todays_price?: boolean;
  // A higher booked price on a sent quote needs the rep's "grower agreed" tick (20261029120000).
  // Holds the price, in cents, the tick confirmed, so changing the price again clears it.
  grower_confirmed_cents?: number;
  suggested_rate: string | null;
  actual_rate: number | null;
  rate_unit: string | null;
  oz_per_acre: number | null;
  price_per_acre: number | null;
  acres: number | null;
  // Where this page set the acres: a field pick or the Acres box. Not saved, so a loaded line has
  // neither, and a cleared field keeps its acres even when they equal the field's: the source
  // cannot be told apart, and guessing could delete typed acres.
  acres_source?: 'field' | 'typed';
  total_units_needed: number | null;
  unit_size: string | null;
  profit: number;
  total_price: number;
  net_margin: number;
  product?: Product;
  calc_mode: CalcMode;
  price_unit: string | null;
}

// The picked customer's tier and default commission split set the quote's; the contact columns
// feed the PDF and email.
const QUOTE_CUSTOMER_SELECT =
  `${CUSTOMER_SEARCH_SELECT}, assigned_tier, default_commission_split, email, phone, billing_address, contact_name`;
type QuoteCustomer = CustomerSearchResult
  & Pick<Customer, 'assigned_tier' | 'default_commission_split' | 'email' | 'phone' | 'billing_address' | 'contact_name'>;

// A section's field supplies its acres (override → measured → legacy total).
const QUOTE_FIELD_SELECT = `${FIELD_SEARCH_SELECT}, measured_acres, override_acres`;
type FieldOption = FieldSearchResult & {
  customer_id: string | null;
  total_acres: number | null;
  measured_acres: number | null;
  override_acres: number | null;
};


interface ActivePlannedHold {
  product_id: string;
  quantity: number;
  expires_at: string | null;
}

// The line table's "no unit" choice (the old select's "--" option).
const NO_UNIT = '__none__';
// Text-link buttons in the Products tab: 44 px tall below 768 px; from 768 px a 40 px hit area
// (an invisible ::after) so the link does not stretch its row.
// Real box (no pseudo area) for links that sit next to each other, so hit areas can't overlap.
const LINK_BOX = 'min-h-11 md:inline-flex md:min-h-10 md:items-center';
const LINK_HIT = "relative min-h-11 md:min-h-0 after:absolute after:inset-x-0 after:top-1/2 after:h-10 after:-translate-y-1/2 after:content-['']";
// Number boxes in the line table and cards: 44 px below 768 px, 40 px above.
const LINE_INPUT = 'w-full min-w-0 h-11 md:h-10 px-2 rounded-lg border text-base md:text-sm text-right text-nav-dark tabular-nums focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green';
// A number and its unit in one box: the input on the left, the unit on a cream strip on the right.
// The caller adds the border colour (the input's hand-set states tint the whole box).
const UNIT_BOX = 'flex w-full min-w-0 h-11 md:h-10 items-stretch overflow-hidden rounded-lg border focus-within:border-crx-green focus-within:ring-2 focus-within:ring-crx-green/20';
const UNIT_BOX_INPUT = 'w-full min-w-0 flex-1 bg-transparent px-1.5 text-base md:text-sm text-right text-nav-dark tabular-nums focus:outline-none';
const UNIT_STRIP = 'shrink-0 flex items-center border-l border-gray-200 bg-cream px-2 text-sm text-secondary';
// The unit Dropdown as the box's right end: its trigger loses its own border and fills the strip.
// The box clips the trigger's ring, so keyboard focus (RAC's data-focus-visible) tints it and draws an inset ring.
const UNIT_SELECT = 'w-auto! shrink-0 max-w-[60%] border-l border-gray-200 bg-cream [&_button]:h-full [&_button]:rounded-none [&_button]:border-0 [&_button]:bg-transparent [&_button]:gap-0.5 [&_button]:px-1.5 [&_button_svg]:h-3.5 [&_button_svg]:w-3.5 [&_button[data-focus-visible]]:bg-crx-green-tint [&_button[data-focus-visible]]:ring-2 [&_button[data-focus-visible]]:ring-inset [&_button[data-focus-visible]]:ring-crx-green/40';

// One muted line under a quote line's product name: SKU, family and package, the fields
// ProductOptionDetails shows, without their labels. Missing ones are left out.
function productMetaLine(p: ProductOptionPresentationModel): string {
  return [p.sku, p.product_family?.name, productPackageText(p)].filter(Boolean).join(' · ');
}

// The quote's totals: line sums, then rounded to the cent. The page's one totals rule.
function quoteTotals(sections: LocalSection[]) {
  return computeQuoteTotals(sections.flatMap((sec) => sec.items));
}

interface CostAlert {
  quote_item_id: string;
  cost_rose: boolean;
  below_cost: boolean;
}

// A saved line on a sent quote whose price went up since it was saved: it needs the rep's
// "grower agreed" tick before it saves (Mason 2026-10-27, 20261029120000).
function priceRaise(
  saved: { productId: string; price: number } | undefined,
  item: { product_id: string; price_per_unit: number },
): { fromCents: number; toCents: number } | null {
  if (!saved || saved.productId !== item.product_id) return null;
  const fromCents = Math.round(saved.price * 100);
  const toCents = Math.round(item.price_per_unit * 100);
  return toCents > fromCents ? { fromCents, toCents } : null;
}

interface DrawRow {
  product_id: string;
  product_name: string;
  booked: number;
  drawn: number;
  remaining: number;
  qty: string;
  unit: string | null;
  // Item 10: a quantity over `remaining` is allowed; the extra is its own order at the price the
  // rep picks (20261029110000). The booked price is the last booked line's, as the server uses.
  bookedPrice: number | null;
  todayPrice: number | null;
  extraPrice: 'today' | 'booked';
}

type DrawRequestLine = { product_id: string; quantity: number; extra_price?: 'today' | 'booked' };
const isDrawRequest = (request: unknown): request is DrawRequestLine[] => Array.isArray(request)
  && request.every((line) => typeof line?.product_id === 'string' && Number.isFinite(line.quantity) && line.quantity > 0
    && (line.extra_price === undefined || line.extra_price === 'today' || line.extra_price === 'booked'));

let keyCounter = 0;
// The price changes save_quote recorded on this quote's sent lines (quote_price_changes, read-only
// to admins and reps). null when the read failed.
async function loadQuotePriceChanges(quoteId: string): Promise<QuotePriceChange[] | null> {
  // supabaseUntyped: quote_price_changes is not in the generated types yet.
  const { data, error } = await fetchAllRows<QuotePriceChange>((from, to) => pageWithList(supabaseUntyped
    .from('quote_price_changes')
    .select('id, quote_item_id, product_id, new_price_cents, sent_version, grower_confirmed_by', { count: 'exact' })
    .eq('quote_id', quoteId)
    .order('id')
    .range(from, to)));
  if (error) {
    Sentry.captureException(error, { tags: { source: 'read', action: 'load_quote_price_changes' } });
    return null;
  }
  return data ?? [];
}

function nextKey() {
  return `_k${++keyCounter}`;
}

function makeEmptyItem(): LocalItem {
  return {
    _key: nextKey(),
    product_id: '',
    sort_order: 1,
    notes: null,
    price_per_unit: 0,
    price_override: null,
    current_cost: 0,
    suggested_rate: null,
    actual_rate: null,
    rate_unit: null,
    oz_per_acre: null,
    price_per_acre: null,
    acres: null,
    total_units_needed: null,
    unit_size: null,
    profit: 0,
    total_price: 0,
    net_margin: 0,
    calc_mode: 'rate_acres',
    price_unit: null,
  };
}

function hasUserEnteredItemValues(item: LocalItem): boolean {
  return item.notes !== null
    || item.price_override !== null
    || item.actual_rate !== null
    || item.rate_unit !== null
    || item.acres !== null
    || item.total_units_needed !== null
    || item.unit_size !== null
    || item.price_unit !== null
    || item.calc_mode !== 'rate_acres';
}

/** Whether a line still names the saved row (and product) its recorded quote-time cost belongs to. */
function holdsQuotedCost(
  item: LocalItem,
  productId: string,
  saved: { id: string; productId: string } | undefined,
): item is LocalItem & { quoted_cost: NonNullable<LocalItem['quoted_cost']> } {
  return item.quoted_cost != null
    && item.quoted_cost.productId === productId
    && saved?.productId === productId
    && saved.id === item.quoted_cost.rowId;
}

function makeEmptySection(order: number): LocalSection {
  return {
    _key: nextKey(),
    section_name: `Section ${order}`,
    sort_order: order,
    section_notes: null,
    section_header_notes: null,
    needed_by_date: null,
    field_id: null,
    items: [],
  };
}

/**
 * Listing an unreadable saved version must not mean going quiet about it.
 *
 * A row the server never stamped as restorable is expected historical data — it predates the
 * current snapshot shape — and reporting one on every page load would be noise. A row the server
 * DID stamp is one the current writer produced, so failing this app's snapshot validation means
 * either the stored snapshot is corrupt or the writer and the validator have drifted apart. That
 * is silent from the user's side (the version simply reads as unavailable), so it has to be
 * visible from ours. One report per load, not one per row.
 */
function reportUntrustworthyQuoteVersions(unreadable: UnreadableQuoteVersion[], quoteId: string) {
  const anomalies = unreadable.filter((v) => v.server_trusted);
  if (anomalies.length === 0) return;
  Sentry.captureMessage('server-trusted quote version failed snapshot validation', {
    level: 'error',
    tags: { source: 'read', action: 'load_quote_versions' },
    extra: { quoteId, versionNumbers: anomalies.map((v) => v.version_number) },
  });
}

// What a new quote's commission split starts as before a customer with a split is picked.
const NEW_QUOTE_SPLIT: CommissionSplit = { splits: [{ recipient: '', percentage: 100 }] };

export default function QuoteBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const convertQuoteIdem = useIdempotencyKey('convert_quote_to_order', profile?.id || '');
  // A committed conversion can be replayed from the idempotency cache with
  // status:'created'. Keep that marker so a lost response can still trigger
  // the client-only email/alerts once, but suppress duplicate side effects if
  // this mounted page observes the same stable order_id more than once.
  const firedConvertSideEffects = useRef<Set<string>>(new Set());
  const plannedHoldsIdem = useIdempotencyKey('create_planned_holds', profile?.id || '');
  const saveTemplateIdem = useIdempotencyKey('save_quote_template', profile?.id || '');
  const fromTemplateIdem = useIdempotencyKey('create_quote_from_template', profile?.id || '');
  const rolloverIdem = useIdempotencyKey('rollover_quote_to_season', profile?.id || '');
  // Version idempotency is quote-specific. Reusing one key after navigating
  // between Quotes could otherwise replay a version created for another Quote.
  const {
    getKey: getCreateVersionIdempotencyKey,
    resetKey: resetCreateVersionIdempotencyKey,
  } = useIdempotencyKey(
    'create_quote_version',
    `${profile?.id || ''}:${id || ''}`,
  );
  const {
    getKey: getRestoreVersionIdempotencyKey,
    resetKey: resetRestoreVersionIdempotencyKey,
  } = useIdempotencyKey(
    'restore_quote_version',
    `${profile?.id || ''}:${id || ''}`,
  );
  const scheduleJobIdem = useIdempotencyKey('create_job_from_quote_section', profile?.id || '');
  const drawDownIdem = useIdempotencyKey('draw_down_quote', profile?.id || '');
  const emailQuoteIdem = useIdempotencyKey('send_email_quote', profile?.id || '');
  const closeAppliedIdem = useIdempotencyKey('close_quote_as_applied', profile?.id || '');
  const closeShortIdem = useIdempotencyKey('close_quote_as_short', profile?.id || '');

  // Partial booking draw-down (sell-side roadmap #1): pull part of the booked
  // quantities into an order; the quote stays open with the remaining balance.
  const [showDrawModal, setShowDrawModal] = useState(false);
  const [drawRows, setDrawRows] = useState<DrawRow[]>([]);
  const [drawLoading, setDrawLoading] = useState(false);
  const [drawing, setDrawing] = useState(false);
  // S14: a draw whose reply never came, kept in this tab across a reload (see pendingRetry).
  const [pendingDraw, setPendingDraw] = useState<PendingRetry<DrawRequestLine[]> | null>(null);
  const drawPendingName = JSON.stringify(['draw_down_quote', profile?.id || '', id || '']);
  // Booking settlement (roadmap #6c): read-only booked/drawn/remaining + prepay
  // position for an open booking (sent/revised quote), via get_booking_settlement.
  const [bookingSettlement, setBookingSettlement] = useState<BookingSettlement | null>(null);
  // The settlement read failed: the money card says so instead of disappearing.
  const [bookingSettlementFailed, setBookingSettlementFailed] = useState(false);
  const [bookingSettlementAttempt, setBookingSettlementAttempt] = useState(0);
  // The saved quote this route opened could not be read: show that, not a blank new-quote form.
  const [quoteLoadFailedId, setQuoteLoadFailedId] = useState<string | null>(null);
  const { warning: staleWarning, check: checkStaleQuote, dismiss: dismissStaleWarning } = useStaleQuoteCheck();
  const isEditing = Boolean(id);

  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  // Kept locally rather than in generated DB types until post-apply regeneration.
  const quoteRowVersionRef = useRef<number | null>(null);
  // Unlike the dialog's open/closed state, this latch survives "Keep Editing".
  // Only a complete, stable Quote reload may clear it.
  const quoteVersionRecoveryRequiredRef = useRef(false);
  const createVersionAttemptRef = useRef<{
    key: string;
    expectedRowVersion: number | null;
  } | null>(null);
  const restoreVersionAttemptRef = useRef<{
    key: string;
    versionId: string;
    expectedRowVersion: number | null;
  } | null>(null);
  const resetCreateVersionAfterReloadRef = useRef(false);
  const resetRestoreVersionAfterReloadRef = useRef(false);
  const resetConvertAfterReloadRef = useRef(false);
  // Once this tab has observed a numeric token, recovery must never downgrade
  // it to the frontend-first legacy tokenless contract.
  const quoteNumericVersionRequiredRef = useRef(false);
  // The quote whose save was rejected with IDEMPOTENCY_PAYLOAD_CONFLICT while the
  // operator was no longer in that editing session, so the recovery dialog could
  // not be shown for it. The server has bound this key to a different payload, so
  // every later save reusing it — of ANY quote, because the key is scoped by
  // operation and user — is rejected the same way until the key rotates.
  //
  // The key is NOT rotated here. It is a receipt as well as a retry token: it may
  // represent a save that committed and lost its reply, and replaying the original
  // payload is the only deterministic way to learn that. Retiring it early is what
  // #603 shipped and reverted. Rotation happens where it is sanctioned — after an
  // authoritative reload of this existing quote resolves the outcome — which is
  // the same rule `reloadAfterStaleSave` already follows.
  const payloadConflictQuoteIdRef = useRef<string | null>(null);
  const [staleSaveOpen, setStaleSaveOpen] = useState(false);

  const getCreateVersionAttempt = useCallback(() => {
    const key = getCreateVersionIdempotencyKey();
    if (createVersionAttemptRef.current?.key === key) {
      return createVersionAttemptRef.current;
    }
    const attempt = {
      key,
      expectedRowVersion: quoteRowVersionRef.current,
    };
    createVersionAttemptRef.current = attempt;
    return attempt;
  }, [getCreateVersionIdempotencyKey]);

  const resetCreateVersionAttempt = useCallback(() => {
    createVersionAttemptRef.current = null;
    resetCreateVersionIdempotencyKey();
  }, [resetCreateVersionIdempotencyKey]);

  const getRestoreVersionAttempt = useCallback((versionId: string) => {
    if (restoreVersionAttemptRef.current?.versionId === versionId) {
      return restoreVersionAttemptRef.current;
    }
    // Selecting a different snapshot is a new action intent and must not reuse
    // a key that the server may already have bound to the previous version.
    resetRestoreVersionIdempotencyKey();
    const attempt = {
      key: getRestoreVersionIdempotencyKey(),
      versionId,
      expectedRowVersion: quoteRowVersionRef.current,
    };
    restoreVersionAttemptRef.current = attempt;
    return attempt;
  }, [getRestoreVersionIdempotencyKey, resetRestoreVersionIdempotencyKey]);

  const resetRestoreVersionAttempt = useCallback(() => {
    restoreVersionAttemptRef.current = null;
    resetRestoreVersionIdempotencyKey();
  }, [resetRestoreVersionIdempotencyKey]);

  const [converting, setConverting] = useState(false);
  const [quoteCreatedAt, setQuoteCreatedAt] = useState<string | null>(null);
  const [confirmConvertOpen, setConfirmConvertOpen] = useState(false);
  const [confirmBookAsOrderOpen, setConfirmBookAsOrderOpen] = useState(false);
  const [bookingAsOrder, setBookingAsOrder] = useState(false);
  const [duplicateOrderConfirmOpen, setDuplicateOrderConfirmOpen] = useState(false);
  const [duplicateOrderMsg, setDuplicateOrderMsg] = useState('');

  const [customerId, setCustomerId] = useState('');
  const customerIdRef = useLatestRef(customerId);
  // Whether a customer was picked since the open quote loaded (picking one and back still counts).
  const customerPickedSinceLoadRef = useRef(false);
  const [tier, setTier] = useState(1);
  // A tier other than the customer's assigned one is saved only once chosen on purpose (KI-105).
  const [tierChoice, setTierChoice] = useState('');
  // What the tier check (KI-105) depends on, as on screen now; Save compares it after its re-read.
  const tierInputsRef = useRef('');
  // The id a new quote's first save opens: its tick carries over; opening any other quote clears it.
  const keepTierChoiceForRef = useRef<string | null>(null);
  useEffect(() => { tierInputsRef.current = `${customerId}|${tier}|${tierChoice}`; }, [customerId, tier, tierChoice]);
  // The expiry date the rep picked; null = season end (Mason 2026-10-26/27). The database
  // applies it at each send (20261029100000).
  const [chosenExpiryDate, setChosenExpiryDate] = useState<string | null>(null);
  const seasonEnd = seasonEndDate(computeSeason(parseLocalDate(todayInBusinessTz())));
  // Settings "Default Quote Valid Days": where "Pick a date" starts (null = season end).
  const [quoteValidDays, setQuoteValidDays] = useState<number | null>(null);
  // Set when "Pick a date" is chosen before the setting arrives, so the start is redone once it does.
  const pickedBeforeValidDaysRef = useRef(false);
  const validDaysLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void loadQuoteValidDays().then((days) => {
      if (cancelled) return;
      validDaysLoadedRef.current = true;
      setQuoteValidDays(days);
      if (pickedBeforeValidDaysRef.current) {
        pickedBeforeValidDaysRef.current = false;
        setChosenExpiryDate((current) => (current === null ? null : pickedExpiryStart(todayInBusinessTz(), days, seasonEndDate(computeSeason(parseLocalDate(todayInBusinessTz()))))));
      }
    });
    return () => { cancelled = true; };
  }, []);
  const [headerNotes, setHeaderNotes] = useState('');
  const [footerNotes, setFooterNotes] = useState('');
  const [commissionSplit, setCommissionSplit] = useState<CommissionSplit>(NEW_QUOTE_SPLIT);
  // Lost-update guard: split as loaded from the DB, and whether the user has
  // changed it this session (see src/lib/commissionSplitConcurrency.ts).
  const loadedCommissionSplitRef = useRef<CommissionSplit | null>(null);
  const commissionSplitTouchedRef = useRef(false);
  // Where the split came from, or a pending choice to take the customer's (plan 2026-11-18); and the split the app
  // last put there. A split that differs from it was changed by hand, which a customer change must never overwrite
  // (a touch that leaves the same split is not a change: Taha's test, 18 Nov).
  const [splitNote, setSplitNote] = useState<SplitNote>(null);
  const autoSplitRef = useRef<CommissionSplit>(NEW_QUOTE_SPLIT);
  // The "From X's split" note for that split, shown again when a hand edit puts it back (Sol LOW, 19 Nov).
  const fromNoteRef = useRef<SplitNote>(null);
  const [quoteNumber, setQuoteNumber] = useState('');
  // Only a new quote allocates a number; an existing quote's number arrives with its row.
  const [quoteNumberLoading, setQuoteNumberLoading] = useState(!id);
  const [status, setStatus] = useState<QuoteStatus>('draft');
  const [quoteId, setQuoteId] = useState<string | null>(id || null);
  // The saved quote whose snapshot is on screen. `quoteId` starts as the URL's id
  // before anything loads, so it cannot tell a loaded quote from a failed first load.
  const [installedQuoteId, setInstalledQuoteId] = useState<string | null>(null);
  const [loadedQuoteOwner, setLoadedQuoteOwner] = useState<{ quoteId: string; createdBy: string | null } | null>(null);
  // Scoped by the quote this save actually TARGETS. F1 makes an ambiguous reply
  // RETAIN this key, and QuoteBuilder does not remount when only `:id` changes (no
  // `<x>/:id` route in src/App.tsx carries a `key` prop). Page-wide, an unresolved
  // key minted for quote A would therefore be sent with quote B's payload; the
  // server fingerprints the mismatch and answers IDEMPOTENCY_PAYLOAD_CONFLICT, so
  // it fails closed with no cross-quote write — but B gets a conflict dialog it
  // did nothing to earn. `create_quote_version` below already scopes this way, for
  // this same reason.
  //
  // The scope mirrors `p_quote_id` EXACTLY (see the save_quote call), so it binds
  // the record the RPC writes rather than the route — which is why route-id
  // scoping would be wrong here: `/quotes/new` has no route id, and `quoteId` is
  // state that the create path reassigns after the save.
  //
  // RESIDUAL, stated rather than implied: every create scopes to 'new', so an
  // unresolved create can still be inherited by the next create on this mount.
  // Binding that needs PR #535's fingerprintIntentPayload.
  const saveQuoteIntentScope = (quoteId && isEditing) ? quoteId : 'new';
  const {
    getKey: getSaveQuoteIdempotencyKey,
    resetKey: resetSaveQuoteIdempotencyKey,
    resetKeyFor: resetSaveQuoteKeyFor,
  } = useIdempotencyKey('save_quote', profile?.id || '', saveQuoteIntentScope);
  // Which scope produced the conflict the stale-save dialog is currently offering to
  // recover. Scoping the key made this necessary: the dialog stays open across a route
  // change, and `reloadAfterStaleSave` releases the CURRENT render's scope, so an
  // operator who navigates A -> B with A's dialog open and then clicks Reload would
  // release B's key and leave A's rejected one in place. Recorded at the moment the
  // conflict opens, checked before anything is released.
  //
  // EVERY site that opens this dialog must record the scope. An opener that skips it
  // leaves the PREVIOUS quote's scope standing, and the comparison below then refuses
  // to release the CURRENT quote's key after its own authoritative reload — so that
  // quote's next edited save fails closed and forces a reload that discards the
  // operator's edits. Recording at only the save-conflict branch was exactly that
  // defect. Keep Editing clears the record because the dialog it belonged to is gone;
  // the reload path clears it only when it actually releases, since a reload for a
  // DIFFERENT quote must leave the originating quote's key retained.
  const staleSaveConflictScopeRef = useRef<StaleSaveConflictOrigin>(null);

  // The wall clock one save_quote attempt is pinned to, per intent scope.
  //
  // The server fingerprints the WHOLE request — quote id, the entire quote payload,
  // the sections, and the actor — into `v_request_fingerprint`
  // (20260812115236_quote_items_cost_at_quote_snapshot.sql:348) and rejects a replay
  // whose fingerprint differs with IDEMPOTENCY_PAYLOAD_CONFLICT. `expires_at` and
  // `sent_at` are derived from `Date.now()`, so a plain re-send regenerates them to a
  // different millisecond and can never match the original.
  //
  // Without this, the recovery instruction below — press Save again on the SAME
  // retained key — is impossible to carry out: the retained key would be a receipt no
  // request this page can build could ever redeem, and a create whose first attempt
  // committed server-side would be stranded with no way back to it.
  //
  // So the first save under a given key records the instant, and every retry under
  // that same key reuses it. Retiring the key mints a new one, which is a new attempt
  // and takes a fresh instant. Keyed by scope and stamped with the key it was minted
  // for, so an A -> B -> A navigation cannot hand quote A's retry quote B's clock.
  //
  // Only the CLOCK is frozen, never the payload. If the operator edits the quote —
  // the expiry included — the fingerprint legitimately changes and the server is
  // right to refuse: that is a different request, not a retry.
  const saveQuoteAttemptClockRef = useRef<Map<string, { key: string; atMs: number }>>(new Map());
  const [isPlanned, setIsPlanned] = useState(false);
  const [wasPlanned, setWasPlanned] = useState(false);

  const [sections, setSections] = useState<LocalSection[]>([makeEmptySection(1)]);
  // The chosen customer's row: from the picker, the ?customer_id= link, or the saved quote. The
  // picker searches the database, so no customer list is loaded.
  const [customerRow, setCustomerRow] = useState<QuoteCustomer | null>(null);
  // Set when the link's or the saved quote's customer could not be read; saving is blocked.
  const [customerLoadError, setCustomerLoadError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  // Set when the product list (or an admin's product costs) failed to load: the list is empty and
  // adding lines and saving are blocked, so nothing is priced from a missing or partial list.
  const [productsLoadFailed, setProductsLoadFailed] = useState(false);
  // Until the product list and unit conversions land, every unit would convert at a factor of 1.
  const [referenceDataReady, setReferenceDataReady] = useState(false);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  // Fields this page knows by id: each section's saved field (read by id) plus each field picked.
  const [fields, setFields] = useState<Record<string, FieldOption>>({});
  const [fieldLoadError, setFieldLoadError] = useState<string | null>(null);
  const [activePlannedHolds, setActivePlannedHolds] = useState<ActivePlannedHold[]>([]);

  const [productSearchOpen, setProductSearchOpen] = useState<{
    sectionKey: string;
    itemKey: string;
  } | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [keepProductPickerOpen, setKeepProductPickerOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  // Products tab: the line waiting on "Remove this line?", and which notes are open for editing.
  const [removeLineTarget, setRemoveLineTarget] = useState<{ sectionKey: string; itemKey: string } | null>(null);
  const [openSectionNotes, setOpenSectionNotes] = useState<Set<string>>(new Set());
  const [editingLineNote, setEditingLineNote] = useState<string | null>(null);
  const [rupWarnings, setRupWarnings] = useState<string[]>([]);
  const [quoteVersions, setQuoteVersions] = useState<QuoteVersion[]>([]);
  const [unreadableQuoteVersions, setUnreadableQuoteVersions] = useState<UnreadableQuoteVersion[]>([]);
  // Tagged with its quote, so a late reply for another quote is never read as this one's. A
  // quote whose list never loaded has none, and the page asks for a re-send rather than promising
  // a price the database may refuse; a failed refresh keeps the last list read.
  const [priceChanges, setPriceChanges] = useState<{ quoteId: string; rows: QuotePriceChange[] } | null>(null);
  const priceChangesSerialRef = useRef(0);
  const refreshPriceChanges = useCallback(async (forQuoteId: string) => {
    const serial = ++priceChangesSerialRef.current;
    const rows = await loadQuotePriceChanges(forQuoteId);
    if (rows && serial === priceChangesSerialRef.current) setPriceChanges({ quoteId: forQuoteId, rows });
  }, []);
  const savedVersionCount = quoteVersions.length + unreadableQuoteVersions.length;
  // A quote with a sent version keeps its prices (save_quote, 20261027040000). The version last
  // sent to the customer is the price authority that Convert, Partial Order and Schedule Job check.
  // A sent or revised quote counts as locked even if its version list failed to load, so the
  // page never re-prices what the server keeps.
  const priceLocked = savedVersionCount > 0 || status === 'sent' || status === 'revised';
  const lastSentVersion = useMemo(
    () => quoteVersions.reduce<QuoteVersion | null>(
      (latest, v) => (latest == null || v.version_number > latest.version_number ? v : latest), null),
    [quoteVersions],
  );
  const lastSentItems = useMemo(() => sentItemsOf(lastSentVersion), [lastSentVersion]);
  // One newest-first list, not readable-then-unreadable: see orderedQuoteVersionHistory. The two
  // state arrays stay separate because everything else (restore, compare, the Sentry report) may
  // only ever see the readable ones.
  const orderedVersionHistory = useMemo(
    () => orderedQuoteVersionHistory({ versions: quoteVersions, unreadable: unreadableQuoteVersions }),
    [quoteVersions, unreadableQuoteVersions],
  );
  const [selectedVersion, setSelectedVersion] = useState<QuoteVersion | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [activeTab, setActiveTab] = useState('products');
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmRewindOpen, setConfirmRewindOpen] = useState(false);
  const [revising, setRevising] = useState(false);
  // Quote lifecycle terminal actions (sell-side roadmap #5 — unstick lifecycle):
  // decline/cancel set a terminal status (triggers release holds); un-accept/
  // reopen routes through the hardened admin-only revert_quote_status RPC.
  const [confirmDeclineOpen, setConfirmDeclineOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [statusActionLoading, setStatusActionLoading] = useState(false);
  // Close a booking we fulfilled by APPLYING product (job applications), as
  // opposed to delivering it (convert/draw = chemical sale). Distinct terminal
  // status; releases any un-applied leftover; never double-bills. (owner 2026-07-03)
  const [confirmCloseAppliedOpen, setConfirmCloseAppliedOpen] = useState(false);
  const [closingApplied, setClosingApplied] = useState(false);
  // Close a booking the customer ABANDONED (walked away / took only part): the
  // un-fulfilled remainder is released back to free inventory. Distinct terminal
  // status 'closed_short'; never bills. The escape hatch for a partially-drawn
  // booking that Decline/Cancel/Expire refuse (BOOKING_PARTIALLY_DRAWN). (#1)
  const [confirmCloseShortOpen, setConfirmCloseShortOpen] = useState(false);
  const [closingShort, setClosingShort] = useState(false);
  // Draft bookings CAN be scheduled server-side (a pre-planned draft is valid),
  // but we warn first because the booking hasn't been sent to the customer. (#103)
  const [confirmDraftScheduleKey, setConfirmDraftScheduleKey] = useState<string | null>(null);
  const [showRevertModal, setShowRevertModal] = useState(false);
  const [revertReason, setRevertReason] = useState('');
  // Bind the retry key to the exact action intent. A network-uncertain retry
  // reuses its key, while navigating to another quote or editing the reason
  // produces a new key that cannot replay the prior quote's result.
  const revertStatusIdem = useIdempotencyKey(
    'revert_quote_status',
    `${profile?.id || ''}:${id || ''}:${revertReason.trim()}`,
  );
  const [reverting, setReverting] = useState(false);
  // #3 Stage A: email the quote PDF to the grower via the send-email Edge Function.
  const [emailingGrower, setEmailingGrower] = useState(false);
  const [lastQuoteEmailAt, setLastQuoteEmailAt] = useState<string | null>(null);
  const [customerView, setCustomerView] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Transaction thread: related orders, deliveries, invoices from this quote
  const [threadOrders, setThreadOrders] = useState<{ id: string; order_number: string; deliveries: { id: string; delivery_number: string }[]; invoices: { id: string; invoice_number: string }[] }[]>([]);
  const [previewPdfBlob, setPreviewPdfBlob] = useState<Blob | null>(null);
  const [markingPresented, setMarkingPresented] = useState(false);
  // The columns the shown preview was drawn with; the effect below redraws when the chips change.
  const previewColumnsKeyRef = useRef<string | null>(null);
  const [previewRebuild, setPreviewRebuild] = useState<'idle' | 'updating' | 'failed'>('idle');
  // Bumped per Preview click and on a move to another quote, so a late first build never opens or
  // replaces the preview. A layout effect, so it moves on commit with routeQuoteIdRef.
  const previewRunRef = useRef(0);
  useLayoutEffect(() => {
    previewRunRef.current += 1;
  }, [id]);
  const [pdfTemplates, setPdfTemplates] = useState<QuotePdfTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [customColumns, setCustomColumns] = useState<string[] | null>(null);

  // Quote template state
  const [quoteTemplates, setQuoteTemplates] = useState<QuoteTemplate[]>([]);
  const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [showRolloverModal, setShowRolloverModal] = useState(false);
  const [rolloverSeason, setRolloverSeason] = useState(() => computeSeason() + 1);
  const isPhone = useIsPhone();
  // The line table needs 1280 px (at 1024 with the sidebar open its number boxes cut values off); below that each line is a card.
  const lineCards = useIsBelowXl();

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const suppressDirtyUntilReloadSettlesRef = useRef(false);
  // Set just before an update the page makes itself (KI-82: a saved line's recorded cost), so the
  // next sections change does not mark the just-saved quote as changed.
  const skipNextDirtyRef = useRef(false);
  const initialLoadGenerationRef = useRef(0);
  const [installedLoadGeneration, setInstalledLoadGeneration] = useState(0);
  // Saved quote_items id (and the product it was saved with) per on-screen line,
  // keyed by `_key`. save_quote keeps a line's quote-time cost only when the save
  // names which saved line each row is; without ids, two lines of one product are
  // refused as QUOTE_ITEM_AMBIGUOUS_COST. A ref, not section state: installing the
  // ids a save returns must not mark the just-saved quote dirty.
  // `price` is the price_per_unit the database holds for that row (loaded, then each save's
  // item_prices): a sent quote keeps it on later saves (20261027040000). `todayApplied` marks a
  // "use today's price" choice the database already stored, so it is applied once, not again.
  // Lines "Use Tier N" moved to today's price (KI-105). Picking another tier from the menu undoes it,
  // so a sent price is never replaced by a choice the operator walked back (Sol, #1605).
  // Each line's state before "Use Tier N", put back exactly when the tier menu undoes it (Codex, #1605).
  const useTierUndoRef = useRef(new Map<string, { useToday: boolean; applied?: boolean }>());
  const savedLineIdsRef = useRef(new Map<string, {
    id: string;
    productId: string;
    price: number;
    todayApplied?: boolean;
  }>());
  // The render-side copy of savedLineIdsRef, set with it on load and on each save. A line added and
  // saved since the page loaded has no local id, so the price lock names it from here.
  const [savedLineIdByKey, setSavedLineIdByKey] = useState<ReadonlyMap<string, { id: string; productId: string; price: number }>>(new Map());
  // Item 11: a rep's cost-rise flags per saved line id (no cost numbers).
  const [costAlerts, setCostAlerts] = useState<ReadonlyMap<string, CostAlert>>(new Map());
  const priceLockLineOf = useCallback((item: LocalItem): PriceLockLine => {
    const saved = savedLineIdByKey.get(item._key);
    return {
      id: saved && saved.productId === item.product_id ? saved.id : undefined,
      product_id: item.product_id,
      price_per_unit: item.price_per_unit,
      saved_price_per_unit: saved && saved.productId === item.product_id ? saved.price : undefined,
    };
  }, [savedLineIdByKey]);
  // The database's re-send rule as the page can see it (src/lib/quotePriceLock.ts).
  const unsentChange = useMemo(() => unsentQuoteChange({
    lastSent: lastSentVersion,
    newestVersionNumber: [...quoteVersions, ...unreadableQuoteVersions]
      .reduce((newest, v) => Math.max(newest, v.version_number), 0),
    customerId,
    lines: sections.flatMap((sec) => sec.items.filter((item) => item.product_id).map(priceLockLineOf)),
    priceChanges: priceChanges && priceChanges.quoteId === quoteId ? priceChanges.rows : [],
  }), [lastSentVersion, quoteVersions, unreadableQuoteVersions, customerId, sections, priceLockLineOf, priceChanges, quoteId]);
  // Lines switched to another product since the last save was sent. A switched
  // line stops being its saved line, even if it is later switched back, so the
  // reply of a save that was in flight must not hand it an id again.
  const switchedLineKeysRef = useRef(new Set<string>());
  // Serial number for quote loads. App.tsx routes every /quotes/:id to this one
  // element with no `key`, so navigating between two saved quotes re-runs the id
  // effect WITHOUT remounting. A load whose serial is no longer current has been
  // superseded — by a route change, or by a newer reload of the same quote — and
  // describes a record this page is no longer showing, so it must install
  // nothing: not the form, not quoteId, not the row-version token.
  const quoteLoadSerialRef = useRef(0);
  // The quote the URL currently names. The serial above orders CALLS; this binds
  // a call to a RECORD, and the two operands have genuinely independent sources
  // (one from this component's own call order, one from the router). Both are
  // needed: `fetchQuote` is also called from stale closures that survive a
  // navigation — the stale-save reload and the post-conversion refetch — and such
  // a call MINTS THE NEWEST SERIAL for the quote the operator already left, so a
  // serial check alone would certify the stale snapshot as current instead of
  // rejecting it.
  //
  // Written in a LAYOUT EFFECT, never during render. React may begin rendering a
  // transition to another quote and then discard that render while the current
  // one is still the committed screen; a render-time write publishes the new id
  // anyway. The save guard reads this ref to decide whether its reply still
  // belongs on screen, so a route that "changed" only inside a discarded render
  // makes it drop a VALID reply after the database has committed — leaving the
  // stale row-version token and a dirty form, and sending the operator's retry
  // into stale-write recovery on a document that drives cost and price. A layout
  // effect runs on commit, and before the passive effects that start the loads,
  // so every reader still sees the committed route. Same discipline, and the same
  // reasoning, as `CustomerDetail.tsx`'s `currentIdRef`.
  const routeQuoteIdRef = useRef<string | null>(id ?? null);
  useLayoutEffect(() => {
    routeQuoteIdRef.current = id ?? null;
  }, [id]);
  // Set right before a navigate() that follows a committed save, so the router's
  // stale "dirty" check cannot show a false Unsaved Changes prompt (see useUnsavedChanges).
  const skipUnsavedPromptRef = useRef(false);
  const blocker = useUnsavedChanges(isDirty, skipUnsavedPromptRef);

  // Status-based guards
  const currentStatus = status || 'draft';
  const isAdmin = profile?.role === 'admin';
  const draftEditLocked = isEditing && currentStatus === 'draft' && !isAdmin
    && (!profile?.id || loadedQuoteOwner?.quoteId !== id || loadedQuoteOwner?.createdBy !== profile.id);
  const canEdit = !draftEditLocked && ['draft', 'revised'].includes(currentStatus);
  // Save keeps a revised quote revised (Save changes); everything else saves as a draft.
  const savesAsRevised = isEditing && currentStatus === 'revised';
  // Codex round-7 P2: include 'sent' so a frozen sent quote can still be re-emailed —
  // "Preview Quote" is the only route to the Email-to-Grower button, and
  // handleEmailToGrower explicitly supports re-sending an already-sent quote and
  // creates a newly confirmed version snapshot before every send.
  const canSend = !draftEditLocked && ['draft', 'revised', 'sent'].includes(currentStatus);
  // The server conversion RPC deliberately resumes an accepted Quote that has
  // no Order and returns the existing Order when one already exists. Keeping
  // accepted Quotes convertible gives a sales rep a safe retry path when a
  // conversion's reply was lost, or for a quote accepted before conversion was
  // made atomic (KI-12).
  const canConvert = ['sent', 'revised', 'accepted'].includes(currentStatus);
  // Both whole conversion and draw_down_quote accept sent/revised bookings.
  const canDraw = currentStatus === 'sent' || currentStatus === 'revised';

  // Quote lifecycle terminal/reopen actions (roadmap #5). The status-transition
  // trigger allows: draft/sent/revised → cancelled; sent/revised → declined;
  // accepted/declined/expired/cancelled → sent (admin revert RPC only).
  const staffSeesLastCharged = !customerView && (isAdmin || profile?.role === 'sales_rep');
  const lastChargedLines = sections.flatMap((section) => section.items.map((item) => ({
    productId: item.product_id,
    productName: item.product?.product_name ?? 'Product',
  })));
  // Loads on page load and when the customer or product set changes, whichever tab shows.
  const lastCharged = useLastChargedPrices(customerId, lastChargedLines, staffSeesLastCharged);
  // USE-2: each line's label adjuvants, read for the products' own EPA numbers (a reminder, never blocks).
  const lineRegistrations = useCancelledRegistrations(sections.flatMap((section) => section.items.map((item) =>
    (item.product || products.find((p) => p.id === item.product_id))?.epa_registration)));
  // Cost, profit and margin are admin-only (Mason, 2026-10-15); Customer View hides them for an admin too.
  const hideCost = customerView || !isAdmin;
  const canCancel = isEditing && !draftEditLocked && ['draft', 'sent', 'revised'].includes(currentStatus);
  const canDecline = isEditing && ['sent', 'revised'].includes(currentStatus);
  // "Close — fulfilled by application" is only for a PLANNED open booking (the
  // application channel), in parity with the close_quote_as_applied RPC
  // (sent/revised + is_planned). A plain non-planned sales quote uses convert/
  // decline, not this. (Codex 2026-07-03 P2)
  const canCloseApplied = isEditing && isPlanned && ['sent', 'revised'].includes(currentStatus);
  // "Close — Short" (customer walked away, release the remainder) is for ANY open
  // booking (planned or not) — parity with close_quote_as_short, which does NOT
  // require is_planned (a non-planned open booking can also be abandoned; it just
  // has no crop holds to release). (#1)
  const canCloseShort = isEditing && ['sent', 'revised'].includes(currentStatus);
  // A booking only takes new scheduled jobs while it's not terminal AND not
  // 'accepted' — parity with create_job_from_quote_section's status guard: once a
  // booking is closed/declined/cancelled/expired it's terminal, and 'accepted'
  // means it was converted to a chemical SALE (order) so scheduling a job would
  // double-count the product (finding #103 — QUOTE_ALREADY_CONVERTED). Draft
  // stays schedulable (warn-only). (#103)
  const canScheduleJobs = isPlanned && !['accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short'].includes(currentStatus);
  // Show an inline explanation where the Schedule-Job button would be, on an
  // accepted planned booking, so the user knows to make a standalone job. (#103)
  const scheduleBlockedAccepted = isPlanned && currentStatus === 'accepted';
  const canRevert = isEditing && isAdmin && ['accepted', 'declined', 'expired', 'cancelled'].includes(currentStatus);
  const revertLabel = currentStatus === 'accepted' ? 'Un-accept' : 'Reopen';

  // The form compared as one value, so an edit typed back to what was saved makes the quote clean
  // again (Save turns off, no "Unsaved changes") instead of staying changed.
  const formSnapshot = useMemo(
    () => JSON.stringify([customerId, tier, chosenExpiryDate, headerNotes, footerNotes, sections, commissionSplit, isPlanned]),
    [customerId, tier, chosenExpiryDate, headerNotes, footerNotes, sections, commissionSplit, isPlanned],
  );
  const cleanSnapshotRef = useRef('');

  // Whatever is on screen when the quote turns clean (loaded, saved, reverted) is "no changes".
  // Declared before the check below so it runs first in the same commit.
  useEffect(() => {
    if (!isDirty) cleanSnapshotRef.current = formSnapshot;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the quote turns clean, not on every edit
  }, [isDirty]);

  // Dirty = the form differs from the last clean state (after initial load)
  useEffect(() => {
    // Changes the page makes itself while loading are the saved state.
    if (!initialLoadDone.current || suppressDirtyUntilReloadSettlesRef.current) {
      cleanSnapshotRef.current = formSnapshot;
      return;
    }
    if (skipNextDirtyRef.current) {
      skipNextDirtyRef.current = false;
      if (!isDirty) cleanSnapshotRef.current = formSnapshot;
      return;
    }
    setIsDirty(formSnapshot !== cleanSnapshotRef.current);
  }, [formSnapshot, isDirty]);

  // Release initial-load dirty suppression only after React has committed the
  // complete installed snapshot. Timer/frame releases can run before that
  // commit on a busy device and let a late passive update mark a saved quote
  // dirty, blocking its first draw-down attempt.
  useEffect(() => {
    if (installedLoadGeneration === 0) return;
    if (initialLoadGenerationRef.current !== installedLoadGeneration) return;
    initialLoadDone.current = true;
    suppressDirtyUntilReloadSettlesRef.current = false;
    setIsDirty(false);
  }, [installedLoadGeneration]);

  // Booking settlement (roadmap #6c): for an open booking (saved sent/revised
  // quote), load booked/drawn/remaining + prepay position. Re-runs when the
  // status changes (e.g. after a draw flips it). Read-only; clears otherwise.
  useEffect(() => {
    const isOpenBooking = isEditing && quoteId && (currentStatus === 'sent' || currentStatus === 'revised');
    if (!isOpenBooking) { setBookingSettlement(null); setBookingSettlementFailed(false); return; }
    // A new read (Try again, or another quote) starts clean: no earlier failure or figures.
    setBookingSettlementFailed(false);
    setBookingSettlement(null);
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_booking_settlement', { p_quote_id: quoteId });
        if (error) throw error;
        const s = assertRpcResult<BookingSettlement>(data, 'get_booking_settlement');
        if (cancelled) return;
        setBookingSettlement(s && s.found ? s : null);
        setBookingSettlementFailed(false);
      } catch (err) {
        if (cancelled) return;
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', action: 'get_booking_settlement' } });
        setBookingSettlement(null);
        setBookingSettlementFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isEditing, quoteId, currentStatus, bookingSettlementAttempt]);

  // Item 11 (Mason 2026-10-26): a rep is told when a line's cost has gone up since it was quoted,
  // as yes/no flags only (20261030090000); admins see the costs themselves (QuoteLineCost).
  // Re-read whenever the saved lines change, so a save shows the flags of the lines it stored.
  useEffect(() => {
    if (isAdmin || !isEditing || !quoteId || savedLineIdByKey.size === 0) { setCostAlerts(new Map()); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_quote_cost_alerts', { p_quote_id: quoteId });
        if (error) throw error;
        const rows = assertRpcResult<CostAlert[]>(data, 'get_quote_cost_alerts');
        if (!cancelled) setCostAlerts(new Map(rows.map((row) => [row.quote_item_id, row])));
      } catch (err) {
        if (cancelled) return;
        // A warning only: a failed read shows no flag and never blocks the quote.
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', action: 'get_quote_cost_alerts' } });
        setCostAlerts(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, isEditing, quoteId, savedLineIdByKey]);

  const loadActivePlannedHolds = useCallback(async (targetQuoteId: string) => {
    const { data, error } = await supabase
      .from('inventory_holds')
      .select('product_id, quantity, expires_at')
      .eq('hold_type', 'crop_program')
      .eq('source_id', targetQuoteId)
      .eq('is_active', true);
    if (error) {
      setActivePlannedHolds([]);
      return;
    }
    setActivePlannedHolds((data || []) as ActivePlannedHold[]);
  }, []);

  useEffect(() => {
    if (!isPlanned || !quoteId) {
      setActivePlannedHolds([]);
      return;
    }
    void loadActivePlannedHolds(quoteId);
  }, [isPlanned, quoteId, loadActivePlannedHolds]);

  const loadQuoteEmailStatus = useCallback(async (targetQuoteNumber: string) => {
    // send-email records this quote reference as its attachment_name, not resource_id.
    const { data, error } = await supabase
      .from('email_log')
      .select('created_at')
      .eq('email_type', 'quote')
      .eq('attachment_name', `Quote-${targetQuoteNumber}.pdf`)
      .eq('status', 'sent')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      setLastQuoteEmailAt(null);
      return;
    }
    setLastQuoteEmailAt(data?.[0]?.created_at ?? null);
  }, []);

  useEffect(() => {
    if (!quoteId || !quoteNumber) {
      setLastQuoteEmailAt(null);
      return;
    }
    void loadQuoteEmailStatus(quoteNumber);
  }, [quoteId, quoteNumber, loadQuoteEmailStatus]);

  // RUP compliance check when the customer or the PRODUCT SET changes. Keyed by a
  // stable product-set string (NOT `sections`) so editing quantities/prices/notes
  // does not re-run the check, and the activity log is deduped per
  // (customer, product-set) via lastRupLogKey — matching the NewOrder flow. Without
  // the dedup, every section edit flooded activity_feed with identical
  // rup_compliance_warning rows (Codex 2026-06-13 round-3 finding 2).
  const rupProductKey = sections.flatMap((s) => s.items.map((i) => i.product_id)).filter(Boolean).sort().join(',');
  const lastRupLogKey = useRef('');
  useEffect(() => {
    if (!customerId || !rupProductKey) { setRupWarnings([]); return; }
    let cancelled = false;
    checkRUPCompliance(customerId, rupProductKey.split(',')).then((res) => {
      if (!cancelled) {
        setRupWarnings(res.warnings);
        const logKey = `${customerId}|${rupProductKey}`;
        if (res.warnings.length > 0 && !res.checkFailed && profile?.id && lastRupLogKey.current !== logKey) {
          lastRupLogKey.current = logKey;
          logActivity({ event: 'rup_compliance_warning', description: `RUP products (${res.rupProductNames.join(', ')}) on quote for customer without valid license`, performedBy: profile.id, entityType: 'customer', entityId: customerId, customerId });
        }
      }
    });
    return () => { cancelled = true; };
  }, [customerId, rupProductKey, profile?.id]);

  // Fetch transaction thread data (orders/deliveries/invoices linked to this quote)
  useEffect(() => {
    if (!isEditing || !id) { setThreadOrders([]); return; }
    let cancelled = false;
    (async () => {
      const { data: orders } = await supabase
        .from('orders').select('id, order_number')
        .eq('quote_id', id).order('order_number');
      if (cancelled || !orders?.length) { if (!cancelled) setThreadOrders([]); return; }
      const orderIds = orders.map(o => o.id);
      const [delRes, invRes] = await Promise.all([
        supabase.from('deliveries').select('id, delivery_number, order_id').in('order_id', orderIds),
        supabase.from('invoices').select('id, invoice_number, order_id').in('order_id', orderIds)
          .not('status', 'in', '("voided","cancelled")'),
      ]);
      if (cancelled) return;
      setThreadOrders(orders.map(o => ({
        id: o.id, order_number: o.order_number as string,
        deliveries: (delRes.data || []).filter((d: Record<string, unknown>) => d.order_id === o.id)
          .map((d: Record<string, unknown>) => ({ id: d.id as string, delivery_number: d.delivery_number as string })),
        invoices: (invRes.data || []).filter((i: Record<string, unknown>) => i.order_id === o.id)
          .map((i: Record<string, unknown>) => ({ id: i.id as string, invoice_number: i.invoice_number as string })),
      })));
    })();
    return () => { cancelled = true; };
  }, [isEditing, id]);

  // Only the newest load may install the product list: a role change re-runs this loader while an
  // older (cost-less) load may still be in flight (Luna round 3).
  const referenceSeqRef = useRef(0);
  const fetchReferenceData = useCallback(async () => {
    const seq = ++referenceSeqRef.current;
    setReferenceDataReady(false);
    // Customers and fields are searched by their pickers; the product list is read whole because
    // pricing, the product picker's local search and the admin cost overlay all use it.
    const [prodRes, convRes] = await Promise.all([
      fetchAllRows((from, to) => pageWithList(supabase
        .from('products')
        .select(`${PRODUCT_COLUMNS}, product_family:product_families(name)`, { count: 'exact' })
        .eq('is_active', true)
        .order('product_name')
        .order('id')
        .range(from, to))),
      supabase.from('unit_conversions').select('*'),
    ]);

    // A read that answers with no list is a failed read too: an empty conversion
    // table would price every unit at a factor of 1 (To-Do 10.5).
    const prodFailed = !!prodRes.error || !prodRes.data;
    const convFailed = !!convRes.error || !convRes.data;
    if (prodFailed) {
      Sentry.captureException(prodRes.error ?? new Error('products read returned no list'), { tags: { source: 'fetch', page: 'quote_builder' } });
      toast('error', 'Failed to load products.');
    }
    if (convFailed) {
      Sentry.captureException(convRes.error ?? new Error('unit_conversions read returned no list'), { tags: { source: 'fetch', page: 'quote_builder' } });
      toast('error', 'Failed to load unit conversions.');
    }

    // Cost and margin are admin-only (Mason, 2026-10-15): only an admin's product list carries cost.
    // A failed read leaves no list at all, never a partial or previous one. Without unit conversions
    // every unit would convert at a factor of 1, so that failure blocks pricing the same way.
    let productRows = prodFailed || convFailed ? [] : ((prodRes.data || []) as unknown as Product[]);
    let productListFailed = prodFailed || convFailed;
    try {
      productRows = await withAdminCosts('products', productRows, isAdmin);
    } catch (costErr) {
      Sentry.captureException(costErr, { tags: { source: 'fetch', page: 'quote_builder', action: 'load_product_costs' } });
      toast('error', 'Failed to load product costs.');
      // Never offer an admin a product list without cost (Luna round 1).
      productRows = [];
      productListFailed = true;
    }
    if (seq !== referenceSeqRef.current) return;

    setProducts(productRows);
    setProductsLoadFailed(productListFailed);
    setUnitConversions(convFailed ? [] : (convRes.data as UnitConversion[]));
    setReferenceDataReady(!productListFailed);
  }, [toast, isAdmin]);

  // Opening a saved quote reuses this mounted page, so a late allocation must not replace its number.
  const quoteNumberSeqRef = useRef(0);
  // A new-quote session allocates once; a reference-data reload must not replace its number.
  const newQuoteNumberRequestedRef = useRef(false);
  const generateQuoteNumber = async () => {
    const seq = ++quoteNumberSeqRef.current;
    // Use server-side sequence to prevent race conditions
    setQuoteNumberLoading(true);
    // Never keep a previous quote's number if this allocation fails.
    setQuoteNumber('');
    try {
      const { data, error } = await supabase.rpc('generate_quote_number');
      if (error) throw Object.assign(new Error(error.message), error);
      if (!data) throw new Error('Quote number unavailable');
      if (seq !== quoteNumberSeqRef.current) return;
      setQuoteNumber(assertRpcResult<string>(data, 'generate_quote_number'));
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'generate_quote_number', ...(err instanceof Error ? err : {}) } });
      if (seq === quoteNumberSeqRef.current) {
        toast('error', 'Failed to generate quote number. Use Retry quote number to try again.');
      }
    } finally {
      if (seq === quoteNumberSeqRef.current) setQuoteNumberLoading(false);
    }
  };

  const clearQuoteRowVersionWithRefreshWarning = useCallback((action: string) => {
    if (quoteRowVersionRef.current !== null) {
      quoteNumericVersionRequiredRef.current = true;
    }
    quoteRowVersionRef.current = null;
    quoteVersionRecoveryRequiredRef.current = true;
    staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
    setStaleSaveOpen(true);
    toast('warning', `The quote was ${action}, but its save-protection version could not be confirmed. Refresh before editing, revising, or converting it.`);
    // No scope in the dep list, and none needed: this opener records the module
    // constant NON_SAVE_RECOVERY, which cannot go stale in a closure. Stamping a
    // scope here is what needed the dependency — and was the wrong thing to stamp.
  }, [toast]);

  const applyDirectQuoteMutationRowVersion = useCallback((
    previousRowVersion: number | null,
    returnedRowVersion: unknown,
    action: string,
  ): boolean => {
    const rowVersionResult = resolveDirectMutationRowVersion(previousRowVersion, returnedRowVersion);
    quoteRowVersionRef.current = rowVersionResult.rowVersion;
    if (rowVersionResult.kind !== 'recovery') {
      if (rowVersionResult.rowVersion !== null) {
        quoteNumericVersionRequiredRef.current = true;
      }
      return true;
    }

    // The direct lifecycle update committed, but a jumped/missing token could
    // belong to another writer. Do not adopt it: preserve local edits and make
    // the next whole-record save fail closed until the operator reloads.
    quoteVersionRecoveryRequiredRef.current = true;
    staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
    setStaleSaveOpen(true);
    toast('warning', `The quote was ${action}, but another edit may have completed at the same time. Your current edits were kept; reload before saving, revising, or converting it.`);
    return false;
    // No scope dependency — see clearQuoteRowVersionWithRefreshWarning above.
  }, [toast]);

  // An RPC response without row_version must never be followed by a blind
  // adoption of whatever a second writer committed after us. Only the one
  // version this mutation can produce is safe to install.
  const refreshQuoteRowVersionAfterMutation = useCallback(async (
    mutatedQuoteId: string,
    previousRowVersion: number | null,
    expectedRowVersion: number | null,
    action: string,
  ): Promise<boolean> => {
    const { data, error } = await supabase
      .from('quotes')
      .select('id, row_version')
      .eq('id', mutatedQuoteId)
      .maybeSingle();
    const nextRowVersion = readRowVersion((data as { row_version?: unknown } | null)?.row_version);

    if (!error
      && data
      && previousRowVersion === null
      && expectedRowVersion === null
      && nextRowVersion === null
      && !quoteNumericVersionRequiredRef.current) {
      quoteRowVersionRef.current = null;
      return true;
    }

    if (error || !data || previousRowVersion === null || expectedRowVersion === null || nextRowVersion !== expectedRowVersion) {
      if (error) {
        Sentry.captureException(error, { tags: { source: 'read', action: 'refresh_quote_row_version_after_mutation' } });
      }
      clearQuoteRowVersionWithRefreshWarning(action);
      return false;
    }

    quoteRowVersionRef.current = nextRowVersion;
    quoteNumericVersionRequiredRef.current = true;
    return true;
  }, [clearQuoteRowVersionWithRefreshWarning]);

  const installAuthoritativeQuoteRowVersion = useCallback((authoritativeRowVersion: unknown, action: string): boolean => {
    const rowVersionResult = resolveAuthoritativeSaveRowVersion(
      quoteRowVersionRef.current,
      authoritativeRowVersion,
    );
    quoteRowVersionRef.current = rowVersionResult.rowVersion;
    if (rowVersionResult.kind === 'recovery') {
      clearQuoteRowVersionWithRefreshWarning(action);
      return false;
    }
    if (rowVersionResult.rowVersion !== null) {
      quoteNumericVersionRequiredRef.current = true;
    }
    return true;
  }, [clearQuoteRowVersionWithRefreshWarning]);

  // U13 (#111): quote_section.id -> the job already scheduled from it (if any).
  // Populated by fetchQuote + updated locally right after a successful schedule
  // so the badge/hide-button logic never needs a full page reload.
  const [sectionJobs, setSectionJobs] = useState<Record<string, { id: string; job_number: string; status: JobStatus }>>({});

  const fetchQuote = useCallback(async (quoteId: string, requireStableRowVersion = false): Promise<boolean> => {
    // Refuse at the door, BEFORE taking a serial. A load for a quote the operator
    // has already left is doomed either way — it would reject itself below — but
    // taking a number on the way past is NOT free. The serial is a shared resource:
    // burning one supersedes the legitimate load of the quote now on screen, which
    // then installs nothing and strands the page behind a skeleton that never
    // clears, and it makes an unrelated in-flight SAVE of that quote look like it
    // belongs to an editing session that ended.
    //
    // Reachable through the delayed post-conversion `fetchQuote(savedId)` below and
    // through `reloadAfterStaleSave`, both of which run from closures that survive a
    // navigation. Same discipline as CustomerDetail's tab loader.
    if (routeQuoteIdRef.current !== quoteId) return false;
    const loadSerial = ++quoteLoadSerialRef.current;
    // Two independent halves; neither subsumes the other, and each has its own
    // regression test. `supersededByNewerLoad` orders CALLS, so reopening the
    // SAME quote twice still resolves to the newer call. `routeLeftThisQuote`
    // binds this call to a RECORD, so a load started from a stale closure
    // cannot install merely because it holds the newest serial.
    //
    // Re-checked after every await. A load that must not install returns false
    // without touching form state, toasts, navigation or `loading` — whichever
    // load is current owns all of those now.
    const supersededByNewerLoad = () => quoteLoadSerialRef.current !== loadSerial;
    const routeLeftThisQuote = () => routeQuoteIdRef.current !== quoteId;
    const mustNotInstall = () => supersededByNewerLoad() || routeLeftThisQuote();

    const quoteRes = await supabase
      .from('quotes')
      .select(`${QUOTE_COLUMNS}, customer:customers(*)`)
      .eq('id', quoteId)
      .maybeSingle();
    if (mustNotInstall()) return false;

    if (quoteRes.error || !quoteRes.data) {
      if (quoteRes.error) {
        Sentry.captureException(quoteRes.error, { tags: { source: 'read', action: 'load_quote_snapshot' } });
      }
      if (!quoteRes.error) {
        toast('error', 'Quote not found');
        navigate('/quotes');
      } else {
        toast('error', 'Could not load the complete quote. Your current edits were kept; try Reload again or refresh the page.');
      }
      setQuoteLoadFailedId(quoteId);
      setLoading(false);
      return false;
    }

    const initialRowVersion = readRowVersion((quoteRes.data as Quote & { row_version?: unknown }).row_version);
    const [sectionsRes, itemsRes] = await Promise.all([
      supabase.from('quote_sections').select('*').eq('quote_id', quoteId).order('sort_order'),
      supabase
        .from('quote_items')
        .select(`${QUOTE_ITEM_COLUMNS}, product:products(${PRODUCT_COLUMNS}, product_family:product_families(name))`)
        .eq('quote_id', quoteId)
        .order('sort_order'),
    ]);
    if (mustNotInstall()) return false;

    // Build and validate the complete editable snapshot before changing any
    // form state. A failed Reload must never replace an operator's local work
    // with an empty quote, sections, or items list.
    // A read that answers with no list counts as failed too: installing it would
    // show an empty quote whose next Save replaces the real lines (To-Do 10.5).
    if (sectionsRes.error || itemsRes.error || !sectionsRes.data || !itemsRes.data) {
      Sentry.captureException(sectionsRes.error ?? itemsRes.error ?? new Error('quote sections or items read returned no list'), { tags: { source: 'read', action: sectionsRes.error || !sectionsRes.data ? 'load_quote_sections_snapshot' : 'load_quote_items_snapshot' } });
      toast('error', 'Could not load the complete quote. Your current edits were kept; try Reload again or refresh the page.');
      setQuoteLoadFailedId(quoteId);
      setLoading(false);
      return false;
    }

    const { data: finalHeader, error: finalHeaderError } = await supabase
      .from('quotes')
      .select('id, row_version')
      .eq('id', quoteId)
      .maybeSingle();
    if (mustNotInstall()) return false;

    // Cost and margin are admin-only (Mason, 2026-10-15): only an admin's copy carries them.
    let costedQuote = quoteRes.data as unknown as Quote;
    let costedItems = (itemsRes.data || []) as unknown as QuoteItem[];
    try {
      costedQuote = (await withAdminCost('quotes', costedQuote, isAdmin)) as Quote;
      costedItems = await withAdminCosts('quote_items', costedItems, isAdmin);
      costedItems = await withAdminNestedCosts('products', costedItems, 'product', isAdmin);
    } catch (costErr) {
      Sentry.captureException(costErr, { tags: { source: 'read', action: 'load_quote_costs' } });
      if (mustNotInstall()) return false;
      toast('error', 'Could not load the complete quote. Your current edits were kept; try Reload again or refresh the page.');
      setQuoteLoadFailedId(quoteId);
      setLoading(false);
      return false;
    }
    if (mustNotInstall()) return false;

    const finalRowVersion = readRowVersion((finalHeader as { row_version?: unknown } | null)?.row_version);
    const stableVersion = initialRowVersion === finalRowVersion
      && (initialRowVersion !== null || !requireStableRowVersion);
    if (finalHeaderError || !finalHeader || !stableVersion) {
      if (finalHeaderError) Sentry.captureException(finalHeaderError, { tags: { source: 'read', action: 'confirm_quote_snapshot_version' } });
      toast('error', 'Could not confirm a stable saved quote. Your current edits were kept; try Reload again or refresh the page.');
      setQuoteLoadFailedId(quoteId);
      setLoading(false);
      return false;
    }

    const q = costedQuote;
    const dbSections = (sectionsRes.data as QuoteSection[]) || [];
    const dbItems = costedItems;

    const localSections: LocalSection[] = dbSections.map((s) => ({
      _key: nextKey(),
      id: s.id,
      section_name: s.section_name,
      sort_order: s.sort_order,
      section_notes: s.section_notes,
      section_header_notes: s.section_header_notes,
      needed_by_date: s.needed_by_date || null,
      field_id: s.field_id || null,
      items: dbItems
        .filter((item) => item.section_id === s.id)
        .map((item) => {
          return {
            _key: nextKey(),
            id: item.id,
            product_id: item.product_id,
            sort_order: item.sort_order,
            notes: item.notes,
            price_per_unit: item.price_per_unit,
            price_override: item.price_override ?? null,
            // Absent for non-admins; the server re-derives cost on save either way.
            current_cost: item.current_cost ?? 0,
            quoted_cost: item.current_cost != null
              ? { rowId: item.id, productId: item.product_id, cost: item.current_cost }
              : undefined,
            suggested_rate: item.suggested_rate,
            actual_rate: item.actual_rate,
            rate_unit: item.rate_unit,
            oz_per_acre: item.oz_per_acre,
            price_per_acre: item.price_per_acre,
            acres: item.acres,
            total_units_needed: item.total_units_needed,
            unit_size: item.unit_size,
            profit: item.profit ?? 0,
            total_price: item.total_price,
            net_margin: item.net_margin ?? 0,
            product: item.product,
            calc_mode: (item.calc_mode as CalcMode) || 'rate_acres',
            price_unit: item.price_unit || null,
          };
        }),
    }));

    // The complete snapshot is now known-good. Install its related form state
    // together so React never observes an error-path partial reload.
    suppressDirtyUntilReloadSettlesRef.current = true;
    quoteRowVersionRef.current = finalRowVersion;
    quoteNumericVersionRequiredRef.current = finalRowVersion !== null;
    quoteVersionRecoveryRequiredRef.current = false;
    // This IS the authoritative reload that a rejected save key was waiting for:
    // the operator is looking at what the database actually holds for this quote,
    // so the receipt has served its purpose and the key may finally rotate. Same
    // condition `reloadAfterStaleSave` uses, reached through the ordinary reopen
    // instead of the recovery dialog — which the moved-session path cannot show.
    // Scoped to the quote the conflict belongs to: reloading a DIFFERENT quote
    // resolves nothing about this one.
    // Retired BY NAME rather than through the current render's scope.
    //
    // The demonstrated reason is identity, not correctness of the target: the scoped
    // `resetKey` changes whenever the scope changes, and #618 made it a dependency of
    // `fetchQuote`. Since the scope is derived from `quoteId` STATE, which lags the
    // route until `setQuoteId` below, that dependency re-created `fetchQuote` on
    // every navigation and re-ran the load effect — loading each quote twice, which
    // is what broke #618's own A -> B -> A load-ordering tests when the two changes
    // met. `resetKeyFor` is memoized on [operation, userId] alone and does not move.
    //
    // Naming the quote is also the honest form of the call: this line means "retire
    // the key belonging to the quote being reopened", and `resetKey()` only says that
    // while the rendered scope happens to already be `q.id`. It does today — a
    // mutation of this line back to `resetKey()` still passes the suite, so the
    // wrong-target failure is NOT a bug observed here and is not claimed as one.
    // `resetKeyFor(q.id)` removes the dependence on that coincidence.
    if (payloadConflictQuoteIdRef.current === q.id) {
      payloadConflictQuoteIdRef.current = null;
      resetSaveQuoteKeyFor(q.id);
    }
    setQuoteId(q.id);
    setInstalledQuoteId(q.id);
    setLoadedQuoteOwner({ quoteId: q.id, createdBy: q.created_by ?? null });
    setQuoteLoadFailedId(null);
    setQuoteNumber(q.quote_number);
    setCustomerId(q.customer_id);
    customerPickedSinceLoadRef.current = false;
    // The quote read embeds its customer (customer:customers(*)); a quote whose customer did not
    // come back cannot be saved, since the screen cannot show who it is for.
    const loadedCustomer = (q as Quote & { customer?: QuoteCustomer | null }).customer ?? null;
    setCustomerRow(loadedCustomer);
    setCustomerLoadError(q.customer_id && !loadedCustomer
      ? "This quote's customer could not be loaded. Refresh the page before saving."
      : null);
    setTier(q.tier);
    pickedBeforeValidDaysRef.current = false;
    setChosenExpiryDate(q.chosen_expiry_date ?? null);
    setHeaderNotes(q.header_notes || '');
    setFooterNotes(q.footer_notes || '');
    setStatus(q.status);
    setIsPlanned(q.is_planned || false);
    setWasPlanned(q.is_planned || false);
    setCommissionSplit(q.commission_split ?? { splits: [] });
    loadedCommissionSplitRef.current = q.commission_split ?? null;
    commissionSplitTouchedRef.current = false;
    setSplitNote(null);
    autoSplitRef.current = q.commission_split ?? { splits: [] };
    fromNoteRef.current = null;
    setQuoteCreatedAt(q.created_at || null);
    savedLineIdsRef.current = new Map(
      localSections.flatMap((s) => s.items)
        .filter((item) => item.id)
        .map((item) => [item._key, { id: item.id as string, productId: item.product_id, price: item.price_per_unit }]),
    );
    setSavedLineIdByKey(new Map(savedLineIdsRef.current));
    setSections(localSections.length > 0 ? localSections : [makeEmptySection(1)]);

    // U13 (#111): which sections already have a job scheduled from them, so the
    // badge renders and the "Schedule Job" button hides on load (not just after
    // a fresh schedule this session).
    const { data: sectionJobsData, error: sectionJobsError } = await supabase
      .from('jobs')
      .select('id, job_number, status, quote_section_id')
      .eq('quote_id', quoteId)
      .is('deleted_at', null)
      .not('quote_section_id', 'is', null);
    if (mustNotInstall()) return false;

    if (sectionJobsError) {
      Sentry.captureException(sectionJobsError, { tags: { source: 'read', action: 'load_quote_section_jobs' } });
      toast('warning', 'Quote loaded, but scheduled-job badges could not be refreshed.');
    } else {
      const sectionJobMap: Record<string, { id: string; job_number: string; status: JobStatus }> = {};
      ((sectionJobsData || []) as { id: string; job_number: string; status: JobStatus; quote_section_id: string }[])
        .forEach((j) => { sectionJobMap[j.quote_section_id] = { id: j.id, job_number: j.job_number, status: j.status }; });
      setSectionJobs(sectionJobMap);
    }

    // Fetch version history for this quote
    const { data: versionsData, error: versionsError } = await supabase
      .rpc('get_quote_versions', { p_quote_id: quoteId });
    if (mustNotInstall()) return false;

    if (versionsError) {
      Sentry.captureException(versionsError, { tags: { source: 'read', action: 'load_quote_versions' } });
      toast('warning', 'Quote loaded, but version history could not be refreshed.');
    } else {
      // Snapshots older than the current shape are listed, not hidden: see
      // adaptQuoteVersionList. They are an expected part of the historical data, so they
      // raise neither a toast nor a Sentry report on every load. A row the SERVER trusts that
      // still fails validation is not that, and is reported.
      const { versions, unreadable } = adaptQuoteVersionList(
        assertRpcResult<QuoteVersionRow[]>(versionsData, 'get_quote_versions'),
      );
      setQuoteVersions(versions);
      setUnreadableQuoteVersions(unreadable);
      reportUntrustworthyQuoteVersions(unreadable, quoteId);
    }
    await refreshPriceChanges(quoteId);
    if (mustNotInstall()) return false;

    setLoading(false);
    const loadGeneration = ++initialLoadGenerationRef.current;
    setInstalledLoadGeneration(loadGeneration);
    return true;
  }, [toast, navigate, resetSaveQuoteKeyFor, isAdmin, refreshPriceChanges]);

  const reloadAfterStaleSave = useCallback(async () => {
    if (!quoteId) return false;
    suppressDirtyUntilReloadSettlesRef.current = true;
    let installedSnapshot = false;
    try {
      // Commission-split conflicts already exist in production, before the
      // row-version migration. Allow the legacy tokenless double-read reload
      // during that rollout window, but stay strict once a numeric token has
      // been loaded for this quote.
      installedSnapshot = await fetchQuote(quoteId, quoteNumericVersionRequiredRef.current);
      if (installedSnapshot) {
        // The rejected key may represent a committed save whose response was
        // lost. Rotate it only after a complete authoritative reload succeeds —
        // and only when the reload that just succeeded is for the SAME quote that
        // produced the conflict. If the operator navigated away with the dialog
        // open, releasing here would retire the wrong scope's key and strand the
        // rejected one; leaving it retained is the safe direction, because a
        // retained key can still replay.
        //
        // An earlier revision retired it in that case, reasoning that a
        // payload-rejected key can only ever be rejected again. That is wrong, and it
        // was a duplicate-write hazard: the key rejects the CHANGED payload, but
        // replaying the ORIGINAL one returns the server's cached receipt. On a create
        // that receipt carries the id of a row that may already have committed, and it
        // is the only deterministic way to learn the create's outcome. Deleting it
        // lets a later retry mint a fresh key and insert the record a second time.
        //
        // So the cost of retaining is one unearned conflict dialog when the operator
        // returns to that quote, which then self-heals on its own reload. The cost of
        // retiring is a possible duplicate quote. Retaining is the safe direction.
        // Release ONLY for a reload of the same quote whose save_quote call produced
        // this dialog. A different quote's scope must keep its key, and so must
        // NON_SAVE_RECOVERY: ten of this page's eleven openers are lifecycle actions
        // with no rejected save key of their own, and releasing on their reload would
        // retire a save_quote receipt whose own reply was never validated.
        if (staleSaveConflictScopeRef.current === saveQuoteIntentScope) {
          resetSaveQuoteIdempotencyKey();
          staleSaveConflictScopeRef.current = null;
        }
        if (resetCreateVersionAfterReloadRef.current) {
          resetCreateVersionAttempt();
          resetCreateVersionAfterReloadRef.current = false;
        }
        if (resetRestoreVersionAfterReloadRef.current) {
          resetRestoreVersionAttempt();
          resetRestoreVersionAfterReloadRef.current = false;
        }
        if (resetConvertAfterReloadRef.current) {
          convertQuoteIdem.resetKey();
          resetConvertAfterReloadRef.current = false;
        }
        setIsDirty(false);
        setStaleSaveOpen(false);
      }
    } finally {
      let released = false;
      const releaseDirtySuppression = () => {
        if (released) return;
        released = true;
        suppressDirtyUntilReloadSettlesRef.current = false;
        if (installedSnapshot) setIsDirty(false);
      };
      const fallback = window.setTimeout(releaseDirtySuppression, 250);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        releaseDirtySuppression();
      }));
    }
    return installedSnapshot;
  }, [
    convertQuoteIdem,
    fetchQuote,
    quoteId,
    resetCreateVersionAttempt,
    resetRestoreVersionAttempt,
    resetSaveQuoteIdempotencyKey,
    // Required, not cosmetic: without it this callback compares the conflict's
    // recorded scope against a STALE one, which is the exact confusion the check
    // exists to prevent.
    saveQuoteIntentScope,
  ]);

  useEffect(() => {
    fetchReferenceData();
    // Fetch PDF templates (non-critical, inline to avoid TDZ issue with useCallback ordering)
    supabase.from('quote_pdf_templates').select('*').order('is_default', { ascending: false })
      .then(({ data }) => {
        if (data) {
          setPdfTemplates(data as QuotePdfTemplate[]);
          const defaultTemplate = (data as QuotePdfTemplate[]).find((t) => t.is_default);
          if (defaultTemplate) setSelectedTemplateId(defaultTemplate.id);
        }
      });
    // Fetch quote templates for new quotes
    if (!id) {
      supabase.from('quote_templates').select('*').eq('is_active', true).order('template_name')
        .then(({ data }) => { if (data) setQuoteTemplates(data as QuoteTemplate[]); });
    }
    if (isEditing && id) {
      // This effect also runs on a route change between two saved quotes, where
      // the previous quote's form is still mounted and filled in. Present the
      // skeleton until THIS id's snapshot installs, so the operator is never
      // shown quote A's numbers under quote B's address.
      setLoading(true);
      quoteNumberSeqRef.current += 1;
      newQuoteNumberRequestedRef.current = false;
      setQuoteNumberLoading(false);
      // A tier tick or "Use Tier N" belongs to one visit to a quote (Luna, #1605).
      if (keepTierChoiceForRef.current !== id) setTierChoice('');
      keepTierChoiceForRef.current = null;
      useTierUndoRef.current = new Map();
      fetchQuote(id);
    } else if (!newQuoteNumberRequestedRef.current) {
      newQuoteNumberRequestedRef.current = true;
      generateQuoteNumber().then(() => {
        // Allow a tick for state to settle before tracking changes
        setTimeout(() => { initialLoadDone.current = true; }, 0);
      }).catch(() => { /* Number-generation failures are reported inside generateQuoteNumber. */ });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fetchQuote, fetchReferenceData, isEditing]);

  const selectedCustomer = customerRow && customerRow.id === customerId ? customerRow : undefined;
  const assignedTier = selectedCustomer?.assigned_tier ?? null;
  const tierMismatch = assignedTier != null && tier !== assignedTier;
  const tierChosen = tierMismatch && tierChoice === tierChoiceKey(id, customerId, tier, assignedTier);

  // Saved sections name their field by id only; read those fields by id (no active filter: it is
  // the saved record) for their names. One that fails to load or no longer exists blocks saving
  // until the section's field is chosen again.
  const unresolvedFieldKey = [...new Set(sections
    .map((sec) => sec.field_id)
    .filter((fieldId): fieldId is string => !!fieldId && !fields[fieldId]))]
    .sort()
    .join(',');
  const unresolvedFieldIds = unresolvedFieldKey ? unresolvedFieldKey.split(',') : [];

  // Repricing lines before products and unit conversions load would convert every unit at a
  // factor of 1, so a tier change waits for them. With no lines there is nothing to reprice.
  const repriceBlocked = !referenceDataReady && sections.some((sec) => sec.items.length > 0);

  // A new quote's split follows the picked customer (Mason, 17 Nov), empty when the customer has none. A split typed
  // by hand, or a saved quote's, is only replaced when the user picks Use it.
  const applyCustomerSplit = (cust: QuoteCustomer) => {
    const theirs = customerSplit(cust.default_commission_split);
    if (isEditing || !sameSplit(commissionSplit, autoSplitRef.current)) {
      // Say why the split stayed when the customer has none to offer.
      if (!theirs) setSplitNote({ kind: 'kept', customer: cust.farm_name });
      else setSplitNote(sameSplit(theirs, commissionSplit) ? null : { kind: 'offer', customer: cust.farm_name, split: theirs });
      return;
    }
    // A customer never given a split starts the blank row; an empty split is "no commission" and is taken as is.
    setCommissionSplit(theirs ?? NEW_QUOTE_SPLIT);
    autoSplitRef.current = theirs ?? NEW_QUOTE_SPLIT;
    commissionSplitTouchedRef.current = true;
    fromNoteRef.current = theirs ? { kind: 'from', customer: cust.farm_name, split: theirs } : null;
    setSplitNote(fromNoteRef.current ?? { kind: 'none', customer: cust.farm_name });
  };
  const takeOfferedSplit = () => {
    if (splitNote?.kind !== 'offer') return;
    setCommissionSplit(splitNote.split);
    commissionSplitTouchedRef.current = true;
    autoSplitRef.current = splitNote.split;
    fromNoteRef.current = { kind: 'from', customer: splitNote.customer, split: splitNote.split };
    setSplitNote(fromNoteRef.current);
  };

  const handleCustomerChange = (cust: QuoteCustomer | null): boolean => {
    if (!cust) {
      setCustomerId('');
      // An offer belongs to the customer it names: with no customer there is nothing to take (Luna, 18 Nov).
      setSplitNote(null);
      // A new quote's split that only came from that customer goes with them, so the next one can't inherit it
      // (Sol MED, 19 Nov). A split changed by hand stays.
      if (!isEditing && sameSplit(commissionSplit, autoSplitRef.current)) {
        setCommissionSplit(NEW_QUOTE_SPLIT);
        autoSplitRef.current = NEW_QUOTE_SPLIT;
        fromNoteRef.current = null;
      }
      return true;
    }
    if (repriceBlocked) {
      toast('error', 'Products are still loading. Try again in a moment.');
      return false;
    }
    customerPickedSinceLoadRef.current = true;
    setCustomerId(cust.id);
    setCustomerRow(cust);
    setCustomerLoadError(null);
    setTier(cust.assigned_tier);
    applyCustomerSplit(cust);
    recalcAllForTier(cust.assigned_tier);
    // A section's field must belong to the quote's customer: clear any that does not. A saved
    // field still loading by id is kept; the unresolved-field check blocks saving until it loads.
    // A field-filled acre count is dropped with the field; acres typed by hand are kept, so the
    // user is told to check them (Luna, #1017).
    const clearedSections = sections.filter((sec) => sec.field_id && fields[sec.field_id] && fields[sec.field_id].customer_id !== cust.id);
    if (clearedSections.length > 0) {
      setSections((prev) => prev.map((sec) => (
        sec.field_id && fields[sec.field_id] && fields[sec.field_id].customer_id !== cust.id
          ? clearSectionField(sec)
          : sec
      )));
      toast('warning', `The previous customer's field was removed from ${clearedSections.map((sec) => sec.section_name || 'a section').join(', ')}. Check those lines' acres.`);
    }
    return true;
  };

  const getTierPrice = useCallback(
    (product: Product, tierNum: number): number => {
      // A stated $0 tier price stays $0 (as save_quote stores it); only a missing one falls back to tier 1
      return getQuoteTierPrice(product, tierNum);
    },
    []
  );

  // The server lock (20261027040000) as the page applies it: once the quote has been sent, a line
  // still naming its saved row (same product, as savedLineIdFor sends it) keeps the price the
  // database stored for that row, unless a "use today's price" choice is not yet saved. A draft
  // that was never sent follows the tier price. Reads a ref: call it from handlers and
  // recalcItem, never during render.
  const lockedPriceFor = useCallback((item: LocalItem, productId: string): number | null => {
    if (!priceLocked) return null;
    const saved = savedLineIdsRef.current.get(item._key);
    if (!saved || saved.productId !== productId) return null;
    if (item.use_todays_price && !saved.todayApplied) return null;
    return saved.price;
  }, [priceLocked]);

  // The price and cost a line is figured at: a manual price, else its locked sent price, else
  // today's tier price; and its quote-time cost, else today's cost.
  const lineBasisFor = useCallback((item: LocalItem, product: Product, tierPrice: number) => {
    return {
      pricePerUnit: item.price_override ?? lockedPriceFor(item, product.id) ?? tierPrice,
      // The recorded cost holds only while the line still names the saved row it was recorded for:
      // a replacement row (saved after a product switch) is stamped by the server at today's cost.
      cost: holdsQuotedCost(item, product.id, savedLineIdsRef.current.get(item._key))
        ? item.quoted_cost.cost
        : (product.current_cost || 0),
    };
  }, [lockedPriceFor]);

  // The tested calculator (quoteCalc, To-Do 1.7), figured at this page's price and cost for the line.
  const recalcItem = useCallback(
    (item: LocalItem, tierNum: number): LocalItem => {
      const product = item.product || products.find((p) => p.id === item.product_id);
      if (!product) return item;
      return recalcQuoteLine(item, product, tierNum, unitConversions, lineBasisFor(item, product, getTierPrice(product, tierNum)));
    },
    [products, getTierPrice, unitConversions, lineBasisFor]
  );

  // Clearing a section's field drops the acres that field filled in this session, and keeps acres
  // typed by hand. A line loaded from the database has no recorded source, so its acres are kept
  // even when they equal the field's: guessing could overwrite typed acres and bill them (Sol,
  // #1049). The callers warn the user to check those lines' acres.
  // The line keeps its unit price (a customer change has already re-priced every line for the new
  // tier), and nothing is converted: a rate line with no acres needs nothing (rate × no acres), and
  // a units line's totals do not use acres, only its per-acre figures do. So this needs neither the
  // product nor the unit conversions, which may still be loading.
  const clearSectionField = (sec: LocalSection): LocalSection => {
    const filledByField = (item: LocalItem) => item.acres != null && item.acres_source === 'field';
    return {
      ...sec,
      field_id: null,
      items: sec.items.map((item) => {
        if (!filledByField(item)) return item;
        const cleared: LocalItem = { ...item, acres: null, acres_source: undefined };
        return item.calc_mode === 'units_direct'
          ? { ...cleared, oz_per_acre: null, price_per_acre: null }
          : { ...cleared, total_units_needed: 0, total_price: 0, profit: 0, net_margin: 0 };
      }),
    };
  };
  const clearSectionFieldRef = useLatestRef(clearSectionField);
  // The saved field ids whose by-id read has finished (loaded, missing or failed). Until it has, the
  // acres a field filled in cannot be told apart, so the section's field cannot be cleared or
  // replaced (Codex and Luna, #1049). Unknown ids count as loading, even before the read starts.
  const fieldIdsSettledRef = useRef<Set<string>>(new Set());
  // Saved field ids whose read FAILED: their acres still cannot be told apart, and clearing the
  // field would also drop the refresh-before-saving warning, so they stay locked until a reload.
  // A field that no longer exists (read fine, row missing) can be replaced (Codex, #1049).
  const fieldIdsFailedRef = useRef<Set<string>>(new Set());

  // Load the saved sections' unresolved fields by id (see unresolvedFieldKey above).
  useEffect(() => {
    if (!unresolvedFieldKey) {
      setFieldLoadError(null);
      return;
    }
    let cancelled = false;
    const ids = unresolvedFieldKey.split(',');
    const settle = () => { ids.forEach((fieldId) => fieldIdsSettledRef.current.add(fieldId)); };
    const fail = () => { ids.forEach((fieldId) => fieldIdsFailedRef.current.add(fieldId)); };
    supabase
      .from('fields')
      .select(QUOTE_FIELD_SELECT)
      .in('id', ids)
      .then(({ data, error }) => {
        if (cancelled) return;
        settle();
        if (error) {
          fail();
          Sentry.captureException(error, { tags: { source: 'fetch', page: 'quote_builder', action: 'load_section_fields' } });
          setFieldLoadError("This quote's fields could not be loaded. Refresh the page before saving.");
          return;
        }
        const rows = (data || []) as unknown as FieldOption[];
        if (rows.length > 0) setFields((known) => ({ ...known, ...Object.fromEntries(rows.map((row) => [row.id, row])) }));
        // The customer may have changed while these were loading: a field that belongs to another
        // customer is then cleared, as a pick would have cleared it. A plain load never clears a
        // saved field (CodeRabbit, #1017): a field later moved to another customer stays as saved.
        // What counts is a pick since the open quote loaded, not the customer when the read started:
        // another quote sharing these field ids may be open by now, and opening it is not a pick; a
        // pick and a pick back to the saved customer still is (CodeRabbit and Luna, #1049).
        const currentCustomerId = customerIdRef.current;
        const customerChanged = customerPickedSinceLoadRef.current;
        const foreign = new Set(rows
          .filter((row) => customerChanged && currentCustomerId && row.customer_id !== currentCustomerId)
          .map((row) => row.id));
        if (foreign.size > 0) {
          setSections((prev) => prev.map((sec) => (sec.field_id && foreign.has(sec.field_id)
            ? clearSectionFieldRef.current(sec)
            : sec)));
          toast('warning', "The previous customer's field was removed from this quote. Check those lines' acres.");
        }
        if (rows.length < ids.length) {
          setFieldLoadError('A field on this quote no longer exists. Choose the section\'s field again before saving.');
        }
      }, (err: unknown) => {
        if (cancelled) return;
        settle();
        fail();
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', page: 'quote_builder', action: 'load_section_fields' } });
        setFieldLoadError("This quote's fields could not be loaded. Refresh the page before saving.");
      });
    return () => { cancelled = true; };
  }, [unresolvedFieldKey, customerIdRef, clearSectionFieldRef, toast]);

  // A tier change re-prices the tier-priced lines and keeps manual (negotiated) prices (pricing
  // plan, section 7 finding 3); on a sent quote the saved prices stay as well.
  const recalcAllForTier = (tierNum: number) => {
    setSections((prev) =>
      prev.map((sec) => ({
        ...sec,
        items: sec.items.map((item) => recalcItem(item, tierNum)),
      }))
    );
  };

  // `toAssigned` is "Use Tier N" from the tier note: on a sent quote it also moves each line without a
  // negotiated price to today's Tier N price (as "Use today" does), so the label never changes while the
  // lines keep another tier's locked price (Sol, KI-105). The tier menu itself keeps sent prices.
  const applyTier = (t: number, toAssigned = false) => {
    if (repriceBlocked) {
      toast('error', 'Products are still loading. Try again in a moment.');
      return;
    }
    setTier(t);
    const undo = useTierUndoRef.current;
    useTierUndoRef.current = new Map();
    if (!toAssigned || !priceLocked) {
      undo.forEach((before, key) => {
        const saved = savedLineIdsRef.current.get(key);
        if (saved) saved.todayApplied = before.applied;
      });
      setSections((prev) => prev.map((sec) => ({
        ...sec,
        items: sec.items.map((item) => {
          const before = undo.get(item._key);
          return recalcItem(before ? { ...item, use_todays_price: before.useToday } : item, t);
        }),
      })));
      return;
    }
    const repriced = (item: LocalItem) => !!item.product_id && item.price_override == null;
    // A new choice: send it again even where an earlier one was saved.
    const keys = new Set(sections.flatMap((sec) => sec.items.filter(repriced).map((item) => item._key)));
    // Pressing "Use Tier N" twice keeps the state from before the first press.
    useTierUndoRef.current = new Map(sections.flatMap((sec) => sec.items.filter((item) => keys.has(item._key)))
      .map((item) => [item._key, undo.get(item._key)
        ?? { useToday: !!item.use_todays_price, applied: savedLineIdsRef.current.get(item._key)?.todayApplied }]));
    savedLineIdsRef.current.forEach((saved, key) => { if (keys.has(key)) saved.todayApplied = false; });
    setSections((prev) => prev.map((sec) => ({
      ...sec,
      items: sec.items.map((item) => recalcItem(repriced(item) ? { ...item, use_todays_price: true } : item, t)),
    })));
  };

  // "Update to today's prices" for the whole quote (Mason, 2026-10-14): every line, manual prices
  // included, takes today's tier price. A price change means the quote must be sent again.
  const applyTodaysPricesToAllLines = () => {
    if (!referenceDataReady) {
      toast('error', 'Products are still loading. Try again in a moment.');
      return;
    }
    // A new choice: send it again even where an earlier one was saved.
    savedLineIdsRef.current.forEach((saved) => { saved.todayApplied = false; });
    useTierUndoRef.current = new Map();
    const toToday = (secs: LocalSection[]) => secs.map((sec) => ({
      ...sec,
      items: sec.items.map((item) => (item.product_id
        ? recalcItem({ ...item, price_override: null, use_todays_price: true }, tier)
        : item)),
    }));
    setSections(toToday);
    // The message only: the same repricing of the lines on screen (it keeps every line, in order),
    // so line i before pairs with line i after; totals by the page's own rule.
    const after = toToday(sections);
    const beforeLines = sections.flatMap((sec) => sec.items);
    const changedCount = after.flatMap((sec) => sec.items)
      .filter((item, i) => Math.round(item.price_per_unit * 100) !== Math.round(beforeLines[i].price_per_unit * 100))
      .length;
    const message = todaysPricesMessage({ changedCount, beforeTotal: totals.totalPrice, afterTotal: quoteTotals(after).totalPrice, tier });
    toast(changedCount > 0 ? 'success' : 'info', `${message.title}. ${message.body}`);
  };

  const handleCustomerChangeRef = useLatestRef(handleCustomerChange);

  // Auto-set customer from URL query param (e.g., /quotes/new?customer_id=xxx)
  // The link's customer is read by id with the old list's filter (active customers only). One
  // that fails to load or is not found is reported and left unselected, never priced at a default.
  useEffect(() => {
    if (id) return;
    const presetCustomerId = new URLSearchParams(location.search).get('customer_id');
    if (!presetCustomerId) return;
    let cancelled = false;
    supabase
      .from('customers')
      .select(QUOTE_CUSTOMER_SELECT)
      .eq('id', presetCustomerId)
      .eq('is_active', true)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) Sentry.captureException(error, { tags: { source: 'fetch', page: 'quote_builder', action: 'load_link_customer' } });
        // A customer the user already chose wins over the link, as before.
        if (customerIdRef.current) return;
        const cust = error ? null : (data as unknown as QuoteCustomer | null);
        if (!cust) {
          setCustomerLoadError('The customer from the link could not be loaded. Choose the customer before saving this quote.');
          return;
        }
        // Lines may already exist (the link read is separate from the product read), so the link
        // customer is applied exactly like a pick: reprice for its tier and clear foreign fields.
        if (!handleCustomerChangeRef.current(cust)) {
          setCustomerLoadError('The customer from the link was not applied while products were loading. Choose the customer before saving this quote.');
        }
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, location.search]);

  const updateItem = (
    sectionKey: string,
    itemKey: string,
    updates: Partial<LocalItem>
  ) => {
    // A line priced before unit conversions load would convert at a factor of 1.
    if (!referenceDataReady) {
      toast('error', 'Products are still loading. Try again in a moment.');
      return;
    }
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        return {
          ...sec,
          items: sec.items.map((item) => {
            if (item._key !== itemKey) return item;
            const merged = { ...item, ...updates };
            return recalcItem(merged, tier);
          }),
        };
      })
    );
  };

  const closeProductPicker = () => {
    if (productSearchOpen) {
      const { sectionKey, itemKey } = productSearchOpen;
      setSections((prev) =>
        prev.map((section) => {
          if (section._key !== sectionKey) return section;
          const targetItem = section.items.find((item) => item._key === itemKey);
          if (!targetItem || targetItem.product_id || hasUserEnteredItemValues(targetItem)) return section;

          return {
            ...section,
            items: section.items
              .filter((item) => item._key !== itemKey)
              .map((item, index) => ({ ...item, sort_order: index + 1 })),
          };
        })
      );
    }
    setProductSearchOpen(null);
    setProductQuery('');
    setKeepProductPickerOpen(false);
  };

  const assignProduct = (sectionKey: string, itemKey: string, product: Product) => {
    const pricePerUnit = getTierPrice(product, tier);
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        return {
          ...sec,
          items: sec.items.map((item) => {
            if (item._key !== itemKey) return item;
            const updated: LocalItem = {
              ...item,
              product_id: product.id,
              product,
              notes: preferredQuoteNotes(product),
              price_per_unit: pricePerUnit,
              price_override: null,
              current_cost: product.current_cost || 0,
              suggested_rate: product.suggested_rate || null,
              actual_rate: product.rate_per_acre ?? item.actual_rate ?? null,
              rate_unit: product.product_form === 'seed' || product.product_form === 'each'
                ? product.inventory_unit : product.rate_unit || null,
              unit_size: product.inventory_unit || product.unit_size || null,
              price_unit: product.inventory_unit || null,
            };
            return recalcItem(updated, tier);
          }),
        };
      })
    );
    if (keepProductPickerOpen) {
      const nextItemKey = addItem(sectionKey);
      setProductSearchOpen({ sectionKey, itemKey: nextItemKey });
      setProductQuery('');
      return;
    }
    closeProductPicker();
  };

  const addSection = () => {
    setSections((prev) => [...prev, makeEmptySection(prev.length + 1)]);
  };

  const removeSection = (key: string) => {
    setSections((prev) => {
      const filtered = prev.filter((s) => s._key !== key);
      return filtered.map((s, i) => ({ ...s, sort_order: i + 1 }));
    });
  };

  const updateSectionName = (key: string, name: string) => {
    setSections((prev) =>
      prev.map((s) => (s._key === key ? { ...s, section_name: name } : s))
    );
  };

  const updateSectionField = (key: string, field: keyof LocalSection, value: string | null) => {
    setSections((prev) =>
      prev.map((s) => (s._key === key ? { ...s, [field]: value } : s))
    );
  };

  // Returns false to refuse the pick (the picker keeps its label): a field's acres reprice the
  // section's lines, which must wait for products and unit conversions (CodeRabbit, #1017).
  const handleSectionFieldChange = (sectionKey: string, field: FieldOption | null): boolean => {
    if (field && repriceBlocked) {
      toast('error', 'Products are still loading. Try again in a moment.');
      return false;
    }
    const currentFieldId = sections.find((sec) => sec._key === sectionKey)?.field_id;
    if (currentFieldId && !fields[currentFieldId] && fieldIdsFailedRef.current.has(currentFieldId)) {
      toast('error', "This section's field could not be loaded. Refresh the page before changing it.");
      return false;
    }
    if (currentFieldId && !fields[currentFieldId] && !fieldIdsSettledRef.current.has(currentFieldId)) {
      toast('error', "This section's field is still loading. Try again in a moment.");
      return false;
    }
    if (field) setFields((known) => ({ ...known, [field.id]: field }));
    const effectiveAcres = field ? billableAcres(field.override_acres, field.measured_acres, field.total_acres) : null;
    // Saved lines keep acres whose source is unknown, so the user is told to check them (Luna, #1049).
    const currentSection = sections.find((sec) => sec._key === sectionKey);
    if (currentFieldId && currentFieldId !== field?.id && currentSection?.items.some((item) => !!item.acres && item.acres_source === undefined)) {
      toast('warning', "This section's saved lines keep their acres. Check them against the new field.");
    }

    setSections((prev) =>
      prev.map((section) => {
        if (section._key !== sectionKey) return section;
        // Clearing or replacing the field first drops the acres the old field filled in, as a
        // customer change does; typed acres stay (Codex, #1049).
        const cleared = section.field_id ? clearSectionField(section) : section;
        const withField = { ...cleared, field_id: field?.id ?? null };
        if (effectiveAcres == null) return withField;
        return {
          ...withField,
          items: withField.items.map((item) => {
            if ((item.acres ?? 0) !== 0) return item;
            return recalcItem({
              ...item,
              acres: effectiveAcres,
              acres_source: 'field',
              calc_mode: item.calc_mode === 'units_direct' ? 'units_direct' : 'rate_acres',
            }, tier);
          }),
        };
      })
    );
    return true;
  };

  function addItem(sectionKey: string): string {
    if (productsLoadFailed) {
      toast('error', 'Products failed to load. Refresh the page before adding products.');
      return '';
    }
    if (!referenceDataReady) {
      toast('error', 'Products are still loading. Try again in a moment.');
      return '';
    }
    const newItem = makeEmptyItem();
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        newItem.sort_order = sec.items.length + 1;
        return { ...sec, items: [...sec.items, newItem] };
      })
    );
    return newItem._key;
  }

  const removeItem = (sectionKey: string, itemKey: string) => {
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        const filtered = sec.items.filter((i) => i._key !== itemKey);
        return {
          ...sec,
          items: filtered.map((i, idx) => ({ ...i, sort_order: idx + 1 })),
        };
      })
    );
  };

  // Decision 4: a line with a product, a quantity or any other entered value asks first; an untouched line goes at once.
  const requestRemoveItem = (sectionKey: string, item: LocalItem) => {
    if (lineNeedsRemoveConfirm({ product_id: item.product_id || null, units_needed: item.total_units_needed, edited: hasUserEnteredItemValues(item) })) {
      setRemoveLineTarget({ sectionKey, itemKey: item._key });
    } else {
      removeItem(sectionKey, item._key);
    }
  };

  // "Edit note" from a line's menu: focus the note once the menu has closed and handed focus back.
  useEffect(() => {
    if (!editingLineNote) return;
    const frame = requestAnimationFrame(() => document.getElementById(`line-note-${editingLineNote}`)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editingLineNote]);

  const toggleSectionCollapse = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const totals = useMemo(() => quoteTotals(sections), [sections]);

  // KI-82: after a save, show an admin the cost the database recorded for each saved line. A new
  // line, or one switched to another product, is stamped at today's cost, which may have moved since
  // this page loaded. Display only: the saved prices, costs and totals are already right.
  const refreshSavedLineCosts = async (sessionChanged: () => boolean) => {
    const saved = savedLineIdsRef.current;
    let costs: Awaited<ReturnType<typeof fetchAdminCostFields>>;
    try {
      costs = await fetchAdminCostFields('quote_items', [...saved.values()].map((line) => line.id));
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', action: 'refresh_saved_line_costs' } });
      toast('warning', 'The quote was saved, but its cost figures could not be refreshed. Reload the quote to see them.');
      return;
    }
    // The operator moved to another quote while this read was in flight: leave that one alone.
    if (sessionChanged()) return;
    const recordedCost = (key: string) => {
      const line = saved.get(key);
      const cost = line ? costs.get(line.id)?.current_cost : undefined;
      return line && typeof cost === 'number' ? { line, cost } : null;
    };
    const differs = (item: LocalItem) => {
      const recorded = recordedCost(item._key);
      return recorded != null && !samePrice(recorded.cost, item.current_cost);
    };
    const stale = sections.flatMap((sec) => sec.items).filter(differs);
    if (stale.length === 0) return;
    // Such a line was stamped at today's cost, so the product's cost has moved since this page
    // loaded: re-read it too, or the line would show a stale "today" cost beside the recorded one.
    let productCosts: Awaited<ReturnType<typeof fetchAdminCostFields>> = new Map();
    try {
      productCosts = await fetchAdminCostFields('products', stale.map((item) => item.product_id));
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', action: 'refresh_saved_line_product_costs' } });
    }
    if (sessionChanged()) return;
    const todayCost = (productId: string) => {
      const cost = productCosts.get(productId)?.current_cost;
      return typeof cost === 'number' ? cost : null;
    };
    setProducts((prev) => prev.map((product) => {
      const cost = todayCost(product.id);
      return cost != null ? { ...product, current_cost: cost } : product;
    }));
    skipNextDirtyRef.current = true;
    setSections((prev) => prev.map((sec) => ({
      ...sec,
      items: sec.items.map((item) => {
        const recorded = recordedCost(item._key);
        if (!recorded || !differs(item)) return item;
        const cost = todayCost(item.product_id);
        // A line carries its own copy of the product, which shows its "today" cost.
        const product = item.product && cost != null ? { ...item.product, current_cost: cost } : item.product;
        return recalcItem({
          ...item,
          product,
          quoted_cost: { rowId: recorded.line.id, productId: recorded.line.productId, cost: recorded.cost },
        }, tier);
      }),
    })));
  };

  const saveQuote = async (newStatus?: QuoteStatus): Promise<string | null> => {
    // Fail closed when the loaded quote is not the quote the URL names. The
    // skeleton normally hides the form for the whole transition, but a load that
    // ERRORS clears `loading` while deliberately keeping the previous quote's
    // edits on screen — leaving a live Save button over the record the operator
    // navigated away from. `p_quote_id` below is this same `quoteId`, so
    // refusing before any RPC also means no idempotency key is ever minted
    // against the wrong quote.
    // A first load that failed leaves `quoteId` equal to the URL's id over an empty
    // form; saving that would replace the real quote's lines (To-Do 10.5).
    if (isEditing && (quoteId !== id || installedQuoteId !== id)) {
      toast('error', 'This quote has not finished loading. Refresh the page before saving so your changes go to the right quote.');
      return null;
    }
    if (draftEditLocked) {
      toast('error', DRAFT_EDIT_PERMISSION_MESSAGE);
      return null;
    }
    if (!customerId) {
      toast('error', customerLoadError ?? 'Please select a customer');
      return null;
    }
    // Never save a quote whose customer, section fields or product list did not load.
    if (!selectedCustomer) {
      toast('error', customerLoadError ?? 'The selected customer could not be loaded. Choose the customer again before saving.');
      return null;
    }
    if (unresolvedFieldIds.length > 0) {
      toast('error', fieldLoadError ?? 'The fields on this quote are still loading. Try again in a moment.');
      return null;
    }
    if (productsLoadFailed) {
      toast('error', 'Products failed to load. Refresh the page before saving this quote.');
      return null;
    }
    if (!referenceDataReady) {
      toast('error', 'Products are still loading. Try again in a moment.');
      return null;
    }
    if (!quoteNumber) {
      if (quoteNumberLoading) {
        toast('error', 'The quote number is still loading. Please wait a moment and try again.');
      } else {
        toast('error', `A quote number could not be confirmed. ${isEditing ? 'Please refresh and try again.' : 'Use Retry quote number to try again.'}`);
      }
      return null;
    }
    if (!profile) return null;

    // Validation: warn about empty sections
    const emptySections = sections.filter((sec) => sec.items.length === 0 || sec.items.every((i) => !i.product_id));
    if (emptySections.length > 0) {
      toast('error', `Section "${emptySections[0].section_name}" has no products. Add items or remove the section.`);
      return null;
    }

    // Validation: warn about items with zero quantity or price
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id) continue;
        // In units_direct mode, only total_units_needed is required
        if (item.calc_mode === 'units_direct') {
          if ((item.total_units_needed ?? 0) <= 0) {
            const prod = item.product || products.find((p) => p.id === item.product_id);
            toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has no units needed set.`);
            return null;
          }
          continue;
        }
        // rate_acres mode: both rate and acres are required
        if ((item.acres ?? 0) === 0 && (item.actual_rate ?? 0) === 0) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has no rate or acres set.`);
          return null;
        }
      }
    }

    // S2-1: Validate rate_unit is set for all items with a rate (rate_acres mode only)
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id || item.calc_mode === 'units_direct') continue;
        if ((item.actual_rate ?? 0) > 0 && !item.rate_unit) {
          toast('error', 'Please select a rate unit for all items with a rate');
          return null;
        }
      }
    }

    // S2-2: Validate rate and acres are both set when either is provided (rate_acres mode only)
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id || item.calc_mode === 'units_direct') continue;
        const hasRate = (item.actual_rate ?? 0) > 0;
        const hasAcres = (item.acres ?? 0) > 0;
        if (hasRate && !hasAcres) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has a rate but no acres. Both are required.`);
          return null;
        }
        if (hasAcres && !hasRate) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has acres but no rate. Both are required.`);
          return null;
        }
      }
    }

    const commissionSplitError = validateCommissionSplits(commissionSplit.splits);
    if (commissionSplitError) {
      toast('error', commissionSplitError);
      return null;
    }

    if (priceLocked) {
      const unconfirmed = sections.flatMap((sec) => sec.items).find((item) => {
        const raise = item.product_id ? priceRaise(savedLineIdsRef.current.get(item._key), item) : null;
        return raise && item.grower_confirmed_cents !== raise.toCents;
      });
      if (unconfirmed) {
        toast('error', 'A booked price went up. Tick "Grower agreed" under that price once the grower has agreed, then save.');
        return null;
      }
    }

    // KI-105: a tier other than the customer's assigned one needs "Use Tier N" or the tick. The assigned
    // tier is re-read here, since an admin may have changed it while this quote was open (Sol).
    // Screen-only BY DECISION (Mason, 2026-11-05, DECISION_LOG): anyone may quote at any tier, so
    // save_quote does not check the tick, and an admin change landing after this read is not caught.
    // The operator may open another quote during the read; this save then belongs to neither (Codex, #1605).
    const routeAtTierRead = routeQuoteIdRef.current;
    const loadAtTierRead = quoteLoadSerialRef.current;
    const currentAssignedTier = await readAssignedTier(customerId).catch((err: unknown) => {
      Sentry.captureException(err, { tags: { action: 'quote_tier_check' } });
      return null;
    });
    if (routeQuoteIdRef.current !== routeAtTierRead || quoteLoadSerialRef.current !== loadAtTierRead) return null;
    // The tier, customer or tick changed during the read: this save would send the old ones (Luna, #1605).
    if (tierInputsRef.current !== `${customerId}|${tier}|${tierChoice}`) {
      toast('error', 'The price tier or customer changed while saving. Save again.');
      return null;
    }
    if (currentAssignedTier === null) {
      toast('error', "The customer's price tier could not be checked. Try again in a moment.");
      return null;
    }
    if (currentAssignedTier !== selectedCustomer.assigned_tier) {
      // Only if the operator has not picked another customer while the read ran (Luna, #1605).
      setCustomerRow((row) => (row?.id === customerId ? { ...row, assigned_tier: currentAssignedTier } : row));
    }
    if (tier !== currentAssignedTier && tierChoice !== tierChoiceKey(id, customerId, tier, currentAssignedTier)) {
      toast('error', customerView
        ? 'Turn off Customer View and confirm the price tier before saving.'
        : `This customer is assigned Tier ${currentAssignedTier}. Use Tier ${currentAssignedTier}, or tick "Quote at Tier ${tier} anyway", before saving.`);
      return null;
    }

    // Minted before the payload so the frozen clock can be bound to it. `getKey`
    // returns the SAME key until it is retired, so this is a read, not a new attempt.
    const idemKey = getSaveQuoteIdempotencyKey();
    const previousAttempt = saveQuoteAttemptClockRef.current.get(saveQuoteIntentScope);
    let saveAttemptAtMs: number;
    if (previousAttempt && previousAttempt.key === idemKey) {
      saveAttemptAtMs = previousAttempt.atMs;
    } else {
      // eslint-disable-next-line react-hooks/purity -- runs inside the async saveQuote handler, not during render
      saveAttemptAtMs = Date.now();
      saveQuoteAttemptClockRef.current.set(saveQuoteIntentScope, { key: idemKey, atMs: saveAttemptAtMs });
    }

    const quotePayload = {
      quote_number: quoteNumber,
      customer_id: customerId,
      created_by: profile.id,
      tier,
      status: newStatus || status,
      ...buildCommissionSplitPatch({
        isUpdate: Boolean(quoteId && isEditing),
        touched: commissionSplitTouchedRef.current,
        key: 'commission_split',
        value: { splits: commissionSplit.splits },
        loaded: loadedCommissionSplitRef.current,
      }),
      ...buildRowVersionPatch(Boolean(quoteId && isEditing), quoteRowVersionRef.current),
      total_price: totals.totalPrice,
      total_cost: totals.totalCost,
      total_profit: totals.totalProfit,
      total_margin_pct: totals.totalMarginPct,
      chosen_expiry_date: chosenExpiryDate,
      // A draft shows the expiry a send would set; a send sets the real one.
      expires_at: chosenExpiryDate ?? seasonEnd,
      header_notes: headerNotes || null,
      footer_notes: footerNotes || null,
      is_planned: isPlanned,
      // The server keeps each section's id (and the jobs scheduled from it) only when told the screen sends them.
      section_ids_v1: true,
      ...(newStatus === 'sent' ? { sent_at: new Date(saveAttemptAtMs).toISOString() } : {}),
    };

    // A saved id is sent only while the line still holds the product it was saved
    // with. A line switched to another product is no longer named as its old line;
    // the server prices it like any unnamed line.
    const savedLineIdFor = (item: LocalItem): string | null => {
      const saved = savedLineIdsRef.current.get(item._key);
      return saved && saved.productId === item.product_id ? saved.id : null;
    };
    // A "use today's price" choice is sent until a save stores it, then the stored price holds.
    const wantsTodaysPrice = (item: LocalItem): boolean => item.use_todays_price === true
      && !savedLineIdsRef.current.get(item._key)?.todayApplied;
    const sentLineProducts = new Map<string, { productId: string; price: number; todayChosen: boolean }>();
    let repricedLines = 0;
    switchedLineKeysRef.current.clear();

    // Build sections JSON for the atomic RPC
    const sectionsPayload = sections.map((sec) => ({
      // A section id names a section of THIS saved quote; a new quote has none to name.
      id: quoteId ? sec.id ?? null : null,
      client_key: sec._key,
      section_name: sec.section_name,
      sort_order: sec.sort_order,
      section_notes: sec.section_notes || null,
      section_header_notes: sec.section_header_notes || null,
      needed_by_date: sec.needed_by_date || null,
      field_id: sec.field_id || null,
      items: sec.items
        .filter((item) => item.product_id)
        .map((item) => {
          sentLineProducts.set(item._key, {
            productId: item.product_id,
            price: item.price_per_unit,
            todayChosen: item.use_todays_price === true,
          });
          return {
            id: savedLineIdFor(item),
            client_key: item._key,
            product_id: item.product_id,
            sort_order: item.sort_order,
            notes: item.notes || null,
            price_per_unit: item.price_per_unit,
            price_override: item.price_override ?? null,
            // On a sent quote the server keeps the line's saved price unless this asks for today's.
            use_todays_price: wantsTodaysPrice(item),
            ...(item.grower_confirmed_cents === Math.round(item.price_per_unit * 100) ? { grower_confirmed: true } : {}),
            current_cost: item.current_cost,
            suggested_rate: item.suggested_rate,
            actual_rate: item.actual_rate,
            rate_unit: item.rate_unit,
            oz_per_acre: item.oz_per_acre,
            price_per_acre: item.price_per_acre,
            acres: item.acres,
            total_units_needed: item.total_units_needed,
            unit_size: item.unit_size,
            profit: item.profit,
            total_price: item.total_price,
            net_margin: item.net_margin,
            calc_mode: item.calc_mode || 'rate_acres',
            price_unit: item.price_unit || null,
          };
        }),
    }));

    try {
      // Which record, and which editing session of it, this request belongs to —
      // captured BEFORE it is sent. The entry check at the top of this function
      // cannot stand in for either: that ran before the request existed, and
      // everything installed below is written AFTER the reply lands.
      // `runWithBelowCostApproval` can also park this await on an operator
      // decision, which widens the window from a round trip to however long that
      // dialog stays open.
      //
      // Two operands, and each is load-bearing on its own.
      //
      // The route id is NOT unique over time. Leaving quote A for B and returning
      // to A restores it, so a route-only check would accept this reply into a
      // DIFFERENT editing session of the same quote: the callers would clear the
      // dirty flag over edits made after the return, which were never part of this
      // request, and report them saved. The load serial is what separates those
      // sessions, because returning to A re-runs `fetchQuote` and mints a new one.
      //
      // The serial alone is not enough either, for the reason documented at its
      // declaration: `fetchQuote` is also called from stale closures, and such a
      // call mints the NEWEST serial for a record the operator has already left.
      const routeAtSend = routeQuoteIdRef.current;
      const loadAtSend = quoteLoadSerialRef.current;
      const editingSessionChanged = () =>
        routeQuoteIdRef.current !== routeAtSend || quoteLoadSerialRef.current !== loadAtSend;
      const quoteNumberAtSend = quoteNumber;
      // The record this request actually targets — component state, not the route.
      // Null on a create, which has no record to reopen.
      const quoteIdAtSend = (quoteId && isEditing) ? quoteId : null;
      const { data, error } = await runWithBelowCostApproval((reason) => {
        // `reason` is non-null ONLY on the post-approval retry, so this never
        // touches the first send.
        //
        // The below-cost dialog parks that first send on an operator decision,
        // and it is a GLOBAL dialog that names the product and nothing else —
        // never which quote is being approved. If the operator moved to another
        // quote (or reloaded this one) while it was open, the approval they just
        // gave was given while looking at a different record, so it may not be
        // spent on this one. Refuse the retry rather than send it.
        //
        // Refusing HERE, before the request exists, is what makes this safe to
        // report plainly: the first attempt was rejected by PostgreSQL, which
        // rolls back, and the retry is never sent — so unlike the lost-reply
        // case below, the outcome is known and the message may say so.
        if (reason !== null && editingSessionChanged()) {
          toast('error', `Quote ${quoteNumberAtSend || 'you were editing'} was not saved. The below-cost approval finished after you left that quote, so it was not applied. Reopen the quote and save again.`);
          throw new BelowCostApprovalHandledError();
        }
        return supabase.rpc('save_quote', withBelowCostReason('save_quote', {
          p_quote_id: quoteIdAtSend as string,
          p_quote_payload: quotePayload as Json,
          p_sections: sectionsPayload,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
        }, reason));
      });

      // The editing session this save belonged to is gone. Quote A's failure is
      // not quote B's, so neither the stale-write recovery dialog nor a bare error
      // toast may land here. It is not swallowed either: the operator left
      // believing this saved. Name the quote, because what they are looking at is
      // a different one — or a freshly reloaded copy of the same one — and an
      // unqualified failure would read as belonging to it.
      //
      // Latching `quoteVersionRecoveryRequiredRef` here would be actively wrong on
      // the return-to-A path: it would strand a freshly loaded quote behind a
      // "reload before saving" gate it has already satisfied.
      //
      // Deliberately does NOT touch the idempotency key. The outcome here is
      // genuinely unknown, so the key must survive for the retry (F1) exactly as it
      // does on the in-route error paths below.
      //
      // And because it is unknown, the message must not claim a rollback. A reply
      // lost in transit AFTER PostgreSQL committed arrives through this same
      // `error` branch, so "your changes were not stored" would be a guess stated
      // as fact — and the operator is not even looking at this quote to check. Say
      // what is true (unconfirmed) and what to do about it. The retained key is
      // what makes the retry safe if it did commit.
      if (error && editingSessionChanged()) {
        // A payload conflict is not merely "unconfirmed" — the server has bound
        // this key to a DIFFERENT payload, so it can never accept the current one
        // again. The in-route branch below recovers through the reload dialog,
        // which rotates the key; that dialog cannot be shown here, because it
        // belongs to a quote the operator has left. Remember which quote is
        // waiting for that reload instead. Without this the key stays poisoned for
        // the life of the component and every later save — of any quote, since the
        // key is scoped by operation and user rather than by record — repeats the
        // same conflict.
        if (hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT) && quoteIdAtSend) {
          payloadConflictQuoteIdRef.current = quoteIdAtSend;
        }
        toast('error', `Quote ${quoteNumberAtSend || 'you were editing'} could not be confirmed as saved. Reopen it to check, and save again if your changes are missing.`);
        return null;
      }

      if (error) {
        if (hasRpcCode(error, RpcErrorCodes.QUOTE_STALE_WRITE)
          || hasRpcCode(error, RpcErrorCodes.COMMISSION_SPLIT_CONFLICT)
          || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
          quoteVersionRecoveryRequiredRef.current = true;
          // The ONE opener that leaves a rejected save_quote key outstanding, so the
          // ONLY one allowed to record a scope. Bind the dialog to the quote that
          // produced it, so the recovery cannot release a different quote's key if
          // the route changes while it is open.
          staleSaveConflictScopeRef.current = saveQuoteIntentScope;
          setStaleSaveOpen(true);
          return null;
        }
        if (hasRpcCode(error, RpcErrorCodes.QUOTE_PRICE_ONLY_FOR_OTHER_REPS)) {
          toast('error', 'This is another rep\'s booking, so you can change its prices only. Undo your other changes and save again, or ask the booking\'s rep or an admin to make them.');
          return null;
        }
        toast('error', error.message || 'Failed to save quote');
        return null;
      }

      const result = assertRpcResult<{ quote_id: string; commission_split?: CommissionSplit | null; row_version?: unknown; item_ids?: Record<string, unknown> | null; item_prices?: Record<string, unknown> | null; section_ids?: Record<string, unknown> | null }>(data, 'save_quote');
      // A save_quote that answers with an EMPTY payload and no error is ambiguous —
      // the row may already be committed — so retiring the key first would send the
      // user's retry under a fresh key the server cannot replay, writing the quote
      // twice. `assertRpcResult` does NOT catch that: it rejects only a MISSING
      // reply, and `{}` passes through it untouched. So the receipt has to be tested
      // here, before the key is retired. The old `|| quoteId` fallback made this
      // worse than a missed check — on an edit route it manufactured a plausible id
      // out of the URL, so an unverified save reported itself as a confirmed one.
      if (!hasReceiptId(result, 'quote_id')) {
        // The key is retained either way — this reply proves nothing about what
        // committed. Two things still have to be right about how we SAY that.
        //
        // Only speak to the operator if they are still in the session that sent this
        // save. Quote A's unqualified failure toast over quote B is the same
        // route-reply leak `editingSessionChanged()` exists to stop, and this early
        // return sits above it.
        //
        // And do not tell a CREATE to reload. The key lives in a `useRef` inside this
        // mounted component, so a reload discards the very receipt that was just
        // retained — the retry then mints a fresh key the server cannot replay and
        // inserts a second quote, which is the outcome this whole branch exists to
        // prevent. Retention only pays off if the operator stays on the form and
        // retries, replaying the original payload against the server's cached result.
        // An EXISTING quote is different: reloading it IS the authoritative
        // resolution, and the reload path releases the key deliberately.
        if (!editingSessionChanged()) {
          toast('error', saveQuoteIntentScope === 'new'
            ? 'The save came back without an ID, so it is unknown whether this quote was created. Press Save Draft again WITHOUT reloading. The retry replays the same request, so the server returns the original result instead of creating a second quote.'
            : 'The quote save came back without an ID, so its outcome is unknown. Reload the quote before making further changes.');
        }
        return null;
      }
      resetSaveQuoteIdempotencyKey();
      const savedQuoteId = result.quote_id;
      // The editing session that sent this save is gone, so nothing below belongs
      // to what is on screen now: the authoritative row-version token, the
      // commission baseline, `setQuoteId`, and — through the `null` return — the
      // callers' dirty-clear, success toast and navigation. Every caller gates
      // its post-save work on a non-null id, so returning `null` suppresses them.
      //
      // Placed AFTER the reply is verified and the key rotated, not before. This
      // save committed; retiring its key is correct and must happen wherever the
      // reply lands, or a later unrelated save would replay this committed
      // result. Rotating it in a second, earlier place would also re-introduce
      // the reset-before-verify ordering that `idempotency-reset-order.test.ts`
      // pins this file against.
      //
      // #618 wrote that "the reply is verified" against `assertRpcResult` alone,
      // which only rejects a MISSING reply. The receipt test above is what makes
      // the sentence true, and it is why the reset now sits below it rather than
      // above the assert as it did on main.
      if (editingSessionChanged()) return null;
      // save_quote rewrites every line; install the id each one now has so the
      // next save can name it. A line switched to another product while this save
      // was in flight gets none, so it is still sent unnamed. A reply without the
      // map (a receipt cached before it existed) keeps the ids already held, which
      // still name this quote's lines.
      if (result.item_ids && typeof result.item_ids === 'object' && !Array.isArray(result.item_ids)) {
        // Each saved row's stored price (item_prices, 20261027040000) becomes the price a sent
        // quote keeps. A reply without it (a receipt cached before it existed) keeps the price
        // the page sent, which the server computed the same way.
        const storedPrices = result.item_prices && typeof result.item_prices === 'object' && !Array.isArray(result.item_prices)
          ? result.item_prices
          : {};
        const savedLineIds: typeof savedLineIdsRef.current = new Map();
        for (const [clientKey, itemId] of Object.entries(result.item_ids)) {
          const sent = sentLineProducts.get(clientKey);
          if (!sent || typeof itemId !== 'string' || switchedLineKeysRef.current.has(clientKey)) continue;
          const storedPrice = storedPrices[clientKey];
          const price = typeof storedPrice === 'number' && Number.isFinite(storedPrice) ? storedPrice : sent.price;
          if (!samePrice(price, sent.price)) repricedLines += 1;
          savedLineIds.set(clientKey, {
            id: itemId,
            productId: sent.productId,
            price,
            todayApplied: sent.todayChosen,
          });
        }
        savedLineIdsRef.current = savedLineIds;
        setSavedLineIdByKey(new Map(savedLineIds));
        // The save is the new baseline: a later tier change no longer undoes "Use Tier N".
        useTierUndoRef.current = new Map();
        // The save recorded any changed price; read the record the database will check.
        await refreshPriceChanges(result.quote_id);
        if (editingSessionChanged()) return null;
      }
      // save_quote answers each section's id (section_ids, 20270125110000); the next save names them
      // so the section, and any job scheduled from it, is kept. A reply without the map (a receipt
      // cached before it existed) means the sections were re-created, so the old ids are dropped.
      const sectionIds = result.section_ids && typeof result.section_ids === 'object' && !Array.isArray(result.section_ids)
        ? result.section_ids
        : null;
      setSections((prev) => prev.map((sec) => {
        const id = sectionIds?.[sec._key];
        if (typeof id === 'string') return { ...sec, id };
        return sectionIds ? sec : { ...sec, id: undefined };
      }));
      // The save committed, but conversion and other chained actions must not
      // continue unless this tab can install the exact authoritative token.
      if (!installAuthoritativeQuoteRowVersion(result.row_version, 'saved')) {
        return null;
      }
      // Advance the baseline snapshot ONLY when THIS tab saved its own split edit;
      // an untouched save keeps the old baseline (still shown in the editor) so a
      // later edit fail-closed-conflicts if another tab changed the split.
      loadedCommissionSplitRef.current = nextLoadedSplitSnapshot({
        touched: commissionSplitTouchedRef.current,
        prevLoaded: loadedCommissionSplitRef.current,
        echoed: result.commission_split,
        currentValue: { splits: commissionSplit.splits },
      });
      commissionSplitTouchedRef.current = false;
      if (!quoteId || !isEditing) {
        setQuoteId(savedQuoteId);
        setInstalledQuoteId(savedQuoteId);
        setLoadedQuoteOwner({ quoteId: savedQuoteId, createdBy: profile.id });
      }
      // The database priced a line from the catalog as it is now, which changed since this page
      // loaded, so the lines and totals shown are not the saved ones. The save stands, but no
      // chained action (Mark Presented, email, convert) may continue from it: they get no id, and
      // later attempts wait for a reload, so the customer never gets a price they were not shown.
      if (repricedLines > 0) {
        const repricedCount = repricedLines === 1 ? 'one line was' : `${repricedLines} lines were`;
        // A create has no saved page to reload yet (the route is still /quotes/new), so the
        // reload dialog could never recover it and the next save would create a second quote.
        // Only Save Draft creates, and it opens the saved quote, which loads the stored prices.
        if (!quoteIdAtSend) {
          toast('warning', `The quote was saved, but ${repricedCount} priced at today's catalog price, which changed since this page loaded. Check the saved prices before sending it.`);
          return savedQuoteId;
        }
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('warning', `The quote was saved, but ${repricedCount} priced at today's catalog price, which changed since this page loaded. Reload the quote to see the saved prices before sending it.`);
        return null;
      }
      if (isAdmin && savedLineIdsRef.current.size > 0) {
        await refreshSavedLineCosts(editingSessionChanged);
      }
      return savedQuoteId;
    } catch (err: unknown) {
      if (isBelowCostApprovalHandledError(err)) return null;
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_quote' } });
      toast('error', err instanceof Error ? err.message : 'Failed to save quote');
      return null;
    }
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    // Always unlock the form (it is locked while saving), whatever the steps below throw.
    try {
      // A revised quote is a live booking and the server refuses revised -> draft: its edits save as revised.
      const result = await saveQuote(savesAsRevised ? 'revised' : 'draft');
      if (result) {
        setIsDirty(false);
        toast('success', savesAsRevised ? 'Changes saved. Send the quote again when it is ready.' : 'Quote saved as draft');
        trackBusinessEvent(isEditing ? 'quote_updated' : 'quote_created', {
          message: `Quote ${quoteNumber} ${isEditing ? 'updated' : 'created'}`,
          data: { quoteId: result, quoteNumber, customer: selectedCustomer?.farm_name ?? '' },
        });
        // Quote activity is logged in-transaction by save_quote() (migration line 290-299).
        // A frontend logActivity() here would double-log every save.
        // Planned program hold management
        if (isPlanned && profile) {
          // The quote is already saved, so a hold failure must not stop the steps below: a new
          // quote still has to open its saved page, or the next save would create a second quote.
          try {
            const holdIdemKey = plannedHoldsIdem.getKey();
            const { data: holdData, error: holdError } = await supabase.rpc('create_planned_holds', {
              p_quote_id: result,
              p_performed_by: profile.id,
              p_idempotency_key: holdIdemKey,
            });
            if (holdError) {
              // Refused as another request's or another person's retry key: nothing changed, so start the next try fresh.
              // Only 'intent' and 'actor' prove nothing committed under this key; a 'receipt' refusal keeps it.
              const bindingRejection = getIdempotencyBindingRejection(holdError);
              if (bindingRejection === 'intent' || bindingRejection === 'actor') plannedHoldsIdem.resetKey();
              Sentry.captureException(holdError, { tags: { source: 'mutation', action: 'create_planned_holds' } });
              toast('error', `Failed to create inventory holds: ${sanitizeError(holdError)}`);
            }
            else {
              assertRpcResult(holdData, 'create_planned_holds');
              plannedHoldsIdem.resetKey();
              toast('success', 'Inventory holds created for planned program');
              await loadActivePlannedHolds(result);
            }
          } catch (holdErr) {
            // An unconfirmed reply keeps the retry key, so the next save replays instead of holding twice.
            Sentry.captureException(holdErr, { tags: { source: 'mutation', action: 'create_planned_holds' } });
            toast('error', `The quote was saved, but its inventory holds could not be confirmed: ${sanitizeError(holdErr)}`);
          }
        } else if (!isPlanned && wasPlanned) {
          // save_quote synchronizes planned holds in the same database transaction;
          // no second client-side table mutation or not-yet-live RPC is needed.
          setWasPlanned(false);
          setActivePlannedHolds([]);
        }

        if (!isEditing) {
          skipUnsavedPromptRef.current = true;
          // The new quote's tier tick (KI-105) stays with it once it has an id.
          setTierChoice((choice) => (choice.startsWith('new:') ? `${result}${choice.slice(3)}` : choice));
      keepTierChoiceForRef.current = result;
          navigate(`/quotes/${result}`, { replace: true });
        }
      }
    } finally {
      setSaving(false);
    }
  };

  // Save as template handler
  const handleSaveTemplate = async () => {
    if (!quoteId || !profile) return;
    const tmplIdemKey = saveTemplateIdem.getKey();
    const { data, error } = await supabase.rpc('save_quote_template', {
      p_quote_id: quoteId,
      p_template_name: templateName.trim(),
      p_description: templateDescription.trim() || undefined,
      p_performed_by: profile.id,
      p_idempotency_key: tmplIdemKey,
    });
    if (error) { toast('error', 'Failed to save template'); return; }
    assertRpcResult(data, 'save_quote_template');
    saveTemplateIdem.resetKey();
    toast('success', `Template "${templateName}" saved`);
    setShowSaveTemplateModal(false);
    setTemplateName('');
    setTemplateDescription('');
  };

  // Create from template handler
  const handleSelectTemplate = async (templateId: string) => {
    if (!templateId || !customerId || !profile) return;
    // One key per customer until a quote is confirmed: this RPC checks only the key, so an edited retry after a
    // lost reply must replay the quote it already created rather than create a second one.
    const ftScope = customerId;
    const { data, error } = await supabase.rpc('create_quote_from_template', {
      p_template_id: templateId,
      p_customer_id: customerId,
      p_performed_by: profile.id,
      p_idempotency_key: fromTemplateIdem.getKeyFor(ftScope),
    });
    if (error) { toast('error', 'Failed to create from template'); return; }
    const result = assertRpcResult<{ quote_id: string; quote_number: string }>(data, 'create_quote_from_template');
    fromTemplateIdem.resetKeyFor(ftScope);
    navigate(`/quotes/${result.quote_id}`);
  };

  // Seasonal rollover handler
  const handleRollover = async () => {
    if (!quoteId || !profile) return;
    // One key per source quote until confirmed: this RPC checks only the key, so a changed season after a lost
    // reply must replay the rollover it already made rather than create a second quote.
    const rollScope = quoteId;
    const { data, error } = await supabase.rpc('rollover_quote_to_season', {
      p_quote_id: quoteId,
      p_new_season: rolloverSeason,
      p_performed_by: profile.id,
      p_idempotency_key: rolloverIdem.getKeyFor(rollScope),
    });
    if (error) {
      if (hasRpcCode(error, RpcErrorCodes.BOOKING_FULLY_DRAWN)) {
        toast('error', 'This booking is fully drawn. All quantities are already on orders. Nothing left to roll over.');
      } else {
        toast('error', 'Failed to roll over quote');
      }
      return;
    }
    const result = assertRpcResult<{ quote_id: string; quote_number: string; season: number; remainder_rollover: boolean }>(data, 'rollover_quote_to_season');
    rolloverIdem.resetKeyFor(rollScope);
    toast('success', `Rolled over to season ${result.season}: ${result.quote_number}`);
    navigate(`/quotes/${result.quote_id}`);
  };

  // Download and the preview print the same data (the email builds its own, with the stored expiry).
  const buildQuotePdfData = () => ({
    quote_number: quoteNumber,
    customer_name: selectedCustomer?.farm_name || 'Customer',
    customer_email: selectedCustomer?.email || undefined,
    customer_phone: selectedCustomer?.phone || undefined,
    customer_address: selectedCustomer?.billing_address || undefined,
    sales_rep_name: profile?.full_name || 'Sales Rep',
    created_at: new Date().toISOString(),
    expires_at: parseLocalDate(chosenExpiryDate ?? seasonEnd).toISOString(),
    tier,
    header_notes: headerNotes || undefined,
    footer_notes: footerNotes || undefined,
    sections: sections.map((sec) => ({
      section_name: sec.section_name,
      section_notes: sec.section_notes || undefined,
      section_header_notes: sec.section_header_notes || undefined,
      items: sec.items
        .filter((i) => i.product_id)
        .map((i) => ({
          product_name: i.product?.product_name || '',
          category: i.product?.category || '',
          notes: i.notes || undefined,
          suggested_rate: i.product?.suggested_rate || undefined,
          actual_rate: i.actual_rate || 0,
          rate_unit: i.rate_unit || '',
          acres: i.acres || 0,
          total_units_needed: i.total_units_needed || 0,
          inventory_unit: i.product?.inventory_unit || undefined,
          unit_size: i.product?.unit_size || undefined,
          price_per_unit: i.price_per_unit,
          price_unit: i.price_unit || undefined,
          price_per_acre: i.price_per_acre || undefined,
          total_price: i.total_price,
        })),
    })),
    totals: {
      totalPrice: totals.totalPrice,
      totalCost: totals.totalCost,
      totalProfit: totals.totalProfit,
      avgMargin: totals.totalMarginPct,
    },
  });

  // === GAP FIX #1: Download Quote as PDF ===
  const handleDownloadPdf = async () => {
    await runCriticalAction({
      action: async () => {
        await downloadQuotePdf(buildQuotePdfData(), customColumns || getTemplateColumns(selectedTemplateId));
      },
      toast,
      successMessage: 'PDF downloaded',
      sentryTag: 'download_quote_pdf',
    });
  };

  const handleReviseQuote = async () => {
    if (!quoteId) return;
    setRevising(true);
    const savedId = await saveQuote('revised');
    if (savedId) {
      setStatus('revised');
      setIsDirty(false);
      toast('success', 'Quote is now in revised mode. You can edit and re-send.');
    }
    setRevising(false);
  };

  // Decline / Cancel a quote (roadmap #5). The status-transition + hold-release
  // triggers do the DB work; we only flip the status under RLS. Guardrail: never
  // abandon an open booking's holds from here — a partially-drawn booking must be
  // closed via its orders first (parity with the Quotes list bulk-delete skip).
  const setTerminalStatus = async (newStatus: 'declined' | 'cancelled') => {
    if (!id) return;
    const verb = newStatus === 'declined' ? 'decline' : 'cancel';
    setStatusActionLoading(true);
    try {
      const [orderDrawsRes, jobDrawsRes] = await Promise.all([
        supabase
          .from('quote_product_draws')
          .select('quantity_drawn')
          .eq('quote_id', id)
          .gt('quantity_drawn', 0)
          .limit(1),
        // Layer 2: a job reservation also blocks a terminal transition — the
        // _enforce_quote_terminal_not_drawn trigger now counts job draws too.
        supabaseUntyped
          .from('job_product_draws')
          .select('quantity_drawn')
          .eq('quote_id', id)
          .gt('quantity_drawn', 0)
          .limit(1),
      ]);
      if (orderDrawsRes.error) throw orderDrawsRes.error;
      if (jobDrawsRes.error) throw jobDrawsRes.error;
      if ((orderDrawsRes.data && orderDrawsRes.data.length > 0) || (jobDrawsRes.data && jobDrawsRes.data.length > 0)) {
        toast('warning', `This booking has partial draw-downs or job reservations. Close it from its orders or jobs (draw or cancel the remaining balance) before you ${verb} the quote.`);
        return;
      }
      const previousRowVersion = quoteRowVersionRef.current;
      const result = await supabase
        .from('quotes')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('id, row_version');
      checkMutationResult(result, `${verb === 'decline' ? 'Decline' : 'Cancel'} quote`);
      setStatus(newStatus);
      const trustedRowVersion = applyDirectQuoteMutationRowVersion(
        previousRowVersion,
        (result.data as Array<{ row_version?: unknown }>)[0]?.row_version,
        'updated',
      );
      if (trustedRowVersion) setIsDirty(false);
      await logActivity({
        event: newStatus === 'declined' ? 'quote_declined' : 'quote_cancelled',
        description: `Quote ${quoteNumber} ${newStatus}`,
        performedBy: profile?.id || '',
        entityType: 'quote',
        entityId: id,
      });
      toast('success', `Quote ${newStatus}. Any inventory holds were released.`);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'mutation', action: `quote_${newStatus}` } });
      toast('error', sanitizeError(err));
    } finally {
      setStatusActionLoading(false);
      setConfirmDeclineOpen(false);
      setConfirmCancelOpen(false);
    }
  };

  // Close a booking we fulfilled by APPLYING product for the customer (job
  // applications), NOT by delivering it (convert/draw = chemical sale). Flips to
  // the distinct terminal status 'closed_by_application' via the actor-bound,
  // idempotent close_quote_as_applied RPC, which releases any un-applied leftover
  // back to free inventory and reports how much. Never double-bills — the
  // customer was already billed through each job's application invoice. (owner 2026-07-03)
  const handleCloseAsApplied = async () => {
    if (!id) return;
    setClosingApplied(true);
    try {
      const previousRowVersion = quoteRowVersionRef.current;
      // supabaseUntyped: close_quote_as_applied is a Layer 2 RPC not yet in the
      // generated types (matches get_dispatch_stock_status / job_product_draws usage).
      const { data, error } = await supabaseUntyped.rpc('close_quote_as_applied', {
        p_quote_id: id,
        p_performed_by: profile!.id,
        // Keyed per quote, so a retry here can never redeem another quote's close.
        p_idempotency_key: closeAppliedIdem.getKeyFor(id),
      });
      if (error) {
        // Refused as another request's or another person's retry key: nothing changed, so start the next try fresh.
        // Only 'intent' and 'actor' prove nothing committed under this key; a 'receipt' refusal keeps it.
        const bindingRejection = getIdempotencyBindingRejection(error);
        if (bindingRejection === 'intent' || bindingRejection === 'actor') closeAppliedIdem.resetKeyFor(id);
        throw error;
      }
      const result = assertRpcResult<{ status: string; released_units?: number; active_jobs_remaining?: number; warnings?: string[] }>(data, 'close_quote_as_applied');
      closeAppliedIdem.resetKeyFor(id);
      setStatus((result.status as QuoteStatus) || 'closed_by_application');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(id, previousRowVersion, previousRowVersion === null ? null : previousRowVersion + 1, 'closed as fulfilled by application');
      setIsDirty(false);
      const warnings = result.warnings || [];
      if (rowVersionConfirmed) {
        toast('success', warnings.length > 0
          ? `Booking closed as fulfilled by application. ${warnings.join('. ')}.`
          : 'Booking closed as fulfilled by application.');
      } else if (warnings.length > 0) {
        toast('warning', `Booking close warnings: ${warnings.join('. ')}.`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'mutation', action: 'close_quote_as_applied' } });
      if (hasRpcCode(err, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('warning', 'This booking is no longer open. Refresh the page to see its current status.');
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setClosingApplied(false);
      setConfirmCloseAppliedOpen(false);
    }
  };

  // Close a booking the customer ABANDONED (walked away, or drew only part and
  // never took the rest). Flips to the terminal status 'closed_short' via the
  // actor-bound, idempotent close_quote_as_short RPC, which releases the
  // un-fulfilled remainder back to free inventory. Never bills — any drawn
  // portion was already billed via its order; the remainder was never billed.
  // Refuses if scheduled/in-progress jobs still exist (BOOKING_HAS_ACTIVE_JOBS). (#1)
  const handleCloseAsShort = async () => {
    if (!id) return;
    setClosingShort(true);
    try {
      const previousRowVersion = quoteRowVersionRef.current;
      // supabaseUntyped: close_quote_as_short is a new RPC not yet in the
      // generated types (matches close_quote_as_applied usage).
      const { data, error } = await supabaseUntyped.rpc('close_quote_as_short', {
        p_quote_id: id,
        p_performed_by: profile!.id,
        // Keyed per quote, so a retry here can never redeem another quote's close.
        p_idempotency_key: closeShortIdem.getKeyFor(id),
      });
      if (error) {
        // Refused as another request's or another person's retry key: nothing changed, so start the next try fresh.
        // Only 'intent' and 'actor' prove nothing committed under this key; a 'receipt' refusal keeps it.
        const bindingRejection = getIdempotencyBindingRejection(error);
        if (bindingRejection === 'intent' || bindingRejection === 'actor') closeShortIdem.resetKeyFor(id);
        throw error;
      }
      const result = assertRpcResult<{ status: string; released_units?: number; warnings?: string[] }>(data, 'close_quote_as_short');
      closeShortIdem.resetKeyFor(id);
      setStatus((result.status as QuoteStatus) || 'closed_short');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(id, previousRowVersion, previousRowVersion === null ? null : previousRowVersion + 1, 'closed short');
      setIsDirty(false);
      const warnings = result.warnings || [];
      if (rowVersionConfirmed) {
        toast('success', warnings.length > 0
          ? `Booking closed short. ${warnings.join('. ')}.`
          : 'Booking closed short.');
      } else if (warnings.length > 0) {
        toast('warning', `Booking close warnings: ${warnings.join('. ')}.`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'mutation', action: 'close_quote_as_short' } });
      if (hasRpcCode(err, RpcErrorCodes.BOOKING_HAS_ACTIVE_JOBS)) {
        toast('warning', 'This booking still has scheduled or in-progress jobs. Cancel or complete them first, then close the booking as short.');
      } else if (hasRpcCode(err, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('warning', 'This booking is no longer open. Refresh the page to see its current status.');
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setClosingShort(false);
      setConfirmCloseShortOpen(false);
    }
  };

  // Un-accept / Reopen a quote back to 'sent' (roadmap #5, fixes W4). Routes
  // through the admin-only hardened revert_quote_status RPC, which blocks
  // reverting an accepted quote that already has an order.
  const handleRevertStatus = async () => {
    if (!id) return;
    const normalizedReason = revertReason.trim();
    if (!normalizedReason) {
      toast('warning', 'Please enter a reason for reopening this quote.');
      return;
    }
    if (normalizedReason.length > MAX_REVERT_REASON_LENGTH) {
      toast('warning', `Reopen reason must be ${MAX_REVERT_REASON_LENGTH} characters or fewer.`);
      return;
    }
    setReverting(true);
    try {
      const previousRowVersion = quoteRowVersionRef.current;
      const idemKey = revertStatusIdem.getKey();
      const { data, error } = await supabase.rpc('revert_quote_status', {
        p_quote_id: id,
        p_reason: normalizedReason,
        p_performed_by: profile?.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ success: boolean; old_status: string; new_status: string }>(data, 'revert_quote_status');
      revertStatusIdem.resetKey();
      setStatus((result.new_status as QuoteStatus) || 'sent');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(id, previousRowVersion, previousRowVersion === null ? null : previousRowVersion + 1, 'reopened');
      // Codex round-9 P2: a PLANNED quote's holds are now rebuilt ATOMICALLY inside
      // revert_quote_status (20260613290000) — same transaction as the status flip, so
      // there is no sent-without-holds window. The previous client-side recreate-after-
      // revert was non-atomic and is removed.
      setShowRevertModal(false);
      setRevertReason('');
      if (rowVersionConfirmed) {
        toast('success', `Quote reopened to ${result.new_status}.`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'revert_quote_status' } });
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) {
        toast('error', 'Only an admin can reopen a quote.');
      } else if (hasRpcCode(err, RpcErrorCodes.QUOTE_SEND_REQUIRED)) {
        toast('error', 'This quote was never sent to the customer, so it cannot be reopened. Create a new quote instead.');
      } else {
        // Server messages here are plain-English and actionable (e.g. "an order
        // has already been created from it") — surface them as-is.
        toast('error', sanitizeError(err));
      }
    } finally {
      setReverting(false);
    }
  };

  const handlePreviewQuote = async () => {
    await runCriticalAction({
      action: async () => {
        const columns = customColumns || getTemplateColumns(selectedTemplateId);
        const run = ++previewRunRef.current;
        const doc = await generateQuotePdf(buildQuotePdfData(), columns);
        if (run !== previewRunRef.current) return;
        previewColumnsKeyRef.current = columns.join(',');
        setPreviewPdfBlob(doc.output('blob'));
        setShowPreviewModal(true);
      },
      toast,
      sentryTag: 'preview_quote_pdf',
    });
  };

  // #3 Stage A: email the quote PDF to the grower via the send-email Edge Function.
  // The Edge Function records the send in email_log and dedupes on the idempotency key.
  const handleEmailToGrower = async () => {
    if (draftEditLocked) { toast('error', DRAFT_EDIT_PERMISSION_MESSAGE); return; }
    if (!quoteId) { toast('warning', 'Save the quote before emailing it.'); return; }
    if (quoteVersionRecoveryRequiredRef.current) {
      staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
      setStaleSaveOpen(true);
      toast('error', 'The email was NOT sent. Reload the quote, then email it again.');
      return;
    }
    // Codex P1: an existing quote with unsaved edits still has quoteId, so the
    // emailed PDF would render local edits the DB + version history don't have —
    // the grower would get an unreproducible quote. Block until saved.
    if (isDirty) { toast('warning', 'You have unsaved changes. Save the quote before emailing it.'); return; }
    if (!selectedCustomer?.email) { toast('error', 'This customer has no email address on file.'); return; }
    if (!profile) { toast('error', 'You must be signed in to send a quote.'); return; }
    setEmailingGrower(true);
    try {
      // #2 (Codex P1): FREEZE the current saved Quote before every email so the
      // grower's PDF always has a confirmed, reproducible version record. This
      // includes re-emailing an already-sent Quote after a tab remount; an
      // in-memory retry latch cannot protect that path. create_quote_version
      // snapshots the version and atomically sets status='sent'. Keep its
      // quote-scoped idempotency key until the whole send succeeds so a retry
      // after a downstream email failure replays the same snapshot.
      const previousRowVersion = quoteRowVersionRef.current;
      const freezeAttempt = getCreateVersionAttempt();
      const { data: freezeVer, error: freezeErr } = await createQuoteVersionWithRowVersion({
        p_quote_id: quoteId,
        p_performed_by: profile.id,
        p_method: 'emailed',
        p_idempotency_key: freezeAttempt.key,
        p_expected_row_version: freezeAttempt.expectedRowVersion,
      });
      if (freezeErr) throw freezeErr;
      const freezeResult = freezeVer;
      setStatus('sent');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(
        quoteId,
        previousRowVersion,
        previousRowVersion === null ? null : readRowVersion(freezeResult.row_version),
        'sent',
      );
      fetchVersions();
      // The snapshot/status change committed, but a missing or jumped token
      // means the local lines may no longer match that frozen snapshot. Never
      // send the locally rendered PDF until a reload proves what was frozen.
      if (!rowVersionConfirmed) {
        // A new key makes the next same-tab attempt create and confirm a fresh
        // snapshot of the reloaded authoritative Quote instead of replaying the
        // mismatched version. A remount naturally receives a new key too.
        resetCreateVersionAttempt();
        toast('error', 'The quote was frozen, but the email was NOT sent. Reload the quote, then email it again.');
        return;
      }
      // Each send starts a new validity window (20261027040000), so the PDF shows the expiry the
      // database just stored, not one worked out from the creation date. The version key is kept,
      // so a retry replays this send and reads the same date.
      const { data: sentQuote, error: expiryErr } = await supabase
        .from('quotes')
        .select('expires_at')
        .eq('id', quoteId)
        .maybeSingle();
      const sentExpiry = (sentQuote as { expires_at?: string | null } | null)?.expires_at;
      if (expiryErr || !sentExpiry) {
        if (expiryErr) Sentry.captureException(expiryErr, { tags: { source: 'read', action: 'email_quote_expiry' } });
        toast('error', 'The quote was frozen, but the email was NOT sent: its expiry date could not be read. Email it again.');
        return;
      }
      // Same rich (download) PDF the customer would receive.
      const pdfData = {
        quote_number: quoteNumber,
        customer_name: selectedCustomer?.farm_name || 'Customer',
        customer_email: selectedCustomer?.email || undefined,
        customer_phone: selectedCustomer?.phone || undefined,
        customer_address: selectedCustomer?.billing_address || undefined,
        sales_rep_name: profile?.full_name || 'Sales Rep',
        // Codex round-8 P2: the issue date stays the quote's persisted created_at, not today's.
        // The expiry is the one this send stored (a date-only value, read as a local date).
        created_at: quoteCreatedAt || new Date().toISOString(),
        expires_at: parseLocalDate(sentExpiry).toISOString(),
        tier,
        header_notes: headerNotes || undefined,
        footer_notes: footerNotes || undefined,
        sections: sections.map((sec) => ({
          section_name: sec.section_name,
          section_notes: sec.section_notes || undefined,
          section_header_notes: sec.section_header_notes || undefined,
          items: sec.items
            .filter((i) => i.product_id)
            .map((i) => ({
              product_name: i.product?.product_name || '',
              category: i.product?.category || '',
              notes: i.notes || undefined,
              suggested_rate: i.product?.suggested_rate || undefined,
              actual_rate: i.actual_rate || 0,
              rate_unit: i.rate_unit || '',
              acres: i.acres || 0,
              total_units_needed: i.total_units_needed || 0,
              inventory_unit: i.product?.inventory_unit || undefined,
              unit_size: i.product?.unit_size || undefined,
              price_per_unit: i.price_per_unit,
              price_unit: i.price_unit || undefined,
              price_per_acre: i.price_per_acre || undefined,
              total_price: i.total_price,
            })),
        })),
        totals: {
          totalPrice: totals.totalPrice,
          totalCost: totals.totalCost,
          totalProfit: totals.totalProfit,
          avgMargin: totals.totalMarginPct,
        },
      };
      const doc = await generateQuotePdf(pdfData, customColumns || getTemplateColumns(selectedTemplateId));
      const base64 = pdfToBase64(doc);
      const idemKey = emailQuoteIdem.getKey();
      const result = await sendEmail({
        to: selectedCustomer.email,
        subject: `Quote ${quoteNumber} from Crop Rx Solutions`,
        html: buildEmailHtml(
          `<p>Hi ${escapeHtml(selectedCustomer.contact_name || selectedCustomer.farm_name || 'there')},</p>` +
          `<p>Please find your quote <strong>${escapeHtml(quoteNumber)}</strong> attached as a PDF. ` +
          `Let us know if you have any questions or would like to proceed.</p>` +
          `<p>Thank you,<br/>Crop Rx Solutions</p>`
        ),
        email_type: 'quote',
        customer_id: customerId,
        resource_type: 'quote',
        resource_id: quoteId,
        idempotency_key: idemKey,
        attachments: [{ filename: `Quote-${quoteNumber}.pdf`, content: base64 }],
      });
      emailQuoteIdem.resetKey();
      // Codex round-8 P2: reset the version idem key only now that the whole send
      // succeeded — a failure before this point keeps the key so a retry replays the
      // same create_quote_version (returns 'duplicate') instead of snapshotting again.
      resetCreateVersionAttempt();
      if (result.deduplicated) {
        toast('info', 'This quote was already emailed (duplicate send skipped).');
      } else {
        toast('success', `Quote emailed to ${selectedCustomer.email}`);
      }
      await loadQuoteEmailStatus(quoteNumber);
      await logActivity({
        event: 'quote_emailed',
        description: `Quote ${quoteNumber} emailed to ${selectedCustomer.email}`,
        performedBy: profile?.id || '',
        entityType: 'quote',
        entityId: quoteId,
        customerId,
      });
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'email_quote_to_grower' } });
      if (hasRpcCode(err, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(err, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        resetCreateVersionAfterReloadRef.current = true;
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('error', 'The quote changed and the email was NOT sent. Reload the quote, then review and send it again.');
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setEmailingGrower(false);
    }
  };

  const handleMarkPresented = async (): Promise<boolean> => {
    if (!quoteId) {
      toast('error', 'Save the quote first, then mark it presented');
      return false;
    }
    if (!profile) return false;
    // Save current state first
    const savedId = await saveQuote(status === 'draft' ? 'draft' : status);
    if (!savedId) return false;
    try {
      // Create version snapshot via RPC
      const previousRowVersion = quoteRowVersionRef.current;
      const presentAttempt = getCreateVersionAttempt();
      const { data: versionData, error } = await createQuoteVersionWithRowVersion({
        p_quote_id: savedId,
        p_performed_by: profile.id,
        p_method: 'presented',
        p_idempotency_key: presentAttempt.key,
        p_expected_row_version: presentAttempt.expectedRowVersion,
      });
      if (error) throw error;
      const ver = versionData;
      // Version creation can update the quote. Keep the committed sent status
      // even if the follow-up version read fails; that condition clears the
      // local token and tells the operator to refresh instead of faking failure.
      setStatus('sent');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(
        savedId,
        previousRowVersion,
        previousRowVersion === null ? null : readRowVersion(ver.row_version),
        'presented',
      );
      resetCreateVersionAttempt();
      setShowPreviewModal(false);
      setPreviewPdfBlob(null);
      setIsDirty(false);
      fetchVersions();
      try {
        await logActivity({ event: 'quote_presented', description: `Quote ${quoteNumber} V${ver.version_number} marked as presented to ${selectedCustomer?.farm_name || 'customer'}`, performedBy: profile.id, entityType: 'quote', entityId: savedId, customerId });
      } catch (logError) {
        // The version/status change already committed. Do not strand Book as Order
        // because the secondary activity-feed write failed.
        Sentry.captureException(logError instanceof Error ? logError : new Error(String(logError)), { tags: { source: 'activity_log', action: 'quote_presented' } });
      }
      if (rowVersionConfirmed) {
        toast('success', `Quote marked as presented (version ${ver.version_number})`);
      }
      // Book-as-Order chains from this boolean. A committed sent transition
      // with an unconfirmed token must stop before customer/order conversion,
      // including during the supported pre-migration compatibility window.
      return rowVersionConfirmed;
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'create_quote_version' } });
      if (hasRpcCode(err, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(err, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        resetCreateVersionAfterReloadRef.current = true;
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('error', 'The quote changed before it could be marked presented. Reload and review it before trying again.');
      } else {
        toast('error', 'Failed to mark as presented');
      }
      return false;
    }
  };

  const AVAILABLE_PDF_COLUMNS = [
    { key: 'product', label: 'Product' },
    { key: 'category', label: 'Category' },
    { key: 'notes', label: 'Notes' },
    { key: 'sug_rate', label: 'Suggested rate' },
    { key: 'actual_rate', label: 'Rate' },
    { key: 'rate_unit', label: 'Unit' },
    { key: 'acres', label: 'Acres' },
    { key: 'qty', label: 'Quantity' },
    { key: 'unit_size', label: 'Container' },
    { key: 'price_unit', label: 'Price' },
    { key: 'price_per_acre', label: '$/Acre' },
    { key: 'total_price', label: 'Total' },
  ] as const;

  const getTemplateColumns = (templateId: string | null): string[] => {
    const t = pdfTemplates.find((p) => p.id === templateId);
    return t ? (t.columns as string[]) : ['product', 'actual_rate', 'acres', 'qty', 'price_unit', 'total_price'];
  };

  // The preview follows the chosen layout and columns (display only: nothing sends or saves this blob).
  const activePdfColumns = customColumns || getTemplateColumns(selectedTemplateId);
  const activePdfColumnsKey = activePdfColumns.join(',');
  const buildQuotePdfDataRef = useLatestRef(buildQuotePdfData);
  useEffect(() => {
    if (!showPreviewModal || previewColumnsKeyRef.current === activePdfColumnsKey) {
      setPreviewRebuild('idle');
      return;
    }
    let stale = false;
    const timer = setTimeout(async () => {
      setPreviewRebuild('updating');
      try {
        const doc = await generateQuotePdf(buildQuotePdfDataRef.current(), activePdfColumnsKey ? activePdfColumnsKey.split(',') : []);
        if (stale) return;
        previewColumnsKeyRef.current = activePdfColumnsKey;
        setPreviewPdfBlob(doc.output('blob'));
        setPreviewRebuild('idle');
      } catch (err) {
        // Keep the last good preview; Download and Email build their own PDF.
        if (!stale) setPreviewRebuild('failed');
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'read', action: 'preview_quote_pdf' } });
      }
    }, 200);
    return () => { stale = true; clearTimeout(timer); };
  }, [showPreviewModal, activePdfColumnsKey, buildQuotePdfDataRef]);

  const fetchVersions = useCallback(async () => {
    if (!quoteId) return;
    // Cost keys arrive NULL for non-admins (get_quote_versions).
    const { data, error } = await supabase.rpc('get_quote_versions', { p_quote_id: quoteId });
    if (error) {
      Sentry.captureException(error, { tags: { source: 'read', action: 'load_quote_versions' } });
      return;
    }
    const { versions, unreadable } = adaptQuoteVersionList(
      assertRpcResult<QuoteVersionRow[]>(data, 'get_quote_versions'),
    );
    setQuoteVersions(versions);
    setUnreadableQuoteVersions(unreadable);
    reportUntrustworthyQuoteVersions(unreadable, quoteId);
    void refreshPriceChanges(quoteId);
  }, [quoteId, refreshPriceChanges]);

  const handleRestoreVersion = async (versionId: string, versionNumber?: number) => {
    if (!quoteId || !profile) return;
    if (quoteVersionRecoveryRequiredRef.current) {
      staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
      setStaleSaveOpen(true);
      toast('error', 'Reload the quote before restoring a saved version.');
      return;
    }
    const restoreAttempt = getRestoreVersionAttempt(versionId);
    let restoreResponse;
    try {
      restoreResponse = await runWithBelowCostApproval((reason) => restoreQuoteVersionWithRowVersion(
        withBelowCostReason('restore_quote_version', {
          p_quote_id: quoteId,
          p_version_id: versionId,
          p_performed_by: profile.id,
          p_idempotency_key: restoreAttempt.key,
          p_expected_row_version: restoreAttempt.expectedRowVersion,
        }, reason),
      ));
    } catch (error: unknown) {
      if (isBelowCostApprovalHandledError(error)) return;
      throw error;
    }
    const { data, error } = restoreResponse;
    if (error) {
      // Restore-after-draw refusal (migration 20260816120000). A version
      // restore mints brand-new quote_items ids, so it cannot carry the
      // per-line billing provenance a draw stamps; dropping that provenance was
      // proven to overbill across a restore that changes the line partition, so
      // the server refuses instead. The message explains the alternative (edit
      // the quote directly), so surface it rather than the generic toast.
      if (hasRpcCode(error, RpcErrorCodes.QUOTE_RESTORE_BLOCKED_BY_DRAW)) {
        const errMsg = (error instanceof Error ? error.message : null)
          || (typeof error.message === 'string' ? error.message : null)
          || 'This booking has already been drawn down into an order, so an earlier version cannot be restored. Edit the quote directly instead.';
        toast('error', errMsg);
      // Drawn-version guard (Codex r2 MED): the server blocks restoring a
      // snapshot that would drop a drawn product or fall below its drawn
      // quantity. The server message names the product and quantities.
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_OVERDRAWN)) {
        const errMsg = (error instanceof Error ? error.message : null)
          || (typeof error.message === 'string' ? error.message : null)
          || 'This version books less than what has already been drawn down to orders.';
        toast('error', errMsg);
      } else if (hasRpcCode(error, RpcErrorCodes.QUOTE_VERSION_LEGACY_UNTRUSTED)) {
        toast('error', 'This older saved version cannot be restored because its cost snapshot was not created through the protected version workflow. Create a new version from the current quote instead.');
      } else if (hasRpcCode(error, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        resetRestoreVersionAfterReloadRef.current = true;
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('error', 'The quote changed before the version could be restored. Reload and review it before trying again.');
      } else if (String((error as { message?: unknown }).message ?? '').includes('jobs_quote_section_id_fkey')) {
        // A restore re-creates every section, so it cannot keep the section a spray job was scheduled from.
        toast('error', 'This booking has a spray job, so an earlier version cannot be restored. Edit the booking directly instead.');
      } else {
        toast('error', 'Failed to restore version');
      }
      return;
    }
    if (!data) return;
    resetRestoreVersionAttempt();
    toast('success', `Restored from version ${versionNumber ?? selectedVersion?.version_number ?? '?'}`);
    setConfirmRestore(null);
    setSelectedVersion(null);
    // The restore rewrote every line, so the held line ids no longer name them.
    // The reload re-seeds them from the database; forgetting them first means a
    // save that somehow ran before it could only be refused, never mismatch costs.
    savedLineIdsRef.current = new Map();
    // Reload quote data
    window.location.reload();
  };
  const [schedulingJobSectionKey, setSchedulingJobSectionKey] = useState<string | null>(null);

  const handleScheduleJob = async (sectionKey: string) => {
    const sec = sections.find((s) => s._key === sectionKey);
    if (!sec || !quoteId || !profile) return;
    // A section with no saved id (new, or re-created by a save whose reply had no section map) cannot be named.
    if (!sec.id) {
      toast('error', 'This section is not saved yet. Save the quote, then reload it if this message comes back, before scheduling a job from it.');
      return;
    }
    // U13 (#111): create_job_from_quote_section only inserts a job_fields row
    // `IF v_section.field_id IS NOT NULL` — a field-less section would silently
    // create a job with ZERO locations (no acres, nothing to apply chemicals on
    // or dispatch). Block here rather than let that job get created.
    if (!sec.field_id) {
      toast('error', 'Select a Field for this section before scheduling a job. A job needs a location to apply chemicals on and to dispatch.');
      return;
    }
    setSchedulingJobSectionKey(sectionKey);
    try {
      const idemKey = scheduleJobIdem.getKey();
      const { data, error } = await supabase.rpc('create_job_from_quote_section', {
        p_quote_id: quoteId,
        p_section_id: sec.id,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ job_id: string }>(data, 'create_job_from_quote_section');
      scheduleJobIdem.resetKey();
      // U13 (#111): record the badge immediately (no reload needed) + it also
      // hides the "Schedule Job" button for this section (the RPC would reject
      // a second job for the same section anyway — this makes that visible
      // BEFORE the user clicks, instead of via an error toast).
      setSectionJobs((prev) => ({ ...prev, [sec.id as string]: { id: result.job_id, job_number: '(new)', status: 'scheduled' } }));
      toast('success', `Job scheduled from "${sec.section_name}"`);
      navigate(`/jobs/${result.job_id}`);
      void (async () => {
        try {
          const { data: createdJob, error: createdJobError } = await supabase
            .from('jobs')
            .select('customer_id')
            .eq('id', result.job_id)
            .single();
          if (createdJobError) return;
          void warnIfOverCreditLimit(createdJob.customer_id, toast);
        } catch {
          // Non-blocking — the job is already committed and navigation has started.
        }
      })();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'schedule_job_from_quote' } });
      toast('error', hasRpcCode(err, RpcErrorCodes.QUOTE_RESEND_REQUIRED) ? resendRequiredMessage(err) : sanitizeError(err));
    }
    setSchedulingJobSectionKey(null);
  };


  // Partial booking draw-down: open the modal with the per-product balance
  const openDrawDownModal = async () => {
    if (!id) return false;
    // Draw-down bills at this quote's locked prices, so a current-price stale guard
    // would be misleading and block the first click without protecting the customer.
    if (isDirty) {
      toast('warning', 'Save the quote before drawing down the booking');
      return false;
    }
    let loaded = false;
    setPendingDraw(loadPendingRetry(drawPendingName, isDrawRequest));
    setDrawLoading(true);
    setShowDrawModal(true);
    try {
      const [itemsRes, drawsRes, jobDrawsRes] = await Promise.all([
        supabase.from('quote_items').select('product_id, total_units_needed').eq('quote_id', id),
        supabase.from('quote_product_draws').select('product_id, quantity_drawn').eq('quote_id', id),
        // Layer 2 (§6.5): a job reservation also consumes the drawable booking, so the
        // modal's remaining MUST subtract job draws too — otherwise it shows too much
        // and lets the user submit an amount draw_down_quote now rejects as
        // BOOKING_OVERDRAWN. Fold job draws into `drawn` (order + job) so drawn +
        // remaining = booked, matching the server-side balance.
        supabaseUntyped.from('job_product_draws').select('product_id, quantity_drawn').eq('quote_id', id),
      ]);
      if (itemsRes.error) throw itemsRes.error;
      if (drawsRes.error) throw drawsRes.error;
      if (jobDrawsRes.error) throw jobDrawsRes.error;
      const drawnByProduct = new Map<string, number>();
      (drawsRes.data || []).forEach((d) => drawnByProduct.set(d.product_id, Number(d.quantity_drawn) || 0));
      (jobDrawsRes.data || []).forEach((d: { product_id: string; quantity_drawn: number | null }) =>
        drawnByProduct.set(d.product_id, (drawnByProduct.get(d.product_id) || 0) + (Number(d.quantity_drawn) || 0)));
      const bookedByProduct = new Map<string, number>();
      (itemsRes.data || []).forEach((it) => {
        if (!it.product_id) return;
        bookedByProduct.set(it.product_id, (bookedByProduct.get(it.product_id) || 0) + (Number(it.total_units_needed) || 0));
      });
      const rows = Array.from(bookedByProduct.entries())
        .filter(([, booked]) => booked > 0)
        .map(([productId, bookedSum]): DrawRow => {
          // Quantities are whole hundredths (S02); summing them as floats shows 333.34000000000003
          // and makes a typed 16.66 look 3.55e-15 over, so settle each figure to hundredths.
          const booked = Math.round(bookedSum * 100) / 100;
          const drawn = Math.round((drawnByProduct.get(productId) || 0) * 100) / 100;
          const product = products.find((p) => p.id === productId);
          // The quote is saved (checked above), so the screen's lines are the booked lines.
          const bookedLines = sections.flatMap((sec) => sec.items)
            .filter((it) => it.product_id === productId && (it.total_units_needed ?? 0) > 0);
          return {
            product_id: productId,
            product_name: product?.product_name || 'Unknown product',
            unit: product?.inventory_unit ?? null,
            booked,
            drawn,
            remaining: Math.max(Math.round((booked - drawn) * 100) / 100, 0),
            qty: '',
            bookedPrice: bookedLines.length ? bookedLines[bookedLines.length - 1].price_per_unit : null,
            todayPrice: product ? getQuoteTierPrice(product, tier) : null,
            extraPrice: 'today',
          };
        })
        .sort((a, b) => a.product_name.localeCompare(b.product_name));
      setDrawRows(rows);
      loaded = true;
    } catch (error: unknown) {
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'draw_down_quote_load' } });
      toast('error', 'Failed to load the booking balance');
      setShowDrawModal(false);
    }
    setDrawLoading(false);
    return loaded;
  };

  // `resume` re-sends a draw whose reply never came, exactly as it was sent and with its key, so the
  // server returns the order it already made or makes it once (S14).
  const handleDrawDown = async (resume?: PendingRetry<DrawRequestLine[]>) => {
    if (!id) return;
    let drawPayload: DrawRequestLine[];
    if (resume) {
      drawPayload = resume.request;
    } else {
      const draws = drawRows
        .map((r) => ({ ...r, quantity: parseFloat(r.qty) || 0 }))
        .filter((d) => d.quantity > 0);
      if (draws.length === 0) {
        toast('warning', 'Enter a quantity for at least one product');
        return;
      }
      const closed = draws.find((d) => d.remaining <= 0);
      if (closed) {
        toast('error', `${closed.product_name}: nothing left on this booking`);
        return;
      }
      // S02: bookings are saved to 0.01, so a finer draw (333.333) would leave a remainder nothing can draw.
      // Read from the typed text, not the float: 333.33 * 100 is not exactly 33333.
      const tooFine = draws.find((d) => !/^\d*(\.\d{0,2})?$/.test(d.qty.trim()));
      if (tooFine) {
        toast('error', `${tooFine.product_name}: use at most 2 decimal places (for example 333.33), the same as the booking.`);
        return;
      }
      // The price choice is sent only for a quantity over what is left, so every other draw
      // is the same request as before.
      drawPayload = draws.map((d) => ({
        product_id: d.product_id,
        quantity: d.quantity,
        ...(d.quantity > d.remaining ? { extra_price: d.extraPrice } : {}),
      }));
    }
    setDrawing(true);
    // One key per quote: the server binds this key to its request, so edited details after a lost reply are refused with the committed result (a re-entered quantity can newly exceed what is left).
    // A key kept from before a reload wins over a fresh one, for the same reason (S14).
    const drawScope = id ?? '';
    const kept = loadPendingRetry(drawPendingName, isDrawRequest);
    // Past the receipt's lifetime (or with its receipt refused) the server can no longer tell whether
    // that draw was made, so any send could make a second order: refuse until the rep has checked.
    if (kept?.expired || (resume && kept?.key !== resume.key)) {
      setPendingDraw(kept);
      setDrawing(false);
      toast('error', 'An earlier Partial Order here did not finish, may have gone through, and can no longer be finished safely. Check the orders on this booking first.');
      return;
    }
    const drawKey = resume?.key ?? kept?.key ?? drawDownIdem.getKeyFor(drawScope);
    // An earlier send with this key got no reply, so it may have made the order.
    const earlierUnresolved = kept?.key === drawKey;
    // Without the note, a lost reply could not be finished after a reload, and a fresh key could draw twice.
    if (!savePendingRetry(drawPendingName, drawKey, drawPayload)) {
      setDrawing(false);
      toast('error', 'This browser could not keep a safety note for the Partial Order, so it was not sent. Allow this site to store data, or use another browser, then try again.');
      return;
    }
    try {
      const { data, error } = await runWithBelowCostApproval((reason) => supabaseUntyped.rpc('draw_down_quote', withBelowCostReason('draw_down_quote', {
        p_quote_id: id,
        p_draws: drawPayload,
        p_performed_by: profile!.id,
        p_idempotency_key: drawKey,
      }, reason)));
      if (error) throw error;
      const result = assertRpcResult<{ status: string; order_id?: string; order_number?: string; warnings?: string[]; fully_drawn?: boolean; extra_order_id?: string; extra_order_number?: string }>(data, 'draw_down_quote');
      drawDownIdem.resetKeyFor(drawScope);
      clearPendingRetry(drawPendingName);
      setPendingDraw(null);
      toast('success', `Order ${result.order_number || ''} created${result.fully_drawn ? '. Booking fully drawn' : '. Booking stays open'}`
        + (result.extra_order_number ? `. The amount over the booking is order ${result.extra_order_number}.` : ''));
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach((w) => toast('warning', `Inventory: ${w}`));
      }
      trackBusinessEvent('quote_drawn_down', {
        message: `Booking draw → Order ${result.order_number || ''}`,
        data: { orderId: result.order_id ?? '', orderNumber: result.order_number ?? '', quoteId: id },
      });
      sendOrderConfirmedEmail(result.order_id!);
      if (result.extra_order_id) sendOrderConfirmedEmail(result.extra_order_id);
      setIsDirty(false);
      setShowDrawModal(false);
      skipUnsavedPromptRef.current = true;
      navigate(`/orders/${result.order_id}`);
    } catch (error: unknown) {
      // The server answered and wrote nothing (or the rep cancelled the below-cost approval), so
      // there is no lost reply to finish: forget the kept draw. Only a missing reply keeps it, and
      // so does an earlier lost reply: some refusals (cutover, sign-in) come before the receipt
      // check, so refusing this send says nothing about whether that earlier one made the order.
      if ((isBelowCostApprovalHandledError(error) || isDefinitiveRpcRejection(error)) && !earlierUnresolved) {
        clearPendingRetry(drawPendingName);
        setPendingDraw(null);
      }
      if (isBelowCostApprovalHandledError(error)) {
        setDrawing(false);
        return;
      }

      // A retained draw key is bound to one actor and one exact set of draw
      // quantities. A binding refusal performed no work for THIS request and
      // makes that key permanently unusable, so retire it before the operator
      // tries again. If the receipt identifies an earlier committed order,
      // open that order rather than suggesting a second draw.
      const bindingRejection = getIdempotencyBindingRejection(error);
      if (bindingRejection) {
        drawDownIdem.resetKeyFor(drawScope);
        // A receipt under this key (refused as damaged, missing or for other quantities) means an
        // earlier send may have made an order: keep the note, flagged for a hand check, which blocks
        // new draws until the rep confirms. Another user's key says nothing was made here.
        if (bindingRejection === 'actor') {
          clearPendingRetry(drawPendingName);
        } else {
          markPendingRetryForCheck(drawPendingName);
        }
        // Flagged here too, so a failed storage write cannot bring back "Finish it" on this screen;
        // after a reload, finishing re-sends the same key and the server refuses it again.
        const keptAfter = loadPendingRetry(drawPendingName, isDrawRequest);
        setPendingDraw(keptAfter && bindingRejection !== 'actor' ? { ...keptAfter, expired: true } : keptAfter);
        const committedResult = bindingRejection === 'intent'
          ? getIdempotencyMismatchResult(error, 'draw_down_quote')
          : null;
        const committedOrderId = typeof committedResult?.order_id === 'string'
          && committedResult.order_id.length > 0
          ? committedResult.order_id
          : null;

        if (committedOrderId) {
          clearPendingRetry(drawPendingName);
          setPendingDraw(null);
          setShowDrawModal(false);
          toast('warning', 'An earlier attempt with this retry already created an order. No new draw was made. Opening that order now.');
          navigate(`/orders/${committedOrderId}`);
          setDrawing(false);
          return;
        }

        if (bindingRejection !== 'intent') {
          Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
            tags: { source: 'critical_action', action: `draw_down_quote_${bindingRejection}_mismatch` },
          });
        }
        if (bindingRejection === 'intent') {
          setShowDrawModal(false);
          toast('warning', 'That retry key was already used, but its prior outcome could not be opened. Nothing new was drawn. Check Orders for this booking before drawing again.');
          setDrawing(false);
          return;
        }
        const balanceReloaded = await openDrawDownModal();
        const recoveryStep = balanceReloaded
          ? 'The booking balance was reloaded; try again.'
          : 'The booking balance could not be reloaded; refresh the page and check Orders before drawing again.';
        toast('warning', bindingRejection === 'actor'
          ? `That retry belongs to another signed-in user, so nothing new was drawn. ${recoveryStep}`
          : `The database could not confirm this retry outcome, so nothing was drawn now. ${recoveryStep}`);
        setDrawing(false);
        return;
      }

      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'draw_down_quote' } });
      const errObj = error as Record<string, unknown> | null;
      const errMsg = (error instanceof Error ? error.message : null)
        || (errObj && typeof errObj.message === 'string' ? errObj.message : null)
        || (errObj && typeof errObj.details === 'string' ? errObj.details : null)
        || 'Failed to create order from booking';
      // Friendly mapping for the booking guards — UX parity with the convert
      // path (2026-06-10 error-prevention review §3 LOW). BOOKING_PARTIALLY_DRAWN
      // can't fire here: draw_down_quote IS the partial path.
      const authError = rpcAuthErrorMessage(error);
      if (authError) {
        toast('error', authError);
      } else if (hasRpcCode(error, RpcErrorCodes.INSUFFICIENT_ROLE)) {
        toast('error', 'Only active administrators and sales representatives can draw down bookings.');
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_OVERDRAWN)) {
        // The server message already names the product and remaining balance
        // (e.g. another draw landed from a second tab) — surface it as-is.
        toast('error', errMsg);
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('error', 'This booking is closed. Only sent or revised quotes can be drawn down.');
      } else if (hasRpcCode(error, RpcErrorCodes.EMPTY_DRAW)) {
        toast('warning', 'Enter a quantity for at least one product');
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_QUANTITY_INVALID)) {
        toast('error', errMsg);
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_PRODUCT_INVALID)) {
        toast('error', 'A draw line has an invalid product reference. Refresh the booking and try again.');
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_QUANTITY_PRECISION)) {
        toast('error', 'Use at most 2 decimal places for each quantity (for example 333.33), the same as the booking.');
      } else if (hasRpcCode(error, RpcErrorCodes.QUOTE_RESEND_REQUIRED)) {
        toast('error', resendRequiredMessage(error));
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKED_PRICE_REQUIRED)) {
        // Server message names the product and says what to fix — surface as-is.
        toast('error', errMsg);
      } else if (hasRpcCode(error, RpcErrorCodes.COST_BASIS_REQUIRED)) {
        // This one carries only a product id, which means nothing to an
        // operator — say what to do instead. Cost is NOT editable here: this
        // page only displays item.current_cost. The quote-time cost snapshot
        // is stamped from the product when a line is inserted and is immutable
        // after that, so the repair is to fix the product, then rebuild the
        // line (CodeRabbit PR #404 — a reload alone changes nothing).
        toast('error', 'A booked product on this quote has no cost recorded. Set the cost on the product under Products, then remove and re-add that line on this quote and save it, then draw down again.');
      } else if (hasRpcCode(error, RpcErrorCodes.DRAW_ALLOCATION_MISMATCH)) {
        // Safety net, not an operator mistake: the draw refused rather than
        // billing units it could not match to a booked price.
        toast('error', `${errMsg}. Nothing was drawn. Check the quote's booked quantities, then try again.`);
      } else {
        toast('error', errMsg);
      }
    }
    setDrawing(false);
  };

  const handleConvertToOrder = async () => {
    if (quoteVersionRecoveryRequiredRef.current) {
      staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
      setStaleSaveOpen(true);
      toast('error', 'The order was not created. Reload the quote, then try Convert to Order again.');
      return;
    }
    // Guardrail: check for stale quote before converting
    if (quoteCreatedAt) {
      const fresh = checkStaleQuote(quoteCreatedAt);
      if (!fresh && !staleWarning?.dismissed) return;
    }

    // Duplicate order warning: check for recent orders for same customer
    if (customerId) {
      // Lock the form (and the confirm dialog's Cancel) from the click: this handler converts
      // from the quote as it is now, so nothing may change or be cancelled during the lookup.
      setConverting(true);
      try {
        const sevenDaysAgo = localDatePlusDays(-7);
        const { data: recentOrders } = await supabase
          .from('orders')
          .select('order_number, order_date')
          .eq('customer_id', customerId)
          .is('deleted_at', null)
          .gte('order_date', sevenDaysAgo)
          .order('order_date', { ascending: false })
          .limit(1);
        if (recentOrders && recentOrders.length > 0) {
          const recent = recentOrders[0];
          // eslint-disable-next-line react-hooks/purity -- runs inside the async handleConvertToOrder handler after an await, not during render
          const daysAgo = Math.ceil((Date.now() - new Date(recent.order_date + 'T00:00:00').getTime()) / 86400000);
          setDuplicateOrderMsg(`This customer already has order ${recent.order_number} from ${daysAgo} day(s) ago. Convert this quote to another order?`);
          setDuplicateOrderConfirmOpen(true);
          setConverting(false);
          return;
        }
      } catch { /* ignore — don't block conversion if check fails */ }
    }

    await executeConvertToOrder();
  };

  const executeConvertToOrder = async () => {
    setDuplicateOrderConfirmOpen(false);
    setConverting(true);
    setConfirmConvertOpen(false);

    // A partially-drawn booking must never be whole-converted. The RPC refuses it
    // (BOOKING_PARTIALLY_DRAWN); checking the draw ledger up front routes staff
    // to the Partial Order flow with a clearer message. Fail closed: if the
    // ledger can't be read, don't start the conversion.
    if (id) {
      try {
        const [orderDrawRes, jobDrawRes] = await Promise.all([
          supabase
            .from('quote_product_draws')
            .select('quantity_drawn')
            .eq('quote_id', id)
            .gt('quantity_drawn', 0)
            .limit(1),
          // Layer 2: a job reservation also makes the booking partially drawn —
          // whole conversion would re-order units a job already holds/bills (§6.5).
          // job_product_draws isn't in the generated types yet → untyped client.
          supabaseUntyped
            .from('job_product_draws')
            .select('quantity_drawn')
            .eq('quote_id', id)
            .gt('quantity_drawn', 0)
            .limit(1),
        ]);
        if (orderDrawRes.error) throw orderDrawRes.error;
        if (jobDrawRes.error) throw jobDrawRes.error;
        if ((orderDrawRes.data && orderDrawRes.data.length > 0) || (jobDrawRes.data && jobDrawRes.data.length > 0)) {
          toast('warning', 'This booking has partial draw-downs or job reservations. Use "Partial Order" to draw the remaining balance instead of converting.');
          setConverting(false);
          return;
        }
      } catch (error: unknown) {
        Sentry.captureException(error, { tags: { source: 'critical_action', action: 'convert_quote_draw_check' } });
        toast('error', 'Could not verify the booking balance. Please try again');
        setConverting(false);
        return;
      }
    }

    // convert_quote_to_order marks a sent or revised quote accepted in the same
    // transaction that creates its order, so the quote is never accepted without
    // one (KNOWN_ISSUES KI-12). Saving it as accepted first did exactly that when
    // the order then failed. Only unsaved edits are saved first, under the quote's
    // own status. An accepted quote is the recovery path: the RPC creates the
    // missing order or returns the existing one, with no whole-quote save.
    const savedId = isDirty && (status === 'sent' || status === 'revised')
      ? await saveQuote(status)
      : quoteId;
    if (!savedId) {
      setConverting(false);
      return;
    }
    // The edits are saved even if the conversion below is refused.
    if (isDirty) setIsDirty(false);

    try {
      // Atomic RPC: order creation + items + inventory prebooking + commissions
      const idemKey = convertQuoteIdem.getKey();
      const expectedRowVersion = quoteRowVersionRef.current;
      const { data, error } = await runWithBelowCostApproval((reason) => convertQuoteToOrderWithRowVersion(
        withBelowCostReason('convert_quote_to_order', {
          p_quote_id: savedId,
          p_performed_by: profile!.id,
          p_idempotency_key: idemKey,
          p_expected_row_version: expectedRowVersion,
        }, reason),
      ));

      if (error) throw error;

      convertQuoteIdem.resetKey();
      const result = data;
      if (!result.order_id) {
        throw new Error('Order conversion completed without an order ID');
      }
      const alreadyConverted = result.status === 'already_converted';
      if (alreadyConverted) {
        toast('info', 'This booking was already converted. Opening the existing order.');
      } else {
        toast('success', `Order ${result.order_number || ''} created`);
      }
      const shouldFireConversionSideEffects = !alreadyConverted
        && !firedConvertSideEffects.current.has(result.order_id);
      if (shouldFireConversionSideEffects) {
        firedConvertSideEffects.current.add(result.order_id);
      }

      // Show any inventory warnings returned by the server.
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach((w) => toast('warning', `Inventory: ${w}`));
      }
      // A server replay for an accepted Quote returns the existing Order. Do
      // not emit creation telemetry, alerts, or customer email a second time.
      if (shouldFireConversionSideEffects) {
        trackBusinessEvent('quote_converted_to_order', {
          message: `Quote converted → Order ${result.order_number || ''}`,
          data: { orderId: result.order_id, orderNumber: result.order_number ?? '', quoteId: savedId },
        });
        notifyLargeOrder(result.order_id, result.order_number || '', selectedCustomer?.farm_name || 'customer', totals.totalPrice);
        // Wave A.2 / P1-7: send the customer "Order Confirmed" email at the
        // creation site (orders are born at status='confirmed' — there is no
        // transition to gate on). Fire-and-forget; helper swallows its own errors.
        sendOrderConfirmedEmail(result.order_id);

        // Phase 3.3: Credit limit check — warn (not block) if exceeded
        if (customerId) {
          try {
            const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', {
              p_customer_id: customerId,
            });
            const cl = assertRpcResult<{ exceeded?: boolean; farm_name?: string; outstanding_ar?: number; credit_limit?: number } | null>(creditCheck, 'check_customer_credit_limit');
            if (cl && cl.exceeded) {
              const fmtCl = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
              toast('warning', `Credit limit warning: ${selectedCustomer?.farm_name || 'Customer'} outstanding AR ${fmtCl(cl.outstanding_ar ?? 0)} exceeds limit ${fmtCl(cl.credit_limit ?? 0)}`);
              notifyCreditLimitExceeded(selectedCustomer?.farm_name || 'Customer', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, customerId);
            }
          } catch {
            // Non-blocking — credit limit check should not prevent navigation
          }
        }
      }

      // Bug #31 fix: Clear dirty state before navigate to prevent unsaved changes dialog
      setIsDirty(false);
      skipUnsavedPromptRef.current = true;
      navigate(`/orders/${result.order_id}`);
    } catch (error: unknown) {
      if (isBelowCostApprovalHandledError(error)) {
        setConverting(false);
        return;
      }
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'convert_quote_to_order' } });

      if (hasRpcCode(error, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        resetConvertAfterReloadRef.current = true;
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('warning', 'The quote changed while conversion was starting. Its order outcome was left untouched; reload and review before retrying.');
        setConverting(false);
        return;
      }

      // Lost-response-after-commit must not resurrect the booking (push-gate P1).
      let liveQuoteStatus: string | null = null;
      try {
        const { data: liveQuote, error: liveQuoteError } = await supabase
          .from('quotes')
          .select('status')
          .eq('id', savedId)
          .maybeSingle();
        if (liveQuoteError) throw liveQuoteError;
        liveQuoteStatus = liveQuote?.status ?? null;
      } catch {
        // A failed verification leaves the conversion outcome unknown. Do not
        // write a recovery status without proving the quote is still open.
      }

      if (liveQuoteStatus === 'accepted') {
        let createdOrderId: string | null = null;
        try {
          const { data: createdOrders, error: createdOrderError } = await supabase
            .from('orders')
            .select('id')
            .eq('quote_id', savedId)
            .is('deleted_at', null)
            .order('created_at', { ascending: false })
            .limit(1);
          if (createdOrderError) throw createdOrderError;
          createdOrderId = createdOrders?.[0]?.id ?? null;
        } catch (orderLookupError) {
          Sentry.captureException(orderLookupError, { tags: { source: 'read', action: 'find_order_after_committed_quote_convert' } });
        }

        if (createdOrderId) {
          toast('success', 'The order was created. Opening it');
          setIsDirty(false);
          skipUnsavedPromptRef.current = true;
          navigate(`/orders/${createdOrderId}`);
        } else {
          toast('warning', 'The quote was accepted, but its order could not be found. Check the Orders page');
          try {
            await fetchQuote(savedId);
          } catch (refetchError) {
            Sentry.captureException(refetchError, { tags: { source: 'read', action: 'refetch_quote_after_committed_convert' } });
          }
        }
        setConverting(false);
        return;
      }

      if (liveQuoteStatus === null) {
        // The conversion RPC is transactional, so a genuine failure leaves the
        // status unchanged. A recovery write is only safe after a successful
        // read proves the quote was not accepted.
        toast('warning', 'Could not verify the outcome. Check the Orders page before retrying. The quote status was left unchanged.');
        setConverting(false);
        return;
      }

      // Friendly mapping for the booking guards (server-side backstop for the
      // pre-check above — e.g. a draw landed from another tab mid-convert).
      if (hasRpcCode(error, RpcErrorCodes.BOOKING_PARTIALLY_DRAWN)) {
        toast('warning', 'This booking has partial draw-downs. Use "Partial Order" to draw the remaining balance instead of converting.');
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('error', 'This booking is closed. Only sent or revised quotes can be converted.');
      } else if (hasRpcCode(error, RpcErrorCodes.QUOTE_RESEND_REQUIRED)) {
        toast('error', resendRequiredMessage(error));
      } else if (hasRpcCode(error, RpcErrorCodes.COST_BASIS_REQUIRED)) {
        // A line saved before quote-time costs were recorded has none. Convert no longer
        // re-saves the quote, so it is no longer stamped on the way (KI-12).
        toast('error', 'A line on this quote has no recorded cost. Revise the quote and save it, then convert it again.');
      } else {
      // Bug #30 fix: Extract error message from Supabase RPC error objects
      const errObj = error as Record<string, unknown> | null;
      const errMsg = (error instanceof Error ? error.message : null)
        || (errObj && typeof errObj.message === 'string' ? errObj.message : null)
        || (errObj && typeof errObj.details === 'string' ? errObj.details : null)
        || (errObj && typeof errObj.hint === 'string' ? errObj.hint : null)
        || 'Failed to create order';
      toast('error', errMsg);
      }
      // The conversion rolled back as a whole, so the quote keeps its status.
    }
    setConverting(false);
  };

  // U16b: one-step booking for a clean, saved draft. Mark Presented uses the
  // existing create_quote_version path (snapshot + sent), then the existing
  // conversion handler applies all stale/duplicate/draw-down guards. If the
  // first step succeeds but conversion fails, the quote stays sent, so staff can
  // retry with the normal Convert button.
  const handleBookAsOrder = async () => {
    setBookingAsOrder(true);
    try {
      if (quoteVersionRecoveryRequiredRef.current) {
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('error', 'The order was not created. Reload the quote, then try Book as Order again.');
        return;
      }
      // A lost mark-sent response leaves the DB sent while the UI thinks draft —
      // resume the chain from the true state (push-gate P2).
      let alreadyMarkedSent = false;
      if (quoteId) {
        try {
          const { data: liveQuote, error: liveQuoteError } = await supabase
            .from('quotes')
            .select('status')
            .eq('id', quoteId)
            .maybeSingle();
          if (liveQuoteError) throw liveQuoteError;
          const liveStatus = liveQuote?.status;
          if (liveStatus === 'sent' || liveStatus === 'revised') {
            setStatus(liveStatus);
            alreadyMarkedSent = true;
          }
        } catch {
          // If the live-status check fails, continue with the existing flow.
        }
      }

      if (!alreadyMarkedSent) {
        const markedSent = await handleMarkPresented();
        if (!markedSent) {
          return;
        }
      }
      setConfirmBookAsOrderOpen(false);
      await handleConvertToOrder();
    } finally {
      setBookingAsOrder(false);
    }
  };

  // A parent's name or nickname finds its sizes (PAR-1).
  const { index: parentIndex } = useProductParents();
  const filteredProducts = useMemo(() => {
    if (!productQuery.trim()) return products;
    const q = productQuery.toLowerCase();
    return products.filter(
      (p) =>
        p.product_name.toLowerCase().includes(q) ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.category && p.category.toLowerCase().includes(q)) ||
        (p.vendor && p.vendor.toLowerCase().includes(q)) ||
        parentIndex.get(p.id)?.name.toLowerCase().includes(q) ||
        parentIndex.get(p.id)?.nickname?.toLowerCase().includes(q)
    );
  }, [parentIndex, products, productQuery]);

  const fmt = formatUSD; // quote math is dollar-denominated (not cents)

  const pct = (n: number) => `${n.toFixed(1)}%`; // net_margin is already stored as percentage

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-10 bg-gray-200 rounded w-48" />
        <div className="h-64 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded" />
      </div>
    );
  }

  // The quote this URL names never loaded. An empty form would read as a quote with no lines,
  // and another quote's form left on screen would offer Close / Revert, which act on this
  // URL's quote while showing the other one's status (compliance review, PR #1073).
  if (isEditing && id && installedQuoteId !== id && quoteLoadFailedId === id) {
    return (
      <LoadFailedState
        title="This quote could not be loaded"
        onRetry={() => { setLoading(true); fetchQuote(id); }}
      />
    );
  }

  // The quote cannot be edited while a save or order creation runs: an edit made then
  // would not be in what was written, and the page usually moves on afterwards.
  const formLocked = saving || converting || drawing;
  // A saved quote whose status can't be edited (sent, accepted, closed...) shows its values but takes no
  // edits: none could be saved, and each one only raised "Unsaved changes". Tabs, History, collapse,
  // the job link and Schedule job still work.
  const readOnly = isEditing && !canEdit;
  const editLocked = formLocked || readOnly;

  // Header actions (spec "Actions by state"). Each action keeps today's show and enable
  // conditions and handler; only where it sits changes.
  const primary = primaryAction({ isNew: !isEditing, status: currentStatus, unsentChange, canConvert, canDraw });
  const showSaveDraft = !isEditing || canEdit; // elsewhere Save draft was always disabled
  const showCreateOrder = isEditing && (canConvert || canDraw);
  const showRevise = isEditing && currentStatus === 'sent';
  const pdfVisible = primary === null && !isPhone; // closed quotes: Download PDF is the visible action
  const createOrderItems: ActionMenuItem[] = [
    {
      id: 'convert', label: 'Convert whole booking', icon: <ShoppingCart className="w-4 h-4" />,
      onAction: () => setConfirmConvertOpen(true),
      disabled: !canConvert || converting,
      disabledReason: canConvert ? undefined : 'Whole-booking conversion is available after the quote is sent or revised.',
    },
    {
      id: 'draw', label: 'Draw part of booking…', icon: <PackageOpen className="w-4 h-4" />,
      onAction: () => { openDrawDownModal(); },
      disabled: !canDraw || drawLoading,
      disabledReason: canDraw ? undefined : 'Partial draw-down is available after the quote is sent or revised.',
    },
  ];
  const moreItems: ActionMenuItem[] = [
    ...(!pdfVisible ? [{ id: 'pdf', label: 'Download PDF', icon: <Download className="w-4 h-4" />, onAction: handleDownloadPdf }] : []),
    {
      id: 'customer-view', label: customerView ? 'Leave customer view' : 'Customer view (hide costs)',
      icon: customerView ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />,
      onAction: () => setCustomerView(!customerView),
    },
    ...(quoteId ? [{ id: 'template', label: 'Save as template', icon: <Copy className="w-4 h-4" />, onAction: () => setShowSaveTemplateModal(true) }] : []),
    ...(quoteId ? [{ id: 'rollover', label: 'Roll over to next season', icon: <RotateCcw className="w-4 h-4" />, onAction: () => setShowRolloverModal(true) }] : []),
    ...(isEditing && !!quoteId && currentStatus === 'draft' && !draftEditLocked && !isDirty ? [{
      id: 'book', label: 'Book as order', icon: <ShoppingCart className="w-4 h-4" />,
      onAction: () => setConfirmBookAsOrderOpen(true), disabled: bookingAsOrder,
    }] : []),
    ...(canRevert ? [{
      id: 'revert', label: revertLabel, icon: <Undo2 className="w-4 h-4" />,
      onAction: () => { setRevertReason(''); setShowRevertModal(true); }, disabled: reverting,
    }] : []),
    // The phone top bar has no room for secondaries, so they join the menu there.
    ...(isPhone && showRevise ? [{ id: 'revise', label: revising ? 'Revising…' : 'Revise quote', icon: <Pencil className="w-4 h-4" />, onAction: handleReviseQuote, disabled: revising }] : []),
    ...(isPhone && showCreateOrder && primary !== 'createOrder' ? createOrderItems.map((item) => ({ ...item, group: 'Create order' })) : []),
    ...(canCloseApplied ? [{
      id: 'close-applied', label: 'Close as applied (we applied the product)', icon: <CheckCircle className="w-4 h-4" />, group: 'Close this booking',
      onAction: () => setConfirmCloseAppliedOpen(true), disabled: closingApplied,
    }] : []),
    ...(canCloseShort ? [{
      id: 'close-short', label: "Close short (grower won't take the rest)", icon: <PackageOpen className="w-4 h-4" />, group: 'Close this booking',
      onAction: () => setConfirmCloseShortOpen(true), disabled: closingShort,
    }] : []),
    ...(canDecline ? [{
      id: 'decline', label: 'Decline quote', icon: <XCircle className="w-4 h-4" />, danger: true,
      onAction: () => setConfirmDeclineOpen(true), disabled: statusActionLoading,
    }] : []),
    ...(canCancel ? [{
      id: 'cancel', label: 'Cancel quote', icon: <Ban className="w-4 h-4" />, danger: true,
      onAction: () => setConfirmCancelOpen(true), disabled: statusActionLoading,
    }] : []),
  ];
  const moreMenu = <ActionMenu label="More actions" items={moreItems} />;
  const createOrderMenu = (variant: 'primary' | 'secondary') => (
    <ActionMenu label="Create order" items={createOrderItems} trigger={{ text: 'Create order', variant, icon: <ShoppingCart className="w-4 h-4" /> }} />
  );
  const tall = 'h-11 md:h-10';
  const saveDraftButton = (className = '') => (
    <Button
      variant="secondary"
      icon={<Save className="w-4 h-4" />}
      onClick={handleSaveDraft}
      loading={saving}
      // Nothing to save until something changes: repeated clicks would only resend the same quote.
      disabled={(!canEdit && isEditing) || (!isEditing && quoteNumberLoading) || (!isDirty && !saving)}
      title={!isDirty && !saving ? 'No changes to save' : undefined}
      className={`${tall} ${className}`}
    >
      {saving ? 'Saving…' : savesAsRevised ? 'Save changes' : 'Save draft'}
    </Button>
  );
  const previewButton = (variant: 'primary' | 'secondary') => (
    <Button variant={variant} icon={<Eye className="w-4 h-4" />} onClick={handlePreviewQuote} className={tall}>
      Preview &amp; send
    </Button>
  );
  const greenAction = primary === 'preview' && canSend
    ? previewButton('primary')
    : primary === 'createOrder' && showCreateOrder
      ? createOrderMenu('primary')
      : null;
  const statusBadge = isEditing && (
    <Badge normalCase dot variant={quoteBadgeVariant(currentStatus)}>{quoteStatusLabel(currentStatus)}</Badge>
  );
  const plannedChip = isPlanned && <Badge normalCase variant="warning">Planned</Badge>;
  const unsavedNote = isDirty && (
    <span className="inline-flex items-center gap-1.5 text-sm text-amber-800">
      <Clock className="w-4 h-4" aria-hidden="true" />
      Unsaved changes
    </span>
  );
  // A new quote's number, held until its first save.
  const pendingNumber = !isEditing && quoteNumber && <span className="text-secondary tabular-nums">{quoteNumber}</span>;
  const retryNumber = !isEditing && !quoteNumber && !quoteNumberLoading && (
    <Button variant="secondary" size="sm" icon={<RotateCcw className="w-4 h-4" />} onClick={generateQuoteNumber} className={tall}>
      Retry quote number
    </Button>
  );
  const subline = [
    selectedCustomer?.farm_name,
    `Tier ${tier}`,
    `Expires ${parseLocalDate(chosenExpiryDate ?? seasonEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
  ].filter(Boolean).join(' · ');
  const title = isEditing ? (quoteNumber || 'Quote') : 'New quote';
  // Summary strip: the totals memo and the booking settlement, as the Totals and Settlement cards show them.
  const settlement = isEditing && canDraw && bookingSettlement?.found ? bookingSettlement : null;
  // Each tab shows exactly when its old card did.
  const tabAvailable: Record<string, boolean> = {
    products: true,
    balance: settlement !== null,
    last: staffSeesLastCharged && !!customerId && lastChargedLines.some((line) => !!line.productId),
    history: isEditing && savedVersionCount > 0,
  };
  // A tab that goes away while selected sends the page back to Products for good (not just for now).
  if (!tabAvailable[activeTab]) setActiveTab('products');
  const shownTab = tabAvailable[activeTab] ? activeTab : 'products';
  const settlementHasPrepay = (settlement?.prepay_remaining_cents ?? 0) > 0 || (settlement?.prepay_earmarked_cents ?? 0) > 0;
  const settlementEmpty = !settlementHasPrepay && (settlement?.lines?.length ?? 0) === 0;
  const productCount = sections.reduce((sum, sec) => sum + sec.items.length, 0);
  const bookedCents = settlement?.booked_cents ?? 0;
  const drawnPct = bookedCents > 0 ? Math.min(100, Math.max(0, Math.round(((settlement?.drawn_cents ?? 0) / bookedCents) * 100))) : 0;
  const summaryFigures: { label: string; value: ReactNode }[] = [{ label: 'Quote total', value: fmt(totals.totalPrice) }];
  if (!hideCost) {
    summaryFigures.push(
      { label: 'Total cost', value: fmt(totals.totalCost) },
      { label: 'Profit · margin', value: <>{fmt(totals.totalProfit)} <span className="text-[15px] font-medium text-secondary">· {totals.totalMarginPct.toFixed(1)}%</span></> },
    );
  }
  if (settlement) {
    summaryFigures.push(
      { label: 'Booked', value: formatCents(settlement.booked_cents ?? 0) },
      { label: 'Drawn', value: formatCents(settlement.drawn_cents ?? 0) },
      { label: 'Left to draw', value: formatCents(settlement.remaining_cents ?? 0) },
    );
  }
  const drawnBar = settlement && (
    <div role="progressbar" aria-label="Drawn of booked" aria-valuemin={0} aria-valuemax={100} aria-valuenow={drawnPct} className="h-1.5 rounded-full bg-cream-dark">
      <div className="h-1.5 rounded-full bg-crx-green" style={{ width: `${drawnPct}%` }} />
    </div>
  );
  // Desktop: one row of cells split by 1px rules. Phone: a stacked card.
  const summaryStrip = (
    <section aria-label="Summary" className={isPhone ? 'rounded-xl border border-gray-200 bg-white p-3.5' : 'overflow-hidden rounded-xl border border-gray-200 bg-gray-200'}>
      <dl className={isPhone ? 'flex flex-col gap-2' : 'flex flex-wrap gap-px'}>
        {summaryFigures.map((f, i) => (
          <div key={f.label} className={isPhone ? 'flex items-baseline justify-between gap-3' : 'flex flex-[1_1_10rem] flex-col gap-0.5 bg-white px-4 py-3.5'}>
            <dt className={`text-secondary ${isPhone && i > 0 ? 'text-sm' : 'text-[13px]'}`}>{f.label}</dt>
            {/* A dl item holds only dt/dd, so the desktop bar sits inside the dd. */}
            <dd className={`tabular-nums text-nav-dark ${isPhone && i > 0 ? 'text-sm font-medium' : 'text-[22px] font-semibold leading-tight'}`}>
              {f.value}
              {!isPhone && f.label === 'Left to draw' && <div className="mt-1.5">{drawnBar}</div>}
            </dd>
          </div>
        ))}
      </dl>
      {isPhone && drawnBar && <div className="mt-2.5">{drawnBar}</div>}
    </section>
  );
  const hasBottomBar = isPhone && (showSaveDraft || !!greenAction);
  // The shared component carries its own mb-4; the wrapper drops it inside the header.
  const thread = isEditing && threadOrders.length > 0 && (
    <div className="[&>div]:mb-0">
      <TransactionThread
        quoteId={quoteId || undefined}
        quoteNumber={quoteNumber || undefined}
        orders={threadOrders.map(o => ({ id: o.id, number: o.order_number }))}
        deliveries={threadOrders.flatMap(o => o.deliveries.map(d => ({ id: d.id, number: d.delivery_number })))}
        invoices={threadOrders.flatMap(o => o.invoices.map(i => ({ id: i.id, number: i.invoice_number })))}
        currentEntity="quote"
        currentEntityId={quoteId || undefined}
      />
    </div>
  );

  return (
    // Scroll margins keep a focused control clear of the sticky bars: TopBar + quote header above
    // (about 112 px on a phone, up to about 210 px on desktop), MobileBottomNav + bottom bar below (about 115 px).
    <div className="space-y-4 [&_:is(a,button,input,select,textarea,[role=spinbutton],[tabindex])]:scroll-mt-32 md:[&_:is(a,button,input,select,textarea,[role=spinbutton],[tabindex])]:scroll-mt-56 max-md:[&_:is(a,button,input,select,textarea,[role=spinbutton],[tabindex])]:scroll-mb-32">
      {isPhone ? (
        <>
          {/* top-14 = TopBar phone height (h-14); -mx-4 -mt-4 undo AppLayout main padding (p-4). */}
          <div data-testid="quote-header" className="sticky top-14 z-20 -mx-4 -mt-4 flex h-14 items-center gap-1 border-b border-gray-200 bg-white px-1">
            <Link to="/quotes" aria-label="Back to quotes" className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-nav-dark">
              <ArrowLeft className="w-5 h-5" aria-hidden="true" />
            </Link>
            <h1 className="min-w-0 flex-1 truncate font-heading text-[22px] font-semibold text-nav-dark">{title}</h1>
            {canSend && (
              <button type="button" aria-label="Preview and send" onClick={handlePreviewQuote} className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-nav-dark">
                <Eye className="w-5 h-5" aria-hidden="true" />
              </button>
            )}
            {moreMenu}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {pendingNumber}
              {statusBadge}
              {plannedChip}
              {unsavedNote}
              {retryNumber}
            </div>
            {selectedCustomer?.farm_name && <span className="text-base font-semibold text-nav-dark break-words">{selectedCustomer.farm_name}</span>}
          </div>
          {thread}
        </>
      ) : (
        // top-16 = TopBar height (md:h-16); -mx/-mt undo AppLayout main padding (p-4, lg:p-6). Not sticky on short landscape screens.
        <div data-testid="quote-header" className="[@media(min-height:600px)]:sticky top-16 z-20 -mx-4 -mt-4 lg:-mx-6 lg:-mt-6 flex flex-col gap-2.5 border-b border-gray-200 bg-cream/95 px-4 py-3.5 backdrop-blur lg:px-6">
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
            <Breadcrumbs items={[
              { label: 'Quotes', href: '/quotes' },
              { label: isEditing ? (quoteNumber || 'Quote') : 'New quote' },
            ]} />
            {thread}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-heading text-3xl font-semibold leading-tight text-nav-dark">{title}</h1>
                {pendingNumber}
                {retryNumber}
                {statusBadge}
                {plannedChip}
                {unsavedNote}
              </div>
              <p className="text-secondary">{subline}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {showRevise && (
                <Button variant="secondary" icon={<Pencil className="w-4 h-4" />} onClick={handleReviseQuote} loading={revising} className={tall}>
                  Revise quote
                </Button>
              )}
              {canSend && primary !== 'preview' && previewButton('secondary')}
              {showSaveDraft && saveDraftButton()}
              {showCreateOrder && primary !== 'createOrder' && createOrderMenu('secondary')}
              {pdfVisible && (
                <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={handleDownloadPdf} className={tall}>
                  Download PDF
                </Button>
              )}
              {greenAction}
              {moreMenu}
            </div>
          </div>
        </div>
      )}

      {summaryStrip}

      {/* Covers a stale warning left active when the convert-confirm modal closes; draw-down no longer raises it. */}
      {!confirmConvertOpen && (
        <GuardrailBanner warning={staleWarning} onDismiss={dismissStaleWarning} />
      )}

      {draftEditLocked && (
        <Notice tone="warn" icon={<Lock className="h-4.5 w-4.5" aria-hidden="true" />}>
          <span>{DRAFT_EDIT_PERMISSION_MESSAGE} You can still use available job actions.</span>
        </Notice>
      )}

      {isEditing && !canEdit && !draftEditLocked && currentStatus !== 'sent' && (
        <Notice tone="warn" icon={<Lock className="h-4.5 w-4.5" aria-hidden="true" />}>
          <span>This quote is in <strong>{quoteStatusLabel(currentStatus)}</strong> status and cannot be edited.</span>
        </Notice>
      )}

      {isEditing && currentStatus === 'sent' && !canEdit && (
        <Notice tone="info" icon={<Lock className="h-4.5 w-4.5" aria-hidden="true" />}>
          <span>This quote has been sent. Click <strong>Revise quote</strong> to make changes, then re-send.</span>
        </Notice>
      )}

      {isEditing && currentStatus === 'revised' && priceLocked && (lastSentVersion || unsentChange === 'unreadable') && (
        <Notice
          role="status"
          tone={unsentChange ? 'warn' : 'info'}
          icon={unsentChange ? <AlertTriangle className="h-4.5 w-4.5" aria-hidden="true" /> : <Lock className="h-4.5 w-4.5" aria-hidden="true" />}
          actions={<>
            <Button
              variant="secondary"
              size="sm"
              showChevron={false}
              onClick={applyTodaysPricesToAllLines}
              disabled={!canEdit || formLocked}
              className={tall}
            >
              Use today&apos;s prices
            </Button>
            {unsentChange && unsentChange !== 'unreadable' && lastSentVersion && (
              <Button
                variant="secondary"
                size="sm"
                showChevron={false}
                icon={<RotateCcw className="w-3.5 h-3.5" />}
                onClick={() => setConfirmRewindOpen(true)}
                disabled={formLocked}
                className={tall}
              >
                Rewind to version {lastSentVersion.version_number}
              </Button>
            )}
          </>}
        >
          <span>
            {unsentChange === 'unreadable' || !lastSentVersion
              ? 'The version last sent to the customer cannot be shown here.'
              : unsentChange === 'customer'
                ? `The customer changed after version ${lastSentVersion.version_number} was sent.`
                : unsentChange === 'prices'
                  ? `Prices or lines changed after version ${lastSentVersion.version_number} was sent.`
                  : `Prices stay as sent in version ${lastSentVersion.version_number} unless you change them.`}
          </span>
          <HelpTip
            text={unsentChange
              ? 'Send the revised quote to the customer before converting it, drawing from it or scheduling a job.'
              : 'A price you change applies without a re-send; a higher one needs the grower\u2019s OK. Quantity and note changes need no re-send.'}
          />
        </Notice>
      )}

      {customerView && (
        <Notice tone="brand" icon={<EyeOff className="h-4.5 w-4.5" aria-hidden="true" />}>
          <span className="font-medium">Customer view: cost, profit, and margin columns hidden</span>
        </Notice>
      )}

      {/* Booking settlement (roadmap #6c): open-booking position. Read-only. */}
      {isEditing && canDraw && bookingSettlementFailed && (
        <Card>
          <LoadFailedState
            title="The booking settlement could not be loaded"
            onRetry={() => setBookingSettlementAttempt((n) => n + 1)}
          />
        </Card>
      )}
      <fieldset disabled={editLocked} aria-busy={formLocked} className="space-y-4 min-w-0">
      {!id && quoteTemplates.length > 0 && (
        <div className="max-w-sm">
          <Dropdown
            label="Start from a template"
            value={null}
            placeholder="Blank quote"
            onChange={handleSelectTemplate}
            options={quoteTemplates.map((t) => ({ value: t.id, label: t.template_name }))}
            helper={!customerId && 'Select a customer first to use a template'}
            disabled={formLocked}
          />
        </div>
      )}

      {/* RAC controls ignore the disabled fieldset, so each one also takes editLocked. */}
      <Card>
        <h2 className="mb-4 font-heading text-xl font-semibold text-nav-dark">Details</h2>
        <div className="grid grid-cols-1 gap-x-5 gap-y-1 md:grid-cols-2 lg:grid-cols-4">
          <div className="md:col-span-2">
            <label htmlFor="quote-customer" className="block text-sm font-medium text-secondary mb-1">
              Customer
            </label>
            {/* Active customers only, as the old list loaded. */}
            <CustomerSearchPicker<QuoteCustomer>
              id="quote-customer"
              value={customerId}
              selectedLabel={selectedCustomer?.farm_name ?? ''}
              onSelect={handleCustomerChange}
              select={QUOTE_CUSTOMER_SELECT}
              placeholder="Select a customer..."
              ariaLabel="Customer"
              disabled={editLocked}
            />
            <div className="min-h-5">
              {customerLoadError && (
                <p role="alert" className="mt-1 text-sm text-red-600">{customerLoadError}</p>
              )}
              {fieldLoadError && unresolvedFieldIds.length > 0 && (
                <p role="alert" className="mt-1 text-sm text-red-600">{fieldLoadError}</p>
              )}
              {productsLoadFailed && (
                <p role="alert" className="mt-1 text-sm text-red-600">Products failed to load. Refresh the page before adding products or saving this quote.</p>
              )}
              {!customerView && selectedCustomer && <QuoteCreditStatus customerId={selectedCustomer.id} />}
            </div>
          </div>
          <div data-testid="tier-field">
            <Dropdown
              label="Pricing tier"
              value={String(tier)}
              onChange={(v) => applyTier(parseInt(v))}
              options={[1, 2, 3].map((n) => ({ value: String(n), label: `Tier ${n}` }))}
              disabled={editLocked}
            />
            {/* The note takes the Dropdown's empty helper line (mt-1 + min-h-5). */}
            {!customerView && tierMismatch && (
              <div className="-mt-5">
                <TierMismatchNote
                  tier={tier}
                  assignedTier={assignedTier}
                  acknowledged={tierChosen}
                  onUseAssigned={() => applyTier(assignedTier, true)}
                  onAcknowledge={(checked) => setTierChoice(checked ? tierChoiceKey(id, customerId, tier, assignedTier) : '')}
                />
              </div>
            )}
          </div>
          <div className="flex flex-col">
            <Dropdown
              label="Expires"
              value={chosenExpiryDate ? 'date' : 'season'}
              onChange={(v) => {
                const pickDate = v === 'date';
                pickedBeforeValidDaysRef.current = pickDate && !validDaysLoadedRef.current;
                setChosenExpiryDate(pickDate ? pickedExpiryStart(todayInBusinessTz(), quoteValidDays, seasonEnd) : null);
              }}
              options={[
                { value: 'season', label: `${parseLocalDate(seasonEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (season end)` },
                { value: 'date', label: 'Pick a date' },
              ]}
              helper={!chosenExpiryDate && status !== 'draft' && 'A change applies when the quote is sent again.'}
              disabled={editLocked}
            />
            {chosenExpiryDate && (
              <DatePicker
                aria-label="Expiry date"
                value={chosenExpiryDate}
                minValue={todayInBusinessTz()}
                onChange={(v) => { pickedBeforeValidDaysRef.current = false; setChosenExpiryDate(v || seasonEnd); }}
                helper={status !== 'draft' && 'A change applies when the quote is sent again.'}
                disabled={editLocked}
              />
            )}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-4 border-t border-cream-dark pt-4 lg:grid-cols-2">
          <div className="min-w-0">
            <CommissionSplitEditor
              label="Commission split"
              value={commissionSplit}
              onChange={(val) => {
                commissionSplitTouchedRef.current = true;
                // An offer stays until answered or typed in by hand; putting the customer's split back shows its
                // source again (Sol LOWs, 19 Nov).
                setSplitNote((note) => {
                  if (note?.kind === 'offer') return sameSplit(val, note.split) ? null : note;
                  return sameSplit(val, autoSplitRef.current) ? fromNoteRef.current : null;
                });
                setCommissionSplit(val);
              }}
              disabled={editLocked}
            />
            <QuoteSplitNote note={splitNote} onUse={takeOfferedSplit} onKeep={() => setSplitNote(null)} disabled={editLocked} />
          </div>
          <div className="flex items-start justify-between gap-3 self-start rounded-lg border border-gray-200 px-3.5 py-1">
            <Switch
              label="Planned program"
              description="Holds product for a grower who hasn't committed yet."
              isSelected={isPlanned}
              onChange={setIsPlanned}
              isDisabled={formLocked || (!canEdit && isEditing)}
            />
            <HelpTip text="Mark as Planned if the customer intends to buy but hasn't committed yet. This reserves inventory with a hold so it's not sold to someone else. Set the Needed By date so you can forecast when product will move." className="mt-2" />
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium text-secondary">
            Note at the top of the quote
            <textarea
              value={headerNotes}
              onChange={(e) => setHeaderNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm font-normal text-nav-dark border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="Notes visible at the top of the quote..."
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-secondary">
            Note at the bottom of the quote
            <textarea
              value={footerNotes}
              onChange={(e) => setFooterNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm font-normal text-nav-dark border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="Notes visible at the bottom of the quote (terms, disclaimers, etc.)..."
            />
          </label>
        </div>
      </Card>

      {rupWarnings.length > 0 && (
        <Notice tone="warn" icon={<AlertTriangle className="h-4.5 w-4.5" aria-hidden="true" />}>
          <div className="flex flex-col gap-1">
            {rupWarnings.map((w, i) => <p key={i}>{w}</p>)}
          </div>
        </Notice>
      )}

      </fieldset>

      <Tabs
        ariaLabel="Quote sections"
        activeKey={shownTab}
        onChange={setActiveTab}
        tabs={[
          {
            key: 'products',
            label: 'Products',
            count: productCount,
            content: (
              <fieldset disabled={formLocked} aria-busy={formLocked} className="min-w-0 space-y-4 pt-4">
      {sections.map((sec) => {
        const isCollapsed = collapsedSections.has(sec._key);
        const sectionTotal = sec.items.reduce((s, i) => s + i.total_price, 0);
        // A section with a note shows it; the link opens an empty one. Focus keeps it open while it is cleared.
        const sectionNoteOpen = !!sec.section_header_notes || openSectionNotes.has(sec._key);
        const openSectionNote = () => setOpenSectionNotes((prev) => (prev.has(sec._key) ? prev : new Set(prev).add(sec._key)));

        // Each line's controls are built once and laid out as a table row (1024 px and up) or a card.
        // What one line needs before its cells are drawn.
        const linePriceFacts = (item: LocalItem) => {
          const prod =
            item.product ||
            products.find((p) => p.id === item.product_id);
          const todayPrice = prod ? getTierPrice(prod, tier) : null;
          const todayPriceOffer = priceLocked && canEdit
            && todayPrice != null
            && Math.round(todayPrice * 100) !== Math.round(item.price_per_unit * 100)
            ? todayPrice
            : null;
          const sentState = priceLocked && lastSentVersion && item.product_id
            ? sentLineState(lastSentItems, priceLockLineOf(item))
            : null;
          const sentHint = sentState == null || !lastSentVersion
            ? null
            : sentState.kind === 'new'
              ? `New since version ${lastSentVersion.version_number}`
              : `Sent at ${formatCents(sentState.sentCents)}`;
          const costAlert = isAdmin ? undefined : costAlerts.get(savedLineIdByKey.get(item._key)?.id ?? '');
          const costHint = costAlert?.below_cost
            ? "Below today's cost: converting needs an admin's approval."
            : costAlert?.cost_rose ? 'Cost has gone up since this was quoted.' : null;
          return { prod, todayPrice, todayPriceOffer, sentState, sentHint, costAlert, costHint };
        };
        const lineProductFacts = (item: LocalItem, { prod }: ReturnType<typeof linePriceFacts>) => {
          const openPicker = () => {
            setProductSearchOpen({
              sectionKey: sec._key,
              itemKey: item._key,
            });
            setProductQuery('');
          };
          // Only from Last charged data already loaded for this customer and these products.
          const charged = lastCharged.state;
          const charge = staffSeesLastCharged && prod && charged.status === 'loaded' ? charged.byProduct.get(item.product_id) ?? null : undefined;
          const lastChargeText = charge === undefined
            ? null
            : charge
              ? `Last charged ${formatCents(charge.unit_price_cents)}${charge.unit_size ? ` / ${charge.unit_size}` : ''} on ${formatChargedOn(charge.charged_on)}`
              : 'First time for this customer';
          const defaultNote = prod ? preferredQuoteNotes(prod) : null;
          const noteEditing = editingLineNote === item._key;
          const allowNoUnit = prod?.product_form !== 'seed' && prod?.product_form !== 'each';
          const unitChoices = rateUnitOptionsForProduct(unitConversions, prod?.product_form, prod?.inventory_unit);
          // A unit the list no longer offers stays listed, so the line still shows what it holds.
          const unitOptions = (current: string | null, label: (unit: string) => string) => [
            ...(allowNoUnit ? [{ value: NO_UNIT, label: '--' }] : []),
            ...unitChoices.map((uc) => ({ value: uc.unit, label: label(uc.unit) })),
            ...(current && !unitChoices.some((uc) => uc.unit === current) ? [{ value: current, label: label(current) }] : []),
          ];
          return { openPicker, charged, charge, lastChargeText, defaultNote, noteEditing, allowNoUnit, unitChoices, unitOptions };
        };
        const lineFacts = (item: LocalItem) => {
          const priceFacts = linePriceFacts(item);
          return { ...priceFacts, ...lineProductFacts(item, priceFacts) };
        };
        type LineFacts = ReturnType<typeof lineFacts>;

        const lineProduct = (item: LocalItem, { prod, openPicker, lastChargeText, defaultNote, noteEditing }: LineFacts) => {
          return (
            <div className="min-w-0">
              {prod ? (
                <button
                  type="button"
                  onClick={openPicker}
                  className={`${LINK_HIT} text-left font-medium text-nav-dark break-words hover:text-crx-green`}
                >
                  {prod.product_name}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={openPicker}
                  className={`${LINK_HIT} inline-flex items-center gap-1 font-medium text-crx-green hover:underline`}
                >
                  <Search className="w-3.5 h-3.5" />
                  Select product
                </button>
              )}
              {prod && (
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary" data-product-id={prod.id}>
                  {productMetaLine(prod) && <span className="min-w-0 break-words">{productMetaLine(prod)}</span>}
                  <PolicyBadge policy={normalizeReturnPolicy(prod.return_policy)} />
                  {prod.is_full_tote_only && <FullToteOnlyBadge />}
                </div>
              )}
              {prod && !customerView && (
                <QuoteLineAdjuvants epaRegistration={prod.epa_registration} rows={lineRegistrations.rows} lookup={lineRegistrations.lookup} />
              )}
              {item.suggested_rate && <p className="mt-0.5 text-xs text-secondary">Suggested {item.suggested_rate}</p>}
              {lastChargeText && <p className="mt-0.5 text-xs text-secondary">{lastChargeText}</p>}
              {noteEditing ? (
                <div className="mt-1.5">
                  <textarea
                    id={`line-note-${item._key}`}
                    value={item.notes || ''}
                    onChange={(e) => updateItem(sec._key, item._key, { notes: e.target.value || null })}
                    rows={2}
                    placeholder="Product notes..."
                    aria-label="Line note"
                    className="w-full text-base md:text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-y"
                  />
                  <button
                    type="button"
                    onClick={() => setEditingLineNote(null)}
                    className={`${LINK_BOX} text-xs font-medium text-crx-green hover:underline`}
                  >
                    Done
                  </button>
                </div>
              ) : item.notes && (
                <p className="mt-1 text-xs italic text-secondary break-words">Note: {item.notes}</p>
              )}
              {defaultNote && item.notes !== defaultNote && (
                <button
                  type="button"
                  onClick={() => updateItem(sec._key, item._key, { notes: defaultNote })}
                  title="Reset to default"
                  className={`${LINK_BOX} text-xs font-medium text-crx-green hover:underline`}
                >
                  Reset note
                </button>
              )}
            </div>
          );
        };

        // The sent, cost and "Use today" hints under a line price.
        const linePriceHints = (item: LocalItem, { todayPriceOffer, sentHint, costAlert, costHint }: LineFacts) => (
          !customerView && (sentHint || todayPriceOffer != null || costHint) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1 text-xs">
              {sentHint && <span className="text-amber-700">{sentHint}</span>}
              {costHint && (
                <span className={costAlert?.below_cost ? 'text-red-600' : 'text-amber-700'}>{costHint}</span>
              )}
              {todayPriceOffer != null && (
                <>
                  {(sentHint || costHint) && <span aria-hidden="true" className="text-secondary">·</span>}
                  <button
                    type="button"
                    onClick={() => {
                      // A new choice: send it again even if an earlier one was saved.
                      const saved = savedLineIdsRef.current.get(item._key);
                      if (saved) saved.todayApplied = false;
                      useTierUndoRef.current.delete(item._key);
                      updateItem(sec._key, item._key, {
                        price_override: null,
                        use_todays_price: true,
                      });
                    }}
                    disabled={editLocked}
                    className={`${LINK_BOX} font-semibold text-crx-green hover:underline disabled:opacity-50`}
                  >
                    Use today {fmt(todayPriceOffer)}
                  </button>
                </>
              )}
            </div>
          )
        );
        const linePrice = (item: LocalItem, f: LineFacts) => {
          const { prod, allowNoUnit, unitOptions } = f;
          return (
            <>
              <div className={`${UNIT_BOX} ${
                item.price_override != null
                  ? 'border-amber-400 bg-amber-50'
                  : 'border-gray-300 bg-white'
              }`}>
                <input
                  type="number"
                  value={item.price_per_unit || ''}
                  onChange={(e) => {
                    const val = e.target.value ? parseFloat(e.target.value) : 0;
                    // A manual price is one that differs from what the line
                    // would otherwise take: its saved price on a sent quote,
                    // else today's tier price.
                    const basePrice = (prod ? lockedPriceFor(item, prod.id) : null)
                      ?? (prod ? getTierPrice(prod, tier) : 0);
                    const isOverride = Math.abs(val - basePrice) > 0.001;
                    updateItem(sec._key, item._key, {
                      price_override: isOverride ? val : null,
                      price_per_unit: val,
                    });
                  }}
                  aria-label="Price per unit"
                  // A stated $0 tier price shows as 0.00, not as a missing price.
                  placeholder={prod ? '0.00' : undefined}
                  className={UNIT_BOX_INPUT}
                  step="any"
                  min={0}
                />
                <Dropdown
                  aria-label="Price unit"
                  noHelperRow
                  value={item.price_unit || (allowNoUnit ? NO_UNIT : null)}
                  onChange={(v) =>
                    updateItem(sec._key, item._key, {
                      price_unit: v === NO_UNIT ? null : v || null,
                    })
                  }
                  options={unitOptions(item.price_unit, (unit) => `/ ${unit}`)}
                  placeholder="--"
                  disabled={editLocked}
                  className={UNIT_SELECT}
                />
              </div>
              {item.price_override != null && (
                <p className="mt-1 text-xs text-amber-800">
                  Set by hand ·{' '}
                  <button
                    type="button"
                    onClick={() =>
                      updateItem(sec._key, item._key, {
                        price_override: null,
                      })
                    }
                    title={priceLocked
                      ? 'Reset to the price saved on this line'
                      : `Reset to tier ${tier} price: ${fmt(prod ? getTierPrice(prod, tier) : 0)}`}
                    aria-label="Reset the manual price"
                    className={`${LINK_BOX} font-semibold text-crx-green hover:underline`}
                  >
                    Reset
                  </button>
                </p>
              )}
              {/* Early warning only: the database refuses this line on save (QUOTE_PRICE_MISSING) */}
              {!customerView && prod && item.price_override == null && !item.price_per_unit
                && isTierPriceMissing(prod, tier) && (
                <p role="status" className="mt-1 flex items-center gap-1 text-xs text-amber-800">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  No tier {tier} price. Type one.
                </p>
              )}
              {!customerView && priceLocked && (() => {
                const raise = priceRaise(savedLineIdByKey.get(item._key), item);
                return raise && (
                  <label className="mt-1 flex items-start gap-1.5 text-xs text-amber-800">
                    <input
                      type="checkbox"
                      checked={item.grower_confirmed_cents === raise.toCents}
                      disabled={editLocked}
                      onChange={(e) => updateItem(sec._key, item._key, {
                        grower_confirmed_cents: e.target.checked ? raise.toCents : undefined,
                      })}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-crx-green"
                    />
                    Grower agreed to {formatCents(raise.toCents)} (was {formatCents(raise.fromCents)})
                  </label>
                );
              })()}
              {linePriceHints(item, f)}
            </>
          );
        };

        const linePerAcre = (item: LocalItem) => `${item.price_per_acre != null ? fmt(item.price_per_acre) : '–'} / acre`;
        const lineParts = (item: LocalItem, n: number) => {
          const f = lineFacts(item);
          const { prod, openPicker, allowNoUnit, unitOptions } = f;
          const product = lineProduct(item, f);
          const rate = (
            <>
              <div className={`${UNIT_BOX} border-gray-300 bg-white`}>
                <input
                  type="number"
                  value={item.actual_rate ?? ''}
                  onChange={(e) =>
                    updateItem(sec._key, item._key, {
                      actual_rate: e.target.value
                        ? parseFloat(e.target.value)
                        : null,
                      calc_mode: 'rate_acres',
                    })
                  }
                  aria-label="Actual rate"
                  className={UNIT_BOX_INPUT}
                  step="any"
                  min={0}
                />
                <Dropdown
                  aria-label="Rate unit"
                  noHelperRow
                  value={item.rate_unit || (allowNoUnit ? NO_UNIT : null)}
                  onChange={(v) =>
                    updateItem(sec._key, item._key, {
                      rate_unit: v === NO_UNIT ? null : v || null,
                    })
                  }
                  options={unitOptions(item.rate_unit, (unit) => unit)}
                  placeholder="--"
                  disabled={editLocked}
                  className={UNIT_SELECT}
                />
              </div>
              {item.oz_per_acre != null && (
                <p className="mt-1 text-xs text-secondary tabular-nums">{item.oz_per_acre.toFixed(2)} oz/acre</p>
              )}
            </>
          );
          const acres = (
            <input
              type="number"
              value={item.acres ?? ''}
              onChange={(e) =>
                updateItem(sec._key, item._key, {
                  acres: e.target.value
                    ? parseFloat(e.target.value)
                    : null,
                  acres_source: 'typed',
                  calc_mode: item.calc_mode === 'units_direct'
                    ? 'units_direct' // keep units_direct if typing acres alongside units
                    : 'rate_acres',
                })
              }
              aria-label="Acres"
              className={`${LINE_INPUT} border-gray-300`}
              step="any"
              min={0}
            />
          );
          const quantity = (
            <>
              <div className={`${UNIT_BOX} ${
                item.calc_mode === 'units_direct'
                  ? 'border-crx-green bg-crx-green-tint'
                  : 'border-gray-300 bg-white'
              }`}>
                <input
                  type="number"
                  value={item.total_units_needed ?? ''}
                  onChange={(e) =>
                    updateItem(sec._key, item._key, {
                      total_units_needed: e.target.value
                        ? parseFloat(e.target.value)
                        : null,
                      calc_mode: 'units_direct',
                    })
                  }
                  aria-label="Quantity"
                  className={UNIT_BOX_INPUT}
                  step="any"
                  min={0}
                />
                {prod?.inventory_unit && <span className={UNIT_STRIP}>{prod.inventory_unit}</span>}
              </div>
              {item.calc_mode === 'units_direct' && <p className="mt-1 text-xs text-crx-green">Entered by hand</p>}
            </>
          );
          const price = linePrice(item, f);
          // Admin only, never in Customer view (hideCost): cost when quoted beside today's, then profit and margin.
          const cost = !hideCost && (
            <div>
              <QuoteLineCost
                quotedCost={item.current_cost}
                // A line not yet quoted (new, or switched to another product)
                // already shows today's cost.
                todayCost={holdsQuotedCost(item, item.product_id, savedLineIdByKey.get(item._key))
                  ? prod?.current_cost ?? null
                  : null}
                pricePerUnit={item.price_per_unit}
              />
              <div className="mt-0.5 font-medium text-crx-green tabular-nums whitespace-nowrap">
                {fmt(item.profit)} · {pct(item.net_margin)}
              </div>
            </div>
          );
          const menu = (
            <ActionMenu
              label={`Actions for line ${n} in ${sec.section_name || 'Untitled section'}`}
              disabled={editLocked}
              items={[
                ...(prod ? [{ id: 'change', label: 'Change product', onAction: openPicker }] : []),
                { id: 'note', label: item.notes ? 'Edit note' : 'Add note', onAction: () => setEditingLineNote(item._key) },
                {
                  id: 'remove',
                  label: lineNeedsRemoveConfirm({ product_id: item.product_id || null, units_needed: item.total_units_needed, edited: hasUserEnteredItemValues(item) }) ? 'Remove line…' : 'Remove line',
                  icon: <Trash2 className="w-4 h-4" />,
                  danger: true,
                  onAction: () => requestRemoveItem(sec._key, item),
                },
              ]}
            />
          );
          const perAcre = linePerAcre(item);
          return { prod, product, rate, acres, quantity, price, perAcre, cost, menu };
        };

        return (
          <Card key={sec._key} padding={false}>
            <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 md:px-4 ${isCollapsed ? '' : 'border-b border-cream-dark'}`}>
              <button
                type="button"
                onClick={() => toggleSectionCollapse(sec._key)}
                className="h-11 w-11 md:h-10 md:w-10 shrink-0 inline-flex items-center justify-center rounded-md text-secondary hover:bg-gray-100"
                aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight className="w-4.5 h-4.5" />
                ) : (
                  <ChevronDown className="w-4.5 h-4.5" />
                )}
              </button>
              <input
                value={sec.section_name}
                onChange={(e) => updateSectionName(sec._key, e.target.value)}
                aria-label="Section name"
                disabled={readOnly}
                className="min-w-0 flex-1 md:flex-none md:w-56 h-11 md:h-10 -ml-1.5 px-1.5 rounded-md border border-transparent bg-transparent text-lg font-semibold font-heading text-nav-dark hover:border-gray-200 focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
                placeholder="Section name"
              />
              <div className="order-last md:order-none w-full md:w-auto flex flex-wrap items-center gap-2">
                <div className="flex w-full sm:w-auto items-center gap-2">
                  <span className="text-xs text-secondary whitespace-nowrap">Field</span>
                  {/* Active fields only (the customer's, once one is chosen), as the old list loaded. */}
                  <FieldSearchPicker<FieldOption>
                    value={sec.field_id || ''}
                    selectedLabel={(sec.field_id && fields[sec.field_id]?.field_name) || ''}
                    onSelect={(field) => handleSectionFieldChange(sec._key, field)}
                    select={QUOTE_FIELD_SELECT}
                    customerId={customerId || null}
                    placeholder="Search fields..."
                    ariaLabel={`Field for ${sec.section_name || 'section'}`}
                    disabled={readOnly}
                    className="min-w-0 flex-1 sm:flex-none sm:w-56"
                  />
                </div>
                {/* U13 (#111): per-section job badge: a section that already has a
                    scheduled job links straight to it (and the Schedule job button
                    hides, since a 2nd job per section is rejected server-side). */}
                {sec.id && sectionJobs[sec.id] && (
                  <button
                    type="button"
                    onClick={() => navigate(`/jobs/${sectionJobs[sec.id as string].id}`)}
                    className="shrink-0 min-h-11 md:min-h-10"
                    title="Open the job scheduled from this section"
                  >
                    <Badge variant={statusToBadgeVariant[sectionJobs[sec.id as string].status] || 'info'}>
                      Job {sectionJobs[sec.id as string].job_number}
                    </Badge>
                  </button>
                )}
                {canScheduleJobs && quoteId && sec.items.length > 0 && !(sec.id && sectionJobs[sec.id]) && (
                  <Button variant="ghost" size="sm" icon={<CalendarClock className="w-3.5 h-3.5" />} showChevron={false} onClick={() => sec.id && currentStatus === 'draft' ? setConfirmDraftScheduleKey(sec._key) : handleScheduleJob(sec._key)} loading={schedulingJobSectionKey === sec._key} className="min-h-11 md:min-h-10">
                    Schedule job
                  </Button>
                )}
                {scheduleBlockedAccepted && quoteId && sec.id && sec.items.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-secondary">
                    <XCircle className="w-3 h-3 text-orange-500" />
                    Sold, make a standalone job
                    <HelpTip text="This booking was accepted and converted to a chemical sale (order). To do field work, create a standalone job from the Jobs page. Scheduling from a sold booking would double-count the product." />
                  </span>
                )}
              </div>
              {/* Always shown; on a phone it shares the first row with the name and the caption is read, not shown. */}
              <div className="ml-auto flex shrink-0 flex-col items-end leading-tight">
                <span className="text-xs text-secondary max-md:sr-only">Section total</span>
                <strong className="text-[17px] md:text-lg font-semibold text-nav-dark tabular-nums whitespace-nowrap">{fmt(sectionTotal)}</strong>
              </div>
              {sections.length > 1 && (
                <ActionMenu
                  label={`Actions for section ${sec.section_name || 'Untitled section'}`}
                  disabled={editLocked}
                  items={[{ id: 'remove-section', label: 'Remove section', icon: <Trash2 className="w-4 h-4" />, danger: true, onAction: () => removeSection(sec._key) }]}
                />
              )}
              {sec.id && sectionJobs[sec.id] && sectionJobs[sec.id].status !== 'cancelled' && (
                <p className="order-last w-full text-xs text-amber-700">
                  Job {sectionJobs[sec.id].job_number} was scheduled from this section. Its products, quantities, prices, needed-by date and field stay as booked; a new name or notes here does not change the job, so change those on the job too.
                </p>
              )}
              {isPlanned && (
                <div className="order-last w-full flex flex-wrap items-start gap-x-6 gap-y-1">
                  <div className="w-full sm:w-52">
                    <div className="mb-1 flex items-center gap-1 text-sm font-medium text-secondary">
                      Needed by
                      <HelpTip text="When the customer needs the product, not when the quote expires. Used for inventory forecasting and delivery scheduling." />
                    </div>
                    <DatePicker
                      aria-label="Needed by"
                      value={sec.needed_by_date || null}
                      onChange={(value) => updateSectionField(sec._key, 'needed_by_date', value || null)}
                      disabled={editLocked || Boolean(sec.id && sectionJobs[sec.id] && sectionJobs[sec.id].status !== 'cancelled')}
                    />
                  </div>
                  {/* Holds have one row per quote item; this per-section view aggregates the quote's matching rows for each product. */}
                  {quoteId && activePlannedHolds.length > 0 && (
                    <div className="sm:pt-8 flex flex-col items-start gap-0.5 text-xs text-secondary">
                      {Array.from(new Set(sec.items.map((item) => item.product_id).filter(Boolean))).map((productId) => {
                        const holds = activePlannedHolds.filter((candidate) => candidate.product_id === productId);
                        if (holds.length === 0) return null;
                        const heldQuantity = holds.reduce((sum, hold) => sum + hold.quantity, 0);
                        const earliestExpiry = holds.reduce<string | null>((earliest, hold) => {
                          if (hold.expires_at == null) return earliest;
                          return earliest == null || hold.expires_at < earliest ? hold.expires_at : earliest;
                        }, null);
                        const unit = products.find((product) => product.id === productId)?.inventory_unit;
                        const isLapsed = earliestExpiry != null && earliestExpiry.slice(0, 10) <= localToday();
                        return (
                          <span key={productId}>
                            Held: {heldQuantity}{unit ? ` ${unit}` : ''} &middot; {earliestExpiry ? (
                              <>expires <span className={isLapsed ? 'text-red-600 font-medium' : undefined}>{parseLocalDate(earliestExpiry.slice(0, 10)).toLocaleDateString()}{isLapsed ? ' (lapsed)' : ''}</span></>
                            ) : 'no expiry (no needed-by date)'}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {!isCollapsed && (
              <fieldset disabled={readOnly} className="min-w-0">
              {/* Section note: prints above the section's products on the PDF. Its link sits in the footer. */}
              {sectionNoteOpen && (
                <div className="px-3 md:px-4 pt-2">
                  <div className="pb-1">
                    <div className="mb-1 flex items-center gap-1 text-xs text-secondary">
                      <span id={`section-note-${sec._key}`}>Note for this section (prints above its products)</span>
                      <HelpTip text="These notes print above the items in the PDF. Use for delivery instructions like 'Apply before 10am' or 'Requires cool storage'." />
                    </div>
                    <textarea
                      value={sec.section_header_notes || ''}
                      onChange={(e) => updateSectionField(sec._key, 'section_header_notes', e.target.value || null)}
                      id={`section-note-input-${sec._key}`}
                      onFocus={openSectionNote}
                      aria-labelledby={`section-note-${sec._key}`}
                      rows={2}
                      placeholder="Section notes for grower (shown above products on PDF)..."
                      className="w-full text-base md:text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-y"
                    />
                  </div>
                </div>
              )}
              {sec.items.length === 0 ? (
                <p className="px-3 md:px-4 pt-2 pb-4 text-sm text-secondary">
                  No products yet.{readOnly ? null : ' '}
                  {!readOnly && <button
                    type="button"
                    onClick={() => addItem(sec._key)}
                    className={`${LINK_HIT} text-crx-green hover:underline font-medium`}
                  >
                    Add one
                  </button>}
                </p>
              ) : lineCards ? (
                // Below 1024 px: one card per line. Fields sit 2 across on a phone and 4 across from 768 px,
                // once the card has the room (36rem; not with the sidebar open at 768 px).
                <div className="mt-2 divide-y divide-cream-dark border-t border-cream-dark">
                  {sec.items.map((item, idx) => {
                    const line = lineParts(item, idx + 1);
                    return (
                      <article
                        key={item._key}
                        aria-label={line.prod ? `Line ${idx + 1}, ${line.prod.product_name}` : `Line ${idx + 1}`}
                        className="@container px-3 py-3.5 md:px-4 space-y-3"
                      >
                        <div className="flex items-start gap-2">
                          <span aria-hidden="true" className="mt-2.5 md:mt-0 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cream-dark text-xs font-semibold text-secondary tabular-nums">{idx + 1}</span>
                          <div className="flex-1 min-w-0">{line.product}</div>
                          {line.menu}
                        </div>
                        <div className="grid grid-cols-2 md:@min-[36rem]:grid-cols-4 gap-x-2.5 gap-y-3">
                          <div className="min-w-0"><span aria-hidden="true" className="mb-1 block text-[13px] font-medium text-secondary">Rate per acre</span>{line.rate}</div>
                          <div className="min-w-0"><span aria-hidden="true" className="mb-1 block text-[13px] font-medium text-secondary">Acres</span>{line.acres}</div>
                          <div className="min-w-0"><span aria-hidden="true" className="mb-1 block text-[13px] font-medium text-secondary">Quantity</span>{line.quantity}</div>
                          <div className="min-w-0"><span aria-hidden="true" className="mb-1 block text-[13px] font-medium text-secondary">Price</span>{line.price}</div>
                        </div>
                        <div className="flex items-end justify-between gap-3 border-t border-cream-dark pt-2.5">
                          <div className="min-w-0 text-[13px] text-secondary">
                            <div className="tabular-nums">{line.perAcre}</div>
                            {line.cost}
                          </div>
                          <strong className="shrink-0 text-lg font-semibold text-nav-dark tabular-nums">{fmt(item.total_price)}</strong>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                // 1024 px and up: fixed columns that fit the card, Product takes what is left and wraps.
                // The number columns widen once the card is 72rem. overflow-x-auto only guards a zoomed page.
                // relative: the sr-only header is absolutely positioned and must stay inside this wrapper.
                <div className="@container relative mt-2 overflow-x-auto">
                  <table className="w-full table-fixed text-sm">
                    <colgroup>
                      <col className="w-9 @min-[72rem]:w-10" />
                      <col />
                      <col className="w-29 @min-[72rem]:w-39" />
                      <col className="w-17 @min-[72rem]:w-23" />
                      <col className="w-24 @min-[72rem]:w-33" />
                      <col className="w-33 @min-[72rem]:w-42" />
                      <col className="w-24 @min-[72rem]:w-28" />
                      {!hideCost && <col className="w-32 @min-[72rem]:w-33" />}
                      <col className="w-12" />
                    </colgroup>
                    <thead>
                      <tr className="border-t border-cream-dark bg-cream/60 text-left text-xs text-secondary">
                        <th scope="col" className="py-2.5 pl-3 pr-1 font-medium md:pl-4">#</th>
                        <th scope="col" className="py-2.5 px-1.5 font-medium">Product</th>
                        <th scope="col" className="py-2.5 px-1.5 font-medium">Rate per acre</th>
                        <th scope="col" className="py-2.5 px-1.5 font-medium">Acres</th>
                        <th scope="col" className="py-2.5 px-1.5 font-medium">Quantity</th>
                        <th scope="col" className="py-2.5 px-1.5 font-medium">Price</th>
                        <th scope="col" className="py-2.5 px-1.5 font-medium text-right">Total</th>
                        {!hideCost && <th scope="col" className="py-2.5 px-1.5 font-medium text-right">Cost · margin</th>}
                        <th scope="col" className="py-2.5 px-1"><span className="sr-only">Line actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sec.items.map((item, idx) => {
                        const line = lineParts(item, idx + 1);
                        return (
                          <tr key={item._key} className="border-t border-cream-dark align-top">
                            <td className="py-3 pl-3 pr-1 pt-5 text-xs text-secondary tabular-nums md:pl-4">{idx + 1}</td>
                            <td className="py-3 px-1.5 break-words">{line.product}</td>
                            <td className="py-3 px-1.5">{line.rate}</td>
                            <td className="py-3 px-1.5">{line.acres}</td>
                            <td className="py-3 px-1.5">{line.quantity}</td>
                            <td className="py-3 px-1.5">{line.price}</td>
                            <td className="py-3 px-1.5 pt-5 text-right">
                              <div className="font-semibold text-nav-dark tabular-nums">{fmt(item.total_price)}</div>
                              <div className="mt-1 text-xs text-secondary tabular-nums">{line.perAcre}</div>
                            </td>
                            {/* Fixed columns: the cost's no-wrap parts may wrap rather than run into the next column. */}
                            {!hideCost && <td className="py-3 px-1.5 pt-5 text-right text-xs [&_*]:whitespace-normal">{line.cost}</td>}
                            <td className="py-2 px-1 text-right">{line.menu}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {!readOnly && (sec.items.length > 0 || !sectionNoteOpen) && (
                <div className="flex flex-col gap-1 border-t border-cream-dark px-3 py-3 md:flex-row md:items-center md:gap-4 md:px-4">
                  {sec.items.length > 0 && (
                    <Button
                      variant="secondary"
                      icon={<Plus className="w-4 h-4" />}
                      showChevron={false}
                      onClick={() => addItem(sec._key)}
                      className="min-h-11 w-full md:min-h-10 md:w-auto"
                    >
                      Add product
                    </Button>
                  )}
                  {!sectionNoteOpen && (
                    <button
                      type="button"
                      onClick={() => {
                        openSectionNote();
                        // Focus once the textarea has rendered; never on a remount (collapse, tab switch).
                        requestAnimationFrame(() => document.getElementById(`section-note-input-${sec._key}`)?.focus());
                      }}
                      className="-ml-2 inline-flex min-h-11 md:min-h-10 items-center gap-1.5 self-start px-2 text-left text-sm font-medium text-crx-green hover:underline md:self-auto"
                    >
                      <Plus className="w-3.5 h-3.5 shrink-0" />
                      Add a note for this section
                    </button>
                  )}
                </div>
              )}
              </fieldset>
            )}
          </Card>
        );
      })}

      {!readOnly && <button
        type="button"
        onClick={addSection}
        className="w-full flex items-center md:justify-center gap-3 rounded-xl border-[1.5px] border-dashed border-gray-300 px-4 py-4 text-left text-nav-dark transition-colors hover:border-crx-green hover:bg-crx-green-tint disabled:opacity-50"
      >
        <span className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-full bg-crx-green-light text-crx-green">
          <Plus className="w-4 h-4" aria-hidden="true" />
        </span>
        <span className="flex flex-col leading-snug">
          <span className="font-semibold">Add a section</span>
          <span className="text-[13px] text-secondary">Group products by field or timing, like &quot;Spring pre-emerge&quot;. Each section gets its own total on the PDF.</span>
        </span>
      </button>}
              </fieldset>
            ),
          },
          ...(settlement ? [{
            key: 'balance',
            label: isPhone ? 'Booking' : 'Booking balance',
            content: <div className="pt-4"><Card>
          {settlementEmpty && <p className="text-sm text-secondary">Nothing booked on this quote yet.</p>}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            {/* Prepaid cell hidden while there is no earmarked prepay — the booking-prepay
                earmark engine is shelved (docs/roadmap/shelved-earmark-engine/), so this
                reads 0 for now and lights up automatically when the engine returns. */}
            {((settlement.prepay_remaining_cents ?? 0) > 0 || (settlement.prepay_earmarked_cents ?? 0) > 0) && (
              <div>
                <div className="text-secondary">Prepaid (remaining)</div>
                <div className="font-semibold text-crx-green">{formatCents(settlement.prepay_remaining_cents ?? 0)}</div>
              </div>
            )}
          </div>
          {(settlement.prepay_earmarked_cents ?? 0) > 0 && (
            <div className="mt-2 text-xs text-secondary">
              Prepay earmarked {formatCents(settlement.prepay_earmarked_cents ?? 0)} · applied {formatCents(settlement.prepay_applied_cents ?? 0)}
            </div>
          )}
          {settlement.lines && settlement.lines.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-secondary">
                    <th className="px-2 py-1 text-left font-medium">Product</th>
                    <th className="px-2 py-1 text-right font-medium">Booked</th>
                    <th className="px-2 py-1 text-right font-medium">Drawn</th>
                    <th className="px-2 py-1 text-right font-medium">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {settlement.lines.map((ln) => (
                    (() => {
                      const unit = products.find((product) => product.id === ln.product_id)?.inventory_unit;
                      const suffix = unit ? ` ${unit}` : '';
                      return (
                        <tr key={ln.product_id} className="border-b border-gray-50">
                          <td className="px-2 py-1">{ln.product_name ?? '–'}</td>
                          <td className="px-2 py-1 text-right">{ln.booked_qty}{suffix}</td>
                          <td className="px-2 py-1 text-right">{ln.drawn_qty}{suffix}</td>
                          <td className="px-2 py-1 text-right">{ln.remaining_qty}{suffix}</td>
                        </tr>
                      );
                    })()
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card></div>,
          }] : []),
          ...(tabAvailable.last ? [{
            key: 'last',
            label: 'Last charged',
            content: <div className="pt-4"><LastChargedPricesCard products={lastCharged.products} state={lastCharged.state} onRetry={lastCharged.retry} /></div>,
          }] : []),
          ...(tabAvailable.history ? [{
            key: 'history',
            label: 'History',
            count: savedVersionCount,
            content: <div className="pt-4"><Card>
          {/* Version list */}
          <div className="divide-y divide-gray-100">
            {orderedVersionHistory.map((entry) => {
              if (!entry.readable) {
                /*
                  Saved versions whose snapshot this build cannot read. Listed at all so a quote whose
                  only versions are legacy still shows its history, and shown without an item count or
                  total because both would have to be read out of a snapshot that cannot be trusted.
                  Not selectable, so they reach neither the compare view nor restore.

                  Only rows the server itself treats as legacy are called an older format; a row the
                  server stamped as restorable says only that its details are unavailable, because
                  calling it old would be a guess. Those also raise a Sentry report - see
                  reportUntrustworthyQuoteVersions.
                */
                const u = entry.version;
                return (
                  <div key={u.id} className="py-3 px-3 flex items-center justify-between">
                    <div>
                      <span className="font-medium text-secondary">v{u.version_number}</span>
                      <span className="text-secondary text-sm ml-3">
                        {new Date(u.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="text-sm text-secondary italic">
                      {u.server_trusted
                        ? 'Details unavailable'
                        : 'Saved in an older format · details unavailable'}
                    </div>
                  </div>
                );
              }
              const v = entry.version;
              const itemCount = v.snapshot_data?.sections?.reduce(
                (sum, s) => sum + (s.items?.length || 0), 0
              ) || 0;
              const totalPrice = v.snapshot_data?.quote?.total_price || 0;
              const isSelected = selectedVersion?.id === v.id;
              return (
                <div
                  key={v.id}
                  className={`py-3 px-3 flex items-center justify-between cursor-pointer transition-colors ${isSelected ? 'bg-crx-green/10 border-l-4 border-crx-green' : 'hover:bg-gray-50'}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setSelectedVersion(isSelected ? null : v);
                    setCompareMode(false);
                    setConfirmRestore(null);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedVersion(isSelected ? null : v); setCompareMode(false); setConfirmRestore(null); } }}
                >
                  <div>
                    <span className="font-medium text-nav-dark">v{v.version_number}</span>
                    <span className="text-secondary text-sm ml-3">
                      {new Date(v.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="text-sm text-secondary">
                    {itemCount} item{itemCount !== 1 ? 's' : ''} &middot;{' '}
                    {fmt(totalPrice)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected version details */}
          {selectedVersion && !compareMode && (
            <div className="border-t border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-nav-dark">V{selectedVersion.version_number} Snapshot</h4>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Eye className="w-3.5 h-3.5" />}
                    showChevron={false}
                    onClick={() => setCompareMode(true)}
                  >
                    Compare
                  </Button>
                  {canEdit && (
                    <>
                      {confirmRestore === selectedVersion.id ? (
                        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1">
                          <span className="text-sm text-amber-800">Restore V{selectedVersion.version_number}?</span>
                          <Button
                            size="sm"
                            icon={<CheckCircle className="w-3.5 h-3.5" />}
                            showChevron={false}
                            onClick={() => handleRestoreVersion(selectedVersion.id)}
                          >
                            Yes
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            showChevron={false}
                            onClick={() => setConfirmRestore(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<RotateCcw className="w-3.5 h-3.5" />}
                          showChevron={false}
                          onClick={() => setConfirmRestore(selectedVersion.id)}
                        >
                          Restore
                        </Button>
                      )}
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    showChevron={false}
                    onClick={() => { setSelectedVersion(null); setConfirmRestore(null); }}
                  >
                    Close
                  </Button>
                </div>
              </div>
              <div className="text-sm text-secondary mb-3">
                Total: {fmt(selectedVersion.snapshot_data?.quote?.total_price || 0)}
                {' '}&middot;{' '}
                {!hideCost && <>Margin: {(selectedVersion.snapshot_data?.quote?.total_margin_pct || 0).toFixed(1)}%</>}
              </div>
              {selectedVersion.snapshot_data?.sections?.map((sec, si) => (
                <div key={si} className="mb-3">
                  <div className="flex items-center gap-2">
                    <h5 className="text-sm font-medium text-nav-dark mb-1">{sec.section_name}</h5>
                    {sec.needed_by_date && <span className="text-xs text-amber-600 mb-1">Needed by: {sec.needed_by_date}</span>}
                  </div>
                  {sec.section_header_notes && <p className="text-xs text-secondary italic mb-1">{sec.section_header_notes}</p>}
                  {sec.section_notes && <p className="text-xs text-secondary mb-1">{sec.section_notes}</p>}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200 text-secondary">
                          <th className="text-left py-1 pr-2">Product</th>
                          <th className="text-right py-1 px-2">Rate</th>
                          <th className="text-right py-1 px-2">Acres</th>
                          <th className="text-right py-1 px-2">Units</th>
                          <th className="text-right py-1 px-2">Price/Unit</th>
                          <th className="text-right py-1 pl-2">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sec.items?.map((item, ii) => (
                          <tr key={ii} className="border-b border-gray-100">
                            <td className="py-1 pr-2 text-nav-dark">{item.product_name}</td>
                            <td className="py-1 px-2 text-right text-secondary">
                              {item.actual_rate ? `${item.actual_rate} ${item.rate_unit || ''}` : '-'}
                            </td>
                            <td className="py-1 px-2 text-right text-secondary">{item.acres ?? '-'}</td>
                            <td className="py-1 px-2 text-right text-secondary">{item.total_units_needed ?? '-'}</td>
                            <td className="py-1 px-2 text-right text-secondary">{fmt(item.price_per_unit)}</td>
                            <td className="py-1 pl-2 text-right font-medium text-nav-dark">{fmt(item.total_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Compare mode: show differences between selected version and current quote */}
          {selectedVersion && compareMode && (
            <div className="border-t border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-nav-dark">
                  Comparing V{selectedVersion.version_number} vs Current
                </h4>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<EyeOff className="w-3.5 h-3.5" />}
                    showChevron={false}
                    onClick={() => setCompareMode(false)}
                  >
                    Exit compare
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    showChevron={false}
                    onClick={() => { setSelectedVersion(null); setCompareMode(false); setConfirmRestore(null); }}
                  >
                    Close
                  </Button>
                </div>
              </div>
              {/* Price comparison summary */}
              {(() => {
                const vTotal = selectedVersion.snapshot_data?.quote?.total_price || 0;
                const cTotal = totals.totalPrice;
                const diff = cTotal - vTotal;
                return (
                  <div className={`rounded-lg p-3 mb-3 text-sm ${diff > 0 ? 'bg-green-50 text-green-800' : diff < 0 ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-secondary'}`}>
                    V{selectedVersion.version_number} Total: {fmt(vTotal)} &rarr; Current: {fmt(cTotal)}
                    {diff !== 0 && (
                      <span className="ml-2 font-medium">
                        ({diff > 0 ? '+' : ''}{fmt(diff)})
                      </span>
                    )}
                  </div>
                );
              })()}
              {/* Item-level comparison */}
              {(() => {
                const versionItems = (selectedVersion.snapshot_data?.sections || []).flatMap(
                  s => (s.items || []).map(i => ({ ...i, section: s.section_name }))
                );
                const currentItems = sections.flatMap(
                  s => s.items.filter(i => i.product_id).map(i => ({
                    product_id: i.product_id,
                    product_name: i.product?.product_name || '',
                    price_per_unit: i.price_per_unit,
                    total_price: i.total_price,
                    total_units_needed: i.total_units_needed,
                    section: s.section_name,
                  }))
                );
                const vMap = new Map(versionItems.map(i => [i.product_id, i]));
                const cMap = new Map(currentItems.map(i => [i.product_id, i]));
                const allProductIds = new Set([...vMap.keys(), ...cMap.keys()]);

                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200 text-secondary">
                          <th className="text-left py-1 pr-2">Product</th>
                          <th className="text-right py-1 px-2">V{selectedVersion.version_number} Price</th>
                          <th className="text-right py-1 px-2">Current price</th>
                          <th className="text-right py-1 px-2">V{selectedVersion.version_number} Total</th>
                          <th className="text-right py-1 pl-2">Current total</th>
                          <th className="text-right py-1 pl-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from(allProductIds).map((pid) => {
                          const vItem = vMap.get(pid);
                          const cItem = cMap.get(pid);
                          const isAdded = !vItem && cItem;
                          const isRemoved = vItem && !cItem;
                          const priceChanged = vItem && cItem && Math.abs(vItem.price_per_unit - cItem.price_per_unit) > 0.001;
                          const bgClass = isAdded ? 'bg-green-50' : isRemoved ? 'bg-red-50' : priceChanged ? 'bg-amber-50' : '';
                          return (
                            <tr key={pid} className={`border-b border-gray-100 ${bgClass}`}>
                              <td className="py-1 pr-2 text-nav-dark">{vItem?.product_name || cItem?.product_name || ''}</td>
                              <td className="py-1 px-2 text-right text-secondary">{vItem ? fmt(vItem.price_per_unit) : '-'}</td>
                              <td className="py-1 px-2 text-right text-secondary">{cItem ? fmt(cItem.price_per_unit) : '-'}</td>
                              <td className="py-1 px-2 text-right text-secondary">{vItem ? fmt(vItem.total_price) : '-'}</td>
                              <td className="py-1 pl-2 text-right text-secondary">{cItem ? fmt(cItem.total_price) : '-'}</td>
                              <td className="py-1 pl-2 text-right">
                                {isAdded && <Badge variant="success">Added</Badge>}
                                {isRemoved && <Badge variant="error">Removed</Badge>}
                                {priceChanged && <Badge variant="warning">Changed</Badge>}
                                {!isAdded && !isRemoved && !priceChanged && <span className="text-secondary">-</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          )}
        </Card></div>,
          }] : []),
        ]}
      />


      <Modal
        open={productSearchOpen !== null}
        onClose={closeProductPicker}
        title="Select"
        accent="Product"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="Search by name, SKU, category, or vendor..."
              // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in just-opened picker; user expects to type immediately
              autoFocus
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={keepProductPickerOpen}
              onChange={(e) => setKeepProductPickerOpen(e.target.checked)}
              className="rounded border-gray-300 text-crx-green focus:ring-crx-green"
            />
            Keep open to add several
          </label>
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {filteredProducts.length === 0 ? (
              <p className="text-sm text-secondary py-4 text-center">
                No products found
              </p>
            ) : (
              filteredProducts.map((p) => {
                // P2-5: catalog $/acre at this tier, computed correctly from the
                // product's own rate + units (NOT the broken tierN_price_per_acre
                // columns) — matches what the line will show once added.
                const perAcre = catalogPricePerAcre(p, tier, unitConversions);
                return (
                <ProductSearchResultRow
                  key={p.id}
                  product={p}
                  onClick={() => {
                    if (!productSearchOpen) return;
                    const { sectionKey, itemKey } = productSearchOpen;
                    const currentProductId = sections
                      .find((sec) => sec._key === sectionKey)?.items
                      .find((item) => item._key === itemKey)?.product_id;
                    if (currentProductId && currentProductId !== p.id) {
                      savedLineIdsRef.current.delete(itemKey);
                      switchedLineKeysRef.current.add(itemKey);
                    }
                    assignProduct(sectionKey, itemKey, p);
                  }}
                  trailing={<><p className="font-mono text-sm text-nav-dark">{fmt(getTierPrice(p, tier))}</p><p className="text-xs text-gray-400">T{tier} price</p>{perAcre != null && <p className="text-xs font-mono text-crx-green" title={`Approx. $/acre at tier ${tier}, applied at this product's standard rate`}>{fmt(perAcre)}/ac</p>}</>}
                />
                );
              })
            )}
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmConvertOpen}
        onClose={() => { if (!converting) setConfirmConvertOpen(false); }}
        title="Convert to order?"
        footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              showChevron={false}
              onClick={() => setConfirmConvertOpen(false)}
              disabled={converting}
              className="min-h-11 w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              icon={<ShoppingCart className="w-4 h-4" />}
              onClick={handleConvertToOrder}
              loading={converting}
              className="min-h-11 w-full sm:w-auto"
            >
              {converting ? 'Creating order…' : 'Create order'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <GuardrailBanner warning={staleWarning} onDismiss={dismissStaleWarning} />
          <p className="text-sm text-secondary">
            This will accept the quote and create a new order for{' '}
            {selectedCustomer?.farm_name || 'the customer'} with all line items. The
            quote status will be updated to accepted.
          </p>
        </div>
      </Modal>

      <Modal
        open={showPreviewModal}
        onClose={() => { setShowPreviewModal(false); setPreviewPdfBlob(null); }}
        title="Preview and send"
        subtitle={selectedCustomer?.farm_name ? `${quoteNumber} for ${selectedCustomer.farm_name}` : quoteNumber}
        size="wide"
      >
        {/* Phone: pages, then options, with the actions pinned at the bottom. md+: pages left, options and actions in a 360px side panel. */}
        <div className="-mx-6 -my-5 flex h-[calc(100%+2.5rem)] flex-col md:grid md:grid-cols-[minmax(0,1fr)_360px] md:grid-rows-[minmax(0,1fr)_auto]">
          <div className="min-h-0 flex-1 overflow-y-auto md:contents">
            <div className="bg-cream-dark p-4 md:row-span-2 md:overflow-y-auto md:p-7">
              {previewRebuild === 'failed' && (
                <p className="mb-3 text-sm text-secondary">Preview could not update. Download and email use the columns you picked.</p>
              )}
              <div role="status" aria-live="polite" className={previewRebuild === 'updating' ? 'mb-3 text-xs text-secondary' : 'sr-only'}>
                {previewRebuild === 'updating' ? 'Updating preview…' : ''}
              </div>
              {previewPdfBlob && <PdfPagePreview blob={previewPdfBlob} title={`Quote ${quoteNumber}`} />}
            </div>
            <div className="flex flex-col gap-5 p-4 md:overflow-y-auto md:border-l md:border-gray-200 md:px-6 md:py-5">
              <Dropdown
                label="PDF layout"
                value={selectedTemplateId}
                placeholder="Default layout"
                onChange={(v) => { setSelectedTemplateId(v); setCustomColumns(null); }}
                options={pdfTemplates.map((t) => ({ value: t.id, label: t.template_name }))}
                noHelperRow
              />
              <fieldset className="flex min-w-0 flex-col gap-2.5">
                <legend className="mb-2.5 text-sm font-medium text-secondary">Columns on the PDF</legend>
                <div className="flex flex-wrap gap-2">
                  {AVAILABLE_PDF_COLUMNS.map((col) => {
                    const isActive = activePdfColumns.includes(col.key);
                    return (
                      <button
                        key={col.key}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => {
                          const cols = [...activePdfColumns];
                          if (isActive) cols.splice(cols.indexOf(col.key), 1);
                          else cols.push(col.key);
                          setCustomColumns(cols);
                        }}
                        className={`inline-flex h-11 items-center rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green focus-visible:ring-offset-2 md:h-10 ${isActive ? 'border-crx-green bg-crx-green-light text-crx-green' : 'border-gray-300 bg-white text-nav-dark hover:bg-gray-50'}`}
                      >
                        {col.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-sm text-secondary">The preview updates as you pick.</p>
              </fieldset>
              <div className="flex flex-col gap-1.5 rounded-lg border border-cream-dark bg-cream p-3.5 text-sm">
                <span className="font-medium text-nav-dark">Sending to</span>
                <span className="break-all text-nav-dark">{selectedCustomer?.email || 'No email address on file'}</span>
                {lastQuoteEmailAt && (
                  <span className="inline-flex items-center gap-1.5 text-crx-green">
                    <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                    Last emailed {new Date(lastQuoteEmailAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2.5 border-t border-gray-200 bg-white px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:border-l md:px-6 md:pb-5">
            <Button
              variant="primary"
              icon={<Send className="w-4 h-4" />}
              onClick={handleEmailToGrower}
              loading={emailingGrower}
              className="h-11 w-full"
            >
              {emailingGrower ? 'Sending…' : 'Email to grower'}
            </Button>
            <div className="flex gap-2.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  setMarkingPresented(true);
                  try { await handleMarkPresented(); } finally { setMarkingPresented(false); }
                }}
                loading={markingPresented}
                disabled={status !== 'draft' && status !== 'revised'}
                className="min-h-11 flex-1 whitespace-nowrap md:min-h-10"
              >
                {markingPresented ? 'Marking…' : 'Mark as presented'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Download className="w-4 h-4" />}
                onClick={handleDownloadPdf}
                className="min-h-11 flex-1 whitespace-nowrap md:min-h-10"
              >
                Download
              </Button>
            </div>
            <p className="text-xs text-secondary">Mark as presented records the quote as sent without emailing, for quotes you hand over in person.</p>
          </div>
        </div>
      </Modal>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      {showSaveTemplateModal && (
        <Modal open={showSaveTemplateModal} onClose={() => setShowSaveTemplateModal(false)} title="Save as template" footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setShowSaveTemplateModal(false)} className="min-h-11 w-full sm:w-auto">
              Cancel
            </Button>
            <Button onClick={handleSaveTemplate} disabled={!templateName.trim()} className="min-h-11 w-full sm:w-auto">
              Save template
            </Button>
          </div>
        }>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Template name</label>
              <input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g., 2026 Soybean Program"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description (optional)</label>
              <textarea
                value={templateDescription}
                onChange={(e) => setTemplateDescription(e.target.value)}
                placeholder="When to use this template..."
                rows={2}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
          </div>
        </Modal>
      )}

      {showDrawModal && (
        <Modal open={showDrawModal} onClose={() => setShowDrawModal(false)} title="Create order from booking" footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setShowDrawModal(false)} className="min-h-11 w-full sm:w-auto">
              Cancel
            </Button>
            <Button
              onClick={() => handleDrawDown()}
              disabled={drawing || drawLoading || !drawRows.some((r) => (parseFloat(r.qty) || 0) > 0)}
              className="min-h-11 w-full sm:w-auto"
            >
              {drawing ? 'Creating…' : 'Create order'}
            </Button>
          </div>
        }>
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Enter how much of each booked product to send now. The quote keeps the
              remaining balance and stays open until it is fully drawn. You can send more than
              is left: the extra goes on its own order at the price you choose.
            </p>
            {pendingDraw?.expired && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-sm flex items-start justify-between gap-3">
                <p>
                  Your last Partial Order here ({new Date(pendingDraw.sentAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}) did not finish
                  and may have gone through, but it can no longer be finished safely. Check the orders on this booking before drawing again.
                </p>
                <Button
                  size="sm"
                  onClick={() => {
                    clearPendingRetry(drawPendingName);
                    setPendingDraw(null);
                  }}
                  className="shrink-0 min-h-11 md:min-h-10"
                >
                  I checked
                </Button>
              </div>
            )}
            {pendingDraw && !pendingDraw.expired && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-sm flex items-start justify-between gap-3">
                <p>
                  Your last Partial Order here ({new Date(pendingDraw.sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}) got no reply,
                  so it may already have gone through. Finish it to get that order: it is made once, never twice.
                </p>
                <Button
                  size="sm"
                  onClick={() => handleDrawDown(pendingDraw)}
                  disabled={drawing}
                  className="shrink-0 min-h-11 md:min-h-10"
                >
                  Finish it
                </Button>
              </div>
            )}
            {drawLoading ? (
              <p className="text-sm text-secondary">Loading booking balance…</p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-secondary border-b">
                      <th className="py-2 pr-2">Product</th>
                      <th className="py-2 pr-2 text-right">Booked</th>
                      <th className="py-2 pr-2 text-right">Drawn</th>
                      <th className="py-2 pr-2 text-right">Remaining</th>
                      <th className="py-2 text-right">Send now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drawRows.map((row, idx) => {
                      const over = Math.round(((parseFloat(row.qty) || 0) - row.remaining) * 100) / 100;
                      const setRow = (patch: Partial<DrawRow>) => {
                        const next = [...drawRows];
                        next[idx] = { ...row, ...patch };
                        setDrawRows(next);
                      };
                      return (
                      <Fragment key={row.product_id}>
                      <tr className={over > 0 && row.remaining > 0 ? '' : 'border-b last:border-0'}>
                        <td className="py-2 pr-2">{row.product_name}</td>
                        <td className="py-2 pr-2 text-right">{row.booked}{row.unit ? ` ${row.unit}` : ''}</td>
                        <td className="py-2 pr-2 text-right">{row.drawn}{row.unit ? ` ${row.unit}` : ''}</td>
                        <td className="py-2 pr-2 text-right font-medium">{row.remaining}{row.unit ? ` ${row.unit}` : ''}</td>
                        <td className="py-2 text-right">
                          <div className="inline-flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={row.qty}
                              // Locked while the order is created: a later change would not be in it.
                              disabled={drawing || row.remaining <= 0}
                              onChange={(e) => setRow({ qty: e.target.value })}
                              aria-label={`Quantity to draw for ${row.product_name}`}
                              className="w-24 px-2 py-1 text-sm text-right border border-gray-200 rounded-lg disabled:bg-gray-50"
                            />
                            {row.unit && <span className="text-xs text-secondary">{row.unit}</span>}
                          </div>
                        </td>
                      </tr>
                      {over > 0 && row.remaining > 0 && (
                        <tr className="border-b last:border-0">
                          <td colSpan={5} className="pb-2 text-xs text-secondary">
                            <p>
                              {over}{row.unit ? ` ${row.unit}` : ''} over the booking. Booked {row.bookedPrice != null ? formatUSD(row.bookedPrice) : 'not set'},
                              {' '}today {row.todayPrice != null ? formatUSD(row.todayPrice) : 'not set'}. The extra goes on its own order at:
                            </p>
                            <div className="mt-1 flex gap-4">
                              {(['today', 'booked'] as const).map((choice) => (
                                <label key={choice} className="inline-flex items-center gap-1 text-nav-dark">
                                  <input
                                    type="radio"
                                    name={`extra-price-${row.product_id}`}
                                    checked={row.extraPrice === choice}
                                    disabled={drawing}
                                    onChange={() => setRow({ extraPrice: choice })}
                                  />
                                  {choice === 'today' ? "Today's price" : 'Booked price'}
                                </label>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Modal>
      )}

      {showRolloverModal && (
        <Modal open={showRolloverModal} onClose={() => setShowRolloverModal(false)} title="Roll over to new season" footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setShowRolloverModal(false)} className="min-h-11 w-full sm:w-auto">
              Cancel
            </Button>
            <Button onClick={handleRollover} className="min-h-11 w-full sm:w-auto">
              Roll over
            </Button>
          </div>
        }>
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Creates a new draft quote with the same products and program structure,
              but with updated pricing from current product prices.
              Need dates will be reset.
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">Target season</label>
              <input
                type="number"
                value={rolloverSeason}
                onChange={(e) => setRolloverSeason(parseInt(e.target.value))}
                className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
          </div>
        </Modal>
      )}

      <RecordVersionConflictDialog
        open={staleSaveOpen}
        entityLabel="quote"
        onKeepEditing={() => {
          // The dialog is no longer offering to recover anything, so its recorded
          // origin must not outlive it. Keeping the record here is what let a
          // dismissed conflict on one quote block the next quote's release.
          staleSaveConflictScopeRef.current = null;
          setStaleSaveOpen(false);
        }}
        onReload={reloadAfterStaleSave}
      />

      {lastSentVersion && (
        <ConfirmModal
          open={confirmRewindOpen}
          onClose={() => setConfirmRewindOpen(false)}
          onConfirm={async () => {
            setConfirmRewindOpen(false);
            await handleRestoreVersion(lastSentVersion.id, lastSentVersion.version_number);
          }}
          title={`Rewind to version ${lastSentVersion.version_number}?`}
          message={`Put this quote back to version ${lastSentVersion.version_number}, the version last sent to the customer? Changes made since then, saved or not, are discarded.`}
          confirmLabel={`Rewind to version ${lastSentVersion.version_number}`}
          variant="info"
          icon={RotateCcw}
        />
      )}

      {/* Decision 4: names the product and its amount, and the quote total without the line (the page's totals rule). */}
      {(() => {
        const target = removeLineTarget && sections.find((sec) => sec._key === removeLineTarget.sectionKey)
          ?.items.find((item) => item._key === removeLineTarget.itemKey);
        if (!removeLineTarget || !target) return null;
        const prod = target.product || products.find((p) => p.id === target.product_id);
        const unit = prod?.inventory_unit;
        const quantity = target.total_units_needed ? `, ${target.total_units_needed.toLocaleString()}${unit ? ` ${unit}` : ''}` : '';
        const totalAfter = quoteTotals(sections.map((sec) => (sec._key === removeLineTarget.sectionKey
          ? { ...sec, items: sec.items.filter((item) => item._key !== removeLineTarget.itemKey) }
          : sec))).totalPrice;
        return (
          <ConfirmModal
            open
            onClose={() => setRemoveLineTarget(null)}
            onConfirm={() => {
              removeItem(removeLineTarget.sectionKey, removeLineTarget.itemKey);
              setRemoveLineTarget(null);
            }}
            title="Remove this line?"
            message={`${prod?.product_name ?? 'This line'}${quantity}, ${fmt(target.total_price)}. The quote total drops to ${fmt(totalAfter)}.`}
            confirmLabel="Remove line"
            cancelLabel="Keep line"
            variant="danger"
          />
        );
      })()}

      <ConfirmModal
        open={confirmBookAsOrderOpen}
        onClose={() => setConfirmBookAsOrderOpen(false)}
        onConfirm={handleBookAsOrder}
        title="Book as order?"
        message="Mark this quote as sent and convert it to an order now?"
        confirmLabel="Book as order"
        variant="info"
        icon={ShoppingCart}
        loading={bookingAsOrder || converting}
      />

      <ConfirmModal
        open={confirmDeclineOpen}
        onClose={() => setConfirmDeclineOpen(false)}
        onConfirm={() => setTerminalStatus('declined')}
        title="Decline this quote?"
        message={`Mark quote ${quoteNumber} as declined? This releases any inventory holds. It is final, though an admin can reopen it later if needed.`}
        confirmLabel="Decline quote"
        variant="danger"
        icon={XCircle}
        loading={statusActionLoading}
      />

      <ConfirmModal
        open={confirmCancelOpen}
        onClose={() => setConfirmCancelOpen(false)}
        onConfirm={() => setTerminalStatus('cancelled')}
        title="Cancel this quote?"
        cancelLabel="Keep quote"
        message={`Cancel quote ${quoteNumber}? This releases any inventory holds. It is final, though an admin can reopen it later if needed.`}
        confirmLabel="Cancel quote"
        variant="danger"
        icon={Ban}
        loading={statusActionLoading}
      />

      <ConfirmModal
        open={confirmCloseAppliedOpen}
        onClose={() => setConfirmCloseAppliedOpen(false)}
        onConfirm={handleCloseAsApplied}
        title="Close booking as applied?"
        message={`Close booking ${quoteNumber} as fulfilled by application. We applied the product for the customer. Any product still unapplied goes back to free inventory. The customer was already billed through each job's application invoice, so this never bills again. This is terminal.`}
        confirmLabel="Close booking"
        icon={CheckCircle}
        loading={closingApplied}
      />

      <ConfirmModal
        open={confirmCloseShortOpen}
        onClose={() => setConfirmCloseShortOpen(false)}
        onConfirm={handleCloseAsShort}
        title="Close booking short?"
        message={`Close booking ${quoteNumber} short? Use this when the customer won't take the rest of this booking (the customer walked away). The un-fulfilled remainder is released back to free inventory. Any product already drawn was billed on its order, so this never bills again. This is terminal. (If jobs are still scheduled against this booking, cancel or complete them first.)`}
        confirmLabel="Close booking"
        icon={PackageOpen}
        loading={closingShort}
      />

      <ConfirmModal
        open={!!confirmDraftScheduleKey}
        onClose={() => setConfirmDraftScheduleKey(null)}
        onConfirm={() => { const k = confirmDraftScheduleKey; setConfirmDraftScheduleKey(null); if (k) handleScheduleJob(k); }}
        title="Schedule job from a draft booking?"
        message="This booking is still a draft and hasn't been sent to the customer yet. You can schedule a job now, but the booking and its pricing may still change before it's sent. Continue?"
        confirmLabel="Schedule anyway"
        icon={CalendarClock}
      />

      {showRevertModal && (
        <Modal open={showRevertModal} onClose={() => { if (!reverting) { setShowRevertModal(false); setRevertReason(''); } }} title={`${revertLabel} quote`} footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={() => { setShowRevertModal(false); setRevertReason(''); }}
              disabled={reverting}
              className="min-h-11 w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRevertStatus}
              disabled={reverting || !revertReason.trim()}
              className="min-h-11 w-full sm:w-auto"
            >
              {reverting ? 'Reopening…' : revertLabel}
            </Button>
          </div>
        }>
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Reopens quote {quoteNumber} back to <strong>sent</strong> so it can be edited,
              re-sent, or converted again.{' '}
              {currentStatus === 'accepted'
                ? 'Blocked if an order has already been created from this quote.'
                : 'The quote re-enters the active pipeline.'}
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">Reason <span className="text-red-600">*</span></label>
              <textarea
                value={revertReason}
                onChange={(e) => setRevertReason(e.target.value)}
                maxLength={MAX_REVERT_REASON_LENGTH}
                rows={3}
                placeholder="Why is this quote being reopened?"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <p className="mt-1 text-xs text-secondary text-right">
                {revertReason.length}/{MAX_REVERT_REASON_LENGTH}
              </p>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmModal
        open={duplicateOrderConfirmOpen}
        onClose={() => setDuplicateOrderConfirmOpen(false)}
        onConfirm={executeConvertToOrder}
        title="Convert anyway?"
        message={duplicateOrderMsg}
        confirmLabel="Convert anyway"
        variant="warning"
      />

      {/* Phone: sticky above MobileBottomNav (min-h-11 + 1px border + safe area); -mx-4 undoes AppLayout main p-4.
          It sits in the page flow, so it never covers the last content. */}
      {hasBottomBar && (
        <div data-testid="quote-bottom-bar" className="sticky bottom-[calc(2.75rem+1px+env(safe-area-inset-bottom))] z-20 -mx-4 flex gap-2 border-t border-gray-200 bg-white px-4 pb-3.5 pt-2.5 shadow-[0_-1px_4px_rgba(0,0,0,0.08)]">
          {showSaveDraft && saveDraftButton('flex-1')}
          {greenAction && <div className="flex flex-[1.4] [&>*]:w-full">{greenAction}</div>}
        </div>
      )}
    </div>
  );
}

const NOTICE_TONES = {
  info: 'bg-blue-50 border-blue-100 text-blue-900',
  warn: 'bg-amber-50 border-amber-200 text-amber-800',
  brand: 'bg-crx-green-tint border-crx-green/20 text-crx-green',
} as const;

/** One-line page notice: icon, text (long help behind a HelpTip in the text), then its actions. */
function Notice({ tone, icon, actions, role, children }: {
  tone: keyof typeof NOTICE_TONES;
  icon: ReactNode;
  actions?: ReactNode;
  role?: 'status';
  children: ReactNode;
}) {
  return (
    <div role={role} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2.5 text-sm ${NOTICE_TONES[tone]}`}>
      <div className="flex min-w-0 flex-[1_1_20rem] items-start gap-2">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1">{children}</div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
