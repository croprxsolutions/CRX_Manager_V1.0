import { assertRpcResult, supabase } from './db';
import { notifyCreditLimitExceeded } from './notificationTriggers';
import { Sentry } from './sentry';

interface CreditLimitCheck {
  exceeded?: boolean;
  farm_name?: string;
  outstanding_ar?: number;
  credit_limit?: number;
}

export async function warnIfOverCreditLimit(
  customerId: string | null | undefined,
  toast: (variant: 'warning', message: string) => void
): Promise<void> {
  if (!customerId) return;

  try {
    const { data: creditCheck, error } = await supabase.rpc('check_customer_credit_limit', {
      p_customer_id: customerId,
    });
    if (error) throw error;
    const cl = assertRpcResult<CreditLimitCheck | null>(creditCheck, 'check_customer_credit_limit');
    if (cl && cl.exceeded) {
      const fmtUsd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
      toast('warning', `Credit limit warning: ${cl.farm_name} outstanding AR ${fmtUsd(cl.outstanding_ar ?? 0)} exceeds limit ${fmtUsd(cl.credit_limit ?? 0)}`);
      notifyCreditLimitExceeded(cl.farm_name ?? 'Unknown', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, customerId);
    }
  } catch (err) {
    // Non-blocking — a failed check must never break the calling flow, but it must not
    // look like "under the limit" either.
    Sentry.captureException(err, { tags: { source: 'credit_limit', action: 'check_customer_credit_limit' } });
    toast('warning', "Couldn't check this customer's credit limit. Check their balance before going ahead.");
  }
}
