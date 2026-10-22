// How much of one order line a customer may still return, mirroring the server's split-payer rule
// (migration 20261021155000, _return_customer_line_share). The server stays authoritative; this only
// sets the form's maximum so a refused return is the exception.
//
// Share mode applies when the returning customer is not the order's customer (a field owner billed
// through a split) or another customer was billed for the line. Then the customer may return only
// what its own posted invoices billed for the line, less its own open returns. Otherwise the old rule
// applies: what was delivered, less every open return of the line.

export interface BilledLine {
  order_item_id: string | null;
  quantity: number;
  customer_id: string;
  /** Set on split invoices; a customer other than the order's is billed only through these. */
  invoice_group_id: string | null;
}

export interface OpenReturnLine {
  order_item_id: string | null;
  quantity: number;
  customer_id: string;
}

// Quantities carry up to four decimals; round away binary noise from the subtraction.
const roundQty = (n: number) => Math.round(n * 10000) / 10000;

export function returnableQuantity(args: {
  orderItemId: string;
  delivered: number;
  orderCustomerId: string | null;
  customerId: string;
  billed: BilledLine[];
  openReturns: OpenReturnLine[];
}): number {
  const { orderItemId, delivered, orderCustomerId, customerId, billed, openReturns } = args;
  const lineReturns = openReturns.filter((r) => r.order_item_id === orderItemId);
  const deliveredLeft = roundQty(Number(delivered) - lineReturns.reduce((s, r) => s + Number(r.quantity), 0));
  const lineBilled = billed.filter((b) => b.order_item_id === orderItemId);
  const isOrderCustomer = customerId === orderCustomerId;
  const shareMode = !isOrderCustomer || lineBilled.some((b) => b.customer_id !== customerId);
  if (!shareMode) return Math.max(0, deliveredLeft);

  const own = lineBilled
    .filter((b) => b.customer_id === customerId && (isOrderCustomer || b.invoice_group_id !== null))
    .reduce((s, b) => s + Number(b.quantity), 0);
  const ownOpen = lineReturns
    .filter((r) => r.customer_id === customerId)
    .reduce((s, r) => s + Number(r.quantity), 0);
  return Math.max(0, Math.min(deliveredLeft, roundQty(own - ownOpen)));
}
