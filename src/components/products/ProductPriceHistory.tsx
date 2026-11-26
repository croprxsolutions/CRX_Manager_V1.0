import { useMemo, useState } from 'react';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import { LoadFailedState } from '../ui/EmptyState';
import Select from '../ui/Select';
import type { useLoad } from '../../hooks/useLoad';
import { costBasisSourceLabel, timeFraction } from '../../lib/sellPriceHistory';
import {
  formatSupplierCents,
  type SupplierPriceHistory,
  type SupplierPriceHistoryPoint,
} from '../../lib/supplierPricing';
import type {
  ProductCostBasisWorkspace,
  PurchaseCostBasisCandidate,
  SupplierCostBasisCandidate,
} from '../../lib/productCostBasis';

const streamLabels: Record<SupplierPriceHistoryPoint['stream'], string> = {
  supplier_observation: 'Supplier observation',
  selected_cost_basis: 'Selected cost basis',
  actual_purchase: 'Received PO cost',
};

const streamColors: Record<SupplierPriceHistoryPoint['stream'], string> = {
  supplier_observation: '#2563eb',
  selected_cost_basis: '#15803d',
  actual_purchase: '#c2410c',
};

// Date-only strings ('2026-07-20') and UTC-midnight timestamps (a Postgres date
// cast to timestamptz, e.g. effective_from in the supplier stream) represent a
// business DAY, not an instant. `new Date('2026-07-20')` parses as UTC midnight
// and toLocaleDateString() then shows the PREVIOUS day in US timezones. Render
// the calendar day the server stated instead.
function formatBusinessDate(value: string): string {
  const dayPart = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00:00(?:\.0+)?(?:\+00(?::00)?|Z)$)/.exec(value);
  if (dayPart) {
    return new Date(
      Number(dayPart[1]),
      Number(dayPart[2]) - 1,
      Number(dayPart[3]),
    ).toLocaleDateString();
  }
  return new Date(value).toLocaleDateString();
}

function chartPosition(
  value: bigint,
  minimum: bigint,
  maximum: bigint,
): number {
  if (maximum === minimum) return 50;
  return 90 - (Number(((value - minimum) * 800n) / (maximum - minimum)) / 10);
}

interface ProductPriceHistoryProps {
  productId: string;
  read: ReturnType<typeof useLoad<SupplierPriceHistory>>;
  costHistoryPriceSources?: ReadonlyMap<string, string>;
  costBasisWorkspace?: ProductCostBasisWorkspace | null;
  costBasisBusy?: boolean;
  onSelectSupplierBasis?: (candidate: SupplierCostBasisCandidate) => void;
  onSelectPurchaseBasis?: (candidate: PurchaseCostBasisCandidate) => void;
}

