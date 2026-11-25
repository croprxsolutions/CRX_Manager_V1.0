/**
 * One tab set for both invoice lists (Chemical Invoices and Field Invoices), so the bookkeeper
 * sees the same Drafts / Posted / By Customer / All Invoices on each. Field also has Unbilled
 * (applied work not invoiced yet), which chemical sales have no equivalent of.
 *
 * Tabs only choose which rows a list shows. Which invoices can be posted, and how, stays with
 * each screen's own handler.
 */
import type { InvoiceStatus } from '../types';
import { STATUS_POSTED } from './fieldInvoiceList';

export type InvoiceListTab = 'unbilled' | 'drafts' | 'posted' | 'customer' | 'all';
export type ChemicalInvoiceTab = Exclude<InvoiceListTab, 'unbilled'>;

export const INVOICE_TAB_LABELS: Record<InvoiceListTab, string> = {
  unbilled: 'Unbilled',
  drafts: 'Drafts',
  posted: 'Posted',
  customer: 'By Customer',
  all: 'All Invoices',
};

/** Every ?tab= value either list has ever used, old names included, so saved links keep working. */
export const INVOICE_TAB_ALIASES: Record<string, InvoiceListTab> = {
  unbilled: 'unbilled',
  drafts: 'drafts',
  unposted: 'drafts',
  posted: 'posted',
  customer: 'customer',
  summary: 'customer',
  all: 'all',
};

/** The tab a ?tab= value names, or undefined. Own keys only, so ?tab=toString is not a tab. */
export function invoiceTabAlias(tabParam: string): InvoiceListTab | undefined {
  return Object.prototype.hasOwnProperty.call(INVOICE_TAB_ALIASES, tabParam) ? INVOICE_TAB_ALIASES[tabParam] : undefined;
}

/** Not posted yet: the Drafts tab on both lists. */
export const DRAFT_STATUSES: ReadonlyArray<InvoiceStatus> = ['draft', 'unposted'];
/** Committed to AR (an overdue or paid invoice was posted first): the Posted tab on both lists. */
export const POSTED_STATUSES: ReadonlyArray<InvoiceStatus> = STATUS_POSTED;

/**
 * The Chemical Invoices tab for an address. A ?tab= wins; without one, the status filter the
 * list kept in its address before it had tabs picks the tab (?status=ready_to_post, draft or
 * unposted open Drafts; posted, overdue or paid open Posted), so old links land where they did.
 * Anything else, including no filter at all, is All Invoices, as the plain address always was.
 */
export function chemicalInvoiceTab(tabParam: string, statusParam: string): ChemicalInvoiceTab {
  const fromTab = invoiceTabAlias(tabParam);
  if (fromTab && fromTab !== 'unbilled') return fromTab;
  if (statusParam === 'ready_to_post' || (DRAFT_STATUSES as readonly string[]).includes(statusParam)) return 'drafts';
  if ((POSTED_STATUSES as readonly string[]).includes(statusParam)) return 'posted';
  return 'all';
}

/** The statuses a tab shows; null shows every status. */
export function tabStatuses(tab: ChemicalInvoiceTab): ReadonlyArray<InvoiceStatus> | null {
  if (tab === 'drafts') return DRAFT_STATUSES;
  if (tab === 'posted') return POSTED_STATUSES;
  return null;
}
