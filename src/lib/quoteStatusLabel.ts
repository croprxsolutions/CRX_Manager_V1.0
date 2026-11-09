import type { BadgeVariant } from '../components/ui/Badge';

// Plain-English label for a quote status. Values stay unchanged; only display differs.
const SPECIAL: Record<string, string> = {
  closed_by_application: 'Fulfilled',
  closed_short: 'Closed short',
};

export function quoteStatusLabel(status: string): string {
  if (SPECIAL[status]) return SPECIAL[status];
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// The quote screens' status palette (Components board). Quote screens only: other
// screens keep statusToBadgeVariant. Cancelled stays gray (the theme has no zinc).
const QUOTE_BADGE: Record<string, BadgeVariant> = {
  draft: 'slate',
  sent: 'sky',
  revised: 'violet',
  accepted: 'accepted',
  declined: 'rose',
  expired: 'warning',
  cancelled: 'default',
  closed_by_application: 'teal',
  closed_short: 'orange',
};

export function quoteBadgeVariant(status: string): BadgeVariant {
  return QUOTE_BADGE[status] ?? 'default';
}
