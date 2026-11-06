import { supabase } from '../../lib/db';
import { searchProductParents } from '../../lib/productParents';
import { textFromIlikePattern } from '../../lib/productSearch';
import { Sentry } from '../../lib/sentry';
import RecordSearchPicker from '../ui/RecordSearchPicker';
import { ProductOptionDetails } from './ProductOptionPresentation';
import type { ProductSearchResult } from '../../types';

/**
 * Ids of the sizes whose parent's name or nickname contains the text (PAR-1). A failed parent search is
 * reported and leaves only the name and SKU match, so the picker still works.
 */
async function parentSizeIds(text: string): Promise<string[]> {
  try {
    const parents = await searchProductParents(text);
    return parents.flatMap((parent) => parent.sizes.map((size) => size.product_id)).slice(0, 200);
  } catch (error) {
    Sentry.captureException(error, { extra: { context: 'product_search_picker_parents' } });
    return [];
  }
}

const PRODUCT_SEARCH_SELECT =
  'id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, rate_unit, rate_per_acre, product_form, product_family:product_families(name)';

interface ProductSearchPickerProps<T extends ProductSearchResult = ProductSearchResult> {
  /** Selected product id, or '' for none. */
  value: string;
  /** Name shown for the selected product; the caller keeps it so a product is labelled without a list. */
  selectedLabel: string;
  /** Called with the picked product, or null when the selection is cleared. */
  onSelect: (product: T | null) => void | boolean;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Active-product picker that searches the database as you type (the Invoice
 * product search pattern), so every active product can be found however many
 * there are. A failed search says so instead of looking like "no matches".
 */
export default function ProductSearchPicker<T extends ProductSearchResult = ProductSearchResult>({
  value,
  selectedLabel,
  onSelect,
  placeholder = 'Search products...',
  ariaLabel = 'Search products',
  id,
  disabled,
  className,
}: ProductSearchPickerProps<T>) {
  return (
    <RecordSearchPicker<T>
      value={value}
      selectedLabel={selectedLabel}
      onSelect={onSelect}
      search={async (pattern, limit) => {
        // One query, so a size found by its own name and by its parent comes back once.
        const ids = await parentSizeIds(textFromIlikePattern(pattern));
        const byParent = ids.length > 0 ? `,id.in.(${ids.join(',')})` : '';
        return supabase
          .from('products')
          .select(PRODUCT_SEARCH_SELECT)
          .eq('is_active', true)
          .or(`product_name.ilike.${pattern},sku.ilike.${pattern}${byParent}`)
          .order('product_name')
          .order('id')
          .limit(limit);
      }}
      getLabel={(product) => product.product_name}
      renderDetails={(product) => <ProductOptionDetails product={product} />}
      noun="products"
      emptyMessage="No matching active products"
      sentryContext="product_search_picker"
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      id={id}
      disabled={disabled}
      className={className}
    />
  );
}
