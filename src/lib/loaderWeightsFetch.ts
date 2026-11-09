import { assertRpcResult, supabaseUntyped } from './db';
import { sourceAmount, type LoaderProductWeights, type LoaderSourceLine } from './loaderWeights';
import type { LoaderProductInput } from './loaderWorksheet';
import type { JobLoaderWorksheet, JobLoaderWorksheetWeight, ProductWeight, WeightUnitFactors } from '../types';

// DM-2 sheet 4.3: one `get_loader_worksheet_weights` read gives a job's lines, acres, settings and weights from one
// moment, so a printed amount and its weight never come from two reads.

export interface LoaderGetterLine {
  id: string;
  product_id: string | null;
  quantity: unknown;
  unit: string | null;
  product_name: string;
  product_form: string | null;
}

export interface LoaderGetterJob {
  job_id: string;
  found: boolean;
  job?: {
    job_number: string;
    job_date: string;
    scheduled_time: string | null;
    applicator_id: string | null;
    carrier_rate_gpa: number | null;
    loader_tank_capacity: number | null;
    loader_comment: string | null;
    vehicle: { vehicle_name: string | null; capacity_gallons: number | null; capacity_unit: string | null } | null;
  };
  acres?: number;
  lines?: LoaderGetterLine[];
  current?: Record<string, ProductWeight | null>;
  worksheet?: { id: string; worksheet: JobLoaderWorksheet; vehicle_name: string; saved: Record<string, JobLoaderWorksheetWeight> } | null;
}

interface GetterResult { read_at: string; unit_factors: WeightUnitFactors; jobs: LoaderGetterJob[] | null }

/** Each job's answer and the unit map of the same read (a bulk read spans several reads, one per chunk). */
export interface LoaderJobWeights { jobs: Map<string, LoaderGetterJob>; unitsByJob: Map<string, WeightUnitFactors> }

const CHUNK = 200;

/** The getter's answer for each job, read in chunks of 200 (its limit). */
export async function fetchLoaderJobWeights(jobIds: readonly string[]): Promise<LoaderJobWeights> {
  const jobs = new Map<string, LoaderGetterJob>();
  const unitsByJob = new Map<string, WeightUnitFactors>();
  for (let start = 0; start < jobIds.length; start += CHUNK) {
    const { data, error } = await supabaseUntyped.rpc('get_loader_worksheet_weights',
      { p_worksheet_ids: null, p_job_ids: jobIds.slice(start, start + CHUNK) });
    if (error) throw error;
    const result = assertRpcResult<GetterResult>(data, 'get_loader_worksheet_weights');
    for (const job of result.jobs ?? []) {
      jobs.set(job.job_id, job);
      unitsByJob.set(job.job_id, result.unit_factors);
    }
  }
  return { jobs, unitsByJob };
}

export interface LoaderJobInputs {
  products: LoaderProductInput[];
  sourceLines: LoaderSourceLine[];
  /** Each product's saved row (selected worksheet only) and current weight. */
  weights: Record<string, LoaderProductWeights>;
}

/** The tank-split inputs and weights of one job, all from the getter's one read. */
export function loaderJobInputs(job: LoaderGetterJob): LoaderJobInputs {
  // As the fetcher always did: a line with neither a product nor an amount is not printed.
  const lines = (job.lines ?? []).filter((line) => line.product_id || line.quantity != null);
  const saved = job.worksheet?.saved ?? {};
  const weights: Record<string, LoaderProductWeights> = {};
  for (const line of lines) {
    if (!line.product_id) continue;
    const current = job.current?.[line.product_id] ?? null;
    weights[line.product_id] = { saved: saved[line.product_id] ?? null, current };
  }
  const products = lines.map((line): LoaderProductInput => {
    const amount = sourceAmount(line.product_name, line.quantity);
    return { product_name: line.product_name, total_quantity: 'value' in amount ? amount.value : null, unit: line.unit,
      product_id: line.product_id, product_form: line.product_form, source_line_id: line.id };
  });
  const sourceLines = lines.map(({ id, product_id, quantity, unit }) => ({ id, product_id, quantity, unit }));
  return { products, sourceLines, weights };
}
