import { assertRpcResult, supabaseUntyped } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';

// REG-1 switch-on (20261231220000_epa_registration_seed, 20261231210000_rup_records_by_line). Admin only;
// these RPCs are not in the generated types yet.

/** Mason's Q1 answer (2026-11-06): a number no row ticks restricted-use becomes "No". */
const SEED_RUP_DEFAULT = 'no';

export type SeedFactValue = string | number | { max_label_rate: number; max_label_rate_unit: string };

export interface SeedRegistration {
  epa_registration: string;
  number_valid: boolean;
  carried: boolean;
  facts: Record<string, unknown>;
  /** Column → the different values the carriers hold; one must be picked. */
  disagreements: Record<string, SeedFactValue[]>;
}

export interface SeedPreview {
  rup_default: string;
  registrations: SeedRegistration[];
  fingerprint: string;
  registration_count: number;
  disagreement_count: number;
  invalid_numbers: string[];
}

export interface SeedResult {
  registrations: number;
  lines_captured: number;
  rup_default: string;
  fingerprint: string;
}

/** Picks sent to the seed: { "<number>": { "<column>": <one candidate> } }. */
export type SeedPicks = Record<string, Record<string, SeedFactValue>>;

export async function previewEpaRegistrationSeed(): Promise<SeedPreview> {
  const { data, error } = await supabaseUntyped.rpc('preview_epa_registration_seed', { p_rup_default: SEED_RUP_DEFAULT });
  if (error) throw error;
  return assertRpcResult<SeedPreview>(data, 'preview_epa_registration_seed');
}

export async function seedEpaRegistrations(picks: SeedPicks, fingerprint: string, key: string): Promise<SeedResult> {
  const { data, error } = await supabaseUntyped.rpc('seed_epa_registrations', {
    p_picks: picks, p_rup_default: SEED_RUP_DEFAULT, p_expected_fingerprint: fingerprint, p_idempotency_key: key,
  });
  if (error) throw error;
  return assertRpcResult<SeedResult>(data, 'seed_epa_registrations');
}

/** An invoice line the seed captures (every line with a product, any status). */
export interface SeedLine {
  id: string;
  epa_registration: string | null;
  invoices: { invoice_number: string | null; status: string } | null;
  products: { product_name: string; epa_registration: string | null; is_rup: boolean | null } | null;
}

export async function listSeedLines(): Promise<SeedLine[]> {
  // The untyped client infers embedded rows as arrays; these are many-to-one, so each is one row or null.
  const { data, error } = await fetchAllRows((from, to) => pageWithList(supabaseUntyped
    .from('invoice_items')
    .select('id, epa_registration, invoices(invoice_number, status), products(product_name, epa_registration, is_rup)', { count: 'exact' })
    .not('product_id', 'is', null)
    .order('id')
    .range(from, to)));
  if (error) throw error;
  return (data ?? []) as unknown as SeedLine[];
}

export interface SaleToCheck {
  line_id: string;
  invoice_id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  product_name: string;
  epa_registration: string | null;
  saved_number: string | null;
  quantity: number;
  captured_rup_status: string | null;
  reason: 'not_captured' | 'restricted_use_to_record' | 'no_epa_number' | 'now_restricted_use' | 'not_reviewed'
    | 'brand_no_epa_number' | 'brand_split_mismatch' | 'overlapping_invoices' | 'payer_split_changed'
    | 'billed_above_delivered' | 'brand_lines_stale' | 'brand_not_recorded';
  /** Brand PR B-1b: set on a row about one brand of a line; null on a row about the whole line. */
  brand_key: string | null;
  brand_name: string | null;
  /** The brand's share of the line's quantity; null on a whole-line row. */
  allocated_quantity: number | null;
}

export async function getEpaSalesToCheck(): Promise<SaleToCheck[]> {
  const { data, error } = await supabaseUntyped.rpc('get_epa_sales_to_check');
  if (error) throw error;
  return assertRpcResult<SaleToCheck[]>(data, 'get_epa_sales_to_check');
}

/** Every disagreement has exactly one picked candidate. */
export function allPicked(preview: SeedPreview, picks: SeedPicks): boolean {
  return preview.registrations.every((r) =>
    Object.keys(r.disagreements).every((col) => picks[r.epa_registration]?.[col] !== undefined));
}

/** Plain-English text for one fact value from the preview. */
export function factText(value: unknown): string {
  if (value && typeof value === 'object' && 'max_label_rate' in value) {
    const v = value as { max_label_rate: number; max_label_rate_unit: string };
    return `${v.max_label_rate} ${v.max_label_rate_unit}`;
  }
  return String(value);
}

export const FACT_LABELS: Record<string, string> = {
  signal_word: 'Signal word', rei_hours: 'Re-entry (hours)', phi_days: 'Pre-harvest (days)', max_label_rate: 'Label max rate',
};
