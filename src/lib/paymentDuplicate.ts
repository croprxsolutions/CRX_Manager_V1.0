/**
 * Warn before one check is recorded twice. allocate_payment's retry key only
 * covers one open page: a second person, or a reload after a lost reply, gets a
 * new key. This is a warning, not a refusal, because two real checks can match.
 *
 * shortcut: two people saving the same check in the same moment both pass,
 * move this into allocate_payment if that ever happens.
 */
import { supabase } from './db';
import { formatCents } from './money';
import { fetchAllRows, pageWithList, PAGE_RETURNED_NO_LIST } from './pagedRead';
import type { DuplicatePayment } from '../types';

// The form stays locked during the check, so a stall must end as a failed check.
const DUPLICATE_CHECK_TIMEOUT_MS = 15_000;

export const DUPLICATE_CHECK_FAILED_MESSAGE =
  'This attempt was not saved. Could not check whether this payment is already recorded. Try again';

// The retry key is kept on this refusal, so resending the first attempt's exact details redeems its
// receipt (see useIdempotencyKey). Reloading the page starts a new key.
export const PAYMENT_RETRY_REFUSED_MESSAGE =
  'This attempt was not saved, but an earlier attempt at this payment may have saved. Check Payment History, or ask an admin to. '
  + 'If the payment is there, do not enter it again. If it is not, enter it again. Either way, reload this page first';

/** "#1234", "1234" and " 1234 " are one check. */
function normalizeReference(reference: string | null | undefined): string {
  return (reference ?? '').normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/** The newest active payment with this customer, amount and reference, or null. A blank reference matches nothing. */
export async function findDuplicatePayment(
  customerId: string,
  totalCents: number,
  reference: string,
): Promise<DuplicatePayment | null> {
  const wanted = normalizeReference(reference);
  if (!wanted) return null;

  const timeLimit = AbortSignal.timeout(DUPLICATE_CHECK_TIMEOUT_MS);
  // The abort stops the read itself. The race also ends a stall in the sign-in step before it.
  const stalled = new Promise<never>((_, reject) => {
    timeLimit.addEventListener('abort', () => reject(timeLimit.reason), { once: true });
  });
  const read = fetchAllRows<DuplicatePayment>((from, to) => pageWithList(supabase
    .from('allocation_sets')
    .select('id, reference_number, check_number, payment_date', { count: 'exact' })
    .eq('customer_id', customerId)
    .eq('total_payment_cents', totalCents)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, to)
    .abortSignal(timeLimit)));
  const { data, error } = await Promise.race([read, stalled]);
  if (error || !data) throw new Error(error?.message ?? PAGE_RETURNED_NO_LIST);

  return data.find((payment) =>
    normalizeReference(payment.reference_number) === wanted
    || normalizeReference(payment.check_number) === wanted) ?? null;
}

export function duplicatePaymentMessage(match: DuplicatePayment, totalCents: number): string {
  const reference = match.reference_number || match.check_number;
  const recorded = match.payment_date
    ? ` recorded ${new Date(`${match.payment_date}T00:00:00`).toLocaleDateString()}`
    : '';
  return `This customer already has a ${formatCents(totalCents)} payment with reference ${reference}${recorded}. `
    + 'Check Payment History first, or ask an admin to. Record it again only if this is a different check.';
}
