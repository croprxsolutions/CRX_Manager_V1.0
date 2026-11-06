/** What a delivery's completion result says about its Bill Split. */
export function billSplitCompletion(result: unknown): { failed: boolean; numbers: string[] } {
  const r = result as { bill_split_failed?: boolean; bill_split_invoices?: Array<{ invoice_number?: string | null }> | null } | null;
  return {
    failed: r?.bill_split_failed === true,
    numbers: (r?.bill_split_invoices ?? []).map((i) => i.invoice_number).filter((n): n is string => !!n),
  };
}
