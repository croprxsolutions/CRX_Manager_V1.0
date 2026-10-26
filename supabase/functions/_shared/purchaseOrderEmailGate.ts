// =============================================================================
// Purchase order -> vendor email gate (To-Do 0.15)
//
// Pure decision logic for send-email's 'purchase_order' type, kept free of
// Deno and Supabase imports so the app's Vitest suite tests it directly
// (src/lib/purchaseOrderEmailGate.test.ts). The edge function does the reads;
// this decides. A PO carries purchase costs, so the caller has already limited
// the type to admins.
// =============================================================================

export const PO_EMAILABLE_STATUSES = ["submitted", "partially_received"];

export interface PoGateOrder {
  id: string;
  vendor: string | null;
  status: string;
}

export interface PoGateLine {
  unit_cost: number | string | null;
  cost_needs_review: boolean | null;
}

export interface PoGateVendor {
  id: string;
  name: string;
  email: string | null;
}

export type PoGateResult =
  | { ok: true; vendorId: string }
  | { ok: false; status: number; error: string };

function normalize(text: string | null | undefined): string {
  return (text ?? "").trim().toLowerCase();
}

/**
 * Decides whether `requestedTo` may receive this purchase order. The recipient is
 * never trusted: it must equal the email on the one active vendor whose name
 * matches the PO's vendor (purchase_orders stores the vendor by name).
 * `activeVendors` must already exclude deleted vendors.
 */
export function decidePurchaseOrderEmail(
  order: PoGateOrder | null,
  lines: readonly PoGateLine[],
  activeVendors: readonly PoGateVendor[],
  requestedTo: string,
): PoGateResult {
  if (!order) return { ok: false, status: 404, error: "Purchase order not found" };
  if (!PO_EMAILABLE_STATUSES.includes(order.status)) {
    return {
      ok: false,
      status: 409,
      error: "Only a submitted or partly received purchase order can be emailed to the vendor",
    };
  }
  if (lines.length === 0) {
    return { ok: false, status: 409, error: "This purchase order has no lines to send" };
  }
  const unconfirmed = lines.some((line) => {
    const cost = Number(line.unit_cost);
    return line.cost_needs_review === true || !Number.isFinite(cost) || cost <= 0;
  });
  if (unconfirmed) {
    return {
      ok: false,
      status: 409,
      error: "Every line needs a confirmed unit cost before the purchase order is emailed",
    };
  }

  const vendorName = normalize(order.vendor);
  const matches = vendorName ? activeVendors.filter((v) => normalize(v.name) === vendorName) : [];
  if (matches.length === 0) {
    return { ok: false, status: 404, error: "This purchase order's vendor is not in the vendors list" };
  }
  if (matches.length > 1) {
    return { ok: false, status: 409, error: "More than one vendor has this purchase order's vendor name" };
  }
  const vendorEmail = normalize(matches[0].email);
  if (!vendorEmail) {
    return { ok: false, status: 400, error: "Vendor has no email on file" };
  }
  if (vendorEmail !== normalize(requestedTo)) {
    return { ok: false, status: 403, error: "Recipient does not match the vendor email on file" };
  }
  return { ok: true, vendorId: matches[0].id };
}
