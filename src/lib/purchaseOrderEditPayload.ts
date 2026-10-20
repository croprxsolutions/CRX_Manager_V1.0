import {
  purchaseOrderCentsToDollars,
  purchaseOrderUnitCostCents,
} from './purchaseOrderMoney';

export interface PurchaseOrderEditableLine {
  id: string;
  product_id: string;
  product_name: string;
  unit_size: string;
  quantity_ordered: string;
  unit_cost: string;
  quantity_received: number;
}

/**
 * `includeCost: false` (a non-admin; purchase cost is admin-only, Mason 2026-10-18) sends no
 * cost at all: save_purchase_order keeps each existing line's stored cost and starts a new line
 * at 0 until an admin fills it in.
 */
export function buildPurchaseOrderEditItemsPayload(
  items: PurchaseOrderEditableLine[],
  { includeCost }: { includeCost: boolean },
) {
  return items.map((item) => {
    const quantityOrdered = Number.parseFloat(item.quantity_ordered);
    if (!Number.isFinite(quantityOrdered)) {
      throw new Error(`Invalid quantity ordered for purchase order line ${item.id}`);
    }
    const line = {
      id: item.id,
      product_id: item.product_id,
      product_name: item.product_name,
      unit_size: item.unit_size || null,
      quantity_ordered: quantityOrdered,
      quantity_received: item.quantity_received || 0,
    };
    if (!includeCost) return line;
    const unitCostCents = purchaseOrderUnitCostCents(parseFloat(item.unit_cost));
    return {
      ...line,
      unit_cost: purchaseOrderCentsToDollars(unitCostCents),
      unit_cost_cents: unitCostCents,
    };
  });
}
