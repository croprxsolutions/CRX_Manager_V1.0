import { useEffect, useState, type JSX } from 'react';
import { computeLoaderWorksheet, type LoaderWorksheet } from '../../lib/loaderWorksheet';
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
      .then(({ units, jobs }) => {
        const entry = jobs.get(jobId);
        if (live) setRead({ tag, value: entry?.found ? { status: 'ready', entry, units } : { status: 'failed' } });
      })
      .catch(() => { if (live) setRead({ tag, value: { status: 'failed' } }); });
    return () => { live = false; };
  }, [jobId, tag, version]);
  // A read for an earlier save or job is never shown as this one's.
  return read.tag === tag ? read.value : { status: 'loading' };
}

const sameSettings = (a: JobLoaderWorksheet, b: JobLoaderWorksheet) => a.capacity_gal === b.capacity_gal
  && a.carrier_rate_gpa === b.carrier_rate_gpa && a.load_balance_mode === b.load_balance_mode
  && (a.per_load_acres ?? []).join('|') === (b.per_load_acres ?? []).join('|');

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
    perLoadAcresOverride: saved.worksheet.per_load_acres ?? undefined, products: inputs.products });
  if (!ws.valid || ws.loads.map((load) => load.volume).join('|') !== shown.loads.map((load) => load.volume).join('|')) return changed;
  const weights = loaderLoadWeights(ws, inputs.weights, read.units, inputs.sourceLines);
  return { ws, weights, caption: loaderWeightCaption(true, weights.anyCurrent) };
}

/** One load's products ("TEST UAN 12.5 Gal · 104.30 lb", marked when current) and its product weight. */
export function LoaderLoadWeightsCell({ result, loadIndex }: { result: SelectedLoaderWeights; loadIndex: number }): JSX.Element | null {
  const load = result.weights.loads[loadIndex];
  const products = result.ws.loads[loadIndex]?.products;
  if (!load || !products) return null;
  return (
    <div className="space-y-0.5 text-xs">
      {load.cells.map((cell, index) => {
        const product = products[index];
        const amount = cell.amountCell === cell.weightText ? cell.amountCell : `${cell.amountCell}${product.unit ? ` ${product.unit}` : ''} · ${cell.weightText}`;
        return (
          <p key={product.source_line_id ?? index} className="text-secondary">
            {product.product_name}: {amount}{cell.mark === 'current' ? ' (current)' : ''}
          </p>
        );
      })}
      <p className="font-medium text-nav-dark">{load.totalText}</p>
    </div>
  );
}
