import type { QuoteStatus } from '../types';
import type { UnsentQuoteChange } from './quotePriceLock';
import { formatUSD } from './money';

/** The green button for the quote builder header (spec: "Actions by state"). */
export function primaryAction(s: {
  isNew: boolean;
  status: QuoteStatus;
  unsentChange: UnsentQuoteChange;
  canConvert: boolean;
  canDraw: boolean; // accepted for callers; no row of the spec table uses it
}): 'preview' | 'createOrder' | null {
  if (s.isNew) return 'preview';
  switch (s.status) {
    case 'draft':
      return 'preview';
    case 'sent':
      return 'createOrder';
    case 'revised':
      return s.unsentChange ? 'preview' : 'createOrder';
    case 'accepted':
      return s.canConvert ? 'createOrder' : null;
    default:
      return null;
  }
}

export function lineNeedsRemoveConfirm(item: { product_id: string | null; units_needed: number | null }): boolean {
  return !!item.product_id || (item.units_needed ?? 0) > 0;
}

type PricedLine = { price: number; total: number };

/** Toast copy after "Use today's prices". Lines are paired by index. */
export function todaysPricesMessage(before: PricedLine[], after: PricedLine[], tier: number): { title: string; body: string } {
  const changed = after.filter((l, i) => l.price !== before[i]?.price).length;
  if (changed === 0) return { title: `Prices already match today's Tier ${tier} prices`, body: 'Nothing changed.' };
  const sum = (ls: PricedLine[]) => ls.reduce((t, l) => t + l.total, 0);
  return {
    title: `${changed} ${changed === 1 ? 'line now uses' : 'lines now use'} today's Tier ${tier} prices`,
    body: `Total went from ${formatUSD(sum(before))} to ${formatUSD(sum(after))}. Save draft to keep it.`,
  };
}
