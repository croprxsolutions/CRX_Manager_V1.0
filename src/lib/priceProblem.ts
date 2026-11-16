import { MONEY_PRECISION_MESSAGE, parseDollarsToCentsSigned } from './parseCents';

export const NEGATIVE_PRICE_MESSAGE = 'Enter a price of $0.00 or more. Use a credit memo to give money back.';
export const NOT_A_PRICE_MESSAGE = 'Enter a price such as 25.50.';

/** What is wrong with a typed price, or null when it is a usable amount (blank counts as $0.00, as before). */
export function priceProblem(text: string): string | null {
  const t = text.trim();
  if (t.startsWith('-')) return NEGATIVE_PRICE_MESSAGE;
  if (t === '') return null;
  if (!/^\$?\d*\.?\d*$/.test(t) || !/\d/.test(t)) return NOT_A_PRICE_MESSAGE;
  return parseDollarsToCentsSigned(t) === null ? MONEY_PRECISION_MESSAGE : null;
}
