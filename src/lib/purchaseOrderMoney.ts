import { isWholeCentDollarInput, parseDollarsToCents } from './parseCents';
import { isWholeCentPurchaseOrderCost, purchaseOrderUnitCostCents } from '../../supabase/functions/_shared/pdf/purchaseOrderMoney.ts';

// Moved to the Edge Functions' shared folder so send-email draws the same PDFs (KNOWN_ISSUES KI-98).
export * from '../../supabase/functions/_shared/pdf/purchaseOrderMoney.ts';

export function parsePurchaseOrderUnitCostDollars(text: string): number | null {
  if (!isWholeCentDollarInput(text)) return null;
  const dollars = Number(text);
  // The legacy dollar field and the cents field must represent the same typed amount.
  return isWholeCentPurchaseOrderCost(dollars) && purchaseOrderUnitCostCents(dollars) === parseDollarsToCents(text)
    ? dollars : null;
}
