
type LockInvoice = {
  invoice_number: string | null;
  status: string;
  invoice_type: string | null;
  invoice_group_id?: string | null;
  delivery_id?: string | null;
};
type LockDelivery = { id: string; delivery_number: string | null; status: string; deleted_at?: string | null };

export type BillSplitLock = { kind: 'posted' | 'delivery' | 'draft'; number: string | null };

/**
 * Why the Bill Split can't change, in the order `_refuse_bill_split_change` checks it.
 * `invoices` is the order page's list, which already leaves out voided, cancelled and deleted ones.
 * The database stays the authority: this only keeps the editors from offering a change it refuses.
 */
export function billSplitLock(invoices: LockInvoice[], deliveries: LockDelivery[]): BillSplitLock | null {
  const posted = invoices.find((i) => ['posted', 'paid', 'overdue'].includes(i.status));
  if (posted) return { kind: 'posted', number: posted.invoice_number };

  // A completed delivery freezes the split only once it's billed. One the split refused to bill
  // (a share too small, or a price-later sale) stays open so the office can fix the shares.
  const billed = deliveries.find((d) => d.status === 'completed' && !d.deleted_at
    && invoices.some((i) => i.delivery_id === d.id && i.invoice_type !== 'credit_memo'));
  if (billed) return { kind: 'delivery', number: billed.delivery_number };

  // A draft that bills the sale to one customer: no split group (e.g. Create Invoice). The database exempts any
  // invoice a split wrote (its provenance row), Bill Split or field split, and every such invoice has a group.
  const draft = invoices.find((i) => ['draft', 'unposted'].includes(i.status)
    && ['chemical_sale', 'misc_charge'].includes(i.invoice_type ?? '')
    && !i.invoice_group_id);
  if (draft) return { kind: 'draft', number: draft.invoice_number };

  return null;
}

/**
 * A card payer's live amount on the products so far: each line without its own split gives them
 * floor(line cents × percent), as the split writer does. Exact integer math (percent is numeric(9,6)).
 * Freight and other charges, and per-delivery rounding, can move the billed total by a few cents.
 */
export function cardPayerLiveCents(
  items: Array<{ id: string; total_price: number | null }>,
  linesWithOwnSplit: Set<string>,
  percent: number,
): number {
  const micro = BigInt(Math.round(percent * 1_000_000));
  let total = 0n;
  for (const it of items) {
    if (it.total_price == null || linesWithOwnSplit.has(it.id)) continue;
    // toPrecision first: 1.005 * 100 is 100.49999999999999 in floating point, and the database rounds it to 101.
    const cents = Math.round(Number((it.total_price * 100).toPrecision(12)));
    total += (BigInt(cents) * micro) / 100_000_000n;
  }
  return Number(total);
}

/**
 * Who may open the split editors. The delivery status doesn't close them: completing a delivery marks the sale
 * fulfilled or part-delivered, and a split the database refused to bill must stay fixable. billSplitLock decides.
 */
export function canEditBillSplit(role: string | null | undefined, orderStatus: string | null | undefined): boolean {
  return (role === 'admin' || role === 'sales_rep') && !!orderStatus && orderStatus !== 'cancelled';
}

/** True when shares total over 100%, added exactly (millionths, as numeric(9,6)) so 0.2 + 83.9 + 15.9 is 100. */
export function sharesOverHundred(percents: number[]): boolean {
  return percents.reduce((sum, p) => sum + Math.round(p * 1_000_000), 0) > 100_000_000;
}

/** What's left of 100% after these shares, exactly (millionths); 0 when they're full or over. */
export function sharesLeft(percents: number[]): number {
  const left = 100_000_000 - percents.reduce((sum, p) => sum + Math.round(p * 1_000_000), 0);
  return left > 0 ? left / 1_000_000 : 0;
}

/** The shares' total for display, added exactly (millionths). */
export function sharesTotal(percents: number[]): number {
  return percents.reduce((sum, p) => sum + Math.round(p * 1_000_000), 0) / 1_000_000;
}
