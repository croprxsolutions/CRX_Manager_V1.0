import { supabase } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';
import { BUSINESS_TIMEZONE } from './dateUtils';

type StatementSendRow = { id: string; customer_id: string | null; created_at: string | null };

/**
 * When each customer's statement was last emailed, read from the email log (only
 * sends that went out: status 'sent'). Keyed by customer id; a customer with no
 * sent statement on record is missing from the map. Throws when the read fails, so
 * the screen can say "could not load" instead of showing every customer as never emailed.
 */
export async function fetchLastStatementEmailedAt(): Promise<Map<string, string>> {
  const { data, error } = await fetchAllRows<StatementSendRow>((from, to) => pageWithList(supabase
    .from('email_log')
    .select('id, customer_id, created_at', { count: 'exact' })
    .eq('email_type', 'statement')
    .eq('status', 'sent')
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, to)));
  if (error || !data) throw new Error(error?.message ?? 'email_log returned no data');
  return latestSendByCustomer(data);
}

function latestSendByCustomer(rows: StatementSendRow[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (!row.customer_id || !row.created_at) continue;
    const seen = latest.get(row.customer_id);
    if (!seen || Date.parse(row.created_at) > Date.parse(seen)) latest.set(row.customer_id, row.created_at);
  }
  return latest;
}

/** "Nov 3, 2026" in the business's own time zone, so an evening send is not shown as the next day. */
export function formatStatementEmailedDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: BUSINESS_TIMEZONE,
  });
}
