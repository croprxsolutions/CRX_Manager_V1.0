import { assertRpcResult, supabase } from './db';

export interface CallListBaseRow {
  customer_id: string;
  farm_name: string | null;
  assigned_sales_rep: string | null;
  primary_contact_name: string | null;
  phone_display: string | null;
  phone_e164: string | null;
  last_interaction_at: string | null;
}

export interface StaleQuoteRow extends CallListBaseRow {
  quote_id: string;
  quote_number: string;
  quote_total_cents: number;
  quote_updated_at: string;
  quote_age_days: number;
}

export interface CallListPayload<Row> {
  success: boolean;
  rows: Row[];
  total_count?: number;
}

export interface CallListPage<Row> {
  rows: Row[];
  total: number;
}

export const DEFAULT_STALE_QUOTE_DAYS = 14;

export function rowsOf<Row>(payload: CallListPayload<Row>, rpcName: string): CallListPage<Row> {
  if (!Array.isArray(payload.rows)) throw new Error(`${rpcName} returned an invalid row list`);
  const count = payload.total_count;
  return {
    rows: payload.rows,
    total: typeof count === 'number' && Number.isFinite(count) && count >= payload.rows.length ? count : payload.rows.length,
  };
}

export async function getCallListStaleQuotes(days: number, repId: string | null): Promise<CallListPage<StaleQuoteRow>> {
  const { data, error } = await supabase.rpc('get_call_list_stale_quotes', {
    p_days: days,
    ...(repId ? { p_rep_id: repId } : {}),
  });
  if (error) throw error;
  return rowsOf(assertRpcResult<CallListPayload<StaleQuoteRow>>(data, 'get_call_list_stale_quotes'), 'get_call_list_stale_quotes');
}
