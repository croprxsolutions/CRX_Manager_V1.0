import { assertRpcResult, supabase } from './db';
import { formatCents } from './money';
import { fetchAllRows, pageWithList } from './pagedRead';
import { parseDollarsToCentsSigned } from './parseCents';
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
 * The customer's open balance in whole cents, as check_customer_credit_limit adds it up on the
 * server (posted, overdue and unposted invoices, not deleted, no negative balances). The server
 * reads every invoice: a sales rep's own read is limited to the invoices they created or sell,
 * so a customer billed by another rep looked under the limit. Null when the answer is not a
 * whole-cent amount.
 */
async function outstandingBalanceCents(customerId: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('check_customer_credit_limit', { p_customer_id: customerId });
  if (error) throw error;
  const result = assertRpcResult<{ outstanding_ar?: unknown }>(data, 'check_customer_credit_limit');
  // The server sends dollars (cents / 100.0); parse its decimal text into exact cents.
  if (typeof result.outstanding_ar !== 'number' || !Number.isFinite(result.outstanding_ar)) return null;
  const cents = parseDollarsToCentsSigned(String(result.outstanding_ar));
  return cents !== null && cents >= 0 ? cents : null;
}

/**
 * The customer's draft invoices in whole cents. check_customer_credit_limit leaves drafts out,
 * but the credit check has always counted them (Sol on #1132): a $9,000 draft plus a $2,000
 * order against a $10,000 limit must still warn. Read page by page as before; a failed page, or
 * one with no list, throws rather than reading as no drafts. Negative balances count as 0, as
 * on the server.
 */
async function draftBalanceCents(customerId: string): Promise<number> {
  const { data, error } = await fetchAllRows((from, to) => pageWithList(supabase
    .from('invoices')
    .select('id, balance_cents', { count: 'exact' })
    .eq('customer_id', customerId)
    .eq('status', 'draft')
    .is('deleted_at', null)
    .order('id')
    .range(from, to)));
  if (error) throw new Error(error.message);
  let total = 0;
  for (const row of data ?? []) {
    const cents = row.balance_cents ?? 0;
    if (!Number.isSafeInteger(cents)) throw new Error('A draft balance is not whole cents.');
    total += Math.max(cents, 0);
  }
  return total;
}

/**
 * Whether a new amount keeps the customer within their credit limit. Every read
 * that fails, or answers with no customer row or no usable balance, is `unverified` —
 * the old code read a failed customer read as "no limit set" and passed.
 */
export async function evaluateCreditLimit({ customerId, newAmountCents }: CreditLimitParams): Promise<CreditLimitResult> {
  // An amount that is not whole cents cannot be compared to the limit, so it is never a pass.
  if (!Number.isSafeInteger(newAmountCents)) return { status: 'unverified' };
  if (!customerId || newAmountCents <= 0) return { status: 'ok' };

  try {
    // The limit itself: every office user can read every customer.
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('farm_name, credit_limit_cents')
      .eq('id', customerId)
      .single();
    if (customerError) throw new Error(customerError.message);
    // No row is a failed read, not "no limit set".
    if (!customer) throw new Error('The customer read returned no row.');

    // No limit set: Customer Detail saves a blank limit as 0, so 0 means none too.
    if (customer.credit_limit_cents === null || customer.credit_limit_cents === 0) return { status: 'ok' };
    // Anything else must be whole cents; a limit that is not cannot be compared.
    if (!Number.isSafeInteger(customer.credit_limit_cents)) throw new Error('The credit limit is not whole cents.');

    const openBalance = await outstandingBalanceCents(customerId);
    if (openBalance === null) throw new Error('check_customer_credit_limit returned no usable balance.');
    const currentBalance = openBalance + await draftBalanceCents(customerId);

    const overBy = currentBalance + newAmountCents - customer.credit_limit_cents;
    if (overBy > 0) {
      return {
        status: 'over',
        message: `This will put ${customer.farm_name} ${formatCents(overBy)} over their ${formatCents(customer.credit_limit_cents)} credit limit.`,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    Sentry.captureException(error, { tags: { guardrail: 'credit_limit' } });
    return { status: 'unverified' };
  }
}
