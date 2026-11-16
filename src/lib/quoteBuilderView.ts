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

/** `edited`: any other user-editable field (notes, rate, acres, override...) holds a value. */
export function lineNeedsRemoveConfirm(item: { product_id: string | null; units_needed: number | null; edited?: boolean }): boolean {
  return !!item.product_id || (item.units_needed ?? 0) > 0 || !!item.edited;
}

/** Toast copy after "Use today's prices". Totals are the page's own rounded totals; only formatted here. */
export function todaysPricesMessage(a: { changedCount: number; beforeTotal: number; afterTotal: number; tier: number }): { title: string; body: string } {
  const { changedCount: n, beforeTotal, afterTotal, tier } = a;
  if (n === 0) return { title: `Prices already match today's Tier ${tier} prices`, body: 'Nothing changed.' };
  return {
    title: `${n} ${n === 1 ? 'line now uses' : 'lines now use'} today's Tier ${tier} prices`,
    body: `Total went from ${formatUSD(beforeTotal)} to ${formatUSD(afterTotal)}. Save draft to keep it.`,
  };
}
