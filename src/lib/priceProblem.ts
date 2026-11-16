import { parseDollarsToCentsSigned } from './parseCents';

// Short on purpose: they sit on the one fixed helper line under a price box (DESIGN.md, Inputs).
export const TOO_MANY_DECIMALS_MESSAGE = '2 decimals max';
export const NEGATIVE_PRICE_MESSAGE = "Can't be negative";
export const NOT_A_PRICE_MESSAGE = 'Numbers only';

/** What is wrong with a typed price, or null when it is a usable amount (blank counts as $0.00, as before). */
export function priceProblem(text: string): string | null {
  const t = text.trim();
  if (t.startsWith('-')) return NEGATIVE_PRICE_MESSAGE;
  if (t === '') return null;
  if (!/^\$?\d*\.?\d*$/.test(t) || !/\d/.test(t)) return NOT_A_PRICE_MESSAGE;
  return parseDollarsToCentsSigned(t) === null ? TOO_MANY_DECIMALS_MESSAGE : null;
}
