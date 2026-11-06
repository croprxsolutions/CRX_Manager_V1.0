import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Plus,
  Sprout,
  MapPin,
  Calendar,
  Droplets,
  FileText,
  Download,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Search,
} from 'lucide-react';
import SectionCard from '../components/ui/SectionCard';
import SectionJumpBar from '../components/ui/SectionJumpBar';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { fetchAllRows, pageWithList } from '../lib/pagedRead';
import { Sentry } from '../lib/sentry';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { computeBounds } from '../hooks/useFitBounds';
import { formatLocalDate } from '../lib/dateUtils';
import { computeSeason } from '../utils/season';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import type {
  FieldDashboardResponse,
  FieldDashboardBillingDefault,
  FieldApplicationRecord,
  FieldActivityEntry,
} from '../types';

interface CropHistoryRecord {
  [k: string]: unknown;
  id: string;
  season: number;
  crop_type: string;
  variety: string | null;
  planting_date: string | null;
  harvest_date: string | null;
  yield_per_acre: number | null;
  yield_unit: string | null;
  notes: string | null;
}

export default function FieldDashboard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [data, setData] = useState<FieldDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [cropHistory, setCropHistory] = useState<CropHistoryRecord[]>([]);
  const [children, setChildren] = useState<Array<{ id: string; field_name: string; total_acres: number | null; boundary_geojson?: string; centroid_geojson?: string }>>([]);

  const fetchDashboard = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const { data: result, error } = await supabase.rpc('get_field_dashboard', {
        p_field_id: id,
      });
      if (error) throw error;
      const dashboard = assertRpcResult<FieldDashboardResponse>(result, 'get_field_dashboard');
      setData(dashboard);

      // Fetch crop history
      const { data: histData } = await supabase
        .from('field_crop_history')
        .select('*')
        .eq('field_id', id)
        .order('season', { ascending: false });
      setCropHistory((histData || []) as CropHistoryRecord[]);

      // Fetch child fields if this is a parent
      // Every page: the server cuts a function's rows off at 1,000, which could hide a child field.
      const { data: allFields, error: childErr } = await fetchAllRows<{ id: string; field_name: string; total_acres: number | null; boundary_geojson?: string; centroid_geojson?: string; parent_field_id?: string }>((from, to) => pageWithList(supabase
        .rpc('get_fields_with_geojson', undefined, { count: 'exact' })
        .order('field_name')
        .order('id')
        .range(from, to)));
      if (!childErr) {
        const allRows = assertRpcResult<Array<{ id: string; field_name: string; total_acres: number | null; boundary_geojson?: string; centroid_geojson?: string; parent_field_id?: string }>>(allFields, 'get_fields_with_geojson');
        const childFields = allRows.filter((f) => f.parent_field_id === id);
        setChildren(childFields);
      }
    } catch (err) {
      Sentry.captureException(err);
      toast('error', 'Failed to load field dashboard');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const mapBounds = useMemo(() => {
    if (!data) return null;
    const allFields = [data.field, ...children];
    const geoStrings = allFields.flatMap((f) => [f.boundary_geojson, f.centroid_geojson]).filter(Boolean);
    return computeBounds(geoStrings as string[]);
  }, [data, children]);

  const handleExportCSV = useCallback(() => {
    if (!data) return;
    const rows = data.application_records.map((r) => ({
      Date: fmtDateCSV(r.application_date),
      'Record #': r.record_number,
      Products: (r.product_data || []).map((p) => p.product_name || '').join(', '),
      'Acres Treated': r.total_acres ?? '',
      Applicator: r.applicator_name,
      Vehicle: r.vehicle_name ?? '',
      Source: r.source_type,
      Notes: r.notes ?? '',
    }));
    exportToCSV(rows as unknown as Record<string, unknown>[], [
      { key: 'Date', header: 'Date' },
      { key: 'Record #', header: 'Record #' },
      { key: 'Products', header: 'Products' },
      { key: 'Acres Treated', header: 'Acres Treated' },
      { key: 'Applicator', header: 'Applicator' },
      { key: 'Vehicle', header: 'Vehicle' },
      { key: 'Source', header: 'Source' },
      { key: 'Notes', header: 'Notes' },
    ], `field-${data.field.field_name}-applications`);
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-crx-green" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Field not found</p>
        <Button variant="ghost" onClick={() => navigate('/fields')} className="mt-4">
          Back to Fields
        </Button>
      </div>
    );
  }

  const { field, season_summary, application_records, recent_activity } = data;

  return (
    <div className="phone-touch space-y-5">
      {/* Header */}
      <header className="flex flex-wrap items-start gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/fields')} aria-label="Back to Fields">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="font-heading text-4xl font-bold leading-none text-nav-dark break-words">{field.field_name}</h1>
          <p className="mt-1.5 text-sm text-secondary">
            {field.customer_name}
            {field.total_acres != null && <> &middot; {field.total_acres.toLocaleString()} ac</>}
            {field.crop_type && <> &middot; <span className="capitalize">{field.crop_type}</span></>}
          </p>
        </div>
        <Button variant="secondary" icon={<Pencil className="w-4 h-4" />} showChevron onClick={() => navigate(`/fields/${id}`)}>
          Edit Field
        </Button>
      </header>

      <SectionJumpBar
        sections={[
          { id: 'field-overview', label: 'Overview' },
          { id: 'field-applications', label: 'Applications', count: application_records.length },
          { id: 'field-billing', label: 'Billing', count: field.billing_defaults?.length ?? 0 },
          { id: 'field-details', label: 'Details' },
          { id: 'field-crop-history', label: 'Crop History', count: cropHistory.length },
        ]}
      />

      <SectionCard id="field-overview" icon={<Sprout className="w-5 h-5" />} title="Overview">
        <div className="grid grid-cols-1 lg:grid-cols-3">
          <div className="lg:col-span-2 lg:border-r lg:border-gray-100">
            <CRXMap
              bounds={mapBounds}
              showLayerToggle
              className="h-[200px] md:h-[300px] w-full"
            >
              <FieldBoundaryLayer fields={[field, ...children as unknown as typeof field[]]} showLabels={children.length > 0} />
            </CRXMap>
          </div>
          <dl className="divide-y divide-gray-100 text-sm">
            <InfoRow label="Acres">{field.total_acres?.toLocaleString() ?? '—'}</InfoRow>
            <InfoRow label="Crop"><span className="capitalize">{field.crop_type ?? '—'}</span></InfoRow>
            <InfoRow label="County">{field.county ?? '—'}</InfoRow>
            <InfoRow label="State">{field.state ?? '—'}</InfoRow>
            <InfoRow label="Soil Type">{field.soil_type ?? '—'}</InfoRow>
            <InfoRow label="Irrigation">
              <Badge variant={field.irrigation ? 'success' : 'default'}>{field.irrigation ? 'Yes' : 'No'}</Badge>
            </InfoRow>
            <InfoRow label="Status">
              <Badge variant={field.is_active ? 'success' : 'default'}>{field.is_active ? 'Active' : 'Inactive'}</Badge>
            </InfoRow>
          </dl>
        </div>
        <OverviewTab summary={season_summary} />
        {children.length > 0 && (
          <SubHeading title={`Sub-fields (${children.length})`}>
            <ul className="divide-y divide-gray-100">
              {children.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/fields/${child.id}/dashboard`)}
                    className="w-full flex min-h-11 items-center justify-between gap-3 px-4 py-2 hover:bg-cream transition-colors text-left"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <MapPin className="w-4 h-4 shrink-0 text-crx-green" aria-hidden="true" />
                      <span className="text-sm font-semibold text-nav-dark truncate">{child.field_name}</span>
                    </span>
                    <span className="flex items-center gap-1 shrink-0 text-sm text-secondary">
                      {child.total_acres?.toLocaleString() ?? '—'} ac
                      <ChevronRight className="w-4 h-4" aria-hidden="true" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </SubHeading>
        )}
      </SectionCard>

      <SectionCard
        id="field-applications"
        icon={<Droplets className="w-5 h-5" />}
        title="Applications"
        action={(
          <Button variant="secondary" size="sm" icon={<Download className="w-4 h-4" />} onClick={handleExportCSV} disabled={application_records.length === 0}>
            Export CSV
          </Button>
        )}
      >
        <ApplicationsTab records={application_records} />
      </SectionCard>

      <SectionCard id="field-billing" icon={<FileText className="w-5 h-5" />} title="Billing Splits">
        <BillingTab billingDefaults={field.billing_defaults} />
      </SectionCard>

      <SectionCard id="field-details" icon={<MapPin className="w-5 h-5" />} title="Details">
        <DetailsTab field={field} activity={recent_activity} />
      </SectionCard>

      <CropHistoryTab
        history={cropHistory}
        currentCrop={field.crop_type}
        fieldId={id || ''}
        onSaved={fetchDashboard}
      />
    </div>
  );
}

/* ─── Style D pieces ───────────────────────────────────────────── */

/** A sub-part of a section: a Barlow sub-heading on a hairline divider. */
function SubHeading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-gray-200">
      <h3 className="px-4 pt-3 pb-1 font-heading text-lg font-semibold text-nav-dark">{title}</h3>
      {children}
    </section>
  );
}

/** Label on the left, value on the right, on a gray-100 divider. */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 px-4 py-1.5">
      <dt className="font-semibold text-nav-dark">{label}</dt>
      <dd className="text-right text-nav-dark">{children}</dd>
    </div>
  );
}

/* ─── Overview section ──────────────────────────────────────────── */

function OverviewTab({ summary }: { summary: FieldDashboardResponse['season_summary'] }) {
  const stats = [
    { label: 'Applications', value: summary.total_applications },
    { label: 'Acres Treated', value: summary.total_acres_treated.toLocaleString() },
    { label: 'Products Applied', value: summary.distinct_products },
  ];

  return (
    <SubHeading title={`Season ${summary.season} Summary`}>
      <dl className="grid grid-cols-3 divide-x divide-gray-100 px-1 pb-3">
        {stats.map(({ label, value }) => (
          <div key={label} className="px-3 py-1">
            <dd className="font-heading text-3xl font-bold leading-tight text-nav-dark tabular-nums">{value}</dd>
            <dt className="text-xs font-medium text-secondary">{label}</dt>
          </div>
        ))}
      </dl>
    </SubHeading>
  );
}

/* ─── Applications section ──────────────────────────────────────── */

function weatherText(w: FieldApplicationRecord['weather_conditions']): string {
  if (!w) return '';
  const parts: string[] = [];
  if (w.temperature !== undefined) parts.push(`${w.temperature}°F`);
  if (w.wind_speed !== undefined) parts.push(`${w.wind_speed} mph ${w.wind_direction || ''}`);
  if (w.humidity !== undefined) parts.push(`${w.humidity}% RH`);
  return parts.join(' · ');
}

function ApplicationsTab({ records }: { records: FieldApplicationRecord[] }) {
  const columns: Column<FieldApplicationRecord>[] = useMemo(
    () => [
      {
        key: 'application_date',
        header: 'Date',
        sortable: true,
        render: (row: FieldApplicationRecord) => (
          <span className="whitespace-nowrap">
            {row.application_date}
          </span>
        ),
      },
      {
        key: 'record_number',
        header: 'Record #',
        render: (row: FieldApplicationRecord) => (
          <span className="font-mono text-xs">{row.record_number}</span>
        ),
      },
      {
        key: 'product_data',
        header: 'Products',
        render: (row: FieldApplicationRecord) => {
          const products = row.product_data || [];
          if (products.length === 0) return <span className="text-gray-500">—</span>;
          return (
            <div className="space-y-0.5">
              {products.slice(0, 3).map((p, i) => (
                <div key={i} className="text-xs">
                  <span className="font-medium">{p.product_name || 'Unknown'}</span>
                  {p.rate && p.rate_unit && (
                    <span className="text-secondary ml-1">
                      {p.rate} {p.rate_unit}
                    </span>
                  )}
                </div>
              ))}
              {products.length > 3 && (
                <span className="text-xs text-secondary">+{products.length - 3} more</span>
              )}
            </div>
          );
        },
      },
      {
        key: 'total_acres',
        header: 'Acres',
        sortable: true,
        render: (row: FieldApplicationRecord) => row.total_acres?.toLocaleString() ?? '—',
      },
      {
        key: 'applicator_name',
        header: 'Applicator',
        sortable: true,
      },
      {
        key: 'vehicle_name',
        header: 'Vehicle',
        render: (row: FieldApplicationRecord) => row.vehicle_name ?? '—',
      },
      {
        key: 'weather_conditions',
        header: 'Weather',
        render: (row: FieldApplicationRecord) => {
          const text = weatherText(row.weather_conditions);
          return text ? <span className="text-xs">{text}</span> : <span className="text-gray-500">—</span>;
        },
      },
      {
        key: 'source_type',
        header: 'Source',
        render: (row: FieldApplicationRecord) => (
          <Badge variant={row.source_type === 'job' ? 'info' : 'default'}>
            {row.source_type === 'job' ? 'Job' : 'Blend Ticket'}
          </Badge>
        ),
      },
    ],
    []
  );

  if (records.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <Droplets className="w-8 h-8 text-gray-300 mx-auto mb-2" aria-hidden="true" />
        <p className="text-sm text-secondary">No application records for this field this season.</p>
      </div>
    );
  }

  return (
    <>
      {/* Phones: one list, a row per record. */}
      <ul className="divide-y divide-gray-100 md:hidden">
        {records.map((r) => {
          const weather = weatherText(r.weather_conditions);
          return (
            <li key={r.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold text-nav-dark">{r.application_date}</span>
                <span className="font-heading text-lg font-bold text-nav-dark tabular-nums">{r.total_acres?.toLocaleString() ?? '—'} ac</span>
              </div>
              <p className="text-sm text-nav-dark">
                {(r.product_data || []).map((p) => [p.product_name || 'Unknown', p.rate && p.rate_unit ? `${p.rate} ${p.rate_unit}` : ''].filter(Boolean).join(' ')).join(', ') || '—'}
              </p>
              <p className="text-xs text-secondary">
                {[r.record_number, r.applicator_name, r.vehicle_name, weather, r.source_type === 'job' ? 'Job' : 'Blend Ticket'].filter(Boolean).join(' · ')}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block px-4 py-3">
        <DataTable columns={columns} data={records} />
      </div>
    </>
  );
}

/* ─── Billing section ───────────────────────────────────────────── */

function BillingTab({
  billingDefaults,
}: {
  billingDefaults: FieldDashboardBillingDefault[];
}) {
  if (!billingDefaults || billingDefaults.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" aria-hidden="true" />
        <p className="text-sm text-secondary">No billing splits configured for this field.</p>
      </div>
    );
  }

  const colors = ['bg-crx-green', 'bg-blue-500', 'bg-orange-500', 'bg-purple-500', 'bg-yellow-500'];

  return (
    <>
      <div className="px-4 pt-4 pb-2">
        <div className="h-6 rounded-full overflow-hidden flex bg-gray-100">
          {billingDefaults.map((bd, i) => (
            <div
              key={bd.customer_id}
              className={`${colors[i % colors.length]} flex items-center justify-center text-xs text-white font-medium`}
              style={{ width: `${bd.split_pct}%` }}
              title={`${bd.customer_name}: ${bd.split_pct}%`}
            >
              {bd.split_pct >= 10 ? `${bd.split_pct}%` : ''}
            </div>
          ))}
        </div>
      </div>

      <ul className="divide-y divide-gray-100">
        {billingDefaults.map((bd, i) => (
          <li key={bd.customer_id} className="px-4 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded-full ${colors[i % colors.length]}`} />
                <span className="font-semibold text-sm text-nav-dark truncate">{bd.customer_name}</span>
                {bd.is_primary && <Badge variant="success">Primary</Badge>}
              </div>
              <span className="font-heading text-xl font-bold text-crx-green tabular-nums">{bd.split_pct}%</span>
            </div>
            {(bd.price_override_cents || bd.pricing_note) && (
              <div className="mt-0.5 pl-5 text-xs text-secondary space-x-4">
                {bd.price_override_cents && (
                  <span>${(bd.price_override_cents / 100).toFixed(2)}/ac override</span>
                )}
                {bd.pricing_note && <span>{bd.pricing_note}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/* ─── Details section ───────────────────────────────────────────── */

function DetailsTab({
  field,
  activity,
}: {
  field: FieldDashboardResponse['field'];
  activity: FieldActivityEntry[];
}) {
  const [showAllActivity, setShowAllActivity] = useState(false);
  const displayedActivity = showAllActivity ? activity : activity.slice(0, 5);

  return (
    <>
      <dl className="divide-y divide-gray-100 text-sm">
        {(field.fsa_farm_number || field.fsa_tract_number || field.fsa_field_number) && (
          <>
            <InfoRow label="FSA Farm #">{field.fsa_farm_number || '—'}</InfoRow>
            <InfoRow label="FSA Tract #">{field.fsa_tract_number || '—'}</InfoRow>
            <InfoRow label="FSA Field #">{field.fsa_field_number || '—'}</InfoRow>
          </>
        )}
        <InfoRow label="Created">{formatLocalDate(new Date(field.created_at))}</InfoRow>
        <InfoRow label="Last Updated">{formatLocalDate(new Date(field.updated_at))}</InfoRow>
      </dl>

      {field.legal_description && (
        <SubHeading title="Legal Description">
          <p className="px-4 pb-3 text-sm text-nav-dark">{field.legal_description}</p>
        </SubHeading>
      )}

      {field.notes && (
        <SubHeading title="Notes">
          <p className="px-4 pb-3 text-sm text-nav-dark whitespace-pre-wrap">{field.notes}</p>
        </SubHeading>
      )}

      <SubHeading title="Activity Log">
        {activity.length === 0 ? (
          <p className="px-4 pb-3 text-sm text-secondary">No activity recorded.</p>
        ) : (
          <>
            <ul className="divide-y divide-gray-100">
              {displayedActivity.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                  <Calendar className="w-4 h-4 mt-0.5 text-secondary shrink-0" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <p className="text-nav-dark">{entry.description}</p>
                    <p className="text-xs text-secondary">
                      {entry.performed_by_name} &middot;{' '}
                      {formatLocalDate(new Date(entry.created_at))}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            {activity.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllActivity(!showAllActivity)}
                className="mx-4 mb-3 min-h-9 text-sm font-semibold text-crx-green hover:underline flex items-center gap-1"
              >
                {showAllActivity ? (
                  <><ChevronUp className="w-4 h-4" aria-hidden="true" /> Show less</>
                ) : (
                  <><ChevronDown className="w-4 h-4" aria-hidden="true" /> Show all {activity.length} entries</>
                )}
              </button>
            )}
          </>
        )}
      </SubHeading>
    </>
  );
}

/* ─── Crop History Tab ─────────────────────────────────────────── */

interface CropForm {
  season: number;
  crop_type: string;
  variety: string;
  planting_date: string;
  harvest_date: string;
  yield_per_acre: string;
  yield_unit: string;
  notes: string;
}

function blankCropForm(): CropForm {
  return {
    season: computeSeason(),
    crop_type: '',
    variety: '',
    planting_date: '',
    harvest_date: '',
    yield_per_acre: '',
    yield_unit: '',
    notes: '',
  };
}

function CropHistoryTab({
  history,
  currentCrop,
  fieldId,
  onSaved,
}: {
  history: CropHistoryRecord[];
  currentCrop: string | null;
  fieldId: string;
  onSaved: () => void;
}) {
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const { getKey, resetKey } = useIdempotencyKey('save_field_crop_history', profile?.id || '');
  const canEdit = role === 'admin' || role === 'sales_rep';

  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingSeason, setEditingSeason] = useState<number | null>(null);
  const [form, setForm] = useState<CropForm>(blankCropForm);

  const cur = computeSeason();
  const existingSeasons = new Set(history.map((h) => h.season));
  const seasonOptions = Array.from({ length: 8 }, (_, i) => cur + 1 - i).map((s) => ({
    value: String(s),
    label: `${s - 1}–${s}`,
  }));
  // Add mode may only target a season that has no row yet. Editing an existing
  // season goes through the pencil (which prefills), so a blank Add can never
  // upsert NULLs over an existing season's variety/dates/yield/notes.
  const addSeasonOptions = seasonOptions.filter((o) => !existingSeasons.has(Number(o.value)));

  const openAdd = () => {
    resetKey();
    setEditingSeason(null);
    const firstFree = addSeasonOptions[0]?.value;
    setForm({ ...blankCropForm(), season: firstFree ? Number(firstFree) : cur });
    setEditOpen(true);
  };

  const openEdit = (r: CropHistoryRecord) => {
    resetKey();
    setEditingSeason(r.season);
    setForm({
      season: r.season,
      crop_type: r.crop_type || '',
      variety: r.variety || '',
      planting_date: r.planting_date || '',
      harvest_date: r.harvest_date || '',
      yield_per_acre: r.yield_per_acre != null ? String(r.yield_per_acre) : '',
      yield_unit: r.yield_unit || '',
      notes: r.notes || '',
    });
    setEditOpen(true);
  };

  const handleSave = async () => {
    const crop = form.crop_type.trim();
    if (!crop) {
      toast('error', 'Crop is required');
      return;
    }
    if (editingSeason == null && existingSeasons.has(form.season)) {
      toast('error', 'That season already has an entry — edit it from the list instead.');
      return;
    }
    if (form.harvest_date && form.planting_date && form.harvest_date < form.planting_date) {
      toast('error', 'Harvest date cannot be before the planting date');
      return;
    }
    setSaving(true);
    try {
      const yieldNum = form.yield_per_acre ? parseFloat(form.yield_per_acre) : null;
      const { data, error } = await supabase.rpc('save_field_crop_history', {
        p_field_id: fieldId,
        p_season: form.season,
        p_crop_type: crop,
        p_variety: form.variety.trim() || undefined,
        p_planting_date: form.planting_date || undefined,
        p_harvest_date: form.harvest_date || undefined,
        p_yield_per_acre: yieldNum != null && !Number.isNaN(yieldNum) ? yieldNum : undefined,
        p_yield_unit: form.yield_unit.trim() || undefined,
        p_notes: form.notes.trim() || undefined,
        p_performed_by: profile?.id || undefined,
        p_idempotency_key: getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'save_field_crop_history');
      resetKey();
      toast('success', 'Crop history saved');
      setEditOpen(false);
      onSaved();
    } catch (err) {
      toast('error', sanitizeError(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: Column<CropHistoryRecord>[] = [
    {
      key: 'season',
      header: 'Season',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.season - 1}–{r.season}</span>,
    },
    {
      key: 'crop_type',
      header: 'Crop',
      sortable: true,
      render: (r) => <Badge variant="default">{r.crop_type}</Badge>,
    },
    { key: 'variety', header: 'Variety', render: (r) => r.variety || '—' },
    { key: 'planting_date', header: 'Planted', render: (r) => r.planting_date || '—' },
    { key: 'harvest_date', header: 'Harvested', render: (r) => r.harvest_date || '—' },
    {
      key: 'yield_per_acre',
      header: 'Yield/Acre',
      render: (r) => r.yield_per_acre != null ? `${r.yield_per_acre.toLocaleString()} ${r.yield_unit || ''}` : '—',
    },
    { key: 'notes', header: 'Notes', render: (r) => r.notes || '—' },
    ...(canEdit
      ? [{
          key: '_actions',
          header: '',
          render: (r: CropHistoryRecord) => (
            <button
              type="button"
              onClick={() => openEdit(r)}
              className="p-1.5 rounded hover:bg-gray-100 text-secondary hover:text-nav-dark transition-colors"
              title="Edit crop history entry"
              aria-label={`Edit ${r.season - 1}–${r.season} crop history`}
            >
              <Pencil className="w-4 h-4" />
            </button>
          ),
        } satisfies Column<CropHistoryRecord>]
      : []),
  ];

  const emptyDescription = canEdit
    ? 'Add a crop record, or it is auto-recorded when the field’s crop type changes between seasons.'
    : 'Crop history is auto-recorded when the field’s crop type changes between seasons.';

  return (
    <SectionCard
      id="field-crop-history"
      icon={<Calendar className="w-5 h-5" />}
      title="Crop History"
      action={canEdit ? (
        <Button size="sm" icon={<Plus className="w-4 h-4" />} onClick={openAdd}>
          Add Entry
        </Button>
      ) : undefined}
    >
      {currentCrop && (
        <dl className="text-sm">
          <InfoRow label="Current Crop"><span className="font-heading text-lg font-bold text-crx-green capitalize">{currentCrop}</span></InfoRow>
        </dl>
      )}
      {/* Phones: one list, a row per season. */}
      <CropHistoryPhoneList history={history} emptyDescription={emptyDescription} onEdit={canEdit ? openEdit : undefined} />
      <div className="hidden md:block px-4 py-3">
        <DataTable<CropHistoryRecord>
          columns={columns}
          data={history}
          searchable
          searchPlaceholder="Search crop history..."
          searchKeys={['crop_type', 'variety', 'notes']}
          emptyTitle="No crop history"
          emptyDescription={emptyDescription}
        />
      </div>

      {canEdit && (
        <Modal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          title={editingSeason != null ? 'Edit' : 'Add'}
          accent="Crop History"
        >
          <div className="space-y-4">
            <Select
              label="Season"
              options={
                editingSeason != null
                  ? [{ value: String(form.season), label: `${form.season - 1}–${form.season}` }]
                  : addSeasonOptions
              }
              value={String(form.season)}
              onChange={(e) => setForm({ ...form, season: Number(e.target.value) })}
              disabled={editingSeason != null}
              placeholder={
                editingSeason == null && addSeasonOptions.length === 0
                  ? 'All recent seasons already have entries'
                  : undefined
              }
            />
            {editingSeason != null && (
              <p className="-mt-2 text-xs text-secondary">
                One record per season — editing the {editingSeason - 1}–{editingSeason} entry.
              </p>
            )}
            {editingSeason == null && addSeasonOptions.length === 0 && (
              <p className="-mt-2 text-xs text-amber-600">
                Every recent season already has an entry — edit one from the list instead.
              </p>
            )}
            <Input
              label="Crop"
              value={form.crop_type}
              onChange={(e) => setForm({ ...form, crop_type: e.target.value })}
              placeholder="e.g. Corn, Soybeans"
              required
            />
            <Input
              label="Variety (optional)"
              value={form.variety}
              onChange={(e) => setForm({ ...form, variety: e.target.value })}
              placeholder="e.g. DKC62-08"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Planting Date (optional)"
                type="date"
                value={form.planting_date}
                onChange={(e) => setForm({ ...form, planting_date: e.target.value })}
              />
              <Input
                label="Harvest Date (optional)"
                type="date"
                value={form.harvest_date}
                onChange={(e) => setForm({ ...form, harvest_date: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Yield / Acre (optional)"
                type="number"
                min="0"
                step="any"
                value={form.yield_per_acre}
                onChange={(e) => setForm({ ...form, yield_per_acre: e.target.value })}
                placeholder="e.g. 220"
              />
              <Input
                label="Yield Unit (optional)"
                value={form.yield_unit}
                onChange={(e) => setForm({ ...form, yield_unit: e.target.value })}
                placeholder="e.g. bu"
              />
            </div>
            <Input
              label="Notes (optional)"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Any notes about this season"
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </SectionCard>
  );
}

/** Phones: one list, a row per season, with its own search (the desktop table has one built in). */
function CropHistoryPhoneList({ history, emptyDescription, onEdit }: {
  history: CropHistoryRecord[];
  emptyDescription: string;
  onEdit?: (r: CropHistoryRecord) => void;
}) {
  const [phoneSearch, setPhoneSearch] = useState('');
  const needle = phoneSearch.trim().toLowerCase();
  const phoneHistory = needle
    ? history.filter((r) => [r.crop_type, r.variety, r.notes].some((v) => v?.toLowerCase().includes(needle)))
    : history;

  return (
    <>
      {history.length > 0 && (
        <div className="relative border-t border-gray-100 px-4 py-2 md:hidden">
          <Search className="absolute left-7 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <input
            type="search"
            value={phoneSearch}
            onChange={(e) => setPhoneSearch(e.target.value)}
            placeholder="Search crop history…"
            aria-label="Search crop history"
            className="h-11 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-base text-nav-dark placeholder:text-gray-500"
          />
        </div>
      )}
      {phoneHistory.length === 0 ? (
        <div className="px-4 py-6 text-center md:hidden">
          <p className="font-semibold text-nav-dark">{history.length === 0 ? 'No crop history' : 'No matching seasons'}</p>
          {history.length === 0 && <p className="text-sm text-secondary">{emptyDescription}</p>}
        </div>
      ) : (
        <ul className="border-t border-gray-100 divide-y divide-gray-100 md:hidden">
          {phoneHistory.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="font-semibold text-nav-dark">
                  {r.season - 1}–{r.season} <span className="font-normal">· {r.crop_type}{r.variety ? ` (${r.variety})` : ''}</span>
                </p>
                <p className="text-xs text-secondary">
                  {[
                    r.planting_date && `Planted ${r.planting_date}`,
                    r.harvest_date && `Harvested ${r.harvest_date}`,
                    r.yield_per_acre != null && `${r.yield_per_acre.toLocaleString()} ${r.yield_unit || ''}/ac`,
                    r.notes,
                  ].filter(Boolean).join(' · ') || '—'}
                </p>
              </div>
              {onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(r)}
                  className="shrink-0 rounded-lg p-2 text-secondary hover:bg-gray-100 hover:text-nav-dark"
                  aria-label={`Edit ${r.season - 1}–${r.season} crop history`}
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
