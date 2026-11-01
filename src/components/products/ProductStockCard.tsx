import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import { assertRpcResult, supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { validateInventoryPositionShape } from '../../lib/inventoryPositionValidator';
import type { InventoryPositionRow } from '../../types';

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const exponent = Number(exponentText);
  const fractionalDigits = mantissa.split('.')[1]?.length ?? 0;
  const scale = Math.max(0, fractionalDigits - exponent);
  return { coefficient: BigInt(mantissa.replace('.', '')), scale };
}

function sumExactQuantities(values: number[]): string {
  const parts = values.map(decimalParts);
  const scale = parts.reduce((largest, part) => Math.max(largest, part.scale), 0);
  const total = parts.reduce(
    (sum, part) => sum + part.coefficient * (10n ** BigInt(scale - part.scale)),
    0n,
  );
  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const divisor = 10n ** BigInt(scale);
  const whole = (absolute / divisor).toString();
  const fraction = scale > 0
    ? (absolute % divisor).toString().padStart(scale, '0').replace(/0+$/, '')
    : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

interface ProductStockCardProps {
  productId: string;
}

export default function ProductStockCard({ productId }: ProductStockCardProps) {
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
      const productRows = positions.filter(
        (row) => row.product_id === productId && row.inventory_id !== null,
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

  return (
    <Card>
      <CardHeader title="Stock" accent="& Reorder" />
      {loadState === 'loading' ? (
        <p className="text-sm text-secondary" role="status">Loading stock…</p>
      ) : loadState === 'failed' ? (
        <div className="space-y-3" role="alert">
          <p className="text-sm text-red-700">Stock could not be loaded</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => { void loadStock(); }}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {rows.length === 0 ? (
            <p className="text-sm text-secondary">No stock recorded for this product.</p>
          ) : (
            <>
              <div className="space-y-3">
                {rows.map((row) => (
                  <div key={row.inventory_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-100 pb-3 text-sm">
                    <span className="font-medium text-nav-dark">
                      <span>{row.location?.trim() || 'Unassigned'}</span>
                    </span>
                    <span className="text-secondary">
                      On hand: <span className="font-medium tabular-nums text-nav-dark">{row.quantity_available} {row.inventory_unit || '—'}</span>
                    </span>
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
              {rows.length >= 2 && (
                <p className="text-sm font-semibold tabular-nums text-nav-dark">
                  Total on hand: {sumExactQuantities(rows.map((row) => row.quantity_available))} {rows[0].inventory_unit || '—'}
                </p>
              )}
            </>
          )}
          {asOf && (
            <p className="text-xs text-secondary">
              As of {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(asOf)}
            </p>
          )}
          <Link to={inventoryLink} className="inline-flex min-h-11 items-center text-sm font-medium text-crx-green underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crx-green">
            Open in Inventory
          </Link>
        </div>
      )}
    </Card>
  );
}
