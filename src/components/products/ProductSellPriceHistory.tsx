import { useMemo } from 'react';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import { LoadFailedState } from '../ui/EmptyState';
import { useLoad } from '../../hooks/useLoad';
import { formatCents } from '../../lib/money';
import {
  sourceLabel,
  TIERS,
  fetchSellPriceHistory,
  sellPricePoints,
  timeFraction,
  type TierKey,
} from '../../lib/sellPriceHistory';

const TIER_LABELS: Record<TierKey, string> = { tier1: 'Tier 1', tier2: 'Tier 2', tier3: 'Tier 3' };
const TIER_COLORS: Record<TierKey, string> = { tier1: '#15803d', tier2: '#2563eb', tier3: '#c2410c' };

// Chart box, in the SVG's 0..100 units: the plot sits inside these edges.
const LEFT = 5;
const RIGHT = 95;
const TOP = 10;
const BOTTOM = 90;

function formatDay(at: string): string {
  // Central time, the business's day, whatever the viewer's browser is set to.
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
}

// Width of the "before" band, in chart units: the prices before the first change, which have no date.
const BEFORE_BAND = 8;

/**
 * Sell-price history (To-Do 0.4): each tier price over time on a real date axis, and every change
 * with its date, source and reason. Admin-only (Mason, 2026-10-14); the page renders it for admins
 * only and cost_history is admin-only in the database.
 */
