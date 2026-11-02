import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { MobileProduct } from '../../types';
import { formatUSD } from '../../lib/money';
import { matchesProductSearch } from '../../lib/productSearch';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import EmptyState, { LoadFailedState } from '../ui/EmptyState';

const MOBILE_PAGE_SIZE = 50;

type Props = {
  products: readonly MobileProduct[];
  categories: readonly string[];
  vendors: readonly string[];
  categoryFilter: string;
  vendorFilter: string;
  statusFilter: 'active' | 'inactive' | 'all';
  onCategoryFilterChange: (value: string) => void;
  onVendorFilterChange: (value: string) => void;
  onStatusFilterChange: (value: 'active' | 'inactive' | 'all') => void;
  onOpenProduct: (product: MobileProduct) => void;
  loadError?: boolean;
  onRetry?: () => void;
};

function formatTierPrice(price: number | null): string {
  return price == null ? '—' : formatUSD(price);
}

export default function ProductsMobileList({
  products,
  categories,
  vendors,
  categoryFilter,
  vendorFilter,
  statusFilter,
  onCategoryFilterChange,
  onVendorFilterChange,
  onStatusFilterChange,
  onOpenProduct,
  loadError = false,
  onRetry,
}: Props) {
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(MOBILE_PAGE_SIZE);

  const filteredProducts = useMemo(() => products.filter((product) => {
    if (categoryFilter && product.category !== categoryFilter) return false;
    if (vendorFilter && product.vendor !== vendorFilter) return false;
    if (statusFilter === 'active' && !product.is_active) return false;
    if (statusFilter === 'inactive' && product.is_active) return false;
    return !search || matchesProductSearch(product, search);
  }), [categoryFilter, products, search, statusFilter, vendorFilter]);

  const resetVisibleCount = () => setVisibleCount(MOBILE_PAGE_SIZE);

  return (
    <div className="space-y-4 p-3" data-testid="products-mobile-list">
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetVisibleCount();
            }}
            placeholder="Search products..."
            aria-label="Search products..."
            className="min-h-11 w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-base focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <select
            value={categoryFilter}
            onChange={(event) => {
              onCategoryFilterChange(event.target.value);
              resetVisibleCount();
            }}
            aria-label="Filter by category"
            className="min-h-11 min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          >
            <option value="">All Categories</option>
            {categories.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
          <select
            value={vendorFilter}
            onChange={(event) => {
              onVendorFilterChange(event.target.value);
              resetVisibleCount();
            }}
            aria-label="Filter by vendor"
            className="min-h-11 min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          >
            <option value="">All Vendors</option>
            {vendors.map((vendor) => (
              <option key={vendor} value={vendor}>{vendor}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(event) => {
              onStatusFilterChange(event.target.value as 'active' | 'inactive' | 'all');
              resetVisibleCount();
            }}
            aria-label="Filter by status"
            className="col-span-2 min-h-11 min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All statuses</option>
          </select>
        </div>
      </div>

      {loadError ? (
        <LoadFailedState onRetry={onRetry} />
      ) : filteredProducts.length === 0 ? (
        <EmptyState
          title={products.length === 0 ? 'No products yet' : 'No matching products'}
          description={products.length === 0 ? 'Add your first product to get started' : 'Try a different search or filter'}
        />
      ) : (
        <>
          <div className="space-y-3">
            {filteredProducts.slice(0, visibleCount).map((product) => (
              <button
                key={product.id}
                type="button"
                onClick={() => onOpenProduct(product)}
                className="block min-h-[44px] w-full rounded-xl border border-gray-200 bg-white p-4 text-left shadow-card transition-colors hover:bg-crx-green-tint focus:outline-none focus:ring-2 focus:ring-crx-green/40"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="line-clamp-2 font-semibold text-nav-dark">{product.product_name}</h2>
                    <p className="mt-1 truncate text-sm text-secondary">SKU: {product.sku || '—'}</p>
                  </div>
                  <Badge variant={product.is_active ? 'success' : 'default'}>
                    {product.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-secondary">{product.category || 'Uncategorized'}</p>
                <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3">
                  <div>
                    <dt className="text-xs font-medium text-secondary">Tier 1</dt>
                    <dd className="mt-1 font-mono text-sm font-semibold text-nav-dark">{formatTierPrice(product.tier1_price)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-secondary">Tier 2</dt>
                    <dd className="mt-1 font-mono text-sm font-semibold text-nav-dark">{formatTierPrice(product.tier2_price)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-secondary">Tier 3</dt>
                    <dd className="mt-1 font-mono text-sm font-semibold text-nav-dark">{formatTierPrice(product.tier3_price)}</dd>
                  </div>
                </dl>
              </button>
            ))}
          </div>
          {visibleCount < filteredProducts.length && (
            <Button
              variant="secondary"
              className="min-h-11 w-full"
              onClick={() => setVisibleCount((count) => count + MOBILE_PAGE_SIZE)}
            >
              Show {Math.min(MOBILE_PAGE_SIZE, filteredProducts.length - visibleCount)} more products
            </Button>
          )}
        </>
      )}
    </div>
  );
}
