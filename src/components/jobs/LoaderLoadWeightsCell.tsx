import type { JSX } from 'react';
import type { SelectedLoaderWeights } from './loaderPanelWeights';

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
