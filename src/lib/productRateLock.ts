import { supabase } from './db';
import type { ProductRateLock } from '../types';

/** The one "Lock rates" record (20261107060000). Every signed-in staff member may read it. */
export async function loadProductRateLock(): Promise<ProductRateLock> {
  const { data, error } = await supabase
    .from('product_rate_lock')
    .select('is_locked, changed_by_name, changed_at, reason')
    .single();
  if (error) throw error;
  return data;
}

export const PRODUCT_RATE_KEYS = ['rate_per_acre', 'rate_unit', 'suggested_rate'] as const;
