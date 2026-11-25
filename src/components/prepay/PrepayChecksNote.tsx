import { Link } from 'react-router-dom';
import { formatCents as fmt } from '../../lib/money';

/** Says Payment History's totals include Prepay Credits checks, which its list does not show. */
export default function PrepayChecksNote({ count, cents, customerId }: { count: number; cents: number; customerId: string }) {
  if (count === 0) return null;
  return (
    <p className="text-sm text-secondary">
      Totals and export include {count} check(s) entered on Prepay Credits ({fmt(cents)}), not listed below.{' '}
      <Link to={customerId ? `/prepay?tab=manager&customer=${customerId}` : '/prepay?tab=manager'} className="font-medium text-crx-green hover:underline">
        See them on Prepay Credits
      </Link>
    </p>
  );
}
