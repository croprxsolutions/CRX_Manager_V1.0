/**
 * A return holds 2 decimal places (return_items.quantity), and create_return refuses a finer one
 * (RETURN_QUANTITY_TOO_FINE). A Bill Split payer's share can have 4 (0.7083), so offer it rounded down.
 */
export function returnableHundredths(qty: number): number {
  return Math.floor(Math.round(qty * 10000) / 100) / 100;
}
