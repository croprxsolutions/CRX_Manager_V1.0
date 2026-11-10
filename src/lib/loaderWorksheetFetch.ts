/**
 * loaderWorksheetFetch — fetch the full per-job data a Loader Worksheet PDF needs
 * (field-app parity #10), for the Jobs-list BULK "Loader Worksheet" action.
 *
 * The job LIST query is summary-only (it does not pull per-product quantity/unit,
 * per-field acres, or the carrier rate / capacity override). The single-job print
 * on JobDetail builds its data from in-memory form state; for the bulk action we
 * re-fetch each selected job's full mix + fields here and map it to the shared
 * LoaderWorksheetPdfData shape, so the per-load split is computed from the SAME
 * pure engine and prints identically.
 *
 * Kept out of the page so the PostgREST shape mapping is isolated. The applicator
 * NAME is resolved via profile_public_view (LEDGER lesson: never embed `profiles`
 * — the RLS hides other users' rows and the name would render "(removed)").
 *
 * Billed CUSTOMERS are resolved via the SECURITY DEFINER RPC get_job_billed_customers
 * (resolveBilledCustomers), NOT a customers embed: on a split-billed job an
 * applicator's customers_select RLS hides the CO-billed customers, so an embed would
 * silently drop them. If ANY selected job's billed-customer resolution is incomplete
 * this THROWS so the caller aborts the worksheet and never stamps printed_at — the
 * same complete-or-refused rule the #11 chemical report uses (shared resolver).
 */
import { supabase, supabaseUntyped } from './db';
import { resolveBilledCustomers } from './billedCustomersResolver';
import { isGallonCapacityUnit } from './loaderWorksheet';
import type { LoaderWorksheetPdfData } from './loaderWorksheetPdf';
import { fetchLoaderJobWeights, loaderJobInputs, type LoaderGetterJob, type LoaderJobWeights } from './loaderWeightsFetch';
import type { ApplicatorSheetCustomer } from './applicatorSheetData';
import type { JobLoaderWorksheet } from '../types';

/** Raw row shape from the loader-worksheet fetch (only the columns we read). */
interface LoaderJobRow {
  id: string;
  job_number: string;
  job_date: string;
  scheduled_time: string | null;
  applicator_id: string | null;
  carrier_rate_gpa: number | null;
  loader_tank_capacity: number | null;
  loader_comment: string | null;
  vehicle: { vehicle_name: string | null; capacity_gallons: number | null; capacity_unit: string | null } | null;
  job_fields: Array<{ field_id: string | null; acres_to_treat: number | null }> | null;
  job_chemicals: Array<{ id: string; product_id: string | null; quantity: number | null; unit: string | null; product: { product_name: string | null } | null }> | null;
}

interface WorksheetVehicleRow {
  id: string;
  vehicle_name: string | null;
}

/**
 * Fetch the loader-worksheet PDF data for a set of job IDs (the bulk-selected jobs).
 * Results are returned in the SAME order as `jobIds`. Jobs that no longer exist are
 * skipped. The applicator name is resolved via profile_public_view.
 */
