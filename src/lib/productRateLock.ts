import { assertRpcResult, supabase } from './db';
import { BUSINESS_TIMEZONE } from './dateUtils';
import type { ProductRateLock, ProductRatePerAcre, ProductRatePreview, ProductRateWriteResult } from '../types';
import type { Json } from '../types/supabase';

/** The one "Lock rates" record (20261106120000). Every signed-in staff member may read it. */
export async function loadProductRateLock(): Promise<ProductRateLock> {
  const { data, error } = await supabase
    .from('product_rate_lock')
    .select('is_locked, changed_by_name, changed_at, reason')
    .single();
  if (error) throw error;
  return data;
}

export async function setProductRateLock(input: {
  locked: boolean;
  reason: string;
  performedBy: string;
  idempotencyKey: string;
}): Promise<ProductRateLock> {
  const { data, error } = await supabase.rpc('set_product_rate_lock', {
    p_locked: input.locked,
    p_reason: input.reason,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<ProductRateLock>(data, 'set_product_rate_lock');
}

/** The per-acre prices a correction would save; read-only, admin only. */
export async function previewProductRateCorrection(input: {
  productId: string;
  ratePerAcre: number | null;
  rateUnit: string;
}): Promise<ProductRatePreview> {
  const { data, error } = await supabase.rpc('preview_product_rate_correction', {
    p_product_id: input.productId,
    p_rate_per_acre: input.ratePerAcre as number, // NULL clears the rate; generated Args omit null
    p_rate_unit: input.rateUnit,
  });
  if (error) throw error;
  return assertRpcResult<ProductRatePreview>(data, 'preview_product_rate_correction');
}

/** One product's rates while locked: admin only, with a reason and the version the admin saw. */
export async function correctProductRates(input: {
  productId: string;
  ratePerAcre: number | null;
  rateUnit: string;
  suggestedRate: string;
  expectedPricingVersion: number;
  expectedPrices: ProductRatePerAcre;
  reason: string;
  performedBy: string;
  idempotencyKey: string;
}): Promise<ProductRateWriteResult> {
  const { data, error } = await supabase.rpc('correct_product_rates', {
    p_product_id: input.productId,
    p_rate_per_acre: input.ratePerAcre as number, // NULL clears the rate; generated Args omit null
    p_rate_unit: input.rateUnit,
    p_suggested_rate: input.suggestedRate,
    p_expected_pricing_version: input.expectedPricingVersion,
    p_expected_prices: input.expectedPrices as unknown as Json,
    p_reason: input.reason,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<ProductRateWriteResult>(data, 'correct_product_rates');
}

/** Who switched the rate lock, when and why, in one line. */
export function rateLockSummary(lock: ProductRateLock): string {
  if (!lock.changed_by_name) return lock.is_locked ? 'Rates are locked.' : 'Rates are not locked.';
  const when = new Date(lock.changed_at).toLocaleString('en-US', { timeZone: BUSINESS_TIMEZONE });
  return `${lock.is_locked ? 'Locked' : 'Unlocked'} by ${lock.changed_by_name} on ${when}${lock.reason ? `: ${lock.reason}` : ''}`;
}

export const PRODUCT_RATE_KEYS = ['rate_per_acre', 'rate_unit', 'suggested_rate'] as const;
