import type { UseTimingOption } from '../types';
import { supabase } from './db';

export async function listProductUseTimingOptions(): Promise<UseTimingOption[]> {
  const { data, error } = await supabase
    .from('product_use_timing_options')
    .select('code, label, timing_code, crop, category, sort_order, is_active')
    .order('sort_order')
    .order('code');
  if (error) throw error;
  return data ?? [];
}

export function visibleProductUseTimingOptions(
  options: readonly UseTimingOption[], category: string | null | undefined, selected: readonly string[],
): UseTimingOption[] {
  return options.filter((option) => option.category === category && (option.is_active || selected.includes(option.code)));
}
