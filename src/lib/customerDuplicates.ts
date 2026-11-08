import { supabase } from './db';
import { ilikeOrPattern, excludedIdList } from './recordSearch';

/** Words too common in farm names to say two customers are the same. */
const FILLER_WORDS = new Set(['farm', 'farms', 'inc', 'llc', 'ltd', 'co', 'corp', 'company', 'the', 'and', 'of', 'partnership', 'lp', 'llp']);

function normalizeFarmName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !FILLER_WORDS.has(w))
    .join(' ');
}

function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '').slice(-10);
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

async function readCandidates(filters: string[], excludeId: string | undefined, limit: number) {
  if (filters.length === 0) return [];
  let query = supabase.from('customers').select(CANDIDATE_COLUMNS).or(filters.join(','));
  if (excludeId) query = query.not('id', 'in', excludedIdList([excludeId]));
  const { data, error } = await query.order('farm_name').order('id').limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * Likely existing duplicates of a customer about to be created or renamed, active or not.
 * The database narrows by name-word prefix, phone digits or email; `duplicateReasons` decides.
 * Phone and email are read on their own so a common name word cannot crowd them out.
 * shortcut: reads at most 200 name candidates and misses a typo in a word's first 4 letters; upgrade to a trigram RPC if that bites.
 */
export async function findLikelyDuplicateCustomers(
  input: CustomerDuplicateInput,
  excludeId?: string,
): Promise<CustomerDuplicateMatch[]> {
  // The first 4 letters of each word, so a typo later in a one-word name ("Hendriks") still finds "Hendricks".
  const nameFilters = [...new Set(normalizeFarmName(input.farm_name).split(' ').filter(Boolean).map((w) => w.slice(0, 4)))]
    .slice(0, 4)
    .map((w) => `farm_name.ilike.${ilikeOrPattern(w)}`);
  const contactFilters: string[] = [];
  const phone = phoneDigits(input.phone);
  // Digits in order with anything between, so "(555) 123-4567" and "555.123.4567" both match.
  if (phone.length >= 7) contactFilters.push(`phone.ilike."%${phone.slice(-7).split('').join('%')}%"`);
  const email = (input.email ?? '').trim();
  if (email) contactFilters.push(`email.ilike.${ilikeOrPattern(email)}`);

  const [byName, byContact] = await Promise.all([
    readCandidates(nameFilters, excludeId, 200),
    readCandidates(contactFilters, excludeId, 50),
  ]);
  const seen = new Set<string>();
  return [...byContact, ...byName]
    .filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)))
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
