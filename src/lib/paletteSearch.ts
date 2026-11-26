import { supabase } from './db';
import { ilikeOrPattern } from './recordSearch';
import { searchByNumberOrCustomerName } from './customerNameSearch';

// The quick search (Ctrl+K) reads quotes itself: global_search has no quote results. The columns
// are a fixed list without cost (quotes is a cost table), read the same way the Quotes list reads
// them, so the database's own access rules decide which quotes come back.
const QUOTE_SEARCH_SELECT = 'id, quote_number, status, created_at, customer:customers(farm_name)';
const QUOTE_SEARCH_BY_CUSTOMER_SELECT = 'id, quote_number, status, created_at, customer:customers!inner(farm_name)';

export interface PaletteQuoteResult {
  id: string;
  quote_number: string;
  status: string;
  customer?: { farm_name?: string | null } | null;
}

/** Up to `limit` quotes, newest first, whose number or customer's farm name matches `query`. */
export async function searchQuotesForPalette(query: string, limit: number): Promise<PaletteQuoteResult[]> {
  const pattern = ilikeOrPattern(query);
  const { data, error } = await searchByNumberOrCustomerName((match) => (match === 'number'
    ? supabase.from('quotes').select(QUOTE_SEARCH_SELECT).or(`quote_number.ilike.${pattern}`)
    : supabase.from('quotes').select(QUOTE_SEARCH_BY_CUSTOMER_SELECT).or(`farm_name.ilike.${pattern}`, { referencedTable: 'customer' }))
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .order('id')
    .limit(limit), 'created_at', limit);
  if (error) throw error;
  return (data ?? []) as PaletteQuoteResult[];
}

/** Each product's tier 1 (list) price by id, for the products a search found. */
export async function fetchProductListPrices(productIds: readonly string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (productIds.length === 0) return prices;
  const { data, error } = await supabase.from('products').select('id, tier1_price').in('id', [...productIds]);
  if (error) throw error;
  for (const row of data ?? []) {
    if (row.tier1_price != null) prices.set(row.id, Number(row.tier1_price));
  }
  return prices;
}
