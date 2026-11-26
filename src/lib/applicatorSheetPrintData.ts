/**
 * applicatorSheetPrintData — best-effort operational additions to the shared
 * applicator-sheet data model. Office billing allocations and application history
 * are optional add-ons. Crew payer identities are resolved before preparation.
 */
import { assertRpcResult, supabase } from './db';
import { fmtNum, type ApplicatorSheetBillingSplit, type ApplicatorSheetData, type ApplicatorSheetSafety, type PreviousFieldApplications } from './applicatorSheetData';
import { type ApplicatorPrintOptions, DEFAULT_APPLICATOR_PRINT_OPTIONS, mapImageOptions } from './applicatorPrintOptions';
import { generateApplicatorSheetPdf } from './applicatorSheetPdf';
import { fetchJobFieldLocations, fetchJobMapImages } from './jobMapImages';

interface ApplicationRecordJoin {
  application_date: string;
  product_data: unknown;
  applicator_name: string | null;
  source_type: string;
  source_id: string;
}

interface ApplicationRecordFieldJoin {
  field_id: string;
}

interface ApplicationRecordHistoryRow extends ApplicationRecordJoin {
  application_record_fields: ApplicationRecordFieldJoin[] | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Convert the stored product JSON snapshot into a compact, crew-readable line. */
function previousApplicationSummary(productData: unknown): string {
  if (!Array.isArray(productData) || productData.length === 0) return 'Product details not recorded';
  const products = productData.flatMap((entry) => {
    const product = asRecord(entry);
    if (!product) return [];
    const name = typeof product.product_name === 'string' && product.product_name.trim()
      ? product.product_name.trim()
      : 'Product';
    const rate = typeof product.rate_per_acre === 'number' && Number.isFinite(product.rate_per_acre)
      ? fmtNum(product.rate_per_acre)
      : '';
    const rateUnit = typeof product.rate_unit === 'string' ? product.rate_unit.trim() : '';
    return [rate ? `${name} (${rate}${rateUnit ? ` ${rateUnit}` : ''})` : name];
  });
  return products.length > 0 ? products.join('; ') : 'Product details not recorded';
}

/**
 * Read the most recent records for the sheet's fields. Application records are
 * the parent so the database applies the date order and ceiling before embeds.
 * Each field is bounded independently so a high-activity field cannot consume
 * another field's history budget. RLS denial is expected for some roles, so
 * this operational enhancement degrades to no history for just that field.
 */
export async function fetchPreviousApplications(
  fields: ApplicatorSheetData['fields'],
  jobId: string,
  limitPerField: number,
): Promise<PreviousFieldApplications[]> {
  const fieldNameById = new Map(fields.flatMap((field) => field.field_id ? [[field.field_id, field.field_name] as const] : []));
  const fieldIds = [...fieldNameById.keys()];
  if (fieldIds.length === 0) return [];
  const safeLimit = Math.min(5, Math.max(1, Math.round(limitPerField)));

  const histories = await Promise.all(fieldIds.map(async (fieldId): Promise<readonly [string, ApplicationRecordHistoryRow[]]> => {
    try {
      const { data, error } = await supabase
        .from('application_records')
        .select('application_date, product_data, applicator_name, source_type, source_id, application_record_fields!inner(field_id)')
        .eq('application_record_fields.field_id', fieldId)
        .order('application_date', { ascending: false })
        // Bound full product-data snapshots while preserving headroom for
        // current-job exclusions within this field.
        .limit(safeLimit * 3);
      if (error) return [fieldId, []];

      const records = ((data ?? []) as unknown as ApplicationRecordHistoryRow[])
        // Exclude ONLY the current job's application record. Other job records
        // and non-job sources remain valid prior-history entries.
        .filter((record) => record.source_type !== 'job' || record.source_id !== jobId)
        .sort((first, second) => second.application_date.localeCompare(first.application_date))
        .slice(0, safeLimit);
      return [fieldId, records];
    } catch {
      return [fieldId, []];
    }
  }));
  const recordsByField = new Map(histories);

  return fields.flatMap((field) => {
    if (!field.field_id) return [];
    const records = (recordsByField.get(field.field_id) ?? [])
      .map((record) => ({
        date: record.application_date,
        summary: previousApplicationSummary(record.product_data),
        applicator: record.applicator_name ?? null,
      }));
    return records.length > 0 ? [{ fieldId: field.field_id, fieldName: field.field_name, records }] : [];
  });
}

interface BilledCustomerRow {
  customer_id: string;
  farm_name: string | null;
  account_number: string | null;
  is_primary: boolean;
}

interface JobFieldRow {
  field_id: string;
  acres_to_treat: number | null;
}

interface CustomerShareRow {
  field_id: string;
  customer_id: string;
  split_pct: number;
}

/**
 * Read billing rows for the packet. Names come from the RLS-safe billed-customer
 * RPC; allocation and phone reads are best effort so a restricted user receives
 * a printable packet without silently inventing a split.
 */
export async function fetchApplicatorSheetBillingSplits(
  jobId: string,
  totalAcres: number,
): Promise<ApplicatorSheetBillingSplit[]> {
  try {
    const { data, error } = await supabase.rpc('get_job_billed_customers', { p_job_id: jobId });
    if (error) return [];
    const customers = assertRpcResult<BilledCustomerRow[]>(data, 'get_job_billed_customers');
    if (customers.length === 0) return [];

    const customerById = new Map(customers.map((customer) => [customer.customer_id, customer]));
    const primaryCustomerId = customers.find((customer) => customer.is_primary)?.customer_id ?? customers[0].customer_id;
    const customerIds = [...customerById.keys()];

    const [
      { data: fields, error: fieldsError },
      { data: savedShares, error: savedSharesError },
      { data: phones },
    ] = await Promise.all([
      supabase.from('job_fields').select('field_id, acres_to_treat').eq('job_id', jobId),
      supabase.from('job_field_shares').select('field_id, customer_id, split_pct').eq('job_id', jobId),
      supabase.from('customers').select('id, phone').in('id', customerIds),
    ]);
    if (fieldsError || savedSharesError) return [];

    const phoneById = new Map<string, string | null>(
      ((phones ?? []) as Array<{ id: string; phone: string | null }>).map((customer) => [customer.id, customer.phone]),
    );
    const jobFields = (fields ?? []) as JobFieldRow[];
    const shares = (savedShares ?? []) as CustomerShareRow[];
    const sharesByField = new Map<string, CustomerShareRow[]>();
    shares.forEach((share) => {
      const current = sharesByField.get(share.field_id) ?? [];
      current.push(share);
      sharesByField.set(share.field_id, current);
    });

    // Existing jobs may predate saved job shares. Pull field defaults only for
    // those fields, then fall back to the primary customer when no split exists.
    const fieldsWithoutShares = jobFields.filter((field) => !sharesByField.has(field.field_id)).map((field) => field.field_id);
    if (fieldsWithoutShares.length > 0) {
      const { data: defaults, error: defaultsError } = await supabase
        .from('field_billing_defaults')
        .select('field_id, customer_id, split_pct')
        .in('field_id', fieldsWithoutShares);
      if (defaultsError) return [];
      ((defaults ?? []) as CustomerShareRow[]).forEach((share) => {
        const current = sharesByField.get(share.field_id) ?? [];
        current.push(share);
        sharesByField.set(share.field_id, current);
      });
    }

    const allocatedAcres = new Map<string, number>();
    jobFields.forEach((field) => {
      const acres = field.acres_to_treat ?? 0;
      const fieldShares = sharesByField.get(field.field_id) ?? [{ field_id: field.field_id, customer_id: primaryCustomerId, split_pct: 100 }];
      fieldShares.forEach((share) => {
        if (!customerById.has(share.customer_id)) return;
        allocatedAcres.set(share.customer_id, (allocatedAcres.get(share.customer_id) ?? 0) + acres * (share.split_pct / 100));
      });
    });

    return customers.map((customer) => {
      const acres = allocatedAcres.get(customer.customer_id);
      return {
        customerName: customer.farm_name?.trim() || 'Customer',
        acres: acres == null ? null : Math.round(acres * 10000) / 10000,
        percentOfJob: acres == null || totalAcres <= 0 ? null : Math.round((acres / totalAcres) * 10000) / 100,
        phone: phoneById.get(customer.customer_id) ?? null,
      };
    });
  } catch {
    return [];
  }
}

interface ProductSafetyRow {
  id: string;
  epa_registration: string | null;
  signal_word: string | null;
  rei_hours: number | null;
  phi_days: number | null;
}

/**
 * Safety for the optional safety sheet: exactly the job order's product lines, in
 * order. Every value (EPA no., signal word, REI, PHI) comes from that line's own
 * product record as it is today (by product id, never by name; Mason 2026-11-24),
 * so one row never mixes sources. A failed read, or a line product the reader cannot
 * see, returns null so the sheet says safety could not be loaded. A line without a
 * product id prints "See label".
 */
async function sheetSafety(products: ApplicatorSheetData['products']): Promise<ApplicatorSheetSafety[] | null> {
  const ids = [...new Set(products.map((product) => product.product_id).filter((id): id is string => Boolean(id)))];
  const labels = new Map<string, ProductSafetyRow>();
  if (ids.length > 0) {
    try {
      const { data, error } = await supabase.from('products').select('id, epa_registration, signal_word, rei_hours, phi_days').in('id', ids);
      if (error || !data) return null;
      (data as ProductSafetyRow[]).forEach((row) => labels.set(row.id, row));
    } catch {
      return null;
    }
    if (ids.some((id) => !labels.has(id))) return null;
  }
  return products.map((product) => {
    const label = product.product_id ? labels.get(product.product_id) : undefined;
    return {
      product_name: product.product_name,
      epa_registration: label?.epa_registration?.trim() || null,
      signal_word: label?.signal_word?.trim() || null,
      rei_hours: label?.rei_hours ?? null,
      phi_days: label?.phi_days ?? null,
    };
  });
}

/** Load maps/history/billing additions for every print entry point in one place. */
export async function prepareApplicatorSheetPrintData(
  jobId: string,
  data: ApplicatorSheetData,
  options: ApplicatorPrintOptions,
  office = true,
): Promise<ApplicatorSheetData> {
  const [maps, previousApplications, billingSplits, locations, safety] = await Promise.all([
    options.mapPages === 'none'
      ? Promise.resolve(null)
      : fetchJobMapImages(jobId, mapImageOptions(options.mapPages)),
    options.includePreviousApplications
      ? fetchPreviousApplications(data.fields, jobId, options.previousApplicationsPerField)
      : Promise.resolve([]),
    office && options.includeBillingSplits
      ? fetchApplicatorSheetBillingSplits(jobId, data.total_acres)
      : Promise.resolve([]),
    fetchJobFieldLocations(jobId),
    options.includeSafetySheet ? sheetSafety(data.products) : Promise.resolve(undefined),
  ]);
  const fields = data.fields.map((field) => ({ ...field, location: field.field_id ? locations.get(field.field_id) ?? null : null }));
  return {
    ...data,
    fields,
    maps,
    previousApplications,
    billingSplits,
    // Safety is off unless chosen; when chosen it prints on its own sheet (Mason, 2026-11-24).
    safety,
  };
}

/**
 * The "Map pages only" print: overview plus per-field maps for a saved job, with no
 * job order. Throws NO_MAP_PAGES_MESSAGE when the job has no map.
 */
export async function printApplicatorMapPages(jobId: string, data: ApplicatorSheetData): Promise<void> {
  const options: ApplicatorPrintOptions = {
    ...DEFAULT_APPLICATOR_PRINT_OPTIONS,
    mapPages: 'both',
    includePreviousApplications: false,
    includeBillingSplits: false,
  };
  await generateApplicatorSheetPdf(await prepareApplicatorSheetPrintData(jobId, data, options), 'original', null, { mapsOnly: true });
}
