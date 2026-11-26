/**
 * FieldView.tsx — Phone/mobile applicator FIELD VIEW ("My Day"), U12 rebuild.
 *
 * The simple phone screen the person actually SPRAYING opens: a clean, touch-friendly
 * list of ONLY THEIR jobs (the locations dispatched to them), so they can see what to
 * do, run it (Start/Complete), and where — without digging through the office Jobs
 * table. Mirrors ChemMan's applicator-facing dispatch card.
 *
 * U12 (2026-07-06) turned this from a READ-ONLY preview into an actionable "My Day"
 * screen — business-workflow-review-2026-07 §3.4 findings #22/#24-33/#64/#79/#114,
 * each re-verified against the live code/DB before building (see the U12 handoff
 * report for the per-finding verdicts). What changed:
 *  - The card face now shows the job DATE and a Start/Complete action button —
 *    no more "open the office Jobs page to actually run the job."
 *  - Jobs are grouped Today-first, with a separate "Done" section for terminal
 *    (completed/cancelled/invoiced) jobs so finished work doesn't compete with
 *    today's remaining list but also isn't silently hidden (see
 *    dispatchDisplay.groupFieldViewCards for the exact design rationale).
 *  - Dollar amounts are GONE — an applicator sees rate/quantity, never price
 *    (owner decision; this was previously the one non-"read-only" leak on an
 *    otherwise read-only screen).
 *  - A REI/PHI line appears on a job's Chemicals section whenever ANY of its
 *    products has that label data on file (0/604 products do today — so this
 *    renders nothing yet, but is wired for when label data is entered).
 *  - Complete captures the same weather/notes fields as the office Complete Job
 *    modal, PLUS an editable per-location applied-acres entry (defaults to the
 *    planned acres_to_treat; only the caller's OWN dispatched locations, which
 *    is also the set RLS lets them read/edit).
 *  - Complete queues OFFLINE via the existing offlineSync 'complete_job' path
 *    (already supported there — untouched) exactly like FieldStop's delivery
 *    completion: requires the card's detail to have loaded ONLINE first (so a
 *    conflict-safe `updated_at` snapshot exists), then queues if the connection
 *    drops. Start is online-only (mirrors FieldStop's Arrive step) — starting a
 *    job is a fast single call, not worth the offline-conflict complexity.
 *  - Cards fetch failing now shows an honest "couldn't load" retry state,
 *    distinct from a genuine empty list.
 *
 * Data (all RLS-equivalent, no profiles embed):
 *  - "My jobs"  → get_dispatched_list() with NO args. As an APPLICATOR caller the RPC
 *                 returns ONLY that applicator's current dispatched-location rows
 *                 (resolved server-side), now including job_date (migration
 *                 20260706060000). Grouped into one card per job
 *                 (groupDispatchedByJob). Admin/sales callers see every dispatched job
 *                 (so they can preview the field screen) — Start/Complete work for
 *                 them too (the RPCs already authorize admin/sales_rep).
 *  - Expand     → on first expand of a card we fetch the job's full read-only detail:
 *                 job_date + updated_at (the latter needed as the offline-conflict
 *                 snapshot for a queued Complete), every job_field (Locations + Crops),
 *                 and every job_chemical joined to its product (Chemicals + REI/PHI).
 *                 All readable by a LOCATION-ONLY dispatched applicator via the
 *                 additive *_location_dispatchee RLS policies.
 *  - Map        → reuses CRXMap + FieldBoundaryLayer to plot the dispatched job
 *                 locations. Wrapped in an ErrorBoundary; LOCAL has no Mapbox token /
 *                 boundary geometry so it renders no tiles locally (prod has both) —
 *                 the LIST view is the provable local path.
 *
 * The view is intentionally a DISTINCT, simpler screen from the office DispatchBoard:
 * no dispatch/assign controls, no office filters, no Cancel/Transfer — just the
 * applicator's own cards and the two actions (Start/Complete) they're allowed to run.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  List as ListIcon,
  Map as MapIcon,
  Search,
  RefreshCw,
  Users,
  MapPin,
  Calendar,
  FlaskConical,
  Sprout,
  ChevronDown,
  ChevronUp,
  Loader2,
  PlayCircle,
  CheckCircle2,
  ShieldAlert,
  WifiOff,
  AlertCircle,
  CloudUpload,
} from 'lucide-react';
import type { MapRef } from 'react-map-gl/mapbox';
import type { Json } from '../types/supabase';
import CrewFieldMarkerMap from '../components/map/CrewFieldMarkerMap';
import ErrorBoundary from '../components/ErrorBoundary';
import ConfirmModal from '../components/ui/ConfirmModal';
import PhoneHeader from '../components/ui/PhoneHeader';
import CompletionWeatherFields from '../components/jobs/CompletionWeatherFields';
import { usePageMeta } from '../hooks/usePageMeta';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useQueuedJobCompletions } from '../hooks/useQueuedJobCompletions';
import { getIdempotencyBindingRejection } from '../lib/idempotency';
import { getOfflineStorageErrorMessage, queueAction } from '../lib/offlineQueue';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { fetchAllRows, fetchAllRowsForIds, pageWithList } from '../lib/pagedRead';
import { Sentry } from '../lib/sentry';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import {
  formatAppliedOfTotal,
  jobStatusToDispatchBadge,
  groupDispatchedByJob,
  filterFieldViewCards,
  groupFieldViewCards,
  maxLabelReiPhi,
  isTerminalJobStatus,
  resolveFieldToJob,
  chunkIds,
  cardDetailCacheKey,
  type DispatchedListRow,
  type FieldViewJobCard,
} from '../lib/dispatchDisplay';
import type { Field, Profile } from '../types';
import { saveTodaySnapshot, savedCopyAfterFailure } from '../lib/todaySnapshot';
import { isNetworkFailure } from '../lib/deliveryEvidence';
import SavedCopyBanner from '../components/route/SavedCopyBanner';

// The Supabase Data API caps a single response at ~1000 rows; page get_dispatched_list
// via .range() until a short page ends the scan (same pattern as the DispatchBoard's
// Dispatched List — an applicator with many dispatched locations must not be truncated).
const PAGE = 1000;

/** Read-only detail for an expanded card (the five fields beyond the header). */
interface CardDetail {
  /** jobs.updated_at at the time this detail was fetched — the offline-conflict
   *  snapshot for a queued Complete (mirrors FieldStop's syncAfterArrive pattern:
   *  the value must be captured while ONLINE, before a Complete might be queued). */
  jobUpdatedAt: string | null;
  /** Every location on the job — name + crop (Locations + Crops card sections). */
  fields: { id: string; field_name: string | null; crop: string | null; acres_to_treat: number | null }[];
  /** Every chemical on the job (rate/quantity only — no pricing on this screen). */
  chemicals: {
    id: string;
    product_name: string | null;
    quantity: number | null;
    unit: string | null;
    rate_per_acre: number | null;
    rate_unit: string | null;
    rei_hours: number | null;
    phi_days: number | null;
  }[];
}

