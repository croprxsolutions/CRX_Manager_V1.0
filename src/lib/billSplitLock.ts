
type LockInvoice = {
  invoice_number: string | null;
  status: string;
  invoice_type: string | null;
  invoice_group_id?: string | null;
  delivery_id?: string | null;
  deleted_at?: string | null;
};
type LockDelivery = { id: string; delivery_number: string | null; status: string; deleted_at?: string | null };

export type BillSplitLock = { kind: 'posted' | 'delivery' | 'draft'; number: string | null };

/**
 * Why the Bill Split can't change, in the order `_refuse_bill_split_change` checks it.
 * `invoices` is the order page's list, which leaves out voided and cancelled ones but not deleted ones.
 * The database stays the authority: this only keeps the editors from offering a change it refuses.
 */
export function billSplitLock(allInvoices: LockInvoice[], deliveries: LockDelivery[]): BillSplitLock | null {
  const invoices = allInvoices.filter((i) => !i.deleted_at);
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

/**
 * Every card payer's live amount on the products, as _bill_split_line_shares bills each line without its own
 * split: other payers get floor(cents x percent); the taker (the main customer, else the largest share, then
 * the lowest id) gets the rest, including any share left off the card.
 */
export function cardLiveCents(
  items: Array<{ id: string; total_price: number | null }>,
  linesWithOwnSplit: Set<string>,
  card: Array<{ customer_id: string; pct: number }>,
  mainCustomerId: string,
): Map<string, number> {
  const micro = new Map<string, bigint>();
  for (const s of card) micro.set(s.customer_id, (micro.get(s.customer_id) ?? 0n) + BigInt(Math.round(s.pct * 1_000_000)));
  const named = [...micro.values()].reduce((a, b) => a + b, 0n);
  micro.set(mainCustomerId, (micro.get(mainCustomerId) ?? 0n) + (100_000_000n - named));
  const payers = [...micro.entries()].filter(([, m]) => m > 0n)
    .sort(([a, ma], [b, mb]) => (Number(b === mainCustomerId) - Number(a === mainCustomerId)) || (mb > ma ? 1 : mb < ma ? -1 : 0) || (a < b ? -1 : 1));
  const out = new Map<string, number>();
  for (const it of items) {
    if (it.total_price == null || linesWithOwnSplit.has(it.id)) continue;
    // ponytail: 15 significant digits, the most a double keeps, so cents are exact on lines up to about $1 trillion.
    const cents = BigInt(Math.round(Number((it.total_price * 100).toPrecision(15))));
    let rest = cents;
    for (const [id, m] of payers.slice(1)) {
      const c = (cents * m) / 100_000_000n;
      rest -= c;
      out.set(id, (out.get(id) ?? 0) + Number(c));
    }
    if (payers.length) out.set(payers[0][0], (out.get(payers[0][0]) ?? 0) + Number(rest));
  }
  return out;
}
