import { assertRpcResult, supabase, supabaseUntyped } from './db';
import type { BrandDocumentKind, BrandDocumentLink } from '../types';

export const BRAND_DOCUMENT_TITLES: Record<BrandDocumentKind, string> = {
  specimen: 'Specimen label',
  sds: 'SDS',
  supplemental: 'Supplemental / 24(c)',
};

export interface BrandDocumentTarget {
  id: string;
  parent_brand: boolean;
  brand_version: number;
}

export interface BrandDocumentWorkspaceRow extends BrandDocumentTarget {
  brand_name: string;
  product_id: string;
  owner_name: string;
  links: BrandDocumentLink[];
}

interface SaveBrandDocument {
  action: 'save';
  kind: BrandDocumentKind;
  url: string;
  state?: string;
  expires_on?: string;
  id?: string;
  version?: number;
}

export type BrandDocumentChange = SaveBrandDocument | {
  action: 'report' | 'hide' | 'dismiss';
  id: string;
  version: number;
  reason?: string;
};

type DocumentEventValue = Partial<Pick<BrandDocumentLink, 'url' | 'state_code' | 'expires_on'>>;

export interface BrandDocumentEvent {
  id: string;
  link_id: string;
  action: 'saved' | 'reported' | 'hidden' | 'dismissed' | 'carried';
  changed_by: string;
  created_at: string;
  reason: string | null;
  before_value: DocumentEventValue | null;
  after_value: DocumentEventValue;
}

const DOCUMENT_HISTORY_PAGE_SIZE = 50;

export function checkedDocumentUrl(input: string): string {
  const raw = input.trim();
  if (new TextEncoder().encode(raw).length > 2048 || /[\s\\\p{Cc}]/u.test(raw) || !/^https:\/\//i.test(raw)) {
    throw new Error('Enter an HTTPS document link.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter an HTTPS document link.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.username || url.password || url.port === '0' || !host.includes('.') || host.split('.').some((label) => label.length > 63)) {
    throw new Error('Enter a valid HTTPS document link without a sign-in.');
  }
  if (/(^|\.)(cdms\.net|greenbook\.net)$/.test(host)) {
    throw new Error('Use a manufacturer link instead of CDMS or Greenbook.');
  }
  return raw;
}

export function isBrandDocumentConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'message' in error
    && /^BRAND_(?:DOCUMENT_)?CHANGED:/.test(String(error.message));
}

export async function readBrandDocumentLinks(ids: string[], parentBrand: boolean, history = false): Promise<BrandDocumentLink[]> {
  if (ids.length === 0) return [];
  let query = supabaseUntyped.from('brand_document_links')
    .select('id, legacy_brand_id, parent_brand_id, document_kind, url, state_code, expires_on, row_version, hidden_at')
    .in(parentBrand ? 'parent_brand_id' : 'legacy_brand_id', ids)
    .order('document_kind').order('state_code').order('expires_on').order('id');
  if (!history) query = query.is('hidden_at', null);
  const { data, error } = await query;
  if (error) throw error;
  const links = (data ?? []) as unknown as Omit<BrandDocumentLink, 'reported_at'>[];
  return links.map((link) => ({ ...link, reported_at: null }));
}

export async function readBrandDocumentHistory(target: BrandDocumentTarget, page: number) {
  const links = await readBrandDocumentLinks([target.id], target.parent_brand, true);
  const names = new Map<string, string>();
  if (links.length === 0) return { events: [], hasOlder: false, names };
  const start = page * DOCUMENT_HISTORY_PAGE_SIZE;
  const { data, error } = await supabaseUntyped.from('brand_document_link_events')
    .select('id, link_id, action, changed_by, created_at, reason, before_value, after_value')
    .in('link_id', links.map((link) => link.id)).order('created_at', { ascending: false })
    .order('id', { ascending: false }).range(start, start + DOCUMENT_HISTORY_PAGE_SIZE);
  if (error) throw error;
  const rows = (data ?? []) as unknown as BrandDocumentEvent[];
  const events = rows.slice(0, DOCUMENT_HISTORY_PAGE_SIZE);
  const actors = [...new Set(events.map((event) => event.changed_by))];
  if (actors.length > 0) {
    const { data: people, error: peopleError } = await supabase.from('profile_public_view').select('id, full_name').in('id', actors);
    if (peopleError) throw peopleError;
    for (const person of people ?? []) {
      if (person.id && person.full_name) names.set(person.id, person.full_name);
    }
  }
  return { events, hasOlder: rows.length > events.length, names };
}

export async function readBrandDocumentWorkspace(reportedOnly: boolean, brandIds?: string[]): Promise<BrandDocumentWorkspaceRow[]> {
  const { data, error } = await supabaseUntyped.rpc('get_brand_document_workspace', {
    p_reported_only: reportedOnly, p_brand_ids: brandIds,
  });
  if (error) throw error;
  return assertRpcResult<BrandDocumentWorkspaceRow[]>(data, 'get_brand_document_workspace');
}

export async function changeBrandDocumentLinks(
  target: BrandDocumentTarget, changes: BrandDocumentChange[], key: string,
): Promise<void> {
  const { data, error } = await supabaseUntyped.rpc('change_brand_document_links', {
    p_brand_id: target.id, p_parent_brand: target.parent_brand, p_brand_version: target.brand_version,
    p_changes: changes, p_idempotency_key: key,
  });
  if (error) throw error;
  assertRpcResult<{ success: true }>(data, 'change_brand_document_links');
}

export async function previewBrandDocumentLinks(target: BrandDocumentTarget, changes: BrandDocumentChange[]): Promise<void> {
  const { data, error } = await supabaseUntyped.rpc('preview_brand_document_links', {
    p_brand_id: target.id, p_parent_brand: target.parent_brand, p_brand_version: target.brand_version, p_changes: changes,
  });
  if (error) throw error;
  assertRpcResult<{ success: true }>(data, 'preview_brand_document_links');
}
