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