/** The compact "Complete Job" form — mirrors JobDetail's Complete Job modal fields. */
interface CompleteForm {
  wind_speed: string;
  wind_direction: string;
  temperature: string;
  humidity: string;
  actual_gallons_applied: string;
  notes: string;
  /** job_field_id -> applied-acres string input, seeded from location_acres. */
  fieldAcres: Record<string, string>;
}

function emptyCompleteForm(): CompleteForm {
  return {
    wind_speed: '', wind_direction: '', temperature: '', humidity: '',
    actual_gallons_applied: '', notes: '', fieldAcres: {},
  };
}

type ViewMode = 'list' | 'map';

function crewMarkerScope(profile: Profile | null, loading: boolean, assignmentsChecked: boolean,
  { savedCopyAt, isOnline, mapAssignmentFailed }: { savedCopyAt: string | null; isOnline: boolean; mapAssignmentFailed: boolean }) {
  const mapChecking = loading || !assignmentsChecked;
  const markerUser = {
    actorId: profile?.id ?? '',
    office: profile?.role === 'admin' || profile?.role === 'sales_rep',
    placementAllowed: isOnline && !(mapChecking || savedCopyAt || mapAssignmentFailed),
  };
  return { mapChecking, markerUser };
}

/** Sign-in or permission refusals: the crew member may have lost access, so a loaded list must not survive them. */
function isAccessRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return status === 401 || status === 403
    || (typeof code === 'string' && (code === '42501' || /^PGRST30[1-3]$/.test(code.trim().toUpperCase())));
}

function jobLoadFallback(error: unknown, actorId: string | undefined, forMap: boolean) {
  const lostSignal = isNetworkFailure(error);
  // A map recheck keeps the loaded list through any temporary failure; the map-check warning still blocks new pins.
  if (forMap && !isAccessRefusal(error)) return { kind: 'keep-current' } as const;
  const saved = savedCopyAfterFailure<FieldViewJobCard[]>(MY_DAY_SNAPSHOT, actorId, lostSignal);
  return saved && Array.isArray(saved.data) ? { kind: 'saved', saved } as const : { kind: 'unavailable' } as const;
}

function FieldMapReadWarning({ jobsFailed, fieldsFailed, mapAssignmentFailed, savedCopyAt, offline, loading, retry }: {
  jobsFailed: boolean;
  offline: boolean;
  fieldsFailed: boolean;
  mapAssignmentFailed: boolean;
  savedCopyAt: string | null;
  loading: boolean;
  retry: () => void;
}) {
  // Offline, assignments cannot be rechecked, so the shown fields may be out of date.
  if (!jobsFailed && !fieldsFailed && !mapAssignmentFailed && !savedCopyAt && !offline) {
    return loading ? <p role="status" className="m-3 text-sm">Checking assigned fields…</p> : null;
  }
  return (
    <div className="m-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p role="status">Couldn't check all assigned fields. Some markers may be missing. Confirm hazards on site.</p>
      <button type="button" disabled={loading || offline} onClick={retry}
        className="mt-2 min-h-[44px] rounded-lg border border-amber-300 bg-white px-3 font-semibold disabled:opacity-50">
        {loading ? 'Checking assigned fields…' : 'Reload map'}
      </button>
    </div>
  );
}

