import type { CropOption, UseTimingOption } from '../types';
import { assertRpcResult, supabaseUntyped } from './db';
import { Sentry } from './sentry';

// supabase.ts predates USE-1 (#1710: option_version, product_crop_options and the two RPCs), so these reads go untyped.
export async function listProductUseTimingOptions(): Promise<UseTimingOption[]> {
  const { data, error } = await supabaseUntyped
    .from('product_use_timing_options')
    .select('code, label, timing_code, crop, category, sort_order, is_active, option_version')
    .order('sort_order')
    .order('code');
  if (error) {
    const failure = new Error(error.message);
    Sentry.captureException(failure, { tags: { source: 'fetch', action: 'load_use_timing_options' } });
    throw failure;
  }
  return (data ?? []) as UseTimingOption[];
}

export async function listProductCropOptions(): Promise<CropOption[]> {
  const { data, error } = await supabaseUntyped
    .from('product_crop_options')
    .select('code, label, sort_order, is_active')
    .order('sort_order')
    .order('code');
  if (error) {
    const failure = new Error(error.message);
    Sentry.captureException(failure, { tags: { source: 'fetch', action: 'load_crop_options' } });
    throw failure;
  }
  return (data ?? []) as CropOption[];
}

export async function addUseTimingOption(input: {
  category: UseTimingOption['category']; timingCode: string; crop: string | null; label: string; key: string;
}): Promise<UseTimingOption> {
  const { data, error } = await supabaseUntyped.rpc('add_use_timing_option', {
    p_category: input.category, p_timing_code: input.timingCode, p_crop: input.crop, p_label: input.label,
    p_idempotency_key: input.key,
  });
  if (error) throw error;
  return assertRpcResult<UseTimingOption>(data, 'add_use_timing_option');
}

export async function setUseTimingOptionActive(input: {
  code: string; isActive: boolean; expectedVersion: number; key: string;
}): Promise<UseTimingOption & { sizes_holding: number; parents_holding: number }> {
  const { data, error } = await supabaseUntyped.rpc('set_use_timing_option_active', {
    p_code: input.code, p_is_active: input.isActive, p_expected_option_version: input.expectedVersion,
    p_idempotency_key: input.key,
  });
  if (error) throw error;
  return assertRpcResult(data, 'set_use_timing_option_active');
}

/** Same (category, timing, crop): one crop + timing, whatever its label. */
export const samePair = (a: UseTimingOption, b: UseTimingOption) =>
  a.category === b.category && a.timing_code === b.timing_code && (a.crop ?? null) === (b.crop ?? null);

/**
 * The picker's choices for a category: every active option, plus a turned-off one only while it is ticked or saved on
 * the product (`held`) (Mason, 2026-11-09: the database no longer refuses a turned-off option, so hiding it here is the
 * only guard). An active option whose pair is ticked through a turned-off one is left out; that one offers
 * "Switch to" instead, so the same crop + timing is never offered twice.
 */
export function visibleProductUseTimingOptions(
  options: readonly UseTimingOption[], category: string | null | undefined, selected: readonly string[],
  held: readonly string[] = selected,
): UseTimingOption[] {
  const tickedRetired = options.filter((option) => !option.is_active && selected.includes(option.code));
  return options.filter((option) => option.category === category && (option.is_active
    ? selected.includes(option.code) || !tickedRetired.some((retired) => samePair(retired, option))
    : selected.includes(option.code) || held.includes(option.code)));
}

/** The active option a turned-off one can be switched to (same crop + timing), if any. */
export const replacementFor = (options: readonly UseTimingOption[], retired: UseTimingOption) =>
  retired.is_active ? undefined : options.find((option) => option.is_active && samePair(option, retired));

/** Options grouped under their crop: "Any crop" first, then the crop list's order. */
export function groupUseTimingOptionsByCrop(
  options: readonly UseTimingOption[], crops: readonly CropOption[],
): Array<{ crop: string | null; label: string; options: UseTimingOption[] }> {
  const groups = new Map<string | null, UseTimingOption[]>();
  for (const option of options) groups.set(option.crop ?? null, [...(groups.get(option.crop ?? null) ?? []), option]);
  const rank = (crop: string | null) => (crop === null ? -1 : crops.find((c) => c.code === crop)?.sort_order ?? Number.MAX_SAFE_INTEGER);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || String(a).localeCompare(String(b)))
    .map(([crop, grouped]) => ({ crop, label: crop === null ? 'Any crop' : crops.find((c) => c.code === crop)?.label ?? crop, options: grouped }));
}
