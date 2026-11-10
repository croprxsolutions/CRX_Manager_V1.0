import { useEffect, useRef, useState, useCallback } from 'react';
import { FlaskConical, Info } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import EmptyState from '../components/ui/EmptyState';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { PRODUCT_COLUMNS, withAdminCosts, withAdminNestedCosts } from '../lib/costFields';
import { fetchAllRows } from '../lib/pagedRead';
import type { Product, IngredientMap } from '../types';

type MappingRow = IngredientMap & { generic_product: Product | null };

export default function BrandVsGeneric() {
  const { toast } = useToast();
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [products, setProducts] = useState<Product[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // Only the newest load may install rows: a role change re-runs the loader while an older
  // (possibly cost-less) load is still in flight (Luna round 2).
  const loadSeqRef = useRef(0);
  const fetchData = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    // Both lists are read in full, page by page: the pickers, the comparison and
    // the management table use them whole, and one read stops silently at the
    // server's 1,000-row cap.
    const [prodRes, mapRes] = await Promise.all([
      fetchAllRows((from, to) => supabase
        .from('products')
        .select(PRODUCT_COLUMNS, { count: 'exact' })
        .eq('is_active', true)
        .order('product_name')
        .order('id')
        .range(from, to)),
      fetchAllRows((from, to) => supabase
        .from('ingredient_map')
        .select(`*, generic_product:products!ingredient_map_generic_product_id_fkey(${PRODUCT_COLUMNS})`, { count: 'exact' })
        .order('fallback_branded_product')
        .order('id')
        .range(from, to)),
    ]);

    // A failed read shows an error and no lists (never an earlier or partial one),
    // and adding or editing a mapping stays blocked until a load succeeds.
    const failLoad = (error: unknown) => {
      Sentry.captureException(error, {
        tags: { source: 'fetch', action: 'load_ingredient_map' },
      });
      if (seq !== loadSeqRef.current) return;
      toast('error', 'Failed to load ingredient mappings');
      setProducts([]);
      setMappings([]);
      setSelectedProductId('');
      setLoadFailed(true);
      setLoading(false);
    };

    if (prodRes.error || mapRes.error) {
      failLoad(prodRes.error || mapRes.error);
      return;
    }
    // Cost is admin-only (Mason, 2026-10-15).
    let loadedProducts: Product[];
    let loadedMappings: MappingRow[];
    try {
      loadedProducts = await withAdminCosts('products', (prodRes.data || []) as unknown as Product[], isAdmin);
      loadedMappings = await withAdminNestedCosts('products', (mapRes.data || []) as unknown as MappingRow[], 'generic_product', isAdmin);
    } catch (costError) {
      failLoad(costError);
      return;
    }
    if (seq !== loadSeqRef.current) return;
    setProducts(loadedProducts);
    setMappings(loadedMappings);
    setLoadFailed(false);
    setLoading(false);
  }, [isAdmin, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);
  // Comparison viewer — derived from the loaded mappings (single source of truth).
  const selectedProduct = products.find((p) => p.id === selectedProductId) || null;
  const viewerMapping = selectedProduct
    ? mappings.find((m) => m.fallback_branded_product === selectedProduct.product_name) || null
    : null;
  const genericProduct = viewerMapping?.generic_product || null;

  const fmt = (n: number | null | undefined) =>
    n != null
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
      : '-';

  const dataColumns: Column<MappingRow>[] = [
    {
      key: 'fallback_branded_product',
      header: 'Branded Product',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.fallback_branded_product || '-'}</span>,
    },
    {
      key: 'branded_ingredient',
      header: 'Active Ingredient',
      sortable: true,
      render: (r) => <span className="text-nav-dark">{r.branded_ingredient || '-'}</span>,
    },
    {
      key: 'generic',
      header: 'Generic Alternative',
      render: (r) =>
        r.generic_product ? (
          <span className="text-crx-green font-medium">{r.generic_product.product_name}</span>
        ) : (
          <span className="text-gray-400">&mdash; unmapped</span>
        ),
    },
    {
      key: 'generic_has_bulk',
      header: 'Bulk',
      render: (r) =>
        r.generic_has_bulk ? <Badge variant="success">Bulk</Badge> : <Badge variant="default">No</Badge>,
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (r) => <span className="text-secondary">{r.notes || '-'}</span>,
    },
  ];


  return (
    <div className="space-y-6">
      <SplitHeading title="Brand vs" accent="Generic" />

      {/* Comparison viewer */}
      <Card>
        <label className="block text-sm font-medium text-secondary mb-2">
          Select a Product to Compare
        </label>
        <select
          value={selectedProductId}
          onChange={(e) => setSelectedProductId(e.target.value)}
          className="w-full max-w-md px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        >
          <option value="">Choose a product...</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.product_name}
            </option>
          ))}
        </select>
      </Card>

      {selectedProduct && !genericProduct && (
        <Card>
          <EmptyState
            icon={<FlaskConical className="w-6 h-6 text-gray-400" />}
            title="No generic alternative found"
            description={
              `No generic alternative has been mapped for ${selectedProduct.product_name}.`
            }
          />
        </Card>
      )}

      {selectedProduct && genericProduct && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader title="Branded" accent="Product" />
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-secondary">Name</p>
                  <p className="text-sm font-medium text-nav-dark">{selectedProduct.product_name}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">Vendor</p>
                  <p className="text-sm text-nav-dark">{selectedProduct.vendor || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">Category</p>
                  <p className="text-sm text-nav-dark">{selectedProduct.category || '-'}</p>
                </div>
                {/* Cost is admin-only (Mason, 2026-10-15). */}
                {isAdmin && (
                  <div className="border-t border-gray-100 pt-3">
                    <p className="text-xs text-secondary">Cost</p>
                    <p className="text-lg font-semibold text-nav-dark font-mono">
                      {fmt(selectedProduct.current_cost)}
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-xs text-secondary">T1</p>
                    <p className="text-sm font-mono">{fmt(selectedProduct.tier1_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">T2</p>
                    <p className="text-sm font-mono">{fmt(selectedProduct.tier2_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">T3</p>
                    <p className="text-sm font-mono">{fmt(selectedProduct.tier3_price)}</p>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="border-crx-green/20">
              <CardHeader title="Generic" accent="Alternative" />
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-secondary">Name</p>
                  <p className="text-sm font-medium text-nav-dark">{genericProduct.product_name}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">Vendor</p>
                  <p className="text-sm text-nav-dark">{genericProduct.vendor || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">Category</p>
                  <p className="text-sm text-nav-dark">{genericProduct.category || '-'}</p>
                </div>
                {isAdmin && (
                  <div className="border-t border-gray-100 pt-3">
                    <p className="text-xs text-secondary">Cost</p>
                    <p className="text-lg font-semibold text-crx-green font-mono">
                      {fmt(genericProduct.current_cost)}
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-xs text-secondary">T1</p>
                    <p className="text-sm font-mono">{fmt(genericProduct.tier1_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">T2</p>
                    <p className="text-sm font-mono">{fmt(genericProduct.tier2_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">T3</p>
                    <p className="text-sm font-mono">{fmt(genericProduct.tier3_price)}</p>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          <Card padding={false}>
            <div className="p-5">
              <CardHeader title="Price" accent="Comparison" />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-4 py-3 text-left font-medium text-secondary">Metric</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Branded</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Generic</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Savings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ...(isAdmin ? [{ label: 'Cost', branded: selectedProduct.current_cost, generic: genericProduct.current_cost }] : []),
                      { label: 'Tier 1 Price', branded: selectedProduct.tier1_price, generic: genericProduct.tier1_price },
                      { label: 'Tier 2 Price', branded: selectedProduct.tier2_price, generic: genericProduct.tier2_price },
                      { label: 'Tier 3 Price', branded: selectedProduct.tier3_price, generic: genericProduct.tier3_price },
                    ].map((row) => {
                      const savings =
                        row.branded != null && row.generic != null ? row.branded - row.generic : null;
                      return (
                        <tr key={row.label} className="border-b border-gray-50">
                          <td className="px-4 py-3 font-medium text-nav-dark">{row.label}</td>
                          <td className="px-4 py-3 font-mono">{fmt(row.branded)}</td>
                          <td className="px-4 py-3 font-mono">{fmt(row.generic)}</td>
                          <td className="px-4 py-3 font-mono">
                            {savings != null ? (
                              <span className={savings > 0 ? 'text-emerald-600' : 'text-red-600'}>
                                {savings > 0 ? '+' : ''}{fmt(savings)}
                              </span>
                            ) : (
                              '-'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </>
      )}

      {/* Management section */}
      <Card padding={false}>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardHeader title="Brand" accent="Mappings" />
          </div>
          {/* Read-only since DM-1: ingredients move to each product's Chemistry section. */}
          <div role="note" className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-secondary">
            <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              This list is read-only. Active ingredients are recorded in the Chemistry section of each product.
            </span>
          </div>
          <DataTable<MappingRow>
            data={mappings}
            columns={dataColumns}
            searchable
            searchPlaceholder="Search mappings..."
            searchKeys={['fallback_branded_product', 'branded_ingredient', 'notes']}
            emptyTitle="No mappings yet"
            emptyDescription="No brand-to-generic mappings have been set up."
            loading={loading}
            loadError={loadFailed}
            onRetry={() => void fetchData()}
          />
        </div>
      </Card>

    </div>
  );
}
