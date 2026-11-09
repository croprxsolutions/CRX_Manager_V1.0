import { useEffect, useState, useMemo , useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Truck,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  CalendarRange,
  MapPin,
  Clock,
  Zap,
  Download,
  FileText,
  Users,
  List,
  CalendarDays,
  PanelRightOpen,
  WifiOff,
  ChevronRight,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import Card from '../components/ui/Card';
import PhoneHeader from '../components/ui/PhoneHeader';
import SectionCard from '../components/ui/SectionCard';
import CustomerDrawer from '../components/customers/CustomerDrawer';
import { hasPageAccess } from '../lib/pagePermissions';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader';
import ReceiptsToCheck from '../components/deliveries/ReceiptsToCheck';
import SectionJumpBar from '../components/ui/SectionJumpBar';
import DataTable, { type Column } from '../components/ui/DataTable';
import type { SortDir } from '../lib/tableSearchSort';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult } from '../lib/db';
import type { Database, Json } from '../types/supabase';
import { fetchAllRows, fetchAllRowsForIds, pageWithList } from '../lib/pagedRead';
import { CriticalActionHandledError, runCriticalAction } from '../lib/criticalAction';
import { hasSignal, NO_SIGNAL_MESSAGE } from '../lib/connectivity';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useLatestRef } from '../hooks/useLatestRef';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { digestIntentPayload, fingerprintIntentPayload, getIdempotencyBindingRejection } from '../lib/idempotency';
import { isValidDeliveredOn, isValidNoProofReason, MAX_PAPER_TICKET_PHOTOS, NO_PROOF_REASON_MAX_CHARS, NO_PROOF_REASON_MIN_CHARS, NO_PROOF_SIGNER, noProofReasonLength, PAPER_TICKET_PHOTO_CAPTION } from '../lib/paperTicket';
import { COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE, INVALID_SIGNATURE_MESSAGE, isNetworkFailure, isSignatureDataUrl, isSignatureImageMissing, latestEvidencePhoto, mergePhotosById, reconcileFailedCompletion, signatureDigest, signatureImagePathFor, storedNoProofReason, uploadEvidencePhoto, uploadSignatureImage } from '../lib/deliveryEvidence';
import SignatureCanvas from '../components/ui/SignatureCanvas';
import { notifyDeliveryCompleted } from '../lib/notificationTriggers';
import BatchCancelModal from '../components/deliveries/BatchCancelModal';
import QuickDeliveryModal from '../components/deliveries/QuickDeliveryModal';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { localToday, parseLocalDate, formatLocalDate, todayInBusinessTz } from '../lib/dateUtils';
import { findShortDeliveries } from '../lib/inventoryShortage';
import { SkeletonTable, SkeletonCard } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import DeliveryCalendar from '../components/deliveries/DeliveryCalendar';
import type { Delivery, DeliveryCompletionEvidence, DeliveryEvidencePhoto, Profile } from '../types';

/* ─── Row type ─── */
interface DeliveryRow extends Delivery {
  customer_name: string;
  driver_name: string;
  item_count: number;
  // Its place in the chosen order (get_deliveries_page), used to re-sort a read made by id.
  sort_position?: number;
  farm_group_name: string | null;
}

