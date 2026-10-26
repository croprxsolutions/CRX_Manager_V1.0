import { supabase } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';
import { Sentry } from './sentry';

export interface CreditLimitParams {
  customerId: string;
  newAmountCents: number;
}

export type CreditLimitResult =
  | { status: 'ok' }
  | { status: 'over'; message: string }
  /** A read failed: the limit is unknown, never a pass. */
  | { status: 'unverified' };

export const CREDIT_LIMIT_UNVERIFIED_MESSAGE =
  'Could not verify credit limit. Please refresh and try again before completing this transaction.';

/**
 * Whether a new amount keeps the customer within their credit limit. Every read
 * that fails, or answers with no customer row or no list, is `unverified` —
 * the old code read a failed customer read as "no limit set" and passed.
 */
export async function evaluateCreditLimit({ customerId, newAmountCents }: CreditLimitParams): Promise<CreditLimitResult> {
  if (!customerId || newAmountCents <= 0) return { status: 'ok' };

  try {
    // Get customer credit limit
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('farm_name, credit_limit_cents')
      .eq('id', customerId)
      .single();
    if (customerError) throw new Error(customerError.message);
    // No row is a failed read, not "no limit set".
    if (!customer) throw new Error('The customer read returned no row.');

    if (!customer.credit_limit_cents) return { status: 'ok' }; // No limit set

    // Get current unpaid invoice balance
    // Every open invoice, page by page: one request stopped at the server's
    // row cap and understated the balance (Goal 4 L17). A failed read, or a
    // page with no list, is unverified instead of reading as a zero balance.
    const { data: invoices, error: invoicesError } = await fetchAllRows((from, to) => pageWithList(supabase
      .from('invoices')
      .select('id, balance_cents', { count: 'exact' })
      .eq('customer_id', customerId)
      .in('status', ['draft', 'unposted', 'posted', 'overdue'])
      .order('id')
      .range(from, to)));
    if (invoicesError || !invoices) throw new Error(invoicesError?.message ?? 'The invoices read returned no list.');

    const currentBalance = invoices.reduce(
      (sum, inv) => sum + (inv.balance_cents || 0),
      0
    );

    const projectedTotal = currentBalance + newAmountCents;
    const overBy = projectedTotal - customer.credit_limit_cents;

    if (overBy > 0) {
      return {
        status: 'over',
        message: `This will put ${customer.farm_name} $${(overBy / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} over their $${(customer.credit_limit_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} credit limit.`,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    Sentry.captureException(error, { tags: { guardrail: 'credit_limit' } });
    return { status: 'unverified' };
  }
}