export default function ProductSellPriceHistory({ productId, reloadToken = 0 }: { productId: string; reloadToken?: number }) {
  const history = useLoad(`sell-price-history:${productId}`, async () => ({
    points: sellPricePoints(await fetchSellPriceHistory(productId)),
    // When this read answered: it ends the time axis (the last price is drawn as still in effect on
    // that day). It belongs to the read, so a failed refresh never stretches an old answer to today.
    loadedAt: new Date().toISOString(),
  }), {
    refreshToken: reloadToken,
    report: { extra: { context: 'sell_price_history' } },
  });
  const retry = () => { void history.reload(); };
  const data = history.status === 'loaded' ? history.data : null;
  const outdated = history.status === 'loaded' && (history.refreshing || history.stale);

  const chart = useMemo(() => {
    if (!data || data.points.length === 0) return null;
    const { points } = data;
    // A product with older history starts at its first change, whose old prices were in effect
    // before it on no recorded date: they get a "before" band at the left edge.
    const before = points[0].isStartingPoint ? null : points[0].previousCents;
    const hasBefore = before !== null && TIERS.some((t) => before[t] !== null);
    const values = [
      ...points.flatMap((p) => TIERS.map((t) => p.cents[t])),
      ...(hasBefore ? TIERS.map((t) => before[t]) : []),
    ].filter((c): c is number => c !== null);
    if (values.length === 0) return null;
    const plotLeft = hasBefore ? LEFT + BEFORE_BAND : LEFT;
    const start = points[0].at;
    // The axis runs to the day it loaded, so the last price is drawn as still in effect.
    const last = points[points.length - 1].at;
    const end = Date.parse(data.loadedAt) > Date.parse(last) ? data.loadedAt : last;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const x = (at: string) => plotLeft + timeFraction(at, start, end) * (RIGHT - plotLeft);
    const y = (cents: number) => (max === min ? 50 : BOTTOM - ((cents - min) / (max - min)) * (BOTTOM - TOP));
    // A step line per tier: flat until the next change, then a jump.
    const paths = TIERS.map((tier) => {
      const segments: string[] = [];
      let pen: { x: number; y: number } | null = null;
      const startCents = hasBefore ? before[tier] : null;
      if (startCents !== null) {
        pen = { x: LEFT, y: y(startCents) };
        segments.push(`M ${LEFT} ${pen.y}`);
      }
      for (const point of points) {
        const cents = point.cents[tier];
        const px = x(point.at);
        if (pen) segments.push(`L ${px} ${pen.y}`);
        if (cents === null) { pen = null; continue; }
        const py = y(cents);
        segments.push(`${pen ? 'L' : 'M'} ${px} ${py}`);
        pen = { x: px, y: py };
      }
      if (pen) segments.push(`L ${RIGHT} ${pen.y}`);
      return { tier, d: segments.join(' ') };
    });
    return { paths, start, end, min, max, x, y, hasBefore };
  }, [data]);

  return (
    <Card>
      <CardHeader title="Sell Price" accent="History" />
      {history.status === 'loading' && <p className="text-sm text-secondary" role="status">Loading sell price history…</p>}
      {history.status === 'failed' && <LoadFailedState title="Sell price history could not be loaded" onRetry={retry} />}
      {history.status === 'loaded' && history.stale && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-sm text-amber-800">
          <span>Could not refresh. This history may be out of date.</span>
          <Button size="sm" variant="secondary" onClick={retry} disabled={history.refreshing}>Try again</Button>
        </div>
      )}
      {history.status === 'loaded' && history.refreshing && (
        <p className="mb-3 text-sm text-secondary" role="status">Refreshing sell price history…</p>
      )}
      <div aria-busy={outdated} className={outdated ? 'opacity-60' : undefined}>
      {data && data.points.length === 0 && (
        <p className="text-sm text-secondary">No price changes recorded since this product was created.</p>
      )}
      {data && chart && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <svg
            role="img"
            aria-label={`Sell prices by tier from ${formatDay(chart.start)} to ${formatDay(chart.end)}`}
            viewBox="0 0 100 100"
            className="h-40 w-full overflow-visible"
            preserveAspectRatio="none"
          >
            <line x1={LEFT} x2={RIGHT} y1={BOTTOM} y2={BOTTOM} stroke="#d1d5db" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
            <line x1={LEFT} x2={LEFT} y1={TOP} y2={BOTTOM} stroke="#d1d5db" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
            {chart.paths.map(({ tier, d }) => (
              d ? <path key={tier} d={d} fill="none" stroke={TIER_COLORS[tier]} strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null
            ))}
            {data.points.map((point) => TIERS.map((tier) => {
              const cents = point.cents[tier];
              if (cents === null) return null;
              return (
                <circle key={`${point.id}:${tier}`} cx={chart.x(point.at)} cy={chart.y(cents)} r="1.6" fill={TIER_COLORS[tier]}>
                  <title>{`${TIER_LABELS[tier]}: ${formatCents(cents)} from ${formatDay(point.at)}`}</title>
                </circle>
              );
            }))}
          </svg>
          <div className="mt-1 flex justify-between text-xs text-secondary tabular-nums">
            <span>{chart.hasBefore ? `Before, then ${formatDay(chart.start)}` : formatDay(chart.start)}</span>
            <span>Price range {formatCents(chart.min)} – {formatCents(chart.max)}</span>
            <span>{formatDay(chart.end)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-secondary">
            {TIERS.map((tier) => (
              <span key={tier} className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TIER_COLORS[tier] }} />
                {TIER_LABELS[tier]}
              </span>
            ))}
          </div>
        </div>
      )}
      {data && data.points.length > 0 && (
        // Scrollable, so it takes keyboard focus (and says what it is) for keyboard scrolling.
        <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto" tabIndex={0} aria-label="Sell price changes, newest first">
          {[...data.points].reverse().map((point) => (
            <li key={point.id} className="border-b border-gray-100 pb-3 last:border-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-nav-dark">{formatDay(point.at)}</span>
                <span className="text-xs text-secondary">{sourceLabel(point.source)}</span>
              </div>
              <dl className="mt-1 grid grid-cols-3 gap-2 text-sm tabular-nums">
                {TIERS.map((tier) => {
                  const before = point.previousCents[tier];
                  const after = point.cents[tier];
                  const moved = !point.isStartingPoint && before !== after;
                  return (
                    <div key={tier}>
                      <dt className="text-xs text-secondary">{TIER_LABELS[tier]}</dt>
                      <dd>
                        {moved && (
                          <span className="mr-1 text-red-700 line-through">
                            <span className="sr-only">was </span>{before === null ? '—' : formatCents(before)}
                          </span>
                        )}
                        <span className={moved ? 'font-medium text-green-700' : 'text-nav-dark'}>
                          {moved && <span className="sr-only">now </span>}{after === null ? '—' : formatCents(after)}
                        </span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {point.reason && <p className="mt-1 text-xs text-secondary">{point.reason}</p>}
            </li>
          ))}
        </ul>
      )}
      </div>
    </Card>
  );
}