export default function ProductPriceHistory({
  productId,
  read,
  costHistoryPriceSources,
  costBasisWorkspace,
  costBasisBusy = false,
  onSelectSupplierBasis,
  onSelectPurchaseBasis,
}: ProductPriceHistoryProps) {
  const history = read.status === 'loaded' ? read.data : null;
  // Shown evidence that is being re-read, or whose last re-read failed, is not acted on.
  const outdated = read.status === 'loaded' && (read.refreshing || read.stale);
  const retry = () => { void read.reload(); };
  // The filter is kept across a refresh of the same product, but only while that supplier is still listed.
  const [filter, setFilter] = useState({ productId, supplierId: '' });
  const supplierId = filter.productId === productId
    && history?.suppliers.some((supplier) => supplier.id === filter.supplierId)
    ? filter.supplierId
    : '';
  // A dropped filter is forgotten, so it never comes back on its own if the supplier or product returns.
  if (filter.supplierId && supplierId !== filter.supplierId && (filter.productId !== productId || history)) {
    setFilter({ productId, supplierId: '' });
  }

  const points = useMemo(() => {
    const all = history?.points ?? [];
    if (!supplierId) return all;
    return all.filter((point) => (
      point.stream === 'selected_cost_basis' || point.vendor_id === supplierId
    ));
  }, [history, supplierId]);

  // One unit on one axis (audit 2026-11-24 #2): only costs per inventory unit are charted. A package
  // quote or PO cost the database could not convert stays in the list below, labelled as recorded.
  const plotted = useMemo(() => points.flatMap((point) => (
    point.normalized_cost_cents === null ? [] : [{ point, value: point.normalized_cost_cents }]
  )), [points]);
  const unchartedCount = points.length - plotted.length;
  const minimum = plotted.reduce<bigint | null>(
    (current, item) => current === null || item.value < current ? item.value : current,
    null,
  );
  const maximum = plotted.reduce<bigint | null>(
    (current, item) => current === null || item.value > current ? item.value : current,
    null,
  );
  // The date axis spans the earliest to the latest plotted point.
  const axis = useMemo(() => {
    const times = plotted.map(({ point }) => point.occurred_at).sort((a, b) => Date.parse(a) - Date.parse(b));
    return { start: times[0] ?? '', end: times[times.length - 1] ?? '' };
  }, [plotted]);
  const selectedBasis = [...(history?.points ?? [])]
    .reverse()
    .find((point) => point.stream === 'selected_cost_basis') ?? null;

  return (
    <Card>
      <CardHeader title="Supplier Price" accent="History" />
      <Select
        label="Filter supplier"
        value={supplierId}
        onChange={(event) => setFilter({ productId, supplierId: event.target.value })}
        placeholder="All suppliers"
        options={(history?.suppliers ?? []).map((supplier) => ({
          value: supplier.id,
          label: supplier.name,
        }))}
      />

      {read.status === 'loaded' && read.stale && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 text-sm text-amber-800">
          <span>Could not refresh. This evidence may be out of date, so Select as cost basis is off.</span>
          <Button size="sm" variant="secondary" onClick={retry} disabled={read.refreshing}>Try again</Button>
        </div>
      )}
      {read.status === 'loaded' && read.refreshing && (
        <p className="mt-4 text-sm text-secondary" role="status">Refreshing supplier and purchase evidence…</p>
      )}

      <div aria-busy={outdated} className={outdated ? 'opacity-60' : undefined}>
      {history && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-blue-700">Replacement cost</p>
            <p className="mt-1 font-semibold tabular-nums text-nav-dark">
              {formatSupplierCents(history.summary.replacement_cost_cents)}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {history.summary.best_supplier || 'No comparable supplier'}
              {history.summary.replacement_cost_as_of
                ? ` · ${formatBusinessDate(history.summary.replacement_cost_as_of)}`
                : ''}
            </p>
          </div>
          <div className="rounded-lg border border-green-100 bg-green-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-green-700">Selected cost basis</p>
            <p className="mt-1 font-semibold tabular-nums text-nav-dark">
              {formatSupplierCents(selectedBasis?.cost_cents ?? null)}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {selectedBasis ? formatBusinessDate(selectedBasis.occurred_at) : 'No history captured'}
            </p>
          </div>
          <div className="rounded-lg border border-orange-100 bg-orange-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-orange-700">Most recent received PO</p>
            <p className="mt-1 font-semibold tabular-nums text-nav-dark">
              {formatSupplierCents(history.summary.last_paid_cents)}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {history.summary.last_paid_as_of
                ? formatBusinessDate(history.summary.last_paid_as_of)
                : 'No received purchase'}
            </p>
          </div>
          <div className="rounded-lg border border-purple-100 bg-purple-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-purple-700">Recent-PO weighted average</p>
            <p className="mt-1 font-semibold tabular-nums text-nav-dark">
              {formatSupplierCents(history.summary.recent_po_weighted_average_cents)}
            </p>
            <p className="mt-1 text-xs text-secondary">Trailing 12 months · received quantities</p>
          </div>
        </div>
      )}

      {read.status === 'loading' && <p className="mt-4 text-sm text-secondary" role="status">Loading supplier and purchase evidence…</p>}
      {read.status === 'failed' && <LoadFailedState title="Supplier price history could not be loaded" onRetry={retry} />}
      {history && points.length === 0 && (
        <p className="mt-4 text-sm text-secondary">No supplier observations, selected cost basis, or purchase facts yet.</p>
      )}

      {history && points.length > 0 && (
        <>
          {plotted.length > 0 && minimum !== null && maximum !== null && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="mb-1 text-xs font-medium text-secondary">Cost per inventory unit</p>
            <svg
              role="img"
              aria-label="Product supplier price history chart"
              viewBox="0 0 100 100"
              className="h-40 w-full overflow-visible"
              preserveAspectRatio="none"
            >
              <line x1="5" x2="95" y1="90" y2="90" stroke="#d1d5db" strokeWidth="0.7" />
              <line x1="5" x2="5" y1="10" y2="90" stroke="#d1d5db" strokeWidth="0.7" />
              {plotted.map(({ point, value }) => {
                // Placed by date (To-Do 0.4), not evenly spaced: a gap in the chart is a gap in time.
                const x = 5 + timeFraction(point.occurred_at, axis.start, axis.end) * 90;
                const y = chartPosition(value, minimum, maximum);
                return (
                  <circle
                    key={`${point.stream}:${point.source_id}`}
                    cx={x}
                    cy={y}
                    r="2.2"
                    vectorEffect="non-scaling-stroke"
                    fill={streamColors[point.stream]}
                  >
                    <title>{`${streamLabels[point.stream]}: ${formatSupplierCents(value)} on ${formatBusinessDate(point.occurred_at)}`}</title>
                  </circle>
                );
              })}
            </svg>
            <div className="mt-1 flex justify-between text-xs text-secondary tabular-nums">
              <span>{formatBusinessDate(axis.start)}</span>
              <span>{formatBusinessDate(axis.end)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-secondary">
              {Object.entries(streamLabels).map(([stream, label]) => (
                <span key={stream} className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: streamColors[stream as keyof typeof streamColors] }} />
                  {label}
                </span>
              ))}
            </div>
          </div>
          )}
          {unchartedCount > 0 && (
            <p className="mt-2 text-xs text-secondary" role="note">
              {unchartedCount} cost{unchartedCount === 1 ? ' is' : 's are'} recorded in a unit that could not be converted to the inventory unit,
              so {unchartedCount === 1 ? 'it is' : 'they are'} listed below but not charted.
            </p>
          )}

          <div className="mt-4 max-h-96 space-y-3 overflow-y-auto">
            {[...points].reverse().map((point) => (
              <div key={`${point.stream}:${point.source_id}`} className="border-b border-gray-100 pb-3 last:border-0">
                <div className="flex items-start justify-between gap-3">
                  <span>
                    <Badge variant={point.stream === 'selected_cost_basis' ? 'success' : point.stream === 'actual_purchase' ? 'warning' : 'info'}>
                      {streamLabels[point.stream]}
                    </Badge>
                    <span className="ml-2 text-sm font-medium text-nav-dark">
                      {point.supplier_name || (point.stream === 'actual_purchase' ? 'supplier unknown' : 'CRX selected basis')}
                    </span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-nav-dark">
                    {formatSupplierCents(point.normalized_cost_cents ?? point.cost_cents)}
                    <span className="ml-1 text-xs font-normal text-secondary">
                      {point.normalized_cost_cents === null ? 'as recorded, not per inventory unit' : 'per inventory unit'}
                    </span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-secondary">
                  {formatBusinessDate(point.occurred_at)} · {costBasisSourceLabel(point.detail, point.provenance.pricing_change_set_id, costHistoryPriceSources)}
                  {point.normalized_cost_cents === null ? ' · not charted: cannot be converted to the inventory unit' : ''}
                </p>
                {point.stream === 'supplier_observation' && (() => {
                  const candidate = costBasisWorkspace?.supplier_candidates.find(
                    (item) => item.supplier_price_observation_id === point.source_id,
                  );
                  return candidate && onSelectSupplierBasis ? (
                    <Button
                      className="mt-2"
                      size="sm"
                      type="button"
                      disabled={!costBasisWorkspace?.enabled || costBasisBusy || outdated}
                      onClick={() => onSelectSupplierBasis(candidate)}
                    >
                      Select as cost basis
                    </Button>
                  ) : null;
                })()}
                {point.stream === 'actual_purchase' && (() => {
                  const candidate = costBasisWorkspace?.purchase_candidates.find(
                    (item) => item.purchase_order_item_id === point.source_id,
                  );
                  return candidate && onSelectPurchaseBasis ? (
                    <Button
                      className="mt-2"
                      size="sm"
                      type="button"
                      variant="secondary"
                      disabled={!costBasisWorkspace?.enabled || costBasisBusy || outdated}
                      onClick={() => onSelectPurchaseBasis(candidate)}
                    >
                      Select as cost basis
                    </Button>
                  ) : null;
                })()}
              </div>
            ))}
          </div>
        </>
      )}
      </div>
    </Card>
  );
}
