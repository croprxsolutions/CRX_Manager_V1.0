import Badge from '../ui/Badge';
import { invoiceStatusBadge } from '../../lib/statusLabel';
import { parseLocalDate } from '../../lib/dateUtils';

/**
 * Cells both invoice lists (Chemical Invoices and the Field Invoices tabs) show the same way,
 * so a status or a due date reads alike on every list.
 */

/** An invoice's status in the app's one set of colors and names (statusLabel.ts). */
export function InvoiceStatusBadge({ status }: { status: string }) {
  const s = invoiceStatusBadge(status);
  return <Badge variant={s.variant} normalCase>{s.label}</Badge>;
}

/** A due date (YYYY-MM-DD) in the reader's own date format, or a dash when none is set. */
export function DueDate({ date }: { date: string | null | undefined }) {
  return <span className="whitespace-nowrap">{date ? parseLocalDate(date).toLocaleDateString() : '—'}</span>;
}
