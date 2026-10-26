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
  id: string;
  quantity_ordered: number | string;
  unit_cost: number | string | null;
  cost_needs_review: boolean | null;
}

/** One line as the attached PDF printed it, sent by the app alongside the PDF. */
export interface PoGateSnapshotLine {
  id: string;
  quantity_ordered: number;
  unit_cost: number;
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
  return (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The snapshot the app sent, or null when it is missing or malformed. */
export function parsePurchaseOrderSnapshot(value: unknown): PoGateSnapshotLine[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const lines: PoGateSnapshotLine[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { id, quantity_ordered, unit_cost } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof quantity_ordered !== "number" || typeof unit_cost !== "number") return null;
    if (!Number.isFinite(quantity_ordered) || !Number.isFinite(unit_cost)) return null;
    lines.push({ id, quantity_ordered, unit_cost });
  }
  return lines;
}

/** True when the PDF's lines are exactly the PO's lines today (same ids, quantities and costs). */
function snapshotMatches(lines: readonly PoGateLine[], snapshot: readonly PoGateSnapshotLine[]): boolean {
  if (lines.length !== snapshot.length) return false;
  const byId = new Map(snapshot.map((line) => [line.id, line]));
  if (byId.size !== snapshot.length) return false;
  return lines.every((line) => {
    const printed = byId.get(line.id);
    return printed !== undefined &&
      Number(line.quantity_ordered) === printed.quantity_ordered &&
      Number(line.unit_cost) === printed.unit_cost;
  });
}

/**
 * Decides whether `requestedTo` may receive this purchase order. The recipient is
 * never trusted: it must equal the email on the one active vendor whose name
 * matches the PO's vendor (purchase_orders stores the vendor by name). The
 * attached PDF is built by the app, so the app also sends the lines it printed and
 * the send is refused unless they are the PO's lines today: a vendor never gets a
 * PDF with yesterday's price. `activeVendors` must already exclude deleted vendors.
 */
export function decidePurchaseOrderEmail(
  order: PoGateOrder | null,
  lines: readonly PoGateLine[],
  activeVendors: readonly PoGateVendor[],
  requestedTo: string,
  snapshot: readonly PoGateSnapshotLine[],
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
  if (!snapshotMatches(lines, snapshot)) {
    return {
      ok: false,
      status: 409,
      error: "The purchase order changed after its PDF was built. Reload it and send again",
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
