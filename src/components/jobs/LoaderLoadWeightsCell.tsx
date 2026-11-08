import type { JSX } from 'react';
import { loaderGroupWeightText } from '../../lib/loaderWeights';
import type { SelectedLoaderWeights } from './loaderPanelWeights';

/**
 * One load's products ("TEST UAN 12.5 Gal · 104.30 lb", marked when current) and its product weight. A condensed
 * row passes every load in its group, so a weight that differs between them shows lowest to highest.
 */
export function LoaderLoadWeightsCell({ result, loadIndexes }: { result: SelectedLoaderWeights; loadIndexes: readonly number[] }): JSX.Element | null {
  const loadIndex = loadIndexes[0];
  const load = result.weights.loads[loadIndex];
  const products = result.ws.loads[loadIndex]?.products;
  if (!load || !products) return null;
  return (
    <div className="space-y-0.5 text-xs">
      {load.cells.map((cell, index) => {
        const product = products[index];
        const weightText = loaderGroupWeightText(result.weights, loadIndexes, index);
        const amount = cell.amountCell === cell.weightText ? cell.amountCell : `${cell.amountCell}${product.unit ? ` ${product.unit}` : ''} · ${weightText}`;
        return (
          <p key={product.source_line_id ?? index} className="text-secondary">
            {product.product_name}: {amount}{cell.mark === 'current' ? ' (current)' : ''}
          </p>
        );
      })}
      <p className="font-medium text-nav-dark">{loaderGroupWeightText(result.weights, loadIndexes, 'total')}</p>
    </div>
  );
}
