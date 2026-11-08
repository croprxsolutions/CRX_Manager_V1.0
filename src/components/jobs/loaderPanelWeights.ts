import { useEffect, useState } from 'react';
import { computeLoaderWorksheet, type LoaderProductInput, type LoaderWorksheet } from '../../lib/loaderWorksheet';
import { loaderLoadWeights, loaderWeightCaption, type LoaderWeights } from '../../lib/loaderWeights';
import { fetchLoaderJobWeights, loaderJobInputs, type LoaderGetterJob } from '../../lib/loaderWeightsFetch';
import type { JobLoaderWorksheet, WeightUnitFactors } from '../../types';

// DM-2 sheet 4.3: the selected worksheet's product weights on the job page, from one getter read.

export type LoaderWeightsRead = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; entry: LoaderGetterJob; units: WeightUnitFactors };

/** Reads the job's loader weights; `version` changes after every successful worksheet save so the marks update. */
export function useLoaderJobWeights(jobId: string, version: number): LoaderWeightsRead {
  const [read, setRead] = useState<{ tag: string; value: LoaderWeightsRead }>({ tag: '', value: { status: 'loading' } });
  const tag = `${jobId}:${version}`;
  useEffect(() => {
    if (version === 0) return undefined; // the panel's first worksheet read bumps it to 1
    let live = true;
    fetchLoaderJobWeights([jobId])
      .then(({ jobs, unitsByJob }) => {
        const entry = jobs.get(jobId);
        const units = unitsByJob.get(jobId);
        if (live) setRead({ tag, value: entry?.found && units ? { status: 'ready', entry, units } : { status: 'failed' } });
      })
      .catch(() => { if (live) setRead({ tag, value: { status: 'failed' } }); });
    return () => { live = false; };
  }, [jobId, tag, version]);
  // A read for an earlier save or job is never shown as this one's.
  return read.tag === tag ? read.value : { status: 'loading' };
}

/** The job page's linked chemical rows as worksheet products; product_id is part of the plan the weights must match. */
export function loaderPanelProducts(rows: readonly { product_id?: string | null; product_name?: string | null; quantity: string; unit?: string | null }[]): LoaderProductInput[] {
  return rows.filter((row) => row.product_id).map((row) => ({
    product_name: row.product_name || 'Product',
    total_quantity: row.quantity.trim() === '' ? null : parseFloat(row.quantity),
    unit: row.unit || null,
    product_id: row.product_id,
  }));
}

const sameSettings = (a: JobLoaderWorksheet, b: JobLoaderWorksheet) => a.capacity_gal === b.capacity_gal
  && a.carrier_rate_gpa === b.carrier_rate_gpa && a.load_balance_mode === b.load_balance_mode
  && (a.per_load_acres ?? []).join('|') === (b.per_load_acres ?? []).join('|');

/**
 * Every load's volume and each product's printed amount, so a weight is shown only for the exact plan on screen.
 * Products are sorted (the job page and the getter list a job's chemicals in different orders) and JSON-encoded,
 * so no name or unit can make two different plans read the same.
 */
// Linked lines only: the panel lists linked lines (loaderPanelProducts), so an unlinked line must not make the plans differ.
const planKey = (ws: LoaderWorksheet) => JSON.stringify(ws.loads.map((load) => [load.volume,
  load.products.filter((product) => product.product_id)
    .map((product) => JSON.stringify([product.product_id, product.product_name, product.amount, product.unit ?? ''])).sort()]));

export interface SelectedLoaderWeights { ws: LoaderWorksheet; weights: LoaderWeights; caption: string }

/**
 * The selected worksheet's weights, or why they are not shown. The getter's own plan must match the plan on
 * screen (same worksheet, settings and loads), so a weight never describes a different load than the one shown.
 */
export function selectedLoaderWeights(read: LoaderWeightsRead, selected: JobLoaderWorksheet, shown: LoaderWorksheet):
  SelectedLoaderWeights | { reason: string } {
  if (read.status === 'loading') return { reason: 'Loading product weights…' };
  if (read.status === 'failed') return { reason: 'Product weights could not be loaded. Reload the page to try again.' };
  const saved = read.entry.worksheet;
  const changed = { reason: 'Product weights not shown: the job or worksheet changed since this page loaded. Reload to see them.' };
  if (!saved || saved.id !== selected.id || !sameSettings(saved.worksheet, selected)) return changed;
  const inputs = loaderJobInputs(read.entry);
  const ws = computeLoaderWorksheet({ total_acres: Number(read.entry.acres ?? 0), carrier_rate_gpa: saved.worksheet.carrier_rate_gpa,
    tank_capacity: saved.worksheet.capacity_gal, mode: saved.worksheet.load_balance_mode,
    // Every line, as the PDF does: an unlinked line with an amount withholds the load total instead of being left out.
    perLoadAcresOverride: saved.worksheet.per_load_acres ?? undefined, products: inputs.products });
  if (!ws.valid || planKey(ws) !== planKey(shown)) return changed;
  const weights = loaderLoadWeights(ws, inputs.weights, read.units, inputs.sourceLines);
  return { ws, weights, caption: loaderWeightCaption(true, weights.anyCurrent) };
}