export async function fetchLoaderWorksheetData(jobIds: string[]): Promise<LoaderWorksheetPdfData[]> {
  if (jobIds.length === 0) return [];

  const { data, error } = await supabase
    .from('jobs')
    .select(`
      id, job_number, job_date, scheduled_time, applicator_id,
      carrier_rate_gpa, loader_tank_capacity, loader_comment,
      vehicle:vehicles(vehicle_name, capacity_gallons, capacity_unit),
      job_fields(field_id, acres_to_treat),
      job_chemicals(id, product_id, quantity, unit, product:products(product_name))
    `)
    .in('id', jobIds);
  if (error) throw error;

  const rows = (data || []) as unknown as LoaderJobRow[];

  // Saved worksheet scenarios are intentionally fetched separately instead of as
  // an embedded relationship: the selected partial-unique row must replace the
  // legacy capacity/rate/comment only when it exists. A read error is fatal — a
  // silent legacy fallback could print the wrong tank plan.
  const { data: savedWorksheetData, error: savedWorksheetError } = await supabaseUntyped
    .from('job_loader_worksheets')
    .select('id, job_id, vehicle_id, capacity_gal, carrier_rate_gpa, load_balance_mode, per_load_acres, loads_done, comment, is_selected, created_by, created_at, updated_at')
    .in('job_id', jobIds)
    .eq('is_selected', true);
  if (savedWorksheetError) throw savedWorksheetError;
  const selectedWorksheets = (savedWorksheetData ?? []) as unknown as JobLoaderWorksheet[];
  const selectedWorksheetByJob = new Map(selectedWorksheets.map((worksheet) => [worksheet.job_id, worksheet]));

  const worksheetVehicleIds = [...new Set(selectedWorksheets.map((worksheet) => worksheet.vehicle_id).filter((id): id is string => !!id))];
  const worksheetVehicleNameById = new Map<string, string>();
  if (worksheetVehicleIds.length > 0) {
    const { data: worksheetVehicles, error: worksheetVehiclesError } = await supabase
      .from('vehicles')
      .select('id, vehicle_name')
      .in('id', worksheetVehicleIds);
    if (worksheetVehiclesError) throw worksheetVehiclesError;
    ((worksheetVehicles ?? []) as WorksheetVehicleRow[]).forEach((vehicle) => {
      if (vehicle.vehicle_name) worksheetVehicleNameById.set(vehicle.id, vehicle.vehicle_name);
    });
  }

  // Billed customers per job via the SECURITY DEFINER RPC (saved job_field_shares →
  // field_billing_defaults → primary customer_id), which resolves the CO-billed
  // customers an applicator's customers_select RLS hides. Resolved per job (the RPC
  // self-gates each job). If ANY selected job's resolution is incomplete (a billed
  // customer with no resolvable name) ABORT — a print document is never built with a
  // silently-partial customer list (shared #11 complete-or-refused rule).
  const customersByJob = new Map<string, ApplicatorSheetCustomer[]>();
  for (const r of rows) {
    const { customers, complete } = await resolveBilledCustomers(r.id);
    if (!complete) {
      throw new Error(`Some billed customers on job ${r.job_number} could not be resolved — the loader worksheet cannot be completed.`);
    }
    customersByJob.set(r.id, customers);
  }

  // DM-2: the load plan, amounts and weights come from one getter read. If it fails, the reads above still print
  // the sheet, with the weights withheld and the reason printed.
  let weights: LoaderJobWeights | null = null;
  try {
    weights = await fetchLoaderJobWeights(rows.map((r) => r.id));
  } catch (_error) {
    weights = null;
  }

  // Resolve applicator names via the public profile view (never a profiles embed).
  // After the getter: a page built from its read names that read's applicator, which may differ from the jobs read.
  const applicatorIds = [...new Set([...rows.map((r) => r.applicator_id), ...[...(weights?.jobs.values() ?? [])].map((j) => j.job?.applicator_id)]
    .filter((x): x is string => !!x))];
  const nameById = new Map<string, string>();
  if (applicatorIds.length > 0) {
    const { data: profs } = await supabase
      .from('profile_public_view')
      .select('id, full_name')
      .in('id', applicatorIds);
    ((profs || []) as Array<{ id: string; full_name: string | null }>).forEach((p) => {
      if (p.full_name) nameById.set(p.id, p.full_name);
    });
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve the caller's order; skip any id that didn't come back.
  return jobIds
    .map((jid) => byId.get(jid))
    .filter((r): r is LoaderJobRow => !!r)
    .map((r) => {
      const customers = customersByJob.get(r.id) ?? [];
      const job = weights?.jobs.get(r.id);
      if (weights && job?.found && job.job) return { ...mapGetterJobToPdfData(job, weights, nameById), customers };
      const fallback = mapRowToPdfData(r, nameById, customers, selectedWorksheetByJob.get(r.id), worksheetVehicleNameById);
      // The job's own lines go along, so a bad amount still prints its reason (never a negative or 0) without weights.
      const sourceLines = (r.job_chemicals || []).map(({ id, product_id, quantity, unit }) => ({ id, product_id, quantity, unit }));
      return { ...fallback, weights: { byProductId: {}, currentUnits: { factors: {}, ambiguous: [] }, sourceLines, saved: false,
        unavailable: 'Product weights not shown: they could not be read. Reprint to include them.' } };
    });
}

/** One job's page built from the getter's one read: date, applicator, settings, vehicle, acres, lines and weights together. */
function mapGetterJobToPdfData(entry: LoaderGetterJob, weights: LoaderJobWeights, nameById: Map<string, string>): LoaderWorksheetPdfData {
  const job = entry.job!;
  const selected = entry.worksheet?.worksheet;
  const legacy = legacyCapacity(job.loader_tank_capacity, job.vehicle);
  const inputs = loaderJobInputs(entry);
  return {
    job_number: job.job_number,
    customers: [],
    scheduled_date: job.job_date,
    scheduled_time: job.scheduled_time,
    applicator_name: job.applicator_id ? (nameById.get(job.applicator_id) ?? null) : null,
    vehicle_name: entry.worksheet ? entry.worksheet.vehicle_name : job.vehicle?.vehicle_name ?? null,
    total_acres: Number(entry.acres ?? 0),
    carrier_rate_gpa: selected ? selected.carrier_rate_gpa : job.carrier_rate_gpa,
    tank_capacity: selected ? selected.capacity_gal : legacy.capacity,
    capacity_unit: selected ? 'gal' : legacy.unit,
    products: inputs.products,
    loader_comment: selected ? selected.comment : job.loader_comment,
    load_balance_mode: selected?.load_balance_mode,
    per_load_acres: selected?.per_load_acres,
    loads_done: selected?.loads_done,
    weights: { byProductId: inputs.weights, currentUnits: weights.unitsByJob.get(entry.job_id) ?? { factors: {}, ambiguous: [] }, sourceLines: inputs.sourceLines, saved: !!selected },
  };
}

/**
 * Effective capacity: the per-job override (in gallons) wins over the assigned vehicle's. The vehicle capacity is
 * only usable as a GALLON tank size when its unit measures gallons: a dry spreader rated in lbs/tons can't seed
 * gallon loads, so without a gallon override the worksheet shows its "enter capacity" guard (Codex).
 */
function legacyCapacity(override: number | null, vehicle: LoaderJobRow['vehicle']): { capacity: number | null; unit: string } {
  const own = override != null && override > 0 ? override : null;
  const vehicleCap = isGallonCapacityUnit(vehicle?.capacity_unit) ? (vehicle?.capacity_gallons ?? null) : null;
  return { capacity: own ?? vehicleCap, unit: own != null ? 'gal' : (vehicle?.capacity_unit || 'gal') };
}

/** Map one fetched job row to the shared LoaderWorksheetPdfData. */
function mapRowToPdfData(
  r: LoaderJobRow,
  nameById: Map<string, string>,
  billedCustomers: ApplicatorSheetCustomer[],
  selectedWorksheet?: JobLoaderWorksheet,
  worksheetVehicleNameById: Map<string, string> = new Map(),
): LoaderWorksheetPdfData {
  const totalAcres = (r.job_fields || []).reduce((s, f) => s + (f.acres_to_treat || 0), 0);

  const { capacity: effectiveCapacity, unit: capacityUnit } = legacyCapacity(r.loader_tank_capacity, r.vehicle);

  return {
    job_number: r.job_number,
    customers: billedCustomers,
    scheduled_date: r.job_date,
    scheduled_time: r.scheduled_time,
    applicator_name: r.applicator_id ? (nameById.get(r.applicator_id) ?? null) : null,
    vehicle_name: selectedWorksheet?.vehicle_id
      ? (worksheetVehicleNameById.get(selectedWorksheet.vehicle_id) ?? 'Manual')
      : (selectedWorksheet ? 'Manual' : r.vehicle?.vehicle_name ?? null),
    total_acres: totalAcres,
    carrier_rate_gpa: selectedWorksheet ? selectedWorksheet.carrier_rate_gpa : r.carrier_rate_gpa,
    tank_capacity: selectedWorksheet ? selectedWorksheet.capacity_gal : effectiveCapacity,
    capacity_unit: selectedWorksheet ? 'gal' : capacityUnit,
    products: (r.job_chemicals || [])
      .filter((c) => c.product?.product_name || c.quantity != null)
      .map((c) => ({
        product_name: c.product?.product_name || 'Product',
        total_quantity: c.quantity,
        unit: c.unit,
        product_id: c.product_id,
        source_line_id: c.id,
      })),
    loader_comment: selectedWorksheet ? selectedWorksheet.comment : r.loader_comment,
    load_balance_mode: selectedWorksheet?.load_balance_mode,
    per_load_acres: selectedWorksheet?.per_load_acres,
    loads_done: selectedWorksheet?.loads_done,
  };
}
