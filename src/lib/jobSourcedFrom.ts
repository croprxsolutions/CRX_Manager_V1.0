import { fetchAllRows, pageWithList } from './pagedRead';

export const FIELD_SOURCED_FROM_DB_READY = false;
const TODO_CONFIRM_JOB_STOCK_PATH_COLUMN = 'stock_path' as const;
const TODO_CONFIRM_JOB_CHEMICAL_SOURCE_VENDOR_COLUMN = 'source_vendor_id' as const;

export type JobStockPath = 'at_completion' | 'batch';

export interface JobStockPathRead {
  available: boolean;
  path: JobStockPath | null;
}

export interface JobSourceVendor {
  id: string;
  name: string;
  inactive?: boolean;
}

export interface JobChemicalSourcesRead {
  available: boolean;
  sourcesByChemicalId: Record<string, string | null>;
}

export function batchCustomerSuppliedLineNeedsVendor(
  stockPath: JobStockPathRead,
  customerSupplied: boolean,
  sourceVendorId: string | null | undefined,
): boolean {
  return stockPath.available && stockPath.path === 'batch' && customerSupplied && !sourceVendorId;
}

export function jobSupportsVendorSourcing(
  featureReady: boolean,
  isOffice: boolean,
  stockPath: JobStockPathRead,
): boolean {
  return featureReady && isOffice && stockPath.available && stockPath.path === 'batch';
}

export function isBatchVendorSourcedLine(
  featureReady: boolean,
  stockPath: JobStockPathRead,
  sourceVendorId: string | null | undefined,
): boolean {
  return jobSupportsVendorSourcing(featureReady, true, stockPath) && Boolean(sourceVendorId);
}

export function isJobChemicalNonBillable(
  featureReady: boolean,
  stockPath: JobStockPathRead,
  customerSupplied: boolean,
  sourceVendorId: string | null | undefined,
): boolean {
  return customerSupplied || isBatchVendorSourcedLine(featureReady, stockPath, sourceVendorId);
}

export function sourceReadBlocksJobSave(
  featureReady: boolean,
  isOffice: boolean,
  reads: {
    chemicalSourcesAvailable: boolean;
    isExistingJob: boolean;
    stockPath: JobStockPathRead;
    vendorListAvailable: boolean;
  },
): boolean {
  return featureReady && isOffice && (
    !reads.chemicalSourcesAvailable
    || (reads.isExistingJob && !reads.stockPath.available)
    || (reads.stockPath.available && reads.stockPath.path === 'batch' && !reads.vendorListAvailable)
  );
}

const unavailableStockPath: JobStockPathRead = { available: false, path: null };
const unavailableChemicalSources: JobChemicalSourcesRead = { available: false, sourcesByChemicalId: {} };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function loadJobStockPath(jobId: string): Promise<JobStockPathRead> {
  try {
    const { supabaseUntyped } = await import('./db');
    const { data, error } = await supabaseUntyped
      .from('jobs')
      .select(TODO_CONFIRM_JOB_STOCK_PATH_COLUMN)
      .eq('id', jobId)
      .maybeSingle();
    const row = record(data);
    if (error || !row) return unavailableStockPath;
    const path = row[TODO_CONFIRM_JOB_STOCK_PATH_COLUMN];
    if (path === 'at_completion' || path === 'batch') return { available: true, path };
  } catch {
    return unavailableStockPath;
  }
  return unavailableStockPath;
}

/** Reads the new column separately so a missing database migration never breaks the job load. */
export async function loadJobChemicalSources(jobId: string | null): Promise<JobChemicalSourcesRead> {
  try {
    const { supabaseUntyped } = await import('./db');
    let query = supabaseUntyped
      .from('job_chemicals')
      .select(`id, ${TODO_CONFIRM_JOB_CHEMICAL_SOURCE_VENDOR_COLUMN}`);
    query = jobId ? query.eq('job_id', jobId) : query.limit(0);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return unavailableChemicalSources;

    const sourcesByChemicalId: Record<string, string | null> = {};
    for (const value of data) {
      const row = record(value);
      if (!row || typeof row.id !== 'string') return unavailableChemicalSources;
      const vendorId = row[TODO_CONFIRM_JOB_CHEMICAL_SOURCE_VENDOR_COLUMN];
      if (vendorId !== null && typeof vendorId !== 'string') return unavailableChemicalSources;
      sourcesByChemicalId[row.id] = vendorId;
    }
    return { available: true, sourcesByChemicalId };
  } catch {
    return unavailableChemicalSources;
  }
}

export async function loadActiveJobSourceVendors(): Promise<{ available: boolean; vendors: JobSourceVendor[] }> {
  try {
    const { supabaseUntyped } = await import('./db');
    const { data, error } = await fetchAllRows<JobSourceVendor>((from, to) => pageWithList(
      supabaseUntyped
        .from('vendors')
        .select('id, name', { count: 'exact' })
        .is('deleted_at', null)
        .order('name')
        .order('id')
        .range(from, to),
    ));
    if (error || !data) return { available: false, vendors: [] };
    const vendors = data.filter((vendor) => typeof vendor.id === 'string' && typeof vendor.name === 'string');
    return { available: true, vendors };
  } catch {
    return { available: false, vendors: [] };
  }
}

export async function loadSavedJobSourceVendors(vendorIds: string[]): Promise<JobSourceVendor[]> {
  if (vendorIds.length === 0) return [];
  try {
    const { supabaseUntyped } = await import('./db');
    const { data, error } = await supabaseUntyped
      .from('vendors')
      .select('id, name, deleted_at')
      .in('id', vendorIds);
    if (error || !Array.isArray(data)) return [];
    return data.flatMap((value) => {
      const row = record(value);
      if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') return [];
      return [{ id: row.id, name: row.name, inactive: row.deleted_at != null }];
    });
  } catch {
    return [];
  }
}
