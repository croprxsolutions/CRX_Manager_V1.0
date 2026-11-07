import { assertRpcResult, supabase } from './db';
import { fetchAllRows, PAGE_RETURNED_NO_LIST } from './pagedRead';
import type { Order } from '../types';
import type { Json } from '../types/supabase';
import type { SortDir } from './tableSearchSort';

/** One Orders list row as get_orders_keyset_page returns it (migrations 20261116120000, 20261125100000). */
export interface OrderListRow extends Order {
  fulfillment_pct: number;
  invoiced_pct: number;
  farm_group_name: string | null;
  customer_name: string;
  active_delivery_count: number;
  earliest_delivery_date: string | null;
  product_names: string;
}

/** What the Orders screen asks for: the season, its filters, the search box and the column sort. */
export interface OrdersQuery {
  p_from: string;
  p_to: string;
  p_search: string | null;
  p_status: string | null;
  p_planned: boolean | null;
  p_pricing_status: string | null;
  p_needs_split_billing: boolean | null;
  p_sort_key: string | null;
  p_sort_dir: SortDir;
}

/** The screen's filter boxes ('' = no filter) as the database arguments (null = no filter). */
export function buildOrdersQuery(
  season: { start: string; end: string },
  f: { search: string; status: string; plan: string; pricing: string; split: string; sortKey: string | null; sortDir: SortDir },
): OrdersQuery {
  return {
    p_from: season.start,
    p_to: season.end,
    p_search: f.search || null,
    p_status: f.status || null,
    p_planned: f.plan === 'planned' ? true : f.plan === 'committed' ? false : null,
    p_pricing_status: f.pricing || null,
    p_needs_split_billing: f.split ? true : null,
    p_sort_key: f.sortKey,
    p_sort_dir: f.sortDir,
  };
}

export interface OrdersPage {
  rows: OrderListRow[];
  /** Every matching order, not just this page. */
  total_count: number;
  /** The matching orders' totals, each rounded to whole cents, summed. */
  total_price_cents: number;
  /** The bookmark after this page's last row, to read the next page from; null on the last page. */
  next_cursor: Json | null;
}

/** The bookmark no longer fits the query (the sort changed) or is malformed: read again from page one. */
export function isBookmarkRefused(message: string | undefined): boolean {
  return /ORDERS_PAGE_(STALE|BAD)_CURSOR/.test(message ?? '');
}

type PageRead = { data: OrdersPage | null; error: { message: string } | null };

/**
 * One page of the Orders list. The database applies the search, filters and sort and counts every match
 * in the same statement. Anything but a whole answer is an error: a screen must never show a missing
 * list as "no orders" or a missing total as $0.
 *
 * With `after` (the previous page's next_cursor) the page starts right after that row, so orders that
 * left the list in between never push one past the screen (offset must then be 0).
 */
export async function fetchOrdersPage(query: OrdersQuery, limit: number, offset: number, after: Json | null = null): Promise<PageRead> {
  // "No filter" is sent as an omitted argument, which the function reads as NULL (never '' or false).
  const { data, error } = await supabase.rpc('get_orders_keyset_page', {
    p_from: query.p_from,
    p_to: query.p_to,
    p_search: query.p_search ?? undefined,
    p_status: query.p_status ?? undefined,
    p_planned: query.p_planned ?? undefined,
    p_pricing_status: query.p_pricing_status ?? undefined,
    p_needs_split_billing: query.p_needs_split_billing ?? undefined,
    p_sort_key: query.p_sort_key ?? undefined,
    p_sort_dir: query.p_sort_dir,
    p_limit: limit,
    p_offset: offset,
    p_after: after ?? undefined,
  });
  if (error) return { data: null, error };
  let page: OrdersPage;
  try {
    page = assertRpcResult<OrdersPage>(data, 'get_orders_keyset_page');
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : PAGE_RETURNED_NO_LIST } };
  }
  if (!Array.isArray(page.rows) || typeof page.total_count !== 'number' || typeof page.total_price_cents !== 'number'
    || (page.next_cursor !== null && (typeof page.next_cursor !== 'object' || Array.isArray(page.next_cursor)))) {
    return { data: null, error: { message: PAGE_RETURNED_NO_LIST } };
  }
  return { data: page, error: null };
}

/**
 * Every order matching the query, for "select all" (export, print, delete). Reads pages of 1000 with
 * fetchAllRows, which checks the rows against the database's count and re-reads until two whole reads
 * agree, so a list that changes mid-read is reported rather than returned short or doubled.
 */
export function fetchAllMatchingOrders(query: OrdersQuery) {
  return fetchAllRows<OrderListRow>(async (from, to) => {
    const { data, error } = await fetchOrdersPage(query, to - from + 1, from);
    if (error || !data) return { data: null, error: error ?? { message: PAGE_RETURNED_NO_LIST }, count: null };
    return { data: data.rows, error: null, count: data.total_count };
  });
}
