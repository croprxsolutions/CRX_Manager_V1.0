import { supabase } from './db';

/** The customer's assigned tier as stored now; Save re-reads it, since an admin may change it while a quote is open. */
export async function readAssignedTier(customerId: string): Promise<number> {
  const { data, error } = await supabase.from('customers').select('assigned_tier').eq('id', customerId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Customer not found');
  return data.assigned_tier;
}