/* ─── Helpers ─── */
// A completion an admin recorded without customer proof (completion_evidence = 'no_proof').
const NoProofLabel = () => (
  <span
    title="Recorded without customer proof (admin)"
    className="inline-flex items-center rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800"
  >
    No proof
  </span>
);
const today = () => localToday();
// Completion dates use the business day in America/Chicago, the day the server dates the delivery.
const businessToday = () => todayInBusinessTz();
const addDays = (d: string, n: number) => {
  const dt = parseLocalDate(d);
  dt.setDate(dt.getDate() + n);
  return formatLocalDate(dt);
};
const weekStart = () => {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return formatLocalDate(d);
};
const dayLabel = (d: string) => {
  const dt = parseLocalDate(d);
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

// Style D driver list: one white list per group, gray-100 dividers.
const DRIVER_SECTION_TITLE = 'mb-2 font-heading text-xl font-bold text-nav-dark';
const DRIVER_LIST = 'overflow-hidden rounded-xl border border-gray-200 bg-white divide-y divide-gray-100';

const priorityBadge = (p: string) => {
  const map: Record<string, { variant: 'default' | 'warning' | 'error' | 'info'; label: string }> = {
    low: { variant: 'default', label: 'Low' },
    normal: { variant: 'info', label: 'Normal' },
    high: { variant: 'warning', label: 'High' },
    urgent: { variant: 'error', label: 'Urgent' },
  };
  const s = map[p] || { variant: 'default' as const, label: p };
  return <Badge variant={s.variant}>{s.label}</Badge>;
};

/* ─── Server-side list (Goal 4) ─── */
// get_deliveries_keyset_page searches, filters, sorts and counts in the database and returns one page
// plus the true totals. Its default order keeps today's work first, then upcoming, then past.
const LIST_PAGE_SIZE = 50;
/** Page one has no bookmark: it reads from the top of the list. */
const FIRST_PAGE: (Json | null)[] = [null];
type NextBookmark = { key: string; page: number; cursor: Json | null };
/** The bookmark after the page on screen, only when it came from that same query and page. */
function nextBookmarkFor(next: NextBookmark | null, key: string, page: number): Json | null {
  return next && next.key === key && next.page === page ? next.cursor : null;
}
/** The bookmark no longer fits the list (the sort or the day changed) or is malformed: read again from page one. */
function isBookmarkRefused(error: unknown): boolean {
  return /DELIVERIES_PAGE_(STALE|BAD)_CURSOR/.test((error as { message?: string } | null)?.message ?? '');
}
const SEARCH_MAX_CHARS = 200;
interface DeliveriesSummary {
  visible_count: number;
  open_count: number;
  scheduled_today: number;
  in_progress: number;
  completed_this_week: number;
  strip: { date: string; count: number; unassigned: number }[];
}
interface DeliveriesPage {
  total_count: number;
  rows: DeliveryRow[];
  summary: DeliveriesSummary;
  /** The bookmark after this page's last row, to read the next page from; null on the last page. */
  next_cursor: Json | null;
}
interface DeliveriesQuery {
  p_today: string;
  p_week_start: string;
  p_search?: string | null;
  p_statuses?: string[] | null;
  p_driver_id?: string | null;
  p_priority?: string | null;
  p_customer_id?: string | null;
  p_date_from?: string | null;
  p_date_to?: string | null;
  p_sort_key?: string | null;
  p_sort_desc?: boolean;
}
// The database returns at most this many rows per call.
const FULL_READ_PAGE_SIZE = 500;
// limit null reads every matching row (exports, the load sheet, the calendar, the driver view), in pages of 500.
// With `after` (the previous page's next_cursor) a page starts right after that row, so deliveries that left
// the list in between never push one past the screen.
async function readDeliveriesPage(query: DeliveriesQuery, limit: number | null, after: Json | null = null): Promise<DeliveriesPage> {
  if (limit !== null) return readOnePage(query, limit, { after });
  // Pages are separate reads, so the list can change between them. A read whose total moved, or whose
  // rows do not add up to it, is read again. A count can stay equal through a change (one delivery
  // cancelled, another created), so a read that needed more than one page is returned only once a second
  // whole read matches it row for row, as fetchAllRows does. After three tries it is reported as failed.
  let unconfirmed: string | null = null;
  for (let attempt = 0; attempt < FULL_READ_ATTEMPTS; attempt++) {
    const result = await readAllPagesOnce(query);
    if (!result) { unconfirmed = null; continue; }
    if (result.pages === 1) return result.page;
    const key = JSON.stringify(result.page.rows);
    if (key === unconfirmed) return result.page;
    unconfirmed = key;
  }
  throw new Error('Deliveries kept changing while they were read. Please try again.');
}
const FULL_READ_ATTEMPTS = 3;
// Walk the list by delivery id, which never changes, so a delivery edited between pages is never skipped
// or repeated; then put the rows back in the chosen order. Null when the list changed mid-read.
async function readAllPagesOnce(query: DeliveriesQuery): Promise<{ page: DeliveriesPage; pages: number } | null> {
  const first = await readOnePage(query, FULL_READ_PAGE_SIZE, { afterId: FIRST_ID });
  const rows = [...first.rows];
  let pages = 1;
  for (let page = first; page.rows.length === FULL_READ_PAGE_SIZE; pages++) {
    page = await readOnePage(query, FULL_READ_PAGE_SIZE, { afterId: page.rows[page.rows.length - 1].id });
    if (page.total_count !== first.total_count) return null;
    rows.push(...page.rows);
  }
  if (rows.length !== first.total_count) return null;
  rows.sort((a, b) => (a.sort_position ?? 0) - (b.sort_position ?? 0));
  return { page: { ...first, rows }, pages };
}
// Below every delivery id: the first page of a read by id.
const FIRST_ID = '00000000-0000-0000-0000-000000000000';
// One page: from the top, after a delivery id (a read by id), or after a bookmark.
async function readOnePage(query: DeliveriesQuery, limit: number, from: { afterId?: string; after?: Json | null }): Promise<DeliveriesPage> {
  // Generated Args cannot say null; the function reads a null filter as "no filter".
  const args = {
    ...query, p_limit: limit, p_offset: 0,
    ...(from.afterId ? { p_after_id: from.afterId } : {}),
    ...(from.after ? { p_after: from.after } : {}),
  } as unknown as Database['public']['Functions']['get_deliveries_keyset_page']['Args'];
  const { data, error } = await supabase.rpc('get_deliveries_keyset_page', args);
  if (error) throw error;
  const page = assertRpcResult<DeliveriesPage>(data, 'get_deliveries_keyset_page');
  if (!Array.isArray(page.rows) || typeof page.total_count !== 'number' || !page.summary || !Array.isArray(page.summary.strip)
    || (page.next_cursor != null && (typeof page.next_cursor !== 'object' || Array.isArray(page.next_cursor)))) {
    throw new Error('get_deliveries_keyset_page returned an unexpected result');
  }
  return page;
}

const SELECTABLE_STATUSES = ['scheduled', 'in_progress'];
const DATE_PRESETS = [
  { value: '', label: 'All Dates' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'future', label: 'Upcoming' },
];

export default function Deliveries() {
  const { role, profile, deniedPages } = useAuth();
  const batchCancelIdem = useIdempotencyKey('batch_cancel_deliveries', profile?.id || '');
  const batchRescheduleIdem = useIdempotencyKey('batch_reschedule_deliveries', profile?.id || '');
  const reassignIdem = useIdempotencyKey('reassign_delivery', profile?.id || '');
  const isOnline = useOnlineStatus();
  // F3 act-from-list: complete a scheduled or in_progress delivery in place (signed-by popup).
  // One server call starts a scheduled delivery and completes it in a single transaction.
  const completeIdem = useIdempotencyKey('start_and_complete_delivery', profile?.id || '');
  const [completeTarget, setCompleteTarget] = useState<DeliveryRow | null>(null);
  const completeTargetRef = useLatestRef(completeTarget);
  // Bumped on every open and close of the complete dialog, so a request started in an
  // earlier dialog session can never submit or close a later one.
  const completeDialogGenRef = useRef(0);
  // The same session number as state, for what the dialog renders (e.g. the per-session upload spinner).
  const [completeDialogGen, setCompleteDialogGen] = useState(0);
  const bumpCompleteDialogGen = () => {
    completeDialogGenRef.current += 1;
    setCompleteDialogGen(completeDialogGenRef.current);
    return completeDialogGenRef.current;
  };
  const closeCompleteDialog = () => {
    bumpCompleteDialogGen();
    setCompleteTarget(null);
    setSignedBy('');
    setDeliveredOnDate(businessToday());
    resetCompleteEvidence();
    setNoProofConfirmOpen(false);
  };
  // Send the in-app completion notification at most once per delivery. start_and_complete_delivery
  // is idempotent but returns no replay marker, so a same-key retry after a lost
  // response replays its cached success; the stable delivery id avoids duplicate
  // driver/admin notifications on that replay (Codex P2).
  const notifiedCompletionFor = useRef<Set<string>>(new Set());
  const [signedBy, setSignedBy] = useState('');
  const [deliveredOnDate, setDeliveredOnDate] = useState(businessToday());
  // Goal 5 (migration 20261022075000): the server completes only with saved proof, either the
  // on-screen signature or a photo of the signed paper ticket, or (admin only) a written reason
  // recorded without proof.
  const [completeEvidence, setCompleteEvidence] = useState<DeliveryCompletionEvidence>('signature');
  const [completeSignature, setCompleteSignature] = useState<string | null>(null);
  const [noProofReason, setNoProofReason] = useState('');
  // A no-proof record is confirmed in a second step, as on the delivery page.
  const [noProofConfirmOpen, setNoProofConfirmOpen] = useState(false);
  // Every ticket-photo read and local add takes a number; only the newest read may replace the list.
  const ticketPhotoSeqRef = useRef(0);
  // The saved ticket photos of the delivery in the dialog (one saved earlier, e.g. by the driver, counts).
  const [ticketPhotos, setTicketPhotos] = useState<{ deliveryId: string; photos: DeliveryEvidencePhoto[] } | null>(null);
  // The dialog session whose ticket photo is uploading, so a later session never shows its spinner.
  const [uploadingTicketGen, setUploadingTicketGen] = useState<number | null>(null);
  const uploadingTicket = uploadingTicketGen !== null && uploadingTicketGen === completeDialogGen;
  const ticketInputRef = useRef<HTMLInputElement>(null);
  const resetCompleteEvidence = () => {
    setCompleteEvidence('signature');
    setCompleteSignature(null);
    setNoProofReason('');
    setTicketPhotos(null);
  };
  const loadTicketPhotos = async (deliveryId: string, dialogGen: number) => {
    const seq = ++ticketPhotoSeqRef.current;
    const { data, error } = await supabase.from('delivery_photos')
      .select('id, storage_path, image_url, caption, uploaded_at')
      .eq('delivery_id', deliveryId).eq('caption', PAPER_TICKET_PHOTO_CAPTION)
      .order('uploaded_at');
    if (completeDialogGenRef.current !== dialogGen) return;
    // A newer read, or a photo saved meanwhile, superseded this read: it must not replace the list.
    if (seq !== ticketPhotoSeqRef.current) return;
    if (error) {
      Sentry.captureException(error, { extra: { context: 'Load ticket photos for Mark Delivered' } });
      toast('error', 'Saved ticket photos could not be loaded. Close and reopen this dialog to try again.');
      return;
    }
    // The server's list replaces the shown one, so a photo no longer saved disappears too.
    setTicketPhotos({ deliveryId, photos: (data || []) as DeliveryEvidencePhoto[] });
  };
  const currentTicketPhotos = ticketPhotos && ticketPhotos.deliveryId === completeTarget?.id ? ticketPhotos.photos : [];
  const currentTicketPhoto = latestEvidencePhoto(currentTicketPhotos, PAPER_TICKET_PHOTO_CAPTION);
  const canRecordWithoutProof = role === 'admin';
  // A role change (or a profile that loads late) never leaves a non-admin on the no-proof path.
  useEffect(() => {
    if (!canRecordWithoutProof && completeEvidence === 'no_proof') setCompleteEvidence('signature');
  }, [canRecordWithoutProof, completeEvidence]);
  // A delivery recorded without proof is signed with the fixed office text, never a customer's name.
  const completeSignedBy = completeEvidence === 'no_proof' ? NO_PROOF_SIGNER : signedBy.trim();
  // The dialog's editable inputs, compared after each signal check (see handleCompleteConfirm).
  const completeInputsRef = useLatestRef(JSON.stringify([completeSignedBy, deliveredOnDate, completeEvidence, completeSignature, noProofReason]));
  const [completing, setCompleting] = useState(false);
  // Claimed synchronously at the start of a submit, so a second tap never starts a second attempt.
  const completeClaimRef = useRef(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  // The list view holds one page; the calendar and the driver view hold every matching row.
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  // Every row matching the list's search and filters, and the cards and strip, from the same read.
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState<DeliveriesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // A page, sort, search or filter change is loading (the first load shows the skeleton instead).
  const [pageLoading, setPageLoading] = useState(false);
  // The last load failed: the page shows an error instead of an empty or partial list.
  const [loadFailed, setLoadFailed] = useState(false);

  /* Filters */
  const [statusFilter, setStatusFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [datePreset, setDatePreset] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [scheduleDate, setScheduleDate] = useState(''); // from schedule strip click

  /* Lookup data */
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  // Customer 360 peek drawer (F2) — view a customer's numbers without leaving the list.
  const [drawerCustomer, setDrawerCustomer] = useState<{ id: string; name: string } | null>(null);

  /* Batch selection */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [printingLoadSheet, setPrintingLoadSheet] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');

  // Codex P2 fix (PR #59, 2026-05-16): reset batchRescheduleIdem when the
  // selection or target date changes. Same response-lost replay bug pattern
  // as the BlendTickets/Invoices batch ops — stable selection+date = same
  // key = idempotent retry; different selection or date = fresh intent.
  const rescheduleIntentKey = `${Array.from(selected).sort().join(',')}|${rescheduleDate}`;
  useEffect(() => {
    batchRescheduleIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rescheduleIntentKey]);

  const [rescheduling, setRescheduling] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const exportingCsvRef = useRef(false);

  /* Quick Delivery modal */
  const [quickDeliveryOpen, setQuickDeliveryOpen] = useState(false);
  const [quickDeliveryInitialCustomerId, setQuickDeliveryInitialCustomerId] = useState<string>();

  /* View mode: list or calendar */
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');

  /* Remainder count for summary */
  const [remainderCount, setRemainderCount] = useState(0);

  /* Inventory shortage tracking */
  const [shortageDeliveryIds, setShortageDeliveryIds] = useState<Set<string>>(new Set());
  // The last stock check failed: no badges then means "not checked", not "enough stock".
  const [shortageCheckFailed, setShortageCheckFailed] = useState(false);
  // True until a stock check finishes: until then, no badge does not yet mean enough stock.
  const [shortageChecking, setShortageChecking] = useState(true);

  /* Driver-specific: unassigned deliveries they can claim */
  const [unassigned, setUnassigned] = useState<DeliveryRow[]>([]);
  const [listSearch, setListSearch] = useState('');
  // The search the database runs: settles 300 ms after the last keystroke, so typing sends one read.
  const [searchTerm, setSearchTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(listSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [listSearch]);
  const [sortState, setSortState] = useState<{ key: string | null; dir: SortDir }>({ key: null, dir: 'asc' });

  const canCreate = role === 'admin' || role === 'sales_rep';
  const canQuickDeliver = role === 'admin' || role === 'sales_rep';
  const isDriver = role === 'driver';
  // Customer 360 peek shows AR balance + credit tier. Gate it with the canonical
  // customers-page permission: this blocks drivers (not in the page's roles — Codex
  // P1) AND a sales rep who has /customers in their deny-list (Codex P2).
  const canPeekCustomer = hasPageAccess(role, deniedPages, 'customers');

  // Consume a Quick Delivery deep link per navigation. The param strip is the
  // re-entry guard; a repeat deep link re-adds the param and re-opens the modal.
  useEffect(() => {
    if (searchParams.get('quickDeliver') !== '1') return;
    if (!role) return;

    if (canQuickDeliver) {
      setQuickDeliveryInitialCustomerId(searchParams.get('customer_id') || undefined);
      setQuickDeliveryOpen(true);
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('quickDeliver');
    nextSearchParams.delete('customer_id');
    setSearchParams(nextSearchParams, { replace: true });
  }, [canQuickDeliver, role, searchParams, setSearchParams]);

  const closeQuickDelivery = () => {
    setQuickDeliveryOpen(false);
    setQuickDeliveryInitialCustomerId(undefined);
  };

  const fetchDrivers = useCallback(async () => {
    // PR-07 follow-up: driver filter dropdown only uses d.id + d.full_name; safe via view.
    const { data, error } = await fetchAllRows((from, to) => supabase
      .from('profile_public_view')
      .select('id, full_name, role, is_active', { count: 'exact' })
      .eq('role', 'driver')
      .eq('is_active', true)
      .order('full_name')
      .order('id')
      .range(from, to));
    if (error) {
      toast('error', 'Failed to load drivers: ' + error.message);
      return;
    }
    setDrivers((data || []) as Profile[]);
  }, [toast]);

  const fetchCustomers = useCallback(async () => {
    // Every active customer, page by page: one request stops at the server's row cap.
    const { data, error } = await fetchAllRows<{ id: string; farm_name: string }>((from, to) => supabase
      .from('customers')
      .select('id, farm_name', { count: 'exact' })
      .eq('is_active', true)
      .order('farm_name')
      .order('id')
      .range(from, to));
    if (error) {
      toast('error', 'Failed to load customers: ' + error.message);
      return;
    }
    setCustomers(data || []);
  }, [toast]);

  const fetchRemainderCount = useCallback(async () => {
    const { count, error } = await supabase
      .from('delivery_remainders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'deliveries' } });
      return;
    }
    setRemainderCount(count || 0);
  }, []);

  /* ─── What the database is asked for ─── */
  const todayStr = today();
  const weekStartStr = weekStart();
  // The list's filters (also what the calendar's export and load sheet read).
  const filterQuery = useMemo<DeliveriesQuery>(() => {
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    if (scheduleDate) {
      dateFrom = scheduleDate;
      dateTo = scheduleDate;
    } else if (datePreset === 'today') {
      dateFrom = todayStr;
      dateTo = todayStr;
    } else if (datePreset === 'week') {
      dateFrom = weekStartStr;
      dateTo = addDays(weekStartStr, 6);
    } else if (datePreset === 'future') {
      dateFrom = todayStr;
    }
    return {
      p_today: todayStr,
      p_week_start: weekStartStr,
      p_statuses: statusFilter ? [statusFilter] : null,
      p_driver_id: driverFilter || null,
      p_priority: priorityFilter || null,
      p_customer_id: customerFilter || null,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    };
  }, [todayStr, weekStartStr, statusFilter, driverFilter, priorityFilter, customerFilter, scheduleDate, datePreset]);
  // The list adds its search and column sort. The calendar hides the search box, so there it does not apply.
  const listQuery = useMemo<DeliveriesQuery>(() => ({
    ...filterQuery,
    p_search: searchTerm || null,
    p_sort_key: sortState.key,
    p_sort_desc: sortState.dir === 'desc',
  }), [filterQuery, searchTerm, sortState]);
  // Drivers see every delivery of theirs (row level security limits them to those); the calendar
  // shows every delivery of the chosen status; the list reads one page at a time.
  const paged = !isDriver && viewMode === 'list';
  const loadQuery = useMemo<DeliveriesQuery>(() => {
    // Row level security already limits a driver to their deliveries; the filter keeps that if it ever widens.
    if (isDriver) return { p_today: todayStr, p_week_start: weekStartStr, p_driver_id: profile?.id ?? null };
    // As before, the calendar shows every delivery except cancelled and voided, unless one of those is chosen.
    if (viewMode === 'calendar') {
      return { p_today: todayStr, p_week_start: weekStartStr, p_statuses: statusFilter === 'cancelled' || statusFilter === 'voided' ? [statusFilter] : null };
    }
    return listQuery;
  }, [isDriver, profile?.id, viewMode, todayStr, weekStartStr, statusFilter, listQuery]);
  // Each list page is read from the bookmark (the last row) of the page before it, so deliveries removed in
  // between never push one past the screen. afters[i] is page i's bookmark; the last one is on screen.
  // The pages belong to one query: a new search, filter or sort starts again at page one.
  const loadQueryKey = JSON.stringify(loadQuery);
  const [pageState, setPageState] = useState({ key: '', afters: FIRST_PAGE });
  const afters = paged && pageState.key === loadQueryKey ? pageState.afters : FIRST_PAGE;
  const listPage = afters.length - 1;
  // The bookmark after the page on screen, from its own read; null on the last page.
  const [nextState, setNextState] = useState<NextBookmark | null>(null);
  const nextCursor = nextBookmarkFor(nextState, loadQueryKey, listPage);
  const goNext = () => {
    if (nextCursor !== null) setPageState({ key: loadQueryKey, afters: [...afters, nextCursor] });
  };
  const goPrevious = () => {
    if (listPage > 0) setPageState({ key: loadQueryKey, afters: afters.slice(0, -1) });
  };
  useEffect(() => {
    setPageState((prev) => (prev.key === loadQueryKey ? prev : { key: loadQueryKey, afters: FIRST_PAGE }));
  }, [loadQueryKey]);
  // The page of the rows on screen, so the pager never pairs a new page number with old rows.
  const [loadedPage, setLoadedPage] = useState(0);

  // A read can finish after a newer one started (a page flip, or a refresh after completing or
  // cancelling); only the latest read may set the list, its counts or the loading state.
  const fetchSeq = useRef(0);
  const loadDeliveries = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setPageLoading(true);
    try {
      const result = await readDeliveriesPage(loadQuery, paged ? LIST_PAGE_SIZE : null, afters[listPage]);
      if (seq !== fetchSeq.current) return;
      // Every delivery after the bookmark was removed (e.g. cancelled): step back to the page before.
      if (listPage > 0 && result.rows.length === 0) {
        setPageState({ key: loadQueryKey, afters: afters.slice(0, -1) });
        return;
      }
      setDeliveries(result.rows);
      setLoadedPage(listPage);
      setNextState({ key: loadQueryKey, page: listPage, cursor: result.next_cursor ?? null });
      setTotalCount(result.total_count);
      setSummary(result.summary);
      setLoadFailed(false);
    } catch (error) {
      if (seq !== fetchSeq.current) return;
      // The bookmark no longer fits this list (e.g. the day changed): start again at page one, with no error.
      if (listPage > 0 && isBookmarkRefused(error)) {
        setPageState({ key: loadQueryKey, afters: FIRST_PAGE });
        return;
      }
      // A failed read shows an error, never an empty or partial list with complete-looking counts.
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'deliveries' } });
      toast('error', 'Failed to load deliveries. Please try again.');
      setDeliveries([]);
      setTotalCount(0);
      setSummary(null);
      setLoadFailed(true);
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setPageLoading(false);
      }
    }
  }, [loadQuery, loadQueryKey, paged, afters, listPage, toast]);

  // Inventory shortage check over every scheduled or in-progress delivery the user can see, not
  // only the shown page: products are summed across all of them before comparing to stock.
  const shortageSeq = useRef(0);
  const loadShortages = useCallback(async () => {
    const seq = ++shortageSeq.current;
    setShortageChecking(true);
    try {
      const { data: diData, error: diError } = await fetchAllRows((from, to) => pageWithList(supabase
        .from('delivery_items')
        .select('id, delivery_id, product_id, quantity, delivery:deliveries!inner(status)', { count: 'exact' })
        .in('delivery.status', ['scheduled', 'in_progress'])
        .order('id')
        .range(from, to)));
      if (seq !== shortageSeq.current) return;
      if (diError || !diData) throw diError ?? new Error('delivery items read returned no list');

      const productIds = [...new Set((diData as Array<{ product_id: string }>).map((i) => i.product_id).filter(Boolean))];
      let invMap: Record<string, number> = {};
      if (productIds.length > 0) {
        const { data: invData, error: invError } = await fetchAllRowsForIds(productIds, (idChunk, from, to) => pageWithList(supabase
          .from('inventory')
          .select('id, product_id, quantity_available', { count: 'exact' })
          .in('product_id', idChunk)
          .eq('location', 'Main Warehouse')
          .order('id')
          .range(from, to)));
        if (seq !== shortageSeq.current) return;
        if (invError) throw invError;
        invMap = {};
        for (const row of (invData || []) as Array<{ product_id: string; quantity_available: number }>) {
          invMap[row.product_id] = (invMap[row.product_id] || 0) + Number(row.quantity_available);
        }
      }
      // Sum each product across ALL active deliveries before comparing to stock, so tier-split
      // lines and deliveries competing for the same product are flagged together.
      // See src/lib/inventoryShortage.ts.
      const lines = (diData as Array<{ delivery_id: string; product_id: string; quantity: number }>)
        .map((item) => ({ deliveryId: item.delivery_id, productId: item.product_id, quantity: Number(item.quantity) }));
      setShortageDeliveryIds(findShortDeliveries(lines, invMap));
      setShortageCheckFailed(false);
    } catch (err) {
      if (seq !== shortageSeq.current) return;
      // A failed check is said out loud: no badge must never be mistaken for "enough stock".
      Sentry.captureException(err, { tags: { source: 'fetch', page: 'deliveries', action: 'shortage_check' } });
      toast('error', 'Stock shortage warnings could not be checked. Reload to try again.');
      setShortageDeliveryIds(new Set());
      setShortageCheckFailed(true);
    } finally {
      if (seq === shortageSeq.current) setShortageChecking(false);
    }
  }, [toast]);

  // After a change (complete, cancel, reschedule): re-read the shown page and the shortage check.
  const fetchDeliveries = useCallback(async () => {
    void loadShortages();
    await loadDeliveries();
  }, [loadDeliveries, loadShortages]);

  // F3 act-from-list: complete a delivery in full, in place. p_quantities omitted = deliver
  // in full. Partial deliveries, issue flags and the customer receipt email stay on the detail page.
  // The proof is captured here: an on-screen signature, a photo of the signed paper ticket, or
  // (admin only) a written reason recorded without proof. One server call, start_and_complete_delivery, starts a scheduled delivery and completes it
  // in a single transaction, so a lost signal can never leave it half done (In Progress).
  // Goal 5: completing needs a signal, checked before that call.
  // Mark Delivered: a no-proof record asks for confirmation first; every other path submits directly.
  const requestCompleteConfirm = () => {
    if (completeEvidence === 'no_proof') {
      if (!canRecordWithoutProof) { toast('error', 'Only an admin can record a delivery without proof'); return; }
      if (!isValidNoProofReason(noProofReason)) {
        toast('error', `Write why there is no proof (${NO_PROOF_REASON_MIN_CHARS} to ${NO_PROOF_REASON_MAX_CHARS} characters)`);
        return;
      }
      setNoProofConfirmOpen(true);
      return;
    }
    void handleCompleteConfirm();
  };

  const handleCompleteConfirm = async () => {
    setNoProofConfirmOpen(false);
    if (completeClaimRef.current) return;
    completeClaimRef.current = true;
    try {
      await runCompleteConfirm();
    } finally {
      completeClaimRef.current = false;
    }
  };

  const runCompleteConfirm = async () => {
    if (!completeTarget || !profile) return;
    // The submitted mode decides every follow-up below (never a checkbox read later).
    const submittedEvidence = completeEvidence;
    if (submittedEvidence === 'no_proof') {
      if (!canRecordWithoutProof) { toast('error', 'Only an admin can record a delivery without proof'); return; }
      if (!isValidNoProofReason(noProofReason)) {
        toast('error', `Write why there is no proof (${NO_PROOF_REASON_MIN_CHARS} to ${NO_PROOF_REASON_MAX_CHARS} characters)`);
        return;
      }
    } else if (!signedBy.trim()) { toast('error', 'Please enter a signature name'); return; }
    // The date is required: an empty date would silently date the delivery and invoice to today.
    if (!isValidDeliveredOn(deliveredOnDate)) {
      toast('error', 'Enter the delivery date (today or earlier)');
      return;
    }
    if (submittedEvidence === 'signature' && !completeSignature) {
      toast('error', 'Have the customer sign on screen, or choose the paper ticket and add its photo');
      return;
    }
    if (submittedEvidence === 'signature' && !isSignatureDataUrl(completeSignature)) {
      toast('error', INVALID_SIGNATURE_MESSAGE);
      return;
    }
    if (submittedEvidence === 'paper_ticket' && !currentTicketPhoto) {
      toast('error', 'Add a photo of the signed paper ticket before completing');
      return;
    }
    const target = completeTarget;
    const signatureAtSubmit = completeSignature;
    const ticketPhotoAtSubmit = submittedEvidence === 'paper_ticket' ? currentTicketPhoto : undefined;
    const reasonAtSubmit = noProofReason;
    // Captured before any await, so a cancel during the hashing or a signal check is seen.
    const dialogGen = completeDialogGenRef.current;
    // The chosen business date (America/Chicago) goes to the server as a date: the server
    // completes "today" at its own clock and an earlier date at midday of that date, so a
    // "today" request that reaches it just after Chicago midnight keeps the chosen day.
    const completeParams = {
      p_delivery_id: target.id,
      p_signed_by: completeSignedBy,
      p_delivered_on: deliveredOnDate,
      p_performed_by: profile.id,
      p_evidence: submittedEvidence,
      // The exact ticket photo shown as saved (the signature's reference comes from the key).
      ...(ticketPhotoAtSubmit ? { p_evidence_ref: ticketPhotoAtSubmit.id } : {}),
      // no_proof: the reason exactly as typed (the server collapses whitespace; an exact retry resends it).
      ...(submittedEvidence === 'no_proof' ? { p_evidence_ref: reasonAtSubmit } : {}),
    };
    // The server binds the key to this exact request (mode, signer, date, photo or reason), so a
    // retry with an edited value mints a fresh key instead of being refused. The scope uses the
    // collision-resistant SHA-256 digest (digestIntentPayload), never the 64-bit FNV fingerprint
    // (see idempotency.ts). A re-drawn signature is a new attempt: new key, new signature file.
    const completeScope = `start-complete:${await digestIntentPayload({
      ...completeParams,
      signature_digest: submittedEvidence === 'signature' && signatureAtSubmit ? await signatureDigest(signatureAtSubmit) : null,
    })}`;
    const idemKey = completeIdem.getKeyFor(completeScope);
    // start_and_complete_delivery completes under `<key>:complete`; the server accepts only the
    // image at the path it derives from that, so a retry of this key reuses the same file.
    const signaturePath = submittedEvidence === 'signature' ? await signatureImagePathFor(target.id, `${idemKey}:complete`) : undefined;
    let signatureUploadError: unknown = null;
    // The signal check takes a few seconds; if the dialog was cancelled or switched to
    // another delivery meanwhile, stop before sending the server call. These checks gate only the
    // DISPATCH: once the call is sent, its result is always reconciled for this delivery.
    const stillOpenForTarget = () =>
      completeDialogGenRef.current === dialogGen && completeTargetRef.current?.id === target.id;
    // An edit to the signer, date, mode or reason during the check must not be dropped in favour of the old values.
    const inputsAtSubmit = JSON.stringify([completeSignedBy, deliveredOnDate, submittedEvidence, completeSignature, noProofReason]);
    const inputsUnchanged = () => completeInputsRef.current === inputsAtSubmit;
    // An error toast for a delivery whose dialog was closed or switched names it.
    const forTarget = (message: string) => (stillOpenForTarget() ? message : `Delivery ${target.delivery_number}: ${message}`);
    // Route through runCriticalAction for parity with this page's other mutations.
    await runCriticalAction<'completed' | 'no_signal' | 'cancelled' | 'changed'>({
      action: async () => {
        if (!(await hasSignal())) return 'no_signal';
        if (!stillOpenForTarget()) return 'cancelled';
        if (!inputsUnchanged()) return 'changed';
        // The server completes only once this attempt's signature image is saved, so it goes up
        // first. A failed upload does not stop the call: after a lost reply the earlier attempt may
        // already have completed the delivery (storage then refuses the re-upload). The same key
        // replays that completion, or the server refuses SIGNATURE_IMAGE_MISSING and nothing changes.
        if (signaturePath && signatureAtSubmit) {
          try {
            await uploadSignatureImage(signaturePath, signatureAtSubmit);
          } catch (sigErr) {
            signatureUploadError = sigErr;
            Sentry.captureException(sigErr instanceof Error ? sigErr : new Error(String(sigErr)), { level: 'warning', extra: { context: 'Deliveries list signature upload before completion failed; sending the completion anyway' } });
          }
          if (!stillOpenForTarget()) return 'cancelled';
          if (!inputsUnchanged()) return 'changed';
        }
        // Sends this attempt exactly: the same inputs and key every time (a lost-reply replay included).
        // completeIdem is intentionally retained until onSuccess, so a retry after a lost response
        // replays the same request idempotently. Any replay-binding refusal (another request's or
        // person's key, or a receipt that can never be used) retires it; nothing ran for THIS request.
        // Safe for a completion even if an earlier attempt committed: the next try runs fresh and the
        // server refuses a completed delivery. So does SIGNATURE_IMAGE_MISSING: this key's image is
        // not saved and never will be under it.
        const sendCompletion = async (): Promise<unknown> => {
          const { data, error: rpcError } = await supabase.rpc('start_and_complete_delivery', {
            ...completeParams,
            ...(signaturePath ? { p_evidence_ref: signaturePath } : {}),
            p_idempotency_key: idemKey,
          });
          try {
            if (rpcError) throw rpcError;
            assertRpcResult(data, 'start_and_complete_delivery');
          } catch (error: unknown) {
            if (getIdempotencyBindingRejection(error) || isSignatureImageMissing(error)) {
              completeIdem.resetKeyFor(completeScope);
            }
            throw error;
          }
          return data;
        };
        try {
          await sendCompletion();
          return 'completed';
        } catch (error: unknown) {
          // A binding refusal or SIGNATURE_IMAGE_MISSING retired the key in sendCompletion; nothing ran
          // for THIS request. Otherwise the key is still held: the reply may have been lost after a commit.
          const bindingRejected = !!getIdempotencyBindingRejection(error);
          const keyHeld = !bindingRejected && !isSignatureImageMissing(error);
          Sentry.captureException(error, { tags: { source: 'critical_action', action: 'start_and_complete_delivery' } });
          // Reconcile for THIS delivery while the button still shows it is working. Completed with the
          // key still held: resend the identical call, which replays the saved result, and run the
          // normal success path.
          const reconciled = await reconcileFailedCompletion({ deliveryId: target.id, keyHeld, resend: sendCompletion, context: 'Deliveries list' });
          if (reconciled.kind === 'replayed') return 'completed';
          if (reconciled.kind === 'completed_not_replayed') {
            toast('error', forTarget(COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE));
          } else {
            toast('error', forTarget(sanitizeError(error)));
            // The upload had already failed for a reason other than the signal: say what it was.
            if (isSignatureImageMissing(error) && signatureUploadError && !isNetworkFailure(signatureUploadError)) {
              toast('error', forTarget(sanitizeError(signatureUploadError)));
            }
          }
          if (bindingRejected || reconciled.kind === 'completed_not_replayed' || reconciled.kind === 'closed') {
            // The delivery is no longer open (or the key was refused and retired): close the dialog and
            // reload, so a completion an earlier attempt committed shows instead of a stale dialog.
            if (completeDialogGenRef.current === dialogGen) closeCompleteDialog();
            await fetchDeliveries();
          } else if (reconciled.kind === 'open' && completeDialogGenRef.current === dialogGen) {
            // Still open: the dialog stays, with the SAME retained key (unless retired above), so a retry
            // after a lost response replays the saved result. Its ticket photos are re-read.
            await loadTicketPhotos(target.id, dialogGen);
          }
          throw new CriticalActionHandledError('Completion failure already reported and reconciled');
        }
      },
      toast,
      setLoading: setCompleting,
      sentryTag: 'start_and_complete_delivery',
      onSuccess: (result) => {
        if (result === 'changed') {
          toast('warning', 'Details changed while checking for signal. Nothing was changed; check them and tap again.');
          return;
        }
        if (result === 'cancelled') {
          toast('warning', 'Cancelled. Nothing was changed.');
          return;
        }
        if (result !== 'completed') {
          toast('error', NO_SIGNAL_MESSAGE);
          return;
        }
        completeIdem.resetKeyFor(completeScope);
        if (submittedEvidence === 'no_proof') {
          toast('success', `Delivery ${target.delivery_number} recorded as completed without proof`);
          toast('info', 'No receipt was emailed. The office can send one later with Email Confirmation on the delivery.');
          void storedNoProofReason(target.id, reasonAtSubmit).then((reason) => logActivity({
            event: 'delivery_completed',
            description: `Delivery ${target.delivery_number} completed (recorded without proof: ${reason}) (from the Deliveries list)`,
            performedBy: profile.id,
            entityType: 'delivery',
            entityId: target.id,
            customerId: target.customer_id,
          }));
        } else {
          toast('success', `Delivery ${target.delivery_number} completed`);
        }
        // Fire the same in-app completion notification the detail page sends
        // (driver/admins/sales) — once per delivery so a same-key RPC replay after
        // a lost response can't duplicate it. The customer EMAIL receipt is sent
        // from the delivery's page (rich HTML w/ items+photos the list doesn't
        // load) — see the modal note. Fire-and-forget; never blocks the success path.
        if (!notifiedCompletionFor.current.has(target.id)) {
          notifiedCompletionFor.current.add(target.id);
          notifyDeliveryCompleted(target.id, target.delivery_number, target.customer_name, target.assigned_driver, target.order_id, false).catch(() => { /* non-critical */ });
        }
        // Close only the dialog session this request came from.
        if (completeDialogGenRef.current === dialogGen) closeCompleteDialog();
        fetchDeliveries();
      },
    });
  };

  useEffect(() => { void loadDeliveries(); }, [loadDeliveries]);
  // The stock check covers every open delivery, not the shown page, so it runs on opening and after each
  // change made here, not on every page flip (that would reread every open delivery's items each time).
  useEffect(() => {
    void loadShortages();
    fetchDrivers();
    fetchCustomers();
    fetchRemainderCount();
  }, [loadShortages, fetchDrivers, fetchCustomers, fetchRemainderCount]);

  // Fetch unassigned deliveries for driver dashboard
  useEffect(() => {
    if (!isDriver) return;
    (async () => {
      const { data, error: unassignedErr } = await supabase
        .from('deliveries')
        .select('*, customer:customers(farm_name, parent_customer_id)')
        .is('assigned_driver', null)
        .in('status', ['scheduled'])
        .order('scheduled_date')
        .limit(20);
      if (unassignedErr) {
        Sentry.captureException(unassignedErr, { tags: { source: 'fetch', page: 'deliveries' } });
        return;
      }
      const pIds = [...new Set(
        (data || []).map((d: Record<string, unknown>) => (d.customer as { parent_customer_id?: string })?.parent_customer_id).filter(Boolean) as string[]
      )];
      const pMap: Record<string, string> = {};
      if (pIds.length > 0) {
        const { data: parents, error: pErr } = await supabase.from('customers').select('id, farm_name').in('id', pIds);
        if (pErr) Sentry.captureException(pErr, { tags: { source: 'fetch', page: 'deliveries' } });
        (parents || []).forEach((p) => { pMap[p.id] = p.farm_name; });
      }
      const rows = (data || []).map((d) => {
        const cust = d.customer as { farm_name?: string; parent_customer_id?: string } | null;
        return {
          ...d,
          customer_name: cust?.farm_name || 'Unknown',
          driver_name: 'Unassigned',
          item_count: 0,
          farm_group_name: cust?.parent_customer_id ? pMap[cust.parent_customer_id] || null : null,
        };
      });
      setUnassigned(rows as DeliveryRow[]);
    })();
  }, [isDriver]);

  /* ─── Summary stats and 7-day strip: every visible delivery that is not cancelled or voided,
     whatever the list's search and filters, counted by the database ─── */
  const scheduledToday = summary?.scheduled_today ?? 0;
  const inProgress = summary?.in_progress ?? 0;
  const completedThisWeek = summary?.completed_this_week ?? 0;
  const scheduleStrip = summary?.strip ?? [];
  // Whether any delivery exists at all, for the empty-list message.
  const anyDeliveries = (summary?.visible_count ?? 0) > 0 || totalCount > 0;

  // The database already searched, filtered and sorted: the list shows its rows as they come.
  const searched = deliveries;
  // A row the search or filters hide stops being selected, so no batch action reaches it and the
  // reschedule retry key (keyed on the selection) starts fresh.
  useEffect(() => {
    setSelected((prev) => {
      const shown = new Set(searched.map((d) => d.id));
      const next = new Set([...prev].filter((id) => shown.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [searched]);

  /* ─── Batch actions ─── */
  // While a new page, search or filter loads (or a search is still being typed), the rows on screen belong
  // to the old query: nothing acts on them, and exports wait for the query on screen.
  const listSettling = pageLoading || listSearch.trim() !== searchTerm;
  const selectedDeliveries = listSettling ? [] : searched.filter((d) => selected.has(d.id));
  const selectableShown = searched.filter((d) => SELECTABLE_STATUSES.includes(d.status));
  const allShownSelected = selectableShown.length > 0 && selectableShown.every((d) => selected.has(d.id));
  const activeFilterCount = [statusFilter, driverFilter, priorityFilter, customerFilter, scheduleDate || datePreset].filter(Boolean).length;
  const selectedCancellable = selectedDeliveries.filter((d) => SELECTABLE_STATUSES.includes(d.status));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allShownSelected ? new Set() : new Set(selectableShown.map((d) => d.id)));
  };

  const handleBatchCancel = async (reason: string) => {
    if (!profile) {
      toast('error', 'Cannot cancel deliveries — profile not loaded. Please refresh.');
      return;
    }
    const ids = selectedCancellable.map((d) => d.id);
    if (ids.length === 0) {
      toast('error', 'No cancellable deliveries selected');
      return;
    }
    await runCriticalAction({
      action: async () => {
        // One key per set of deliveries, in any order: the server binds this key to its request, so edited details after a lost reply are refused with the committed result.
        const cancelScope = fingerprintIntentPayload([...ids].sort());
        const { data, error } = await supabase.rpc('batch_cancel_deliveries', {
          p_delivery_ids: ids,
          p_cancel_reason: reason,
          p_performed_by: profile.id,
          p_idempotency_key: batchCancelIdem.getKeyFor(cancelScope),
        });
        if (error) {
          // Refused as another request's or another person's retry key: nothing changed, so start the next try fresh.
          // Only 'intent' and 'actor' prove nothing committed under this key; a 'receipt' refusal keeps it.
          const bindingRejection = getIdempotencyBindingRejection(error);
          if (bindingRejection === 'intent' || bindingRejection === 'actor') batchCancelIdem.resetKeyFor(cancelScope);
          // A changed reason after a lost reply: the earlier cancel already committed, so show the current list.
          if (bindingRejection === 'intent') {
            setSelected(new Set());
            await fetchDeliveries();
            throw new Error('An earlier cancel of these deliveries already went through. The list has been refreshed.');
          }
          throw error;
        }
        // The server skips any delivery that completed or was cancelled since this list loaded.
        const cancelled = assertRpcResult<number>(data, 'batch_cancel_deliveries');
        batchCancelIdem.resetKeyFor(cancelScope);
        if (cancelled > 0) logActivity({ event: 'batch_cancel_deliveries', description: `Batch cancelled ${cancelled} of ${ids.length} selected delivery(ies). Reason: ${reason}`, performedBy: profile.id });
        return cancelled;
      },
      toast,
      setLoading: setCancelling,
      sentryTag: 'batch_cancel_deliveries',
      onSuccess: (cancelled) => {
        const skipped = ids.length - cancelled;
        if (skipped > 0) {
          toast('warning', `Cancelled ${cancelled} of ${ids.length} delivery(ies). ${skipped} were no longer scheduled or in progress and were skipped; an admin can void a completed delivery instead.`);
        } else {
          toast('success', `Cancelled ${cancelled} delivery(ies)`);
        }
        setSelected(new Set());
        fetchDeliveries();
      },
    });
    setShowCancelModal(false);
  };

  // What the screen shows: the calendar hides the filters and search, so there its own query applies.
  const shownQuery = viewMode === 'calendar' ? loadQuery : listQuery;
  // The selected rows, or every row matching the search and filters on every page, in the shown order.
  const readExportRows = async (): Promise<DeliveryRow[]> => (selectedDeliveries.length > 0
    ? selectedDeliveries
    : (await readDeliveriesPage(shownQuery, null)).rows);
  // The load sheet only prints open deliveries, so with no status chosen it reads only those.
  const readLoadSheetRows = async (): Promise<DeliveryRow[]> => {
    const query = shownQuery;
    return (await readDeliveriesPage({ ...query, p_statuses: query.p_statuses ?? ['scheduled', 'in_progress'] }, null)).rows;
  };

  const handlePrintLoadSheet = async () => {
    await runCriticalAction({
      action: async () => {
        const { generateBatchDeliveryPdf } = await import('../lib/deliveryPdf');

        // Use selected deliveries, or every scheduled/in_progress one matching the search and filters (all pages)
        const rows = selectedDeliveries.length > 0
          ? selectedDeliveries
          : (await readLoadSheetRows()).filter((d) => d.status === 'scheduled' || d.status === 'in_progress');

        if (rows.length === 0) {
          throw new Error('No deliveries to include in load sheet');
        }

        // Batch-fetch customer contact info, addresses, and order numbers
        const customerIds = [...new Set(rows.map((d) => d.customer_id).filter(Boolean))];
        const orderIds = [...new Set(rows.map((d) => d.order_id).filter(Boolean))];
        const addressIds = [...new Set(
          rows.map((d) => (d as unknown as Record<string, unknown>).delivery_address_id as string)
            .filter(Boolean),
        )];

        // Chunked and paged, so a large selection neither overflows the request URL nor
        // loses rows past the server's row cap.
        const [customerResult, orderResult, addressResult] = await Promise.all([
          fetchAllRowsForIds(customerIds, (idChunk, from, to) => supabase
            .from('customers')
            .select('id, contact_name, phone, shipping_address, billing_address', { count: 'exact' })
            .in('id', idChunk)
            .order('id')
            .range(from, to)),
          fetchAllRowsForIds(orderIds, (idChunk, from, to) => supabase
            .from('orders')
            .select('id, order_number', { count: 'exact' })
            .in('id', idChunk)
            .order('id')
            .range(from, to)),
          fetchAllRowsForIds(addressIds, (idChunk, from, to) => supabase
            .from('customer_addresses')
            .select('id, address_line, city, state, zip', { count: 'exact' })
            .in('id', idChunk)
            .order('id')
            .range(from, to)),
        ]);

        // A load sheet missing contacts, order numbers or addresses would look complete.
        const lookupError = customerResult.error || orderResult.error || addressResult.error;
        if (lookupError) throw lookupError;
        const customerData = customerResult.data;
        const orderData = orderResult.data;
        const addressData = addressResult.data;

        const customerMap: Record<string, { contact_name: string | null; phone: string | null; shipping_address: string | null; billing_address: string | null }> = {};
        ((customerData || []) as Array<{ id: string; contact_name: string | null; phone: string | null; shipping_address: string | null; billing_address: string | null }>).forEach((c) => {
          customerMap[c.id] = { contact_name: c.contact_name, phone: c.phone, shipping_address: c.shipping_address, billing_address: c.billing_address };
        });

        const orderMap: Record<string, string> = {};
        ((orderData || []) as Array<{ id: string; order_number: string }>).forEach((o) => {
          orderMap[o.id] = o.order_number;
        });

        const addressMap: Record<string, string> = {};
        ((addressData || []) as Array<{ id: string; address_line: string | null; city: string | null; state: string | null; zip: string | null }>).forEach((a) => {
          const parts = [a.address_line, a.city, a.state, a.zip].filter(Boolean);
          addressMap[a.id] = parts.join(', ');
        });

        // Build PdfDeliveryData for each delivery (same format as Receipt PDF)
        const pdfDataList = [];
        for (const del of rows) {
          const { data: items, error: itemsError } = await supabase
            .from('delivery_items')
            .select('*, product:products(product_name)')
            .eq('delivery_id', del.id)
            .order('id');
          if (itemsError) throw itemsError;
          if (!items || items.length === 0) {
            throw new Error(`No delivery items found for ${del.delivery_number}`);
          }

          const delAny = del as unknown as Record<string, unknown>;
          const custInfo = customerMap[del.customer_id] || { contact_name: null, phone: null, shipping_address: null, billing_address: null };

          // Address fallback: delivery address → customer shipping → customer billing
          const deliveryAddrId = delAny.delivery_address_id as string | null;
          const address = (deliveryAddrId && addressMap[deliveryAddrId])
            || custInfo.shipping_address
            || custInfo.billing_address
            || undefined;

          pdfDataList.push({
            delivery_number: del.delivery_number,
            order_number: del.order_id ? (orderMap[del.order_id] || '-') : '-',
            customer_name: del.customer_name,
            customer_address: address,
            contact_name: custInfo.contact_name || undefined,
            contact_phone: custInfo.phone || undefined,
            driver_name: del.driver_name,
            scheduled_date: del.scheduled_date,
            completed_at: del.completed_at || undefined,
            status: del.status,
            signed_by: del.signed_by || undefined,
            delivery_notes: del.delivery_notes || undefined,
            priority: del.priority || 'normal',
            issue_type: del.issue_type || undefined,
            issue_notes: del.issue_notes || undefined,
            items: ((items || []) as Array<Record<string, unknown> & { product?: { product_name?: string } }>)
              .map((it) => ({
                product_name: it.product?.product_name || (it.product_name as string) || 'Unknown',
                quantity: it.quantity as number,
                unit_size: (it.unit_size as string) || '-',
                quantity_delivered: (it.quantity_delivered as number) || undefined,
                tote_number: (it.tote_number as string) || undefined,
              }))
              .sort((a, b) => (a.product_name || '').localeCompare(b.product_name || '')),
          });
        }

        if (pdfDataList.length === 0) {
          throw new Error('No deliveries to print');
        }

        await generateBatchDeliveryPdf(pdfDataList);
      },
      toast,
      successMessage: 'Delivery receipt(s) generated',
      setLoading: setPrintingLoadSheet,
      sentryTag: 'print_load_sheet',
    });
  };

  const handleBatchReschedule = async () => {
    if (!rescheduleDate) {
      toast('error', 'Please select a new date');
      return;
    }
    if (!profile) {
      toast('error', 'Cannot reschedule deliveries — profile not loaded. Please refresh.');
      return;
    }
    const ids = selectedCancellable.map((d) => d.id);
    await runCriticalAction({
      action: async () => {
        const rescheduleKey = batchRescheduleIdem.getKey();
        const { data, error } = await supabase.rpc('batch_reschedule_deliveries', {
          p_delivery_ids: ids,
          p_new_date: rescheduleDate,
          p_performed_by: profile.id,
          p_idempotency_key: rescheduleKey,
        });
        if (error) throw error;
        assertRpcResult(data, 'batch_reschedule_deliveries');
        batchRescheduleIdem.resetKey();
        logActivity({ event: 'batch_reschedule_deliveries', description: `Rescheduled ${ids.length} delivery(ies) to ${rescheduleDate}`, performedBy: profile.id });
      },
      toast,
      successMessage: `Rescheduled ${ids.length} delivery(ies) to ${parseLocalDate(rescheduleDate).toLocaleDateString()}`,
      setLoading: setRescheduling,
      sentryTag: 'batch_reschedule_deliveries',
      onSuccess: () => {
        setSelected(new Set());
        setShowReschedule(false);
        setRescheduleDate('');
        fetchDeliveries();
      },
    });
  };

  const handleExportCSV = async () => {
    // Claimed synchronously, so a double click cannot start two reads and download two files.
    if (exportingCsvRef.current) return;
    exportingCsvRef.current = true;
    setExportingCsv(true);
    let rows: DeliveryRow[];
    try {
      rows = await readExportRows();
    } catch (err: unknown) {
      Sentry.captureException(err, { tags: { source: 'export', page: 'deliveries' } });
      toast('error', 'The deliveries could not be read for the export. Nothing was exported; try again.');
      return;
    } finally {
      exportingCsvRef.current = false;
      setExportingCsv(false);
    }
    exportToCSV(rows as unknown as Record<string, unknown>[], [
      { key: 'delivery_number', header: 'Delivery #' },
      { key: 'customer_name', header: 'Customer' },
      { key: 'driver_name', header: 'Driver' },
      { key: 'scheduled_date', header: 'Scheduled', format: (v) => fmtDateCSV(v as string) },
      { key: 'priority', header: 'Priority' },
      { key: 'status', header: 'Status' },
      { key: 'item_count', header: 'Items' },
      { key: 'completed_at', header: 'Completed', format: (v) => fmtDateCSV(v as string) },
    ], 'deliveries');
    toast('success', `Exported ${rows.length} delivery(ies) to CSV`);
  };

  const handleExportPDF = async () => {
    setExportingPdf(true);
    try {
      const rows = await readExportRows();
      await downloadReportPdf({
        title: 'Deliveries',
        subtitle: `${rows.length} delivery(ies)`,
        columns: [
          { header: 'Delivery #', key: 'delivery_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Driver', key: 'driver_name' },
          { header: 'Scheduled', key: 'scheduled_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
          { header: 'Priority', key: 'priority', format: (v) => v ? String(v) : 'normal' },
          { header: 'Status', key: 'status' },
          { header: 'Items', key: 'item_count', align: 'right' },
        ],
        data: rows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${rows.length} delivery(ies)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExportingPdf(false);
  };

  /* ─── Driver Dashboard View ─── */
  if (isDriver) {
    // Completed, cancelled and voided deliveries are finished; only these two are still to do.
    const isOpen = (d: DeliveryRow) => d.status === 'scheduled' || d.status === 'in_progress';
    const myToday = deliveries.filter((d) => d.scheduled_date === todayStr && isOpen(d));
    const myUpcoming = deliveries.filter((d) => d.scheduled_date > todayStr && isOpen(d));
    const myCompleted = deliveries.filter((d) => d.status === 'completed').slice(0, 10);

    const handleTakeDelivery = async (deliveryId: string) => {
      if (!profile) {
        toast('error', 'Cannot take delivery — profile not loaded. Please refresh.');
        return;
      }
      await runCriticalAction({
        action: async () => {
          // One key per delivery: reassign_delivery does not bind its request, so a shared key would
          // replay delivery A's result for delivery B after a lost reply.
          const reassignKey = reassignIdem.getKeyFor(deliveryId);
          const { data, error } = await supabase.rpc('reassign_delivery', {
            p_delivery_id: deliveryId,
            p_new_driver: profile.id,
            p_performed_by: profile.id,
            p_idempotency_key: reassignKey,
          });
          if (error) throw error;
          assertRpcResult(data, 'reassign_delivery');
          reassignIdem.resetKeyFor(deliveryId);
          logActivity({ event: 'reassign_delivery', description: `Took delivery ${deliveryId}`, performedBy: profile.id, entityType: 'delivery', entityId: deliveryId });
        },
        toast,
        successMessage: 'Delivery assigned to you',
        sentryTag: 'take_delivery',
        onSuccess: () => fetchDeliveries(),
      });
    };

    const DriverRow = ({ d }: { d: DeliveryRow }) => {
      const short = shortageDeliveryIds.has(d.id);
      return (
        <li className={short ? 'border-l-4 border-amber-500 bg-amber-50' : ''}>
          <button
            type="button"
            onClick={() => navigate(`/deliveries/${d.id}`)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left md:hover:bg-crx-green-tint transition-colors"
          >
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm text-secondary">
                  <span>{d.delivery_number}</span>
                  {short && (
                    <span title="Inventory shortage"><AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" /></span>
                  )}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  {d.completion_evidence === 'no_proof' && <NoProofLabel />}
                  <Badge variant={statusToBadgeVariant[d.status] || 'default'}>{d.status.replace('_', ' ')}</Badge>
                </span>
              </span>
              <span className="block font-heading text-lg font-bold text-nav-dark">{d.customer_name}</span>
              {d.farm_group_name && (
                <span className="flex items-center gap-1 text-xs text-blue-700">
                  <Users className="w-3 h-3 shrink-0" />
                  {d.farm_group_name}
                </span>
              )}
              {(d as unknown as Record<string, unknown>).delivery_address ? (
                <span className="flex items-center gap-2 text-xs text-secondary">
                  <MapPin className="w-3 h-3 shrink-0" />
                  <span className="truncate">{String((d as unknown as Record<string, unknown>).delivery_address)}</span>
                </span>
              ) : null}
              <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-secondary">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {parseLocalDate(d.scheduled_date).toLocaleDateString()}
                </span>
                {d.delivery_window_start && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {d.delivery_window_start}{d.delivery_window_end ? ` - ${d.delivery_window_end}` : ''}
                  </span>
                )}
                <span>{d.item_count} items</span>
              </span>
              {d.priority && d.priority !== 'normal' && (
                <span className="block pt-1">{priorityBadge(d.priority)}</span>
              )}
              {short && <span className="block text-sm font-medium text-amber-800">Warehouse stock is short for this load</span>}
              {d.status === 'scheduled' && (
                <span className="block text-sm font-semibold text-crx-green">Tap to start delivery</span>
              )}
              {d.status === 'in_progress' && (
                <span className="block text-sm font-semibold text-nav-dark">Ready to complete</span>
              )}
            </span>
            <ChevronRight className="w-5 h-5 shrink-0 text-gray-400" aria-hidden="true" />
          </button>
        </li>
      );
    };

    const driverHeader = (
      <PhoneHeader
        title="My Deliveries"
        eyebrow={!loadFailed && !loading ? `${deliveries.filter(isOpen).length} active` : null}
        className="sm:px-6"
        action={!loadFailed && canQuickDeliver && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Zap className="w-4 h-4" />}
              onClick={() => {
                setQuickDeliveryInitialCustomerId(undefined);
                setQuickDeliveryOpen(true);
              }}
            >
              Quick Delivery
            </Button>
          )}
      />
    );

    // Still loading must not read as "no deliveries today" either.
    if (loading) {
      return (
        <div className="-m-4 sm:-m-6 min-h-screen bg-cream">
          {driverHeader}
          <div className="space-y-3 p-4 sm:p-6">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        </div>
      );
    }

    // A failed load must never read as "no deliveries assigned to you".
    if (loadFailed) {
      return (
        <div className="-m-4 sm:-m-6 min-h-screen bg-cream">
          {driverHeader}
          <div className="p-4 sm:p-6">
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700">
              Your deliveries could not be loaded.
            </p>
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => void fetchDeliveries()} loading={pageLoading}>Try again</Button>
            </div>
          </div>
        </div>
      );
    }

    const jumpSections = [
      { id: 'my-today', label: 'Today', count: myToday.length },
      ...(myUpcoming.length > 0 ? [{ id: 'my-upcoming', label: 'Upcoming', count: myUpcoming.length }] : []),
      ...(myCompleted.length > 0 ? [{ id: 'my-completed', label: 'Completed', count: myCompleted.length }] : []),
      ...(unassigned.length > 0 ? [{ id: 'my-available', label: 'Available', count: unassigned.length }] : []),
    ];

    return (
      <div className="phone-touch -m-4 sm:-m-6 min-h-screen bg-cream">
        {driverHeader}

        <div className="space-y-4 p-4 sm:p-6">
          {jumpSections.length > 1 && <SectionJumpBar sections={jumpSections} ariaLabel="Jump to deliveries" />}

          {shortageChecking && !shortageCheckFailed && (
            <p role="status" className="rounded-xl border border-gray-200 bg-cream px-4 py-3 text-sm text-secondary">Checking stock for shortages. Until this finishes, a missing warning does not mean there is enough stock.</p>
          )}
          {shortageCheckFailed && (
            <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Stock shortage warnings could not be checked, so a missing warning does not mean there is enough stock. Reload to try again.
            </p>
          )}

          {/* Today */}
          <section id="my-today" className="scroll-mt-32">
            <h2 className={DRIVER_SECTION_TITLE}>Today</h2>
            {myToday.length === 0 ? (
              <p className="text-sm text-secondary">No deliveries scheduled for today.</p>
            ) : (
              <ul className={DRIVER_LIST}>
                {myToday.map((d) => <DriverRow key={d.id} d={d} />)}
              </ul>
            )}
          </section>

          {/* Upcoming */}
          {myUpcoming.length > 0 && (
            <section id="my-upcoming" className="scroll-mt-32">
              <h2 className={DRIVER_SECTION_TITLE}>Upcoming</h2>
              <ul className={DRIVER_LIST}>
                {myUpcoming.map((d) => <DriverRow key={d.id} d={d} />)}
              </ul>
            </section>
          )}

          {/* Completed */}
          {myCompleted.length > 0 && (
            <section id="my-completed" className="scroll-mt-32">
              <h2 className={DRIVER_SECTION_TITLE}>Recently Completed</h2>
              <ul className={DRIVER_LIST}>
                {myCompleted.map((d) => <DriverRow key={d.id} d={d} />)}
              </ul>
            </section>
          )}

          {/* Available (unassigned) */}
          {unassigned.length > 0 && (
            <section id="my-available" className="scroll-mt-32">
              <h2 className={DRIVER_SECTION_TITLE}>Available Deliveries</h2>
              <ul className={DRIVER_LIST}>
                {unassigned.map((d) => (
                  <li key={d.id} className="space-y-1 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-secondary">{d.delivery_number}</span>
                      <Badge variant="warning">Unassigned</Badge>
                    </div>
                    <p className="font-heading text-lg font-bold text-nav-dark">{d.customer_name}</p>
                    {d.farm_group_name && (
                      <div className="flex items-center gap-1 text-xs text-blue-700">
                        <Users className="w-3 h-3 shrink-0" />
                        <span>{d.farm_group_name}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-xs text-secondary">
                      <Calendar className="w-3 h-3" />
                      <span>{parseLocalDate(d.scheduled_date).toLocaleDateString()}</span>
                    </div>
                    <Button
                      onClick={(e) => { e.stopPropagation(); handleTakeDelivery(d.id); }}
                      className="w-full mt-2"
                    >
                      Take This Delivery
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Quick Delivery Modal */}
        <QuickDeliveryModal
          open={quickDeliveryOpen}
          onClose={closeQuickDelivery}
          initialCustomerId={quickDeliveryInitialCustomerId}
        />
      </div>
    );
  }

  /* ─── Admin / Sales Rep View ─── */
  // Shared by the desktop table and the phone list.
  const selectBox = (row: DeliveryRow) =>
    SELECTABLE_STATUSES.includes(row.status) ? (
      <input
        type="checkbox"
        checked={selected.has(row.id)}
        onChange={(e) => { e.stopPropagation(); toggleSelect(row.id); }}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select ${row.delivery_number}`}
        className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
      />
    ) : null;

  const completeAction = (row: DeliveryRow) =>
    row.status === 'in_progress' || row.status === 'scheduled' ? (
      <button
        onClick={(e) => {
          e.stopPropagation();
          completeIdem.resetKey();
          const dialogGen = bumpCompleteDialogGen();
          setCompleteTarget(row);
          setSignedBy('');
          setDeliveredOnDate(businessToday());
          resetCompleteEvidence();
          void loadTicketPhotos(row.id, dialogGen);
        }}
        title={row.status === 'scheduled' ? 'Mark this delivery delivered' : 'Mark this delivery complete'}
        aria-label={`Mark delivery ${row.delivery_number} ${row.status === 'scheduled' ? 'delivered' : 'complete'}`}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-crx-green border border-crx-green/30 hover:bg-crx-green-light transition-colors"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        {row.status === 'scheduled' ? 'Mark Delivered' : 'Complete'}
      </button>
    ) : null;

  const columns: Column<DeliveryRow>[] = [
    {
      key: 'id',
      header: '',
      className: 'w-10',
      render: selectBox,
    },
    {
      key: 'delivery_number',
      header: 'Delivery #',
      headerExtra: <HelpTip text="Warehouse stock on hand is less than this delivery needs, counting every active delivery that needs the same product. Check inventory before dispatching." className="ml-1" />,
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <Truck className="w-4 h-4 text-crx-green shrink-0" />
          <span className="font-medium text-nav-dark">{row.delivery_number}</span>
          {shortageDeliveryIds.has(row.id) && (
            <span title="Inventory shortage"><AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" /></span>
          )}
        </div>
      ),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (row) => (
        <div>
          <div className="flex items-center gap-1.5">
            <span>{row.customer_name}</span>
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
          {row.farm_group_name && (
            <div className="flex items-center gap-1 mt-0.5">
              <Users className="w-3 h-3 text-blue-500 shrink-0" />
              <span className="text-xs text-blue-600">{row.farm_group_name}</span>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'driver_name',
      header: 'Driver',
      sortable: true,
      render: (row) => (
        <span className={!row.assigned_driver ? 'text-amber-600 font-medium' : ''}>
          {row.driver_name}
        </span>
      ),
    },
    {
      key: 'scheduled_date',
      header: 'Scheduled',
      sortable: true,
      render: (row) => {
        const d = parseLocalDate(row.scheduled_date);
        const window = row.delivery_window_start
          ? ` ${row.delivery_window_start}${row.delivery_window_end ? '-' + row.delivery_window_end : ''}`
          : '';
        return (
          <span>
            {d.toLocaleDateString()}
            {window && <span className="text-xs text-secondary ml-1">{window}</span>}
          </span>
        );
      },
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      render: (row) => priorityBadge(row.priority || 'normal'),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <span className="inline-flex items-center gap-1.5 flex-wrap">
          <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
            {row.status.replace('_', ' ')}
          </Badge>
          {row.completion_evidence === 'no_proof' && <NoProofLabel />}
        </span>
      ),
    },
    {
      key: 'item_count',
      header: 'Items',
      sortable: true,
    },
    {
      key: 'actions',
      header: '',
      render: completeAction,
    },
  ];

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonTable rows={8} />
      </div>
    );
  }

  // No counts, schedule strip or list: zeros or a short list would look complete.
  if (loadFailed) {
    return (
      <div className="space-y-4">
        <PageHeader title="Deliveries" />
        <Card>
          <p role="alert" className="text-center text-red-600 pt-8 pb-3 text-sm">Deliveries could not be loaded.</p>
          <div className="flex justify-center pb-6">
            <Button variant="secondary" size="sm" onClick={() => void fetchDeliveries()} loading={pageLoading}>Try again</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Deliveries"
        actions={(
          <>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
                viewMode === 'list'
                  ? 'bg-crx-green text-white'
                  : 'bg-white text-secondary hover:bg-gray-50'
              }`}
              aria-label="List view"
            >
              <List className="w-4 h-4" />
              List
            </button>
            <button
              onClick={() => setViewMode('calendar')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
                viewMode === 'calendar'
                  ? 'bg-crx-green text-white'
                  : 'bg-white text-secondary hover:bg-gray-50'
              }`}
              aria-label="Calendar view"
            >
              <CalendarDays className="w-4 h-4" />
              Calendar
            </button>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
          <Button
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
            onClick={handleExportCSV}
            loading={exportingCsv}
            disabled={listSettling}
          >
            Export CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileText className="w-4 h-4" />}
            onClick={handleExportPDF}
            loading={exportingPdf}
            disabled={listSettling}
          >
            Download PDF
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileText className="w-4 h-4" />}
            onClick={handlePrintLoadSheet}
            loading={printingLoadSheet}
            disabled={listSettling}
          >
            {selectedDeliveries.length > 0 ? `Load Sheet (${selectedDeliveries.length})` : 'Load Sheet'}
          </Button>
          {selectedDeliveries.length > 0 && (
            <>
              {selectedCancellable.length > 0 && (
                <Button
                  variant="danger"
                  icon={<XCircle className="w-4 h-4" />}
                  onClick={() => setShowCancelModal(true)}
                >
                  Cancel {selectedCancellable.length} Selected
                </Button>
              )}
              {selectedCancellable.length > 0 && (
                <Button
                  variant="secondary"
                  icon={<CalendarRange className="w-4 h-4" />}
                  onClick={() => setShowReschedule(true)}
                >
                  Reschedule {selectedCancellable.length}
                </Button>
              )}
            </>
          )}
          {canQuickDeliver && (
            <Button
              variant="secondary"
              icon={<Zap className="w-4 h-4" />}
              onClick={() => {
                setQuickDeliveryInitialCustomerId(undefined);
                setQuickDeliveryOpen(true);
              }}
            >
              Quick Delivery
            </Button>
          )}
          {canCreate && (
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/deliveries/new')}>
              Schedule Delivery
            </Button>
          )}
          </div>
          </>
        )}
      />

      {canCreate && <ReceiptsToCheck />}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Scheduled Today</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-blue-600">{scheduledToday}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <Truck className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-secondary">In Progress</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-amber-600">{inProgress}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Completed This Week</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{completedThisWeek}</p>
        </Card>
        <Card>
          <button
            onClick={() => navigate('/delivery-remainders')}
            className="w-full text-left"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <span className="text-sm text-secondary">Pending Remainders</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-red-600">{remainderCount}</p>
          </button>
        </Card>
      </div>

      {/* Calendar View */}
      {viewMode === 'calendar' && (
        <Card>
          {pageLoading ? <SkeletonCard /> : <DeliveryCalendar
            deliveries={deliveries}
            onDeliveryClick={(deliveryId) => navigate(`/deliveries/${deliveryId}`)}
            onDateClick={(date) => navigate(`/deliveries/new?date=${date}`)}
          />}
        </Card>
      )}

      {/* List View */}
      {viewMode === 'list' && <>
      {/* 7-Day Schedule Strip */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {scheduleStrip.map((day) => {
          const isToday = day.date === todayStr;
          const isActive = scheduleDate === day.date;
          return (
            <button
              key={day.date}
              onClick={() => setScheduleDate(isActive ? '' : day.date)}
              className={`shrink-0 px-4 py-3 rounded-xl border text-center min-w-[100px] transition-all ${
                isActive
                  ? 'border-crx-green bg-crx-green-tint shadow-sm'
                  : isToday
                  ? 'border-blue-300 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className={`text-xs font-medium ${isToday ? 'text-blue-600' : 'text-secondary'}`}>
                {isToday ? 'TODAY' : dayLabel(day.date).split(',')[0]}
              </div>
              <div className={`text-xs ${isToday ? 'text-blue-500' : 'text-secondary'}`}>
                {dayLabel(day.date).split(' ').slice(1).join(' ')}
              </div>
              <div className={`text-lg font-bold mt-1 ${
                day.count === 0 ? 'text-gray-300' : isActive ? 'text-crx-green' : 'text-nav-dark'
              }`}>
                {day.count}
              </div>
              {day.unassigned > 0 && (
                <div className="text-[10px] text-amber-600 font-medium">{day.unassigned} unassigned</div>
              )}
            </button>
          );
        })}
      </div>

      {shortageChecking && !shortageCheckFailed && (
        <div role="status" className="rounded-lg border border-gray-200 bg-cream px-4 py-3 text-sm text-secondary">Checking stock for shortages. Until this finishes, a missing warning does not mean there is enough stock.</div>
      )}
      {shortageCheckFailed && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Stock shortage warnings could not be checked, so a missing warning does not mean there is enough stock. Reload to try again.
        </div>
      )}

      {/* Delivery list: one search and filter bar; a table from md up, a tappable list on phones */}
      <SectionCard id="delivery-list" icon={<Truck className="w-5 h-5" />} title="Delivery List">
        <div className="phone-touch space-y-4 p-4 md:p-5">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                maxLength={SEARCH_MAX_CHARS}
                placeholder="Search deliveries..."
                aria-label="Search deliveries"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green transition-colors"
              />
            </div>
            <div className="flex min-w-0 gap-2 items-center flex-wrap [&_select]:max-w-full">
              <button
                type="button"
                onClick={() => setFiltersOpen((open) => !open)}
                aria-expanded={filtersOpen}
                aria-controls="delivery-filters"
                className="md:hidden inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-nav-dark border border-gray-200 rounded-lg hover:bg-cream-dark"
              >
                <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-crx-green px-2 text-xs font-semibold text-white">
                    {activeFilterCount}<span className="sr-only"> active</span>
                  </span>
                )}
              </button>
              {/* On phones the dropdowns fold behind the Filters button; from md up they always show. */}
              <div id="delivery-filters" className={`${filtersOpen ? 'contents' : 'hidden'} md:contents`}>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by delivery status"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Statuses</option>
                <option value="scheduled">Scheduled</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
                <option value="voided">Voided</option>
              </select>
              <select
                value={driverFilter}
                onChange={(e) => setDriverFilter(e.target.value)}
                aria-label="Filter by driver"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Drivers</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>{d.full_name}</option>
                ))}
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                aria-label="Filter by priority"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Priorities</option>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
              <select
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                aria-label="Filter by customer"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Customers</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.farm_name}</option>
                ))}
              </select>
              <select
                value={scheduleDate ? 'custom' : datePreset}
                onChange={(e) => {
                  setScheduleDate('');
                  setDatePreset(e.target.value === 'custom' ? '' : e.target.value);
                }}
                aria-label="Filter by date range"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                {DATE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
                {scheduleDate && <option value="custom">{dayLabel(scheduleDate)}</option>}
              </select>
              </div>
              {selectableShown.length > 0 && (
                <button
                  onClick={toggleAll}
                  className="text-xs text-crx-green hover:underline ml-2"
                >
                  {allShownSelected ? 'Deselect All' : totalCount > deliveries.length ? 'Select All on This Page' : 'Select All'}
                </button>
              )}
            </div>
          </div>
          <div className="hidden md:block">
            <DataTable<DeliveryRow>
              data={searched}
              columns={columns}
              onRowClick={(row) => navigate(`/deliveries/${row.id}`)}
              emptyTitle={anyDeliveries ? 'No deliveries match your search or filters' : 'No deliveries scheduled'}
              emptyDescription={anyDeliveries ? undefined : "Deliveries are created from orders. Open an order and click 'Schedule Delivery' to get started."}
              emptyAction={anyDeliveries ? undefined : (
                <Button icon={<Truck className="w-4 h-4" />} showChevron onClick={() => navigate('/orders')}>
                  View Orders
                </Button>
              )}
              sortState={sortState}
              onSortChange={setSortState}
              serverSide
              loading={loading || pageLoading}
            />
          </div>
          <div className="md:hidden">
            {/* While a page loads, the old rows and their actions are hidden, as the table above hides them. */}
            {pageLoading ? <SkeletonCard /> : searched.length === 0 ? (
              anyDeliveries ? (
                <p className="py-8 text-center font-semibold text-nav-dark">No deliveries match your search or filters</p>
              ) : (
                <div className="py-8 text-center">
                  <p className="font-semibold text-nav-dark">No deliveries scheduled</p>
                  <p className="mt-1 text-sm text-secondary">Deliveries are created from orders. Open an order and click &apos;Schedule Delivery&apos; to get started.</p>
                  <Button className="mt-4" icon={<Truck className="w-4 h-4" />} showChevron onClick={() => navigate('/orders')}>
                    View Orders
                  </Button>
                </div>
              )
            ) : (
              <ul className="-mx-4 border-y border-gray-100 divide-y divide-gray-100">
                {searched.map((row) => {
                  const short = shortageDeliveryIds.has(row.id);
                  const action = completeAction(row);
                  return (
                    <li key={row.id} className={`px-4 py-3 ${short ? 'border-l-4 border-amber-500 bg-amber-50' : ''}`}>
                      <div className="flex items-center gap-1">
                        {/* A 44px tap area around the small checkbox; a spacer keeps rows aligned without one. */}
                        {SELECTABLE_STATUSES.includes(row.status)
                          ? <label className="-ml-3 flex h-11 w-11 shrink-0 items-center justify-center">{selectBox(row)}</label>
                          : <span aria-hidden="true" className="-ml-3 w-11 shrink-0" />}
                        <button
                          type="button"
                          onClick={() => navigate(`/deliveries/${row.id}`)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <span className="min-w-0 flex-1 space-y-0.5">
                            <span className="flex items-center gap-1.5 text-sm text-secondary">
                              <span>{row.delivery_number}</span>
                              {short && (
                                <span title="Inventory shortage"><AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" /></span>
                              )}
                            </span>
                            <span className="block truncate font-heading text-lg font-bold text-nav-dark">{row.customer_name}</span>
                            <span className="block text-xs text-secondary">
                              {parseLocalDate(row.scheduled_date).toLocaleDateString()}
                              {row.delivery_window_start && ` ${row.delivery_window_start}${row.delivery_window_end ? '-' + row.delivery_window_end : ''}`}
                              {' · '}<span className={!row.assigned_driver ? 'font-medium text-amber-800' : ''}>{row.driver_name}</span> · {row.item_count} items
                            </span>
                            <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              <Badge variant={statusToBadgeVariant[row.status] || 'default'}>{row.status.replace('_', ' ')}</Badge>
                              {row.priority && row.priority !== 'normal' && priorityBadge(row.priority)}
                              {row.completion_evidence === 'no_proof' && <NoProofLabel />}
                            </span>
                            {short && <span className="block text-sm font-medium text-amber-800">Warehouse stock is short for this load</span>}
                          </span>
                          <ChevronRight className="w-5 h-5 shrink-0 text-gray-400" aria-hidden="true" />
                        </button>
                      </div>
                      {action && <div className="mt-2">{action}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <DeliveriesPager totalCount={totalCount} page={loadedPage} rowsShown={deliveries.length} busy={pageLoading}
            hasPrevious={listPage > 0} hasNext={nextCursor !== null} onPrevious={goPrevious} onNext={goNext} />
        </div>
      </SectionCard>
      </>}

      {/* Batch Cancel Modal */}
      <BatchCancelModal
        open={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        count={selectedCancellable.length}
        onConfirm={handleBatchCancel}
        loading={cancelling}
      />

      {/* Reschedule Modal (inline) */}
      {showReschedule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm space-y-4">
            <h3 className="text-lg font-semibold text-nav-dark">Reschedule Deliveries</h3>
            <p className="text-sm text-secondary">
              Select a new date for {selectedCancellable.length} delivery{selectedCancellable.length !== 1 ? 'ies' : ''}.
            </p>
            <input
              type="date"
              value={rescheduleDate}
              onChange={(e) => setRescheduleDate(e.target.value)}
              min={todayStr}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => { setShowReschedule(false); setRescheduleDate(''); }}>
                Cancel
              </Button>
              <Button onClick={handleBatchReschedule} loading={rescheduling} disabled={!rescheduleDate}>
                Reschedule
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Delivery Modal */}
      <QuickDeliveryModal
        open={quickDeliveryOpen}
        onClose={closeQuickDelivery}
        initialCustomerId={quickDeliveryInitialCustomerId}
      />

      <CustomerDrawer
        open={canPeekCustomer && !!drawerCustomer}
        customerId={drawerCustomer?.id ?? ''}
        customerName={drawerCustomer?.name ?? ''}
        onClose={() => setDrawerCustomer(null)}
      />

      <Modal
        open={!!completeTarget}
        onClose={closeCompleteDialog}
        title={completeTarget?.status === 'scheduled' ? 'Mark Delivered' : 'Mark Delivery Complete'}
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Complete delivery <span className="font-medium text-nav-dark">{completeTarget?.delivery_number}</span> for{' '}
            <span className="font-medium text-nav-dark">{completeTarget?.customer_name}</span> — all items delivered in full.
            For a partial delivery or to email the customer their receipt, open the delivery instead.
            The customer signs on screen here, or, if they signed a paper ticket, add a photo of it.
          </p>
          {completeTarget?.status === 'scheduled' && (
            <p className="text-sm text-secondary">
              This will confirm and complete the delivery in one step. Inventory is deducted and a draft invoice is created.
            </p>
          )}
          {!isOnline && (
            <p role="alert" className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
              No signal. A delivery can only be completed with signal; nothing is saved offline.
            </p>
          )}
          <div>
            <label htmlFor="complete-signed-by" className="block text-xs font-medium text-secondary mb-1">Signed by</label>
            <input
              id="complete-signed-by"
              type="text"
              value={completeEvidence === 'no_proof' ? NO_PROOF_SIGNER : signedBy}
              onChange={(e) => setSignedBy(e.target.value)}
              placeholder="Name of person who received"
              disabled={completeEvidence === 'no_proof'}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-100 disabled:text-gray-500"
            />
          </div>
          <div>
            <label htmlFor="delivered-on" className="block text-xs font-medium text-secondary mb-1">Delivered on</label>
            <input
              id="delivered-on"
              type="date"
              value={deliveredOnDate}
              onChange={(e) => setDeliveredOnDate(e.target.value)}
              max={businessToday()}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
            <p className="mt-1 text-xs text-secondary">Recording a delivery that already happened? Set the real date — it becomes the invoice date.</p>
          </div>
          {completeEvidence !== 'no_proof' && (
            <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={completeEvidence === 'paper_ticket'}
                onChange={(e) => {
                  setCompleteEvidence(e.target.checked ? 'paper_ticket' : 'signature');
                  setCompleteSignature(null);
                }}
                className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
              />
              Customer signed a paper ticket
            </label>
          )}
          {canRecordWithoutProof && (
            <div className="flex items-center gap-1">
              <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={completeEvidence === 'no_proof'}
                  onChange={(e) => {
                    setCompleteEvidence(e.target.checked ? 'no_proof' : 'signature');
                    setCompleteSignature(null);
                  }}
                  className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                />
                Record without proof (admin only)
              </label>
              <HelpTip text="Only when there is no signature and no ticket photo, for example a delivery confirmed by phone. Your name, the time and your written reason are saved with the delivery. No receipt is emailed." className="ml-1" />
            </div>
          )}
          {completeEvidence === 'no_proof' ? (
            <div className="space-y-2 border border-amber-300 rounded-lg p-3 bg-amber-50">
              <label htmlFor="complete-no-proof-reason" className="flex items-center gap-2 text-sm font-medium text-amber-900">
                <AlertTriangle className="w-4 h-4 shrink-0" /> Why is there no proof? (required)
              </label>
              <textarea
                id="complete-no-proof-reason"
                value={noProofReason}
                onChange={(e) => setNoProofReason(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="For example: customer confirmed by phone that all items arrived"
                aria-describedby="complete-no-proof-reason-count"
                className="w-full px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <p
                id="complete-no-proof-reason-count"
                className={`text-xs ${isValidNoProofReason(noProofReason) ? 'text-secondary' : 'text-amber-800'}`}
              >
                {noProofReasonLength(noProofReason)} / {NO_PROOF_REASON_MAX_CHARS} characters (at least {NO_PROOF_REASON_MIN_CHARS})
              </p>
            </div>
          ) : completeEvidence === 'paper_ticket' ? (
            <div className="space-y-2">
              <input
                ref={ticketInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  const target = completeTargetRef.current;
                  const dialogGen = completeDialogGenRef.current;
                  if (!file || !target || !profile) return;
                  if (currentTicketPhotos.length >= MAX_PAPER_TICKET_PHOTOS) {
                    toast('error', `Maximum ${MAX_PAPER_TICKET_PHOTOS} ticket photos per delivery`);
                    return;
                  }
                  setUploadingTicketGen(dialogGen);
                  try {
                    const saved = await uploadEvidencePhoto(target.id, file, profile.id, PAPER_TICKET_PHOTO_CAPTION);
                    // Only the dialog session that took the photo shows it (and its toast).
                    if (completeDialogGenRef.current === dialogGen && completeTargetRef.current?.id === target.id) {
                      ticketPhotoSeqRef.current++; // an older in-flight read must not replace the list without it
                      setTicketPhotos((prev) => ({
                        deliveryId: target.id,
                        photos: mergePhotosById(prev?.deliveryId === target.id ? prev.photos : [], [saved]),
                      }));
                      toast('success', 'Photo of the signed ticket saved');
                    }
                  } catch (err) {
                    Sentry.captureException(err, { tags: { source: 'critical_action', action: 'upload_delivery_photo' } });
                    if (completeDialogGenRef.current === dialogGen) toast('error', sanitizeError(err));
                  }
                  // Clear only this session's spinner; a newer session's upload keeps its own.
                  setUploadingTicketGen((current) => (current === dialogGen ? null : current));
                }}
              />
              {currentTicketPhoto ? (
                <p className="flex items-center gap-2 text-sm text-green-700">
                  <CheckCircle2 className="w-4 h-4 shrink-0" /> Photo of the signed ticket saved
                </p>
              ) : (
                <p className="text-sm text-amber-700">A photo of the signed paper ticket is required.</p>
              )}
              <Button
                variant="secondary"
                onClick={() => ticketInputRef.current?.click()}
                loading={uploadingTicket}
                disabled={!isOnline || currentTicketPhotos.length >= MAX_PAPER_TICKET_PHOTOS}
              >
                Add Photo of Signed Ticket
              </Button>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg p-3 bg-white">
              <SignatureCanvas
                key={completeTarget?.id ?? 'none'}
                onSignatureChange={setCompleteSignature}
                label="Customer Signature"
                height={120}
              />
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={closeCompleteDialog}>Cancel</Button>
            <Button icon={<CheckCircle2 className="w-4 h-4" />} onClick={requestCompleteConfirm} loading={completing} disabled={!completeSignedBy || uploadingTicket || (completeEvidence === 'no_proof' && !isValidNoProofReason(noProofReason))}>
              {completeTarget?.status === 'scheduled' ? 'Mark Delivered' : 'Mark Complete'}
            </Button>
          </div>
        </div>
      </Modal>
      <ConfirmModal
        open={noProofConfirmOpen && !!completeTarget}
        onClose={() => setNoProofConfirmOpen(false)}
        onConfirm={() => { void handleCompleteConfirm(); }}
        title="Record Without Proof"
        message={`Record delivery ${completeTarget?.delivery_number ?? ''} as completed WITHOUT customer proof? Your name and reason are saved with it. This will update inventory and cannot be undone.`}
        confirmLabel="Record Without Proof"
        variant="warning"
        loading={completing}
      />
    </div>
  );
}

/** "Showing 1–B of N" (later pages: "Page P · B shown of N") with Previous/Next; N covers every matching delivery. */
function DeliveriesPager({ totalCount, page, rowsShown, busy, hasPrevious, hasNext, onPrevious, onNext }: {
  totalCount: number;
  page: number;
  rowsShown: number;
  busy: boolean;
  /** From the page being read, not the one on screen: a new search returns to page one before its rows land. */
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (totalCount === 0) return null;
  return (
    <nav aria-label="Delivery list pages" className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-secondary" aria-live="polite">
        {/* Past page one the exact row numbers are unknown: a page starts after the last row seen, and deliveries removed before it change the numbering. */}
        {page === 0 ? `Showing 1–${rowsShown}` : `Page ${page + 1} · ${rowsShown} shown`} of {totalCount}
      </span>
      {(totalCount > LIST_PAGE_SIZE || page > 0) && (
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onPrevious} disabled={!hasPrevious || busy}>
            Previous
          </Button>
          <Button variant="secondary" size="sm" onClick={onNext} disabled={!hasNext || busy}>
            Next
          </Button>
        </div>
      )}
    </nav>
  );
}
