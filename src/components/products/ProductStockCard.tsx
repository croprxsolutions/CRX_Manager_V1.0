import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Card, { CardHeader } from '../ui/Card';
import { LoadFailedState } from '../ui/EmptyState';
import { useAuth } from '../../contexts/AuthContext';
import { assertRpcResult, supabase } from '../../lib/db';
import { exactDecimalSum, type ExactDecimal } from '../../lib/chemCalculator';
import { hasPageAccess } from '../../lib/pagePermissions';
import { Sentry } from '../../lib/sentry';
import { validateInventoryPositionShape } from '../../lib/inventoryPositionValidator';
import type { InventoryPositionRow } from '../../types';

function formatExactQuantity(value: ExactDecimal): string {
  const negative = value.coefficient < 0n;
  const absolute = negative ? -value.coefficient : value.coefficient;
  const divisor = 10n ** BigInt(value.scale);
  const whole = (absolute / divisor).toString();
  const fraction = value.scale > 0
    ? (absolute % divisor).toString().padStart(value.scale, '0').replace(/0+$/, '')
    : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function inventoryUnit(row: InventoryPositionRow): string {
  return row.inventory_unit || row.unit_size || '—';
}

interface ProductStockCardProps {
  productId: string;
  isActive: boolean;
}

export default function ProductStockCard({ productId, isActive }: ProductStockCardProps) {
  const { role, deniedPages } = useAuth();
  const canOpenInventory = hasPageAccess(role, deniedPages, 'inventory');
  const [rows, setRows] = useState<InventoryPositionRow[]>([]);
  const [asOf, setAsOf] = useState<Date | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const requestIdRef = useRef(0);

  const loadStock = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setRows([]);
    setAsOf(null);
    setLoadState('loading');

    try {
      const { data, error } = await supabase.rpc('get_inventory_position');
      const readAt = new Date();
      if (requestId !== requestIdRef.current) return;
      if (error) throw error;

      const positions = assertRpcResult<InventoryPositionRow[]>(data, 'get_inventory_position');
      validateInventoryPositionShape(positions);
      const productRows = positions
        .filter((row) => row.product_id === productId)
        .sort((left, right) =>
          (left.location?.trim() || '').localeCompare(right.location?.trim() || ''),
        );

      setRows(productRows);
      setAsOf(readAt);
      setLoadState('loaded');
    } catch (error: unknown) {
      if (requestId !== requestIdRef.current) return;
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'product-stock-card' } });
      setRows([]);
      setAsOf(null);
      setLoadState('failed');
    }
  }, [productId]);

  useEffect(() => {
    void loadStock();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadStock]);

  const inventoryLink = `/inventory?product=${productId}`;
  const canShowTotal = rows.length >= 2 && rows.every((row) =>
    (row.inventory_unit || row.unit_size) === (rows[0].inventory_unit || rows[0].unit_size)
    && row.unit_size === rows[0].unit_size,
  );
  const total = canShowTotal
    ? exactDecimalSum(rows.map((row) => row.quantity_available))
    : null;

  return (
    <Card>
      <CardHeader title="Stock" accent="& Reorder" />
      {loadState === 'loading' ? (
        <p className="text-sm text-secondary" role="status">Loading stock…</p>
      ) : loadState === 'failed' ? (
        <LoadFailedState title="Stock could not be loaded" onRetry={() => { void loadStock(); }} />
      ) : (
        <div className="space-y-4">
          {rows.length === 0 ? (
            <p className="text-sm text-secondary">
              {isActive
                ? 'No stock recorded for this product.'
                : 'Inventory does not list inactive products, so stock cannot be shown here.'}
            </p>
          ) : (
            <>
              <div className="space-y-3">
                {rows.map((row, index) => (
                  <div key={`${row.inventory_id ?? 'on-order'}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-100 pb-3 text-sm">
                    <span className="font-medium text-nav-dark">
                      <span>{row.location?.trim() || 'No location'}</span>
                    </span>
                    {row.inventory_id === null ? (
                      <>
                        <span className="text-secondary">No stock on hand.</span>
                        <span className="text-secondary">
                          On order: <span className="font-medium tabular-nums text-nav-dark">{row.quantity_on_order} {inventoryUnit(row)}</span>
                        </span>
                      </>
                    ) : (
                      <span className="text-secondary">
                        On hand: <span className="font-medium tabular-nums text-nav-dark">{row.quantity_available} {inventoryUnit(row)}</span>
                      </span>
                    )}
                    <span className="text-secondary">
                      Reorder point: <span className="font-medium tabular-nums text-nav-dark">{row.reorder_point === 0 ? 'Not set' : row.reorder_point}</span>
                    </span>
                    {row.is_low_stock && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                        Needs Reorder
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {total !== null && (
                <p className="text-sm font-semibold tabular-nums text-nav-dark">
                  Total on hand: {formatExactQuantity(total)} {inventoryUnit(rows[0])}
                </p>
              )}
            </>
          )}
          {asOf && (
            <p className="text-xs text-secondary">
              As of {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(asOf)}
            </p>
          )}
          {canOpenInventory && (
            <Link to={inventoryLink} className="inline-flex min-h-11 items-center text-sm font-medium text-crx-green underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crx-green">
              Open in Inventory
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}
