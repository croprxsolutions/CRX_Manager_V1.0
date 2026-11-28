import { supabase } from './db';

export interface SplitVersionPayer {
  customer_id: string;
  customer_name: string;
  product_share_micro_pct: number;
  application_share_micro_pct: number;
}

export interface SplitVersion {
  id: string;
  version_number: number;
  effective_from: string;
  history_known: boolean;
  created_at: string;
  created_by_name: string | null;
  payers: SplitVersionPayer[];
}

export interface FieldSplitData {
  history: SplitVersion[];
  inForce: SplitVersion | null;
  notes: Record<string, string>;
}

/** Split history and payer notes from the FP-1 tables (office only by RLS). Throws when a read fails, because the
 * screen must not offer a split save over a split it could not read. */
export async function loadFieldSplit(fieldId: string, today: string): Promise<FieldSplitData> {
  const [versionsRes, notesRes] = await Promise.all([
    supabase
      .from('field_billing_split_versions')
      .select('id, version_number, effective_from, history_known, created_by, created_at, field_billing_split_payers(customer_id, product_share_micro_pct, application_share_micro_pct, customer:customers!field_billing_split_payers_customer_id_fkey(farm_name))')
      .eq('field_id', fieldId)
      .order('version_number', { ascending: false }),
    supabase.from('field_payer_notes').select('customer_id, notes').eq('field_id', fieldId),
  ]);
  if (versionsRes.error || !Array.isArray(versionsRes.data)) throw versionsRes.error ?? new Error('Split history read returned no list');
  if (notesRes.error || !Array.isArray(notesRes.data)) throw notesRes.error ?? new Error('Payer notes read returned no list');

  const creatorIds = [...new Set(versionsRes.data.map((v) => v.created_by).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (creatorIds.length > 0) {
    // Who saved it is a label only: an unreadable name shows as "Unknown" rather than blocking the screen.
    const { data } = await supabase.from('profile_public_directory').select('id, full_name').in('id', creatorIds);
    for (const p of data ?? []) if (p.id) names.set(p.id, p.full_name ?? 'Unknown');
  }

  const history: SplitVersion[] = versionsRes.data.map((v) => ({
    id: v.id,
    version_number: v.version_number,
    effective_from: v.effective_from,
    history_known: v.history_known,
    created_at: v.created_at,
    created_by_name: v.created_by ? names.get(v.created_by) ?? 'Unknown' : null,
    payers: (v.field_billing_split_payers ?? [])
      .map((p) => ({
        customer_id: p.customer_id,
        customer_name: p.customer?.farm_name || 'Unknown',
        product_share_micro_pct: p.product_share_micro_pct,
        application_share_micro_pct: p.application_share_micro_pct,
      }))
      .sort((a, b) => b.product_share_micro_pct - a.product_share_micro_pct || a.customer_name.localeCompare(b.customer_name)),
  }));
  // In force today: latest start on or before today, then the highest version number (same rule as field_split_as_of).
  const inForce = history
    .filter((v) => v.effective_from <= today)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.version_number - a.version_number)[0] ?? null;
  const notes: Record<string, string> = {};
  for (const n of notesRes.data) notes[n.customer_id] = n.notes ?? '';
  return { history, inForce, notes };
}
