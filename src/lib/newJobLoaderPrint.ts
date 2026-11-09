import { fetchProductWeights, type ProductWeightsResult } from './productWeights';
import { sourceAmount, type LoaderSourceLine } from './loaderWeights';
import type { LoaderProductInput } from './loaderWorksheet';
import type { LoaderPdfWeights } from './loaderWorksheetPdf';

// DM-2 sheet 4.3: a new, never-saved job prints its loader worksheet from the form, with current weights.

export interface LoaderFormRow { product_id: string; product_name: string; quantity: string; unit: string }

/**
 * The form rows as tank-split inputs. Each row keeps its original position as its line id (taken before any row is
 * skipped), so two rows of one product are weighed or refused row by row; a row with a quantity but no product
 * still prints its amount, with its weight refused; a row with neither is skipped.
 */
export function newJobLoaderLines(rows: readonly LoaderFormRow[], weights: ProductWeightsResult | null):
  { products: LoaderProductInput[]; sourceLines: LoaderSourceLine[] } {
  const kept = rows.map((row, index) => ({ row, id: `row-${index}` }))
    .filter(({ row }) => row.product_id || row.quantity.trim() !== '');
  const products = kept.map(({ row, id }): LoaderProductInput => {
    const name = row.product_name || 'Product';
    const amount = sourceAmount(name, row.quantity.trim() === '' ? null : row.quantity);
    return { product_name: name, total_quantity: 'value' in amount ? amount.value : null, unit: row.unit || null,
      product_id: row.product_id || null, product_form: weights?.products[row.product_id]?.product_form ?? null, source_line_id: id };
  });
  const sourceLines = kept.map(({ row, id }) => ({ id, product_id: row.product_id || null,
    quantity: row.quantity.trim() === '' ? null : row.quantity, unit: row.unit || null }));
  return { products, sourceLines };
}

/** The new job's print inputs with each product's current weight (or the reason none are printed). */
export async function newJobLoaderPrint(rows: readonly LoaderFormRow[]): Promise<{ products: LoaderProductInput[]; weights: LoaderPdfWeights }> {
  const ids = [...new Set(rows.map((row) => row.product_id).filter(Boolean))];
  let read: ProductWeightsResult | null = null;
  try {
    read = ids.length > 0 ? await fetchProductWeights(ids) : null;
  } catch (_error) {
    read = null;
  }
  const { products, sourceLines } = newJobLoaderLines(rows, read);
  if (ids.length > 0 && !read) {
    return { products, weights: { byProductId: {}, currentUnits: { factors: {}, ambiguous: [] }, sourceLines, saved: false,
      unavailable: 'Product weights not shown: they could not be read. Reprint to include them.' } };
  }
  const byProductId = Object.fromEntries(ids.map((id) => [id, { current: read?.products[id]?.weight ?? null }]));
  return { products, weights: { byProductId, currentUnits: read?.units ?? { factors: {}, ambiguous: [] }, sourceLines, saved: false } };
}
