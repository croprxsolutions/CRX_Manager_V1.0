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

/** The Save message for the first line whose price box holds a typed price that can't be saved, or null. */
export function linePriceProblem(lines: Array<{ price_draft?: string | null; product_id: string | null; product_name: string; description: string }>): string | null {
  for (const line of lines) {
    const problem = line.price_draft == null ? null : priceProblem(line.price_draft);
    // A charge line's product_name is a load-time copy, so it is named by its (editable) description.
    if (problem) return `Price for ${(line.product_id ? line.product_name : line.description) || 'a line'}: ${problem}`;
  }
  return null;
}
