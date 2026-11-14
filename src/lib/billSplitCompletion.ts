import { BILL_SPLIT_FAILED_MESSAGE } from './deliverySplitBilling';

/** What a delivery's completion result says about its Bill Split. */
export function billSplitCompletion(result: unknown): { failed: boolean; numbers: string[] } {
  const r = result as { bill_split_failed?: boolean; bill_split_invoices?: Array<{ invoice_number?: string | null }> | null } | null;
  return {
    failed: r?.bill_split_failed === true,
    numbers: (r?.bill_split_invoices ?? []).map((i) => i.invoice_number).filter((n): n is string => !!n),
  };
}

/** Only an admin can run Create Invoice on a delivery, so only an admin gets the fix steps. */
export function billSplitFailedMessage(role: string | null | undefined): string {
  return role === 'admin'
    ? BILL_SPLIT_FAILED_MESSAGE
    : "Delivery completed, but its Bill Split invoices couldn't be drafted. Admins have been told and will draft them.";
}

/** Create Invoice on a Bill Split delivery drafts one invoice per payer (`invoice_numbers`). */
export function createdInvoicesMessage(result: { invoice_number: string; invoice_numbers?: string[] | null }): string {
  const numbers = result.invoice_numbers ?? [];
  return numbers.length > 1 ? `Draft invoices ${numbers.join(', ')} created` : `Invoice ${result.invoice_number} created`;
}