export default function FieldView() {
  usePageMeta();
  const { toast } = useToast();
  const { profile } = useAuth();
  const isOnline = useOnlineStatus();
  const startIdem = useIdempotencyKey('start_job', profile?.id || '');
  const completeIdem = useIdempotencyKey('complete_job', profile?.id || '');
  const today = useMemo(() => localToday(), []);

  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [mapAssignmentFailed, setMapAssignmentFailed] = useState(false);
  // When the job list failed to load and today's saved copy is shown instead (read-only): when it was loaded.
  const [savedCopyAt, setSavedCopyAt] = useState<string | null>(null);
  const [cards, setCards] = useState<FieldViewJobCard[]>([]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('list');
  const [mapOpenCount, setMapOpenCount] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Per-job expanded detail, fetched lazily on first expand and cached.
  const [details, setDetails] = useState<Record<string, CardDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const inFlightDetail = useRef<Set<string>>(new Set());

  // Start Job (online-only, mirrors FieldStop's Arrive step).
  const [startConfirmFor, setStartConfirmFor] = useState<FieldViewJobCard | null>(null);
  const [starting, setStarting] = useState(false);

  // Complete Job (queues offline — mirrors FieldStop's Complete step).
  const [completeFormOpenFor, setCompleteFormOpenFor] = useState<string | null>(null);
  const [completeForm, setCompleteForm] = useState<CompleteForm>(emptyCompleteForm());
  const [completeConfirmFor, setCompleteConfirmFor] = useState<FieldViewJobCard | null>(null);
  const [completing, setCompleting] = useState(false);
  // Jobs whose completion is saved on this phone and still waiting to send: no second
  // Complete for them until it sends, needs attention, or is discarded.
  const { queuedJobIds, markQueued } = useQueuedJobCompletions(profile);

  // Map geometry (best-effort; the list view never depends on it).
  const [mapFields, setMapFields] = useState<Field[]>([]);
  const [mapActorId, setMapActorId] = useState<string>();
  const [mapReadFailed, setMapReadFailed] = useState(false);
  const [mapCheckedCards, setMapCheckedCards] = useState(cards);
  const { mapChecking, markerUser } = crewMarkerScope(profile, loading, cards === mapCheckedCards, {
    savedCopyAt, isOnline, mapAssignmentFailed,
  });
  const mapRef = useRef<MapRef | null>(null);
  const [jobsByField, setJobsByField] = useState<Map<string, string[]>>(() => new Map());
  const jobLoadSequence = useRef(0);

  // --- Load "my jobs" (the dispatched-location rows for the caller) -----------------
  const fetchCards = useCallback(async (forMap = false) => {
    const sequence = ++jobLoadSequence.current;
    const applyLatest = (update: () => void) => {
      if (sequence === jobLoadSequence.current) update();
    };
    setLoading(true);
    try {
      const all: DispatchedListRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .rpc('get_dispatched_list')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const page = assertRpcResult<DispatchedListRow[]>(data, 'get_dispatched_list');
        const rows = Array.isArray(page) ? page : [];
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      const grouped = groupDispatchedByJob(all);

      // U12 Codex R3 #1: an applicator assigned the LEGACY way (jobs.applicator_id
      // set, no job_location_dispatches rows) has work that get_dispatched_list
      // never returns — without this merge they'd land on an empty "No jobs"
      // screen despite having a full day. Fetch their open whole-job assignments
      // plus a 7-day tail of completed/invoiced jobs, then merge any job the dispatch
      // list didn't already cover as a whole-job card (locations: [] — the card face
      // reads "Whole job assigned to you" and the expanded detail falls back to a
      // by-job_id job_fields fetch).
      // Start/Complete already authorize the legacy jobs.applicator_id path
      // server-side. RLS: jobs_select/job_fields_select let the whole-job
      // applicator read their own jobs (JobDetail relies on this today). The
      // customers embed is RLS-gated for applicators (7-day job window) — a
      // blocked embed just renders 'Unknown', never errors.
      // Accepted difference (A1 compliance MED): this legacy tail anchors on
      // jobs.updated_at (any job edit bumps it, stretching how long the card
      // lingers in Done), while the RPC path anchors on the dispatch row's
      // updated_at (touched only at job-terminal). jobs has no
      // completion-specific timestamp to anchor on; a slightly-longer Done
      // linger for legacy jobs is harmless.
      if (profile?.id) {
        const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const legacyRes = await supabase
          .from('jobs')
          .select('id, job_number, job_date, status, total_acres, applied_acres, customer_id, customer:customers(farm_name)')
          .eq('applicator_id', profile.id)
          .is('deleted_at', null)
          .or(`status.in.(scheduled,in_progress),and(status.in.(completed,invoiced),updated_at.gte.${sevenDaysAgoIso})`);
        if (legacyRes.error) throw legacyRes.error;
        const covered = new Set(grouped.map((c) => c.job_id));
        const legacyRows = (legacyRes.data || []) as unknown as Array<{
          id: string; job_number: string; job_date: string | null; status: string;
          total_acres: number | null; applied_acres: number | null;
          customer_id: string; customer?: { farm_name?: string } | null;
        }>;
        for (const j of legacyRows) {
          if (covered.has(j.id)) continue;
          grouped.push({
            job_id: j.id,
            job_number: j.job_number,
            job_status: j.status,
            job_date: j.job_date,
            customer_name: j.customer?.farm_name ?? null,
            job_applied_acres: j.applied_acres,
            job_total_acres: j.total_acres,
            locations: [],
          });
        }
        // Keep the stable job_number ordering groupDispatchedByJob promises.
        grouped.sort((a, b) => a.job_number.localeCompare(b.job_number));
      }

      applyLatest(() => {
        // Today's read-only copy for a dead spot (src/lib/todaySnapshot.ts): the cards as shown, nothing more.
        if (profile?.id) saveTodaySnapshot(MY_DAY_SNAPSHOT, profile.id, grouped);
        setFetchError(false);
        setSavedCopyAt(null);
        setMapAssignmentFailed(false);
        setCards(grouped);
      });
    } catch (err) {
      applyLatest(() => {
        Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_my_jobs' } });
        const fallback = jobLoadFallback(err, profile?.id, forMap);
        if (fallback.kind === 'keep-current') {
          // Checking pins must not turn an already loaded job into a read-only copy.
          setMapAssignmentFailed(true);
          return;
        }
        if (fallback.kind === 'saved') {
          // Shown read-only: Start and Complete stay off until a load succeeds (the banner says why), and an open
          // Complete form closes, as it did when a failed load emptied the list.
          setCompleteFormOpenFor(null);
          setFetchError(false);
          setSavedCopyAt(fallback.saved.savedAt);
          setCards(fallback.saved.data);
        } else {
          // Honest error state: distinguish "couldn't load" from "genuinely no jobs" —
          // the empty-state copy below only shows when fetchError is false.
          setSavedCopyAt(null);
          setFetchError(true);
          toast('error', 'Failed to load your jobs');
          setCards([]);
        }
      });
    } finally {
      applyLatest(() => setLoading(false));
    }
  }, [toast, profile?.id]);

  useEffect(() => {
    void fetchCards();
    return () => { jobLoadSequence.current += 1; };
  }, [fetchCards]);

  useEffect(() => {
    if (view !== 'map' || mapChecking) return;
    function onMapResume() {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      setMapOpenCount((count) => count + 1);
      void fetchCards(true);
    }
    document.addEventListener('visibilitychange', onMapResume);
    window.addEventListener('online', onMapResume);
    return () => {
      document.removeEventListener('visibilitychange', onMapResume);
      window.removeEventListener('online', onMapResume);
    };
  }, [view, mapChecking, fetchCards]);

  // A saved completion left the queue (sent, needs attention, or discarded): reload so a
  // sent one shows the job as done instead of offering Complete again. Wait for signal:
  // a reload that fails offline would blank the whole job list.
  const prevQueuedJobIds = useRef(queuedJobIds);
  const reloadAfterSend = useRef(false);
  useEffect(() => {
    if ([...prevQueuedJobIds.current].some((id) => !queuedJobIds.has(id))) reloadAfterSend.current = true;
    prevQueuedJobIds.current = queuedJobIds;
    if (reloadAfterSend.current && isOnline) {
      reloadAfterSend.current = false;
      void fetchCards();
    }
  }, [queuedJobIds, fetchCards, isOnline]);

  // --- Map geometry for the visible job locations (best-effort) ---------------------
  useEffect(() => {
    if (cards.length === 0) { setMapReadFailed(false); setMapFields([]); setJobsByField(new Map()); setMapCheckedCards(cards); return; }
    let cancelled = false;
    let checkedJobs: Map<string, string[]> | undefined;
    (async () => {
      try {
        const myJobFieldIds = cards.flatMap((c) => c.locations.map((l) => l.job_field_id));
        const jfRows: { id: string; job_id: string; field_id: string | null }[] = [];
        for (const chunk of chunkIds(myJobFieldIds)) {
          const jfRes = await supabase
            .from('job_fields')
            .select('id, job_id, field_id')
            .in('id', chunk);
          if (jfRes.error) throw jfRes.error;
          jfRows.push(...(jfRes.data ?? []));
        }
        // Read by job ID only for whole-job cards. A split job can include fields dispatched to another crew.
        const wholeJobIds = cards.filter((card) => card.locations.length === 0).map((card) => card.job_id);
        const wholeJobFields = await fetchAllRowsForIds(wholeJobIds, (jobIds, from, to) => pageWithList(supabase
          .from('job_fields').select('id, job_id, field_id', { count: 'exact' })
          .in('job_id', jobIds).order('id').range(from, to)));
        if (wholeJobFields.error) throw wholeJobFields.error;
        for (const row of wholeJobFields.data ?? []) jfRows.push(row);
        const mappedJobs = new Map<string, string[]>();
        for (const { field_id, job_id } of jfRows) {
          if (!field_id) continue;
          const jobs = mappedJobs.get(field_id);
          if (jobs) jobs.push(job_id);
          else mappedJobs.set(field_id, [job_id]);
        }
        checkedJobs = mappedJobs;
        const fieldIds = [...mappedJobs.keys()];
        // Every requested field, page by page (one reply stopped at the server's row cap, Goal 4 N8).
        // A page with neither rows nor an error is a silent denial: reported, not read as "no fields".
        const { data: geoData, error: geoErr } = fieldIds.length === 0 ? { data: [], error: null } : await fetchAllRows(async (from, to) => {
          const page = await supabase
            .rpc('get_fields_geojson_by_ids', { p_field_ids: fieldIds }, { count: 'exact' })
            .order('field_name').order('id').range(from, to);
          if (!page.error && (page.data === null || page.data === undefined)) {
            return { data: null, error: { message: 'get_fields_geojson_by_ids returned no data' }, count: null };
          }
          return page;
        });
        if (geoErr) throw geoErr;
        const fRows = (assertRpcResult<Array<Field>>(geoData, 'get_fields_geojson_by_ids') || []) as unknown as Field[];
        if (!cancelled) {
          const locationIds = new Set(jfRows.map((row) => row.id));
          const mappedIds = new Set(fRows.map((field) => field.id));
          setMapReadFailed([
            jfRows.some((row) => !row.field_id),
            myJobFieldIds.some((id) => !locationIds.has(id)),
            fieldIds.some((id) => !mappedIds.has(id)),
          ].some(Boolean));
          setJobsByField(mappedJobs);
          setMapFields(fRows);
          setMapActorId(markerUser.actorId);
          setMapCheckedCards(cards);
        }
      } catch (err) {
        Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_map_fields' } });
        if (cancelled) return;
        setMapCheckedCards(cards);
        setMapReadFailed(true);
        if (!isNetworkFailure(err)) {
          setMapFields([]);
          setJobsByField(new Map());
        } else if (checkedJobs) {
          setJobsByField(checkedJobs);
        } else if (!savedCopyAt) {
          // A fresh legacy job card alone does not identify the fields now on that job.
          const splitJobs = new Set(cards.filter((card) => card.locations.length > 0).map((card) => card.job_id));
          setJobsByField((previous) => {
            const kept = new Map<string, string[]>();
            for (const [id, jobs] of previous) {
              kept.set(id, jobs.filter((job) => splitJobs.has(job)));
            }
            return kept;
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [cards, markerUser.actorId, savedCopyAt]);

  useEffect(() => {
    if (view !== 'map' || !mapRef.current) return;
    const id = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [view]);

  const visibleCards = useMemo(() => filterFieldViewCards(cards, search), [cards, search]);
  const { active: activeCards, done: doneCards } = useMemo(
    () => groupFieldViewCards(visibleCards, today),
    [visibleCards, today]
  );

  const fieldToJob = useMemo(() => {
    const visibleFieldJobs = new Map<string, string>();
    if (mapActorId !== markerUser.actorId) return visibleFieldJobs;
    const currentJobs = new Map(cards.map((card) => [card.job_id, card.locations]));
    for (const [fieldId, jobIds] of jobsByField) {
      const jobId = [...jobIds].sort().find((id) => {
        const locations = currentJobs.get(id);
        return locations && (locations.length === 0 || locations.some((location) => location.field_id === fieldId));
      });
      if (jobId) visibleFieldJobs.set(fieldId, jobId);
    }
    return visibleFieldJobs;
  }, [cards, jobsByField, mapActorId, markerUser.actorId]);
  const visibleMapFields = useMemo(() => mapFields.filter((field) => fieldToJob.has(field.id)), [mapFields, fieldToJob]);

  // --- Lazy-load a card's read-only detail on first expand --------------------------
  const loadDetail = useCallback(async (card: FieldViewJobCard) => {
    const cacheKey = cardDetailCacheKey(card);
    if (details[cacheKey]) return; // cached
    if (inFlightDetail.current.has(cacheKey)) return; // already fetching this exact set
    inFlightDetail.current.add(cacheKey);
    setDetailLoading(card.job_id);
    try {
      // updated_at is the offline-conflict snapshot for a queued Complete — must be
      // captured HERE (while online) so a later offline Complete has a value to send.
      const jobRes = await supabase
        .from('jobs')
        .select('job_date, updated_at')
        .eq('id', card.job_id)
        .maybeSingle();
      if (jobRes.error) throw jobRes.error;

      const myJobFieldIds = card.locations.map((l) => l.job_field_id);
      const jfRaw: Array<{ id: string; crop: string | null; acres_to_treat: number | null; sort_order: number | null; field?: { field_name?: string } }> = [];
      if (myJobFieldIds.length === 0) {
        // Legacy whole-job card (U12 Codex R3 #1): no per-location dispatch rows
        // to scope by, and the caller owns the WHOLE job — fetch its job_fields by
        // job_id instead. RLS: job_fields_select already grants the whole-job
        // applicator (jobs.applicator_id = caller) read of every field on the job.
        const fieldsRes = await supabase
          .from('job_fields')
          .select('id, crop, acres_to_treat, sort_order, field:fields(field_name)')
          .eq('job_id', card.job_id)
          .order('sort_order', { ascending: true, nullsFirst: false });
        if (fieldsRes.error) throw fieldsRes.error;
        jfRaw.push(...((fieldsRes.data || []) as typeof jfRaw));
      } else {
        for (const chunk of chunkIds(myJobFieldIds)) {
          const fieldsRes = await supabase
            .from('job_fields')
            .select('id, crop, acres_to_treat, sort_order, field:fields(field_name)')
            .in('id', chunk)
            .order('sort_order', { ascending: true, nullsFirst: false });
          if (fieldsRes.error) throw fieldsRes.error;
          jfRaw.push(...((fieldsRes.data || []) as typeof jfRaw));
        }
      }
      jfRaw.sort((a, b) => (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER));

      // Chemicals (job_chemicals) — rate/quantity + REI/PHI only, NO pricing on this
      // screen (owner decision, U12). Readable via job_chemicals_select_location_dispatchee.
      const chemRes = await supabase
        .from('job_chemicals')
        .select('id, quantity, unit, rate_per_acre, rate_unit, sort_order, product:products(product_name, rei_hours, phi_days)')
        .eq('job_id', card.job_id)
        .order('sort_order', { ascending: true, nullsFirst: false });
      if (chemRes.error) throw chemRes.error;

      const detail: CardDetail = {
        jobUpdatedAt: (jobRes.data as { updated_at?: string } | null)?.updated_at ?? null,
        fields: jfRaw.map((jf) => ({
          id: jf.id,
          field_name: jf.field?.field_name ?? null,
          crop: jf.crop,
          acres_to_treat: jf.acres_to_treat,
        })),
        chemicals: ((chemRes.data || []) as Array<{ id: string; quantity: number | null; unit: string | null; rate_per_acre: number | null; rate_unit: string | null; product?: { product_name?: string; rei_hours?: number | null; phi_days?: number | null } }>).map((jc) => ({
          id: jc.id,
          product_name: jc.product?.product_name ?? null,
          quantity: jc.quantity,
          unit: jc.unit,
          rate_per_acre: jc.rate_per_acre,
          rate_unit: jc.rate_unit,
          rei_hours: jc.product?.rei_hours ?? null,
          phi_days: jc.product?.phi_days ?? null,
        })),
      };
      setDetails((prev) => ({ ...prev, [cacheKey]: detail }));

      // Seed the per-location applied-acres inputs from the card's own dispatched
      // locations (defaults to the planned acres_to_treat — untouched = no override).
      // MERGES new keys only (never overwrites an already-seeded/edited key) so
      // expanding a SECOND job doesn't clobber edits already made on a first one —
      // fieldAcres accumulates across every job expanded this session; submission
      // only ever reads the keys belonging to the job being completed.
      setCompleteForm((prev) => {
        let changed = false;
        const merged = { ...prev.fieldAcres };
        for (const loc of card.locations) {
          if (!(loc.job_field_id in merged)) {
            merged[loc.job_field_id] = loc.location_acres != null ? String(loc.location_acres) : '';
            changed = true;
          }
        }
        return changed ? { ...prev, fieldAcres: merged } : prev;
      });
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'field_view_card_detail' } });
      toast('error', 'Failed to load job details');
    } finally {
      inFlightDetail.current.delete(cacheKey);
      setDetailLoading(null);
    }
  }, [details, toast]);

  const toggleExpand = useCallback((card: FieldViewJobCard) => {
    setExpandedId((prev) => (prev === card.job_id ? null : card.job_id));
  }, []);

  useEffect(() => {
    if (!expandedId) return;
    const card = visibleCards.find((c) => c.job_id === expandedId);
    if (card && !details[cardDetailCacheKey(card)]) void loadDetail(card);
  }, [expandedId, visibleCards, details, loadDetail]);

  const cropList = (detail: CardDetail): string[] =>
    Array.from(new Set(detail.fields.map((f) => (f.crop || '').trim()).filter(Boolean)));

  // --- Start Job (online-only) -------------------------------------------------------
  const requestStart = (card: FieldViewJobCard) => {
    if (!isOnline) { toast('error', 'Connect to the internet to start this job'); return; }
    setStartConfirmFor(card);
  };

  const handleStart = async () => {
    const card = startConfirmFor;
    if (!card || !profile) return;
    setStarting(true);
    try {
      const { data, error } = await supabase.rpc('start_job', {
        p_job_id: card.job_id,
        p_performed_by: profile.id,
        p_idempotency_key: startIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'start_job');
      startIdem.resetKey();
      toast('success', `Job ${card.job_number} started`);
      setStartConfirmFor(null);
      // U12 Codex R4 #1: start_job just bumped jobs.updated_at server-side, so a
      // detail cached BEFORE the start now carries a stale jobUpdatedAt snapshot.
      // If a Complete were queued offline with that pre-start value, offlineSync
      // compares server updated_at > snapshotAt and would treat the caller's OWN
      // start as a conflict — permanently skipping the completion on reconnect.
      // Drop every cached detail for this job (any dispatch-set cache key); the
      // expand effect re-fetches immediately while we're still online (Start is
      // online-only), caching a fresh post-start snapshot. If the connection
      // drops mid-refetch, the queued Complete carries NO snapshot (undefined),
      // which offlineSync treats as "no conflict check" — a blind replay beats a
      // guaranteed false conflict.
      setDetails((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${card.job_id}|`)) delete next[key];
        }
        return next;
      });
      await fetchCards();
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'critical_action', action: 'field_view_start_job' } });
      toast('error', sanitizeError(err));
    }
    setStarting(false);
  };

  // --- Complete Job (queues offline) --------------------------------------------------
  const openCompleteForm = (card: FieldViewJobCard) => {
    if (queuedJobIds.has(card.job_id)) return;
    setExpandedId(card.job_id); // Complete lives in the expanded panel (needs detail loaded)
    // U12 Codex R4 #2: completeForm is ONE shared state — without a reset, values
    // typed for job A (wind/notes/gallons) silently submit for job B after
    // cancel→reopen. Reset on EVERY open and seed this card's own per-location
    // acres defaults (same source loadDetail seeds from; loadDetail's later
    // merge-only seeding fills identical values, so no clobber either way).
    // Deliberate side effect: Cancel→reopen of the SAME job also starts clean —
    // Cancel means discard.
    const seeded = emptyCompleteForm();
    for (const loc of card.locations) {
      seeded.fieldAcres[loc.job_field_id] = loc.location_acres != null ? String(loc.location_acres) : '';
    }
    setCompleteForm(seeded);
    setCompleteFormOpenFor(card.job_id);
  };

  const requestComplete = (card: FieldViewJobCard) => {
    if (queuedJobIds.has(card.job_id)) return;
    setCompleteConfirmFor(card);
  };

  const handleComplete = async () => {
    const card = completeConfirmFor;
    if (!card || !profile) return;
    const detail = details[cardDetailCacheKey(card)];
    setCompleteConfirmFor(null); // close confirm immediately
    // A completion for this job is already saved on this phone: a second one is never queued or sent.
    if (queuedJobIds.has(card.job_id)) return;
    setCompleting(true);

    // field_id comes from get_dispatched_list (U12 Codex P1 — the RPC now returns
    // job_fields.field_id per row, threaded through DispatchedListRow → card
    // locations). complete_job's field_acres override is keyed by the master
    // fields.id, so a location with no linked master field (null) is skipped —
    // it can't be addressed by the override and falls back to planned acres.
    const fieldAcresPayload = card.locations
      .filter((l) => l.field_id)
      .map((l) => ({
        field_id: l.field_id,
        acres_applied: Number(completeForm.fieldAcres[l.job_field_id] ?? l.location_acres ?? 0),
      }))
      .filter((f) => Number.isFinite(f.acres_applied));

    const appliedInfo = {
      wind_speed: completeForm.wind_speed || null,
      wind_direction: completeForm.wind_direction || null,
      temperature: completeForm.temperature || null,
      humidity: completeForm.humidity || null,
      actual_gallons_applied: completeForm.actual_gallons_applied || null,
      notes: completeForm.notes || null,
      field_acres: fieldAcresPayload,
    };
    const rpcParams = {
      p_job_id: card.job_id,
      p_applied_info: appliedInfo as unknown as Json,
      p_performed_by: profile.id,
      p_idempotency_key: completeIdem.getKey(),
    };

    // OFFLINE — requires the card's detail to have been fetched ONLINE already (so
    // jobUpdatedAt exists as the conflict snapshot). Mirrors FieldStop's pattern.
    if (!isOnline) {
      try {
        await queueAction({
          operation: 'complete_job',
          params: rpcParams as Record<string, unknown>,
          createdAt: new Date().toISOString(),
          retryCount: 0,
          ownerUserId: profile.id,
          status: 'pending',
          entityTable: 'jobs',
          entityId: card.job_id,
          snapshotAt: detail?.jobUpdatedAt ?? undefined,
        });
        completeIdem.resetKey();
        markQueued(card.job_id);
        toast('success', `Job ${card.job_number} saved offline — it will retry when connected and remain saved if it needs attention`);
        setCompleteFormOpenFor(null);
        setCompleteForm(emptyCompleteForm());
      } catch (error) {
        toast('error', getOfflineStorageErrorMessage(error));
      }
      setCompleting(false);
      return;
    }

    try {
      const { data, error } = await supabase.rpc('complete_job', rpcParams);
      if (error) throw error;
      const result = assertRpcResult<{ record_number?: string }>(data, 'complete_job');
      completeIdem.resetKey();
      toast('success', `Job ${card.job_number} completed${result.record_number ? ` — record ${result.record_number}` : ''}`);
      setCompleteFormOpenFor(null);
      setCompleteForm(emptyCompleteForm());
      await fetchCards();
    } catch (err) {
      // Any replay-binding refusal (another request's or person's key, or a receipt that can never be
      // used) retires the key; nothing ran for THIS request. Safe for a completion even if an earlier
      // attempt committed: the next try runs fresh and the body refuses a record no longer in_progress.
      // Close the form and reload so a completion an earlier attempt already committed shows; the
      // typed values stay in completeForm if the job is still open and the form is reopened.
      if (getIdempotencyBindingRejection(err)) {
        completeIdem.resetKey();
        // Only this job's form: another job's form opened meanwhile keeps its draft.
        setCompleteFormOpenFor((open) => (open === card.job_id ? null : open));
        fetchCards();
      }
      Sentry.captureException(err, { tags: { source: 'critical_action', action: 'field_view_complete_job' } });
      // U12 Codex R5 #2: a dispatch-only applicator on a SPLIT job (other
      // locations dispatched to someone else) sees Complete, but complete_job
      // correctly rejects — completing would close the WHOLE job over the other
      // party's work. RLS hides other parties' dispatch rows from this client,
      // so ownership can't be pre-computed here; translate the RPC's raw
      // rejection into a friendly explanation instead.
      const msg = sanitizeError(err);
      toast('error', msg.includes('Not authorized to complete this job')
        ? 'This job is split with another applicator or crew — the office will complete and close it.'
        : msg);
    }
    setCompleting(false);
  };

  const canSubmitComplete = !completing;

  // --- Card renderer (shared by the Today-first list and the Done section) ---------
  function renderCard(card: FieldViewJobCard) {
    const badge = jobStatusToDispatchBadge(card.job_status);
    const expanded = expandedId === card.job_id;
    const detail = details[cardDetailCacheKey(card)];
    const isDetailLoading = detailLoading === card.job_id;
    const isTerminal = isTerminalJobStatus(card.job_status);
    const dateLabel = card.job_date
      // parseLocalDate, not new Date(): a bare YYYY-MM-DD parses as UTC midnight
      // and renders the PREVIOUS day in US timezones (U12 Codex P2).
      ? (card.job_date === today ? 'Today' : parseLocalDate(card.job_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
      : null;
    const reiPhi = detail ? maxLabelReiPhi(detail.chemicals) : { reiHours: null, phiDays: null };
    const completionQueued = queuedJobIds.has(card.job_id);
    const showingCompleteForm = completeFormOpenFor === card.job_id && !completionQueued;

    return (
      <div
        key={card.job_id}
        className="bg-white"
      >
        {/* Card header — the always-visible summary row (tap to expand). */}
        <button
          onClick={() => toggleExpand(card)}
          aria-expanded={expanded}
          className="w-full flex items-start justify-between gap-3 px-4 pt-3 pb-3 text-left min-h-[44px] hover:bg-cream/60"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-heading text-xl font-bold leading-tight text-nav-dark">{card.job_number}</span>
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold tracking-wide ${lightBadgeClass(card.job_status)}`}>
                {badge.label}
              </span>
              {dateLabel && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                  <Calendar className="w-3 h-3" aria-hidden="true" /> {dateLabel}
                </span>
              )}
            </div>
            <p className="mt-1 text-base text-nav-dark font-semibold break-words">{card.customer_name || 'Unknown'}</p>
            <p className="flex items-center gap-1.5 text-sm text-secondary">
              <MapPin className="w-4 h-4 shrink-0" aria-hidden="true" />
              {/* A legacy whole-job assignment (jobs.applicator_id, no per-location
                  dispatch rows) has no locations array — "0 locations assigned to
                  you" would read as a bug, so name what it actually is. */}
              {card.locations.length === 0
                ? 'Whole job assigned to you'
                : `${card.locations.length} location${card.locations.length === 1 ? '' : 's'} assigned to you`}
            </p>
          </div>
          <div className="flex flex-col items-end gap-0.5 shrink-0">
            <span className="font-heading text-xl font-bold text-nav-dark tabular-nums leading-tight whitespace-nowrap">
              {formatAppliedOfTotal(card.job_applied_acres, card.job_total_acres)}
            </span>
            <span className="text-xs text-secondary">job total</span>
            {expanded ? <ChevronUp className="w-5 h-5 text-secondary mt-0.5" aria-hidden="true" /> : <ChevronDown className="w-5 h-5 text-secondary mt-0.5" aria-hidden="true" />}
          </div>
        </button>

        {/* Quick actions — visible on the card face, no expand required for Start. Off on a saved copy. */}
        {!isTerminal && !savedCopyAt && (
          <div className="px-4 pb-3 flex gap-2">
            {card.job_status === 'scheduled' && (
              <button
                type="button"
                onClick={() => requestStart(card)}
                disabled={!isOnline}
                className={ROW_ACTION}
              >
                <PlayCircle className="w-5 h-5" aria-hidden="true" /> Start Job
              </button>
            )}
            {card.job_status === 'in_progress' && (completionQueued ? (
              <p role="status" className="flex-1 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-base font-semibold text-amber-900">
                <CloudUpload className="w-5 h-5 shrink-0" aria-hidden="true" />
                Completion saved on this phone — will send when signal returns
              </p>
            ) : (
              <button
                type="button"
                onClick={() => openCompleteForm(card)}
                className={ROW_ACTION}
              >
                <CheckCircle2 className="w-5 h-5" aria-hidden="true" /> Complete Job
              </button>
            ))}
          </div>
        )}
        {!isOnline && !savedCopyAt && card.job_status === 'scheduled' && (
          <p className="px-4 pb-3 -mt-1 flex items-center gap-1.5 text-sm text-amber-800">
            <WifiOff className="w-4 h-4" aria-hidden="true" /> Connect to the internet to start this job.
          </p>
        )}

        {/* Expanded card — the read-only detail sections + (when in_progress) the
            Complete Job form. */}
        {expanded && (
          <div className="border-t border-gray-100 bg-cream/50 px-4 py-4 space-y-4">
            {isDetailLoading && !detail ? (
              <div className="flex items-center gap-2 text-sm text-secondary">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading job details…
              </div>
            ) : detail ? (
              <>
                <Section icon={<Users className="w-4 h-4" />} title="Customer">
                  <p className="text-base text-nav-dark font-medium">{card.customer_name || 'Unknown'}</p>
                </Section>

                <Section icon={<MapPin className="w-4 h-4" />} title="Locations">
                  {detail.fields.length === 0 ? (
                    <p className="text-sm text-secondary">No locations.</p>
                  ) : (
                    <ul className="divide-y divide-gray-100">
                      {detail.fields.map((f) => (
                        <li key={f.id} className="flex items-center justify-between gap-3 py-1.5 text-base">
                          <span className="text-nav-dark truncate">{f.field_name || 'Field'}</span>
                          {f.acres_to_treat != null && (
                            <span className="text-secondary tabular-nums shrink-0">{f.acres_to_treat} ac</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Section icon={<Sprout className="w-4 h-4" />} title="Crops">
                  {cropList(detail).length === 0 ? (
                    <p className="text-sm text-secondary">No crop recorded.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {cropList(detail).map((crop) => (
                        <span key={crop} className="px-2.5 py-0.5 rounded-full bg-crx-green-light text-sm text-crx-green font-medium">
                          {crop}
                        </span>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Chemicals — rate/quantity ONLY, no pricing (U12 owner decision). */}
                <Section icon={<FlaskConical className="w-4 h-4" />} title="Chemicals">
                  <p className="text-xs text-secondary -mt-1 mb-1.5">Applies to the whole job.</p>
                  {detail.chemicals.length === 0 ? (
                    <p className="text-sm text-secondary">No chemicals listed.</p>
                  ) : (
                    <ul className="divide-y divide-gray-100">
                      {detail.chemicals.map((c) => (
                        <li key={c.id} className="py-2 first:pt-0 last:pb-0">
                          <p className="text-base text-nav-dark font-medium truncate">{c.product_name || 'Product'}</p>
                          <p className="text-sm text-secondary">
                            {c.rate_per_acre != null ? `${c.rate_per_acre}${c.rate_unit ? ' ' + c.rate_unit : ''}/ac` : '—'}
                            {c.quantity != null ? ` · ${c.quantity}${c.unit ? ' ' + c.unit : ''}` : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                {/* REI/PHI — only when at least one product has that label data on file. */}
                {(reiPhi.reiHours != null || reiPhi.phiDays != null) && (
                  <Section icon={<ShieldAlert className="w-4 h-4" />} title="Re-Entry / Harvest" tone="amber">
                    <div className="flex flex-wrap gap-4 text-base">
                      {reiPhi.reiHours != null && (
                        <div><span className="text-secondary">REI</span> <span className="text-nav-dark font-semibold">{reiPhi.reiHours}h</span></div>
                      )}
                      {reiPhi.phiDays != null && (
                        <div><span className="text-secondary">PHI</span> <span className="text-nav-dark font-semibold">{reiPhi.phiDays}d</span></div>
                      )}
                    </div>
                  </Section>
                )}

                {/* Complete Job form — only for an in_progress job the applicator opened. */}
                {showingCompleteForm && card.job_status === 'in_progress' && (
                  <Section icon={<CheckCircle2 className="w-4 h-4" />} title="Complete Job">
                    {!isOnline && (
                      <p className="flex items-center gap-1.5 text-sm text-amber-800 mb-2">
                        <WifiOff className="w-4 h-4" aria-hidden="true" /> You're offline &mdash; this will save now and sync when you reconnect.
                      </p>
                    )}
                    <CompletionWeatherFields
                      value={completeForm}
                      onChange={(patch) => setCompleteForm((p) => ({ ...p, ...patch }))}
                      otherJobs={cards.filter((c) => c.job_id !== card.job_id)}
                    />
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <FieldInput label="Actual Gallons" value={completeForm.actual_gallons_applied}
                        onChange={(v) => setCompleteForm((p) => ({ ...p, actual_gallons_applied: v }))} />
                    </div>
                    {card.locations.length > 0 && (
                      <div className="mb-3">
                        <p className="text-sm font-semibold text-nav-dark mb-1.5">Applied acres (per location)</p>
                        <div className="divide-y divide-gray-100">
                          {card.locations.map((loc) => (
                            <label key={loc.job_field_id} className="flex items-center justify-between gap-3 py-1.5">
                              <span className="text-base text-nav-dark truncate">{loc.field_name || 'Field'}</span>
                              <input
                                type="number" inputMode="decimal" step="any" min={0}
                                value={completeForm.fieldAcres[loc.job_field_id] ?? ''}
                                onChange={(e) => setCompleteForm((p) => ({ ...p, fieldAcres: { ...p.fieldAcres, [loc.job_field_id]: e.target.value } }))}
                                className="h-11 w-28 text-right font-heading text-xl font-bold tabular-nums bg-white border border-gray-300 rounded-lg px-2 text-nav-dark"
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="mb-3">
                      <label htmlFor={`complete-notes-${card.job_id}`} className="block text-sm font-semibold text-nav-dark mb-1">Notes</label>
                      <textarea
                        id={`complete-notes-${card.job_id}`}
                        value={completeForm.notes}
                        onChange={(e) => setCompleteForm((p) => ({ ...p, notes: e.target.value }))}
                        rows={2}
                        className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-base text-nav-dark"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={!canSubmitComplete}
                        onClick={() => requestComplete(card)}
                        className="flex-1 inline-flex h-14 items-center justify-center gap-2 bg-crx-green text-white font-heading text-xl font-bold rounded-xl hover:bg-crx-green-hover active:scale-[0.99] disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-6 h-6" aria-hidden="true" /> {completing ? 'Completing…' : 'Complete Job'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCompleteFormOpenFor(null)}
                        className="h-14 px-4 rounded-xl border border-gray-300 bg-white text-nav-dark text-base font-semibold active:scale-[0.99]"
                      >
                        Cancel
                      </button>
                    </div>
                  </Section>
                )}

                <p className="text-sm text-secondary pt-1">
                  {isTerminal
                    ? 'This job is finished — pricing and invoicing are handled in the office app.'
                    : 'Pricing and job setup are managed in the office app.'}
                </p>
              </>
            ) : (
              <p className="text-sm text-secondary">Tap again to retry loading details.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="phone-touch -m-4 lg:-m-6 min-h-[calc(100vh-4rem)] bg-cream">
      {/* Header — title + view toggle. Touch-friendly; sized for a phone width. */}
      <PhoneHeader
        title="My Day"
        className="sticky top-14 z-20 md:top-16"
        eyebrow={parseLocalDate(today).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
        action={
          <div className="inline-flex shrink-0 rounded-lg bg-white/10 p-0.5">
            <button
              onClick={() => setView('list')}
              aria-pressed={view === 'list'}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-semibold min-h-[44px] ${
                view === 'list' ? 'bg-crx-green text-white' : 'text-gray-300 hover:text-white'
              }`}
            >
              <ListIcon className="w-4 h-4" aria-hidden="true" /> List
            </button>
            <button
              onClick={() => {
                if (view === 'map') return;
                if (mapOpenCount > 0 && !mapChecking && isOnline) void fetchCards(true);
                setMapOpenCount((count) => count + 1);
                setView('map');
              }}
              aria-pressed={view === 'map'}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-semibold min-h-[44px] ${
                view === 'map' ? 'bg-crx-green text-white' : 'text-gray-300 hover:text-white'
              }`}
            >
              <MapIcon className="w-4 h-4" aria-hidden="true" /> Map
            </button>
          </div>
        }
      >
        {/* Search + reload (list mode) */}
        {view === 'list' && (
          <div className="flex items-center gap-2 mt-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" aria-hidden="true" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search job # or customer…"
                aria-label="Search job number or customer"
                className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-white border border-transparent text-base text-nav-dark placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-crx-green-on-dark min-h-[44px]"
              />
            </div>
            <button
              onClick={() => void fetchCards()}
              aria-label="Reload my jobs"
              className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-white/10 hover:bg-white/20 text-white shrink-0"
            >
              <RefreshCw className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        )}
      </PhoneHeader>

      <SavedCopyBanner
        what="your jobs"
        savedAt={savedCopyAt}
        blocked="You can't start or complete jobs until signal returns."
        onRetry={() => void fetchCards()}
        retrying={loading}
        className="m-3 sm:mx-4 mb-0"
      />

      {/* CONTENT */}
      {/* Preserve the marker draft and retry ID when someone checks their job list. */}
      {mapOpenCount > 0 && (
        <div hidden={view !== 'map'} className="m-3 rounded-xl border border-gray-200">
          <FieldMapReadWarning jobsFailed={fetchError} fieldsFailed={mapReadFailed} mapAssignmentFailed={mapAssignmentFailed}
            savedCopyAt={savedCopyAt} offline={!isOnline} loading={mapChecking} retry={() => void fetchCards(true)} />
          <ErrorBoundary inline>
            <CrewFieldMarkerMap
              key={markerUser.actorId}
              fields={visibleMapFields}
              jobByField={fieldToJob}
              refreshKey={mapOpenCount}
              active={view === 'map'}
              {...markerUser}
              onMapLoad={(map) => { mapRef.current = map; }}
              onFieldClick={(fieldId) => {
                const jobId = resolveFieldToJob(fieldToJob, fieldId);
                if (!jobId) return;
                const card = cards.find((c) => c.job_id === jobId);
                if (card) {
                  if (!visibleCards.some((visible) => visible.job_id === jobId)) setSearch('');
                  setView('list');
                  setExpandedId(card.job_id);
                }
              }}
            />
          </ErrorBoundary>
        </div>
      )}
      {view === 'map' ? null : loading ? (
        <div className="p-3 sm:p-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-gray-200/70 animate-pulse" />
          ))}
        </div>
      ) : fetchError && visibleCards.length === 0 ? (
        <div className="p-3 sm:p-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-10 text-center">
            <AlertCircle className="w-9 h-9 text-amber-600 mx-auto" aria-hidden="true" />
            <p className="mt-3 font-heading text-xl font-bold text-amber-900">Couldn't load your jobs</p>
            <p className="mt-1 text-sm text-amber-800">Check your connection and try again.</p>
            <button
              onClick={() => void fetchCards()}
              className="mt-4 inline-flex items-center gap-2 px-4 min-h-[44px] rounded-lg bg-white border border-amber-300 hover:bg-amber-100 text-amber-900 text-sm font-semibold"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> Retry
            </button>
          </div>
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="p-3 sm:p-4">
          <div className="rounded-xl border border-gray-200 bg-white p-10 text-center">
            <MapPin className="w-9 h-9 text-gray-400 mx-auto" aria-hidden="true" />
            <p className="mt-3 font-heading text-xl font-bold text-nav-dark">No jobs assigned to you right now.</p>
            <p className="mt-1 text-sm text-secondary">
              When a dispatcher hands you a field location, it shows up here.
            </p>
          </div>
        </div>
      ) : (
        <div className="p-3 sm:p-4 space-y-4 max-w-3xl">
          {activeCards.length > 0 && (
            <div className={JOB_LIST}>
              {activeCards.map(renderCard)}
            </div>
          )}

          {doneCards.length > 0 && (
            <div>
              <h2 className="px-1 pb-2 font-heading text-lg font-semibold text-nav-dark">
                Done ({doneCards.length})
              </h2>
              <div className={JOB_LIST}>
                {doneCards.map(renderCard)}
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        open={!!startConfirmFor}
        onClose={() => setStartConfirmFor(null)}
        onConfirm={handleStart}
        title="Start this job?"
        message={startConfirmFor ? `Job ${startConfirmFor.job_number} for ${startConfirmFor.customer_name || 'this customer'} will move to in-progress.` : ''}
        confirmLabel="Start Job"
        variant="info"
        loading={starting}
      />

      <ConfirmModal
        open={!!completeConfirmFor}
        onClose={() => setCompleteConfirmFor(null)}
        onConfirm={handleComplete}
        title="Complete this job?"
        message={
          isOnline
            ? 'Inventory will be deducted and an application record created.'
            : "You're offline — this will save now and sync (deduct inventory / create the record) when you reconnect."
        }
        confirmLabel="Complete"
        variant="info"
        loading={completing}
      />
    </div>
  );
}

const MY_DAY_SNAPSHOT = 'my-day';
const JOB_LIST = 'bg-white rounded-xl border border-gray-200 overflow-hidden divide-y divide-gray-100';
const ROW_ACTION = 'flex-1 inline-flex h-12 items-center justify-center gap-2 bg-crx-green text-white font-heading text-lg font-bold rounded-xl hover:bg-crx-green-hover active:scale-[0.99] disabled:opacity-50 disabled:active:scale-100';

/** Light status chips; the badge labels still come from jobStatusToDispatchBadge (shared with the dark Dispatch Board). */
function lightBadgeClass(status: string): string {
  switch (status) {
    case 'scheduled': return 'bg-amber-100 text-amber-800';
    case 'in_progress': return 'bg-crx-green-light text-crx-green';
    case 'completed': return 'bg-sky-100 text-sky-800';
    case 'invoiced': return 'bg-violet-100 text-violet-800';
    default: return 'bg-gray-100 text-gray-700';
  }
}

/** A labeled section inside the expanded card. */
function Section({ icon, title, tone = 'green', children }: { icon: JSX.Element; title: string; tone?: 'green' | 'amber'; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span aria-hidden="true" className={`flex h-7 w-7 items-center justify-center rounded-md text-white ${tone === 'amber' ? 'bg-amber-500' : 'bg-crx-green'}`}>
          {icon}
        </span>
        <h3 className="font-heading text-base font-semibold text-nav-dark">{title}</h3>
      </div>
      <div className="pl-9">{children}</div>
    </div>
  );
}

/** Compact labeled number input for the Complete Job form. */
function FieldInput({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold text-nav-dark mb-1">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full bg-white border border-gray-300 rounded-lg px-3 text-base text-nav-dark placeholder:text-gray-500"
      />
    </label>
  );
}
