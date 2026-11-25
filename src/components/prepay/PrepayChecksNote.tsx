import { formatCents as fmt } from '../../lib/money';

/**
 * Says Payment History's totals include Prepay Credits checks, which its list does not show.
 * No link: Prepay Credits lists only customers with a balance left, so a fully applied check is not there.
 */
export default function PrepayChecksNote({ count, cents }: { count: number; cents: number }) {
  if (count === 0) return null;
  return (
    <p className="text-sm text-secondary">
      Totals include {count} check(s) entered on Prepay Credits ({fmt(cents)}), not listed below. Export CSV lists each one.
    </p>
  );
}
