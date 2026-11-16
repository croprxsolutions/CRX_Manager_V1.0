import type { BadgeVariant } from '../components/ui/Badge';

/** A database status as a title-case pill label: "partially_fulfilled" -> "Partially Fulfilled". */
export const statusLabel = (s: string) => s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// The invoice status palette on every billing page: Draft, Unposted and Cancelled grey, Posted green,
// Paid dark green, Overdue amber, Voided red.
const INVOICE_STATUS_VARIANT: Record<string, BadgeVariant> = {
  draft: 'draft',
  unposted: 'draft',
  posted: 'success',
  paid: 'paid',
  overdue: 'warning',
  voided: 'error',
  cancelled: 'draft',
};

/** An invoice status as a Badge: its colour and title-case label. */
export const invoiceStatusBadge = (status: string | null | undefined): { variant: BadgeVariant; label: string } =>
  ({ variant: (status && INVOICE_STATUS_VARIANT[status]) || 'default', label: statusLabel(status ?? '') });

/** A payer's share as shown on screen: at most two decimals, e.g. 33.333 -> "33.33%". */
export const formatSharePct = (pct: number) => `${Math.round(pct * 100) / 100}%`;
