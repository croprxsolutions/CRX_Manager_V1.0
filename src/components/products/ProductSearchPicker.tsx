import { supabase } from '../../lib/db';
import { searchProductParents } from '../../lib/productParents';
import { textFromIlikePattern } from '../../lib/productSearch';
import { Sentry } from '../../lib/sentry';
import RecordSearchPicker from '../ui/RecordSearchPicker';
import { ProductOptionDetails } from './ProductOptionPresentation';
import type { ProductSearchResult } from '../../types';

// search_product_parents returns at most 50 parents; 200 ids keep the request URL short.
const PARENT_SEARCH_CAP = 50;
const SIZE_ID_CAP = 200;

/**
 * Ids of the active sizes whose parent's name or nickname contains the text (PAR-1), and whether a cap
 * left some out (the picker then asks for more text instead of hiding them). A failed parent search is
 * reported and leaves only the name and SKU match, so the picker still works.
 */
async function parentSizeIds(text: string): Promise<{ ids: string[]; truncated: boolean }> {
  try {
    const parents = await searchProductParents(text);
    const ids = parents.flatMap((parent) => parent.sizes.filter((size) => size.is_active).map((size) => size.product_id));
    return { ids: ids.slice(0, SIZE_ID_CAP), truncated: parents.length >= PARENT_SEARCH_CAP || ids.length > SIZE_ID_CAP };
  } catch (error) {
    Sentry.captureException(error, { extra: { context: 'product_search_picker_parents' } });
    return { ids: [], truncated: false };
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
        const { ids, truncated } = await parentSizeIds(textFromIlikePattern(pattern));
        const byParent = ids.length > 0 ? `,id.in.(${ids.join(',')})` : '';
        const result = await supabase
          .from('products')
          .select(PRODUCT_SEARCH_SELECT)
          .eq('is_active', true)
          .or(`product_name.ilike.${pattern},sku.ilike.${pattern}${byParent}`)
          .order('product_name')
          .order('id')
          .limit(limit);
        return { data: result.data, error: result.error, truncated };
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
