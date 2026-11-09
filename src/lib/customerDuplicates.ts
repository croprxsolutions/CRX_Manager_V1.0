import { supabase } from './db';
import { fetchAllRows } from './pagedRead';

/** Words too common in farm names to say two customers are the same. */
const FILLER_WORDS = new Set(['farm', 'farms', 'inc', 'llc', 'ltd', 'co', 'corp', 'company', 'the', 'and', 'of', 'partnership', 'lp', 'llp']);

function normalizeFarmName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // "José" and "Jose" are the same name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !FILLER_WORDS.has(w))
    .join(' ');
}

function phoneDigits(phone: string | null | undefined): string {
  // An extension ("ext. 89", "x89") is not part of the number.
  return (phone ?? '').replace(/\s*(?:ext\.?|x)\s*\d+\s*$/i, '').replace(/\D/g, '').slice(-10);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Same core name, one name's words wholly inside the other's, or a typo or two apart. */
export function namesLookAlike(a: string, b: string): boolean {
  const na = normalizeFarmName(a);
  const nb = normalizeFarmName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (` ${nb} `.includes(` ${na} `) || ` ${na} `.includes(` ${nb} `)) return true;
  return Math.min(na.length, nb.length) >= 5 && editDistance(na, nb) <= 2;
}

export interface CustomerDuplicateInput {
  farm_name: string;
  phone?: string | null;
  email?: string | null;
}

export interface CustomerDuplicateMatch {
  id: string;
  farm_name: string;
  city: string | null;
  state: string | null;
  is_active: boolean;
  reasons: string[];
}

function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (da.length < 7 || db.length < 7) return false;
  // A 7-digit local number matches the same number stored with its area code.
  return da.length >= db.length ? da.endsWith(db) : db.endsWith(da);
}

/** Reasons `candidate` looks like the same customer as `input`; empty when it does not. */
export function duplicateReasons(input: CustomerDuplicateInput, candidate: CustomerDuplicateInput): string[] {
  const reasons: string[] = [];
  if (namesLookAlike(input.farm_name, candidate.farm_name)) reasons.push('similar name');
  if (phonesMatch(input.phone, candidate.phone)) reasons.push('same phone');
  const email = (input.email ?? '').trim().toLowerCase();
  if (email && email === (candidate.email ?? '').trim().toLowerCase()) reasons.push('same email');
  return reasons;
}

const CANDIDATE_COLUMNS = 'id, farm_name, phone, email, city, state, is_active';

/**
 * Likely existing duplicates of a customer about to be created or renamed, active or not.
 * Every customer is read and compared here, so a typo anywhere in a name, an accent, or a
 * common name word cannot hide one (KI-77; about 150 customers in November 2026).
 * shortcut: reads the whole customer list per check; move matching into a trigram RPC if customers pass ~5,000.
 */
export async function findLikelyDuplicateCustomers(
  input: CustomerDuplicateInput,
  excludeId?: string,
): Promise<CustomerDuplicateMatch[]> {
  if (!normalizeFarmName(input.farm_name) && phoneDigits(input.phone).length < 7 && !(input.email ?? '').trim()) return [];
  const { data, error } = await fetchAllRows<CustomerDuplicateInput & Omit<CustomerDuplicateMatch, 'reasons'>>((from, to) => supabase
    .from('customers')
    .select(CANDIDATE_COLUMNS, { count: 'exact' })
    .order('farm_name')
    .order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((row) => row.id !== excludeId)
    .map((row) => ({
      id: row.id,
      farm_name: row.farm_name,
      city: row.city,
      state: row.state,
      is_active: row.is_active,
      reasons: duplicateReasons(input, row),
    }))
    .filter((m) => m.reasons.length > 0);
}
