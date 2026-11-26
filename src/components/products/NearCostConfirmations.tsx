import { AlertTriangle } from 'lucide-react';
import { formatExactCents } from '../../lib/money';
import type { NearCostProduct } from '../../lib/nearCostPricing';

function displayPercent(percent: number): string {
  return String(Number(percent.toFixed(2)));
}

/** "0.35" -> "35". Keep suggestions that would read as 100% off the screen. */
function wholePercent(text: string): string | null {
  const percent = Number((Number(text) * 100).toFixed(6));
  if (!Number.isFinite(percent) || percent >= 100) return null;
  const displayed = displayPercent(percent);
  return displayed === '100' ? null : displayed;
}

interface NearCostConfirmationsProps {
  products: NearCostProduct[];
  ticked: ReadonlySet<string>;
  disabled: boolean;
  onTickChange: (productId: string, ticked: boolean) => void;
}

/**
 * Audit 2026-11-24 #3: a price within 2% of cost or a margin under 1% is usually a margin typed as a fraction. Each such
 * product needs its own tick, naming every affected tier; a typed warning reason does not clear it.
 * A screen check only: the database records no near-cost acknowledgement.
 */
export default function NearCostConfirmations({ products, ticked, disabled, onTickChange }: NearCostConfirmationsProps) {
  if (products.length === 0) return null;
  return (
    <section aria-label="Prices close to cost" className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
        <div>
          <div className="text-sm font-semibold text-amber-900">
            {products.length} product{products.length === 1 ? ' has' : 's have'} a price within 2% of cost or a margin under 1%
          </div>
          <p className="mt-0.5 text-xs text-amber-900">
            This often means a margin was typed as a fraction (0.35 instead of 35). Tick each product to confirm the price is meant.
          </p>
        </div>
      </div>
      <ol className="mt-3 space-y-3">
        {products.map((product) => {
          const inputId = `pricing-near-cost-${product.product_id}`;
          return (
            <li key={product.product_id} className="rounded-lg border border-amber-200 bg-white p-3">
              <div id={`${inputId}-name`} className="text-sm font-semibold text-nav-dark">{product.product_name}</div>
              <ul id={`${inputId}-tiers`} className="mt-1 space-y-0.5 text-xs tabular-nums text-amber-900">
                {product.tiers.map((tier) => {
                  const suggestedPercent = tier.margin_driven && tier.fraction_margin_percent !== null
                    ? wholePercent(tier.fraction_margin_percent)
                    : null;
                  return (
                    <li key={tier.tier}>
                      Tier {tier.tier} {formatExactCents(tier.price_cents)} on a cost of {formatExactCents(tier.cost_cents)}
                      {tier.fraction_margin_percent !== null && (
                        <span className="font-semibold">
                          {` (margin ${displayPercent(Number(tier.fraction_margin_percent))}%`}
                          {suggestedPercent !== null && `: did you mean ${suggestedPercent} for ${suggestedPercent}%?`}
                          {')'}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <label htmlFor={inputId} className="mt-2 flex min-h-11 items-center gap-2 text-sm text-nav-dark">
                <input
                  id={inputId}
                  type="checkbox"
                  className="h-4 w-4"
                  aria-describedby={`${inputId}-name ${inputId}-tiers`}
                  checked={ticked.has(product.product_id)}
                  disabled={disabled}
                  onChange={(event) => onTickChange(product.product_id, event.target.checked)}
                />
                Yes, {product.tiers.length === 1 ? 'this price and margin are' : `all ${product.tiers.length} prices and margins above are`} what I meant
              </label>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
