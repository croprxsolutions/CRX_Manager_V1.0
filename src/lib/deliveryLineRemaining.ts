/**
 * Figures for one line of the delivery page's Products table (F05).
 *
 * `orderDelivered` is the order line's delivered total now, which already includes this load once it is
 * completed. `otherOpen` is what the order's other scheduled or in-progress loads hold. "Remaining after"
 * follows the F05 rule (delivered + open loads <= ordered): what is still neither delivered nor on a load.
 */
export function deliveryLineFigures(input: {
  status: string;
  ordered: number;
  orderDelivered: number;
  otherOpen: number;
  scheduled: number;
  actual: number;
}): { prevDelivered: number; remainingAfter: number } {
  const { status, ordered, orderDelivered, otherOpen, scheduled, actual } = input;
  const countedDelivered = status === 'completed' ? actual : 0;
  const stillHeld = status === 'scheduled' || status === 'in_progress' ? scheduled : 0;
  return {
    prevDelivered: Math.max(0, orderDelivered - countedDelivered),
    remainingAfter: Math.max(0, ordered - orderDelivered - otherOpen - stillHeld),
  };
}
