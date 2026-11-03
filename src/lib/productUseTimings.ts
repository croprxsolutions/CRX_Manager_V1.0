import type { UseTimingOption } from '../types';
import { supabase } from './db';
import { Sentry } from './sentry';

export async function listProductUseTimingOptions(): Promise<UseTimingOption[]> {
  const { data, error } = await supabase
    .from('product_use_timing_options')
    .select('code, label, timing_code, crop, category, sort_order, is_active')
    .order('sort_order')
    .order('code');
  if (error) {
    const failure = new Error(error.message);
    Sentry.captureException(failure, { tags: { source: 'fetch', action: 'load_use_timing_options' } });
    throw failure;
  }
  return (data ?? []).map((option) => ({
    ...option, category: option.category as UseTimingOption['category'],
  }));
}

export function visibleProductUseTimingOptions(
  options: readonly UseTimingOption[], category: string | null | undefined, selected: readonly string[],
): UseTimingOption[] {
  return options.filter((option) => option.category === category && (option.is_active || selected.includes(option.code)));
}
