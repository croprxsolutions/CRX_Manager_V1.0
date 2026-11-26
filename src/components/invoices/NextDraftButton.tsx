import { useLocation, useNavigate } from 'react-router-dom';
import Button from '../ui/Button';
import { readDraftQueue } from '../../lib/invoiceDraftQueue';

/**
 * Opens the next unposted invoice from the Invoices list the bookkeeper came from, in that list's order,
 * so a run of drafts can be posted without going back to the list each time. It only navigates (Back
 * still returns to the list) and shows nothing when no draft follows or the invoice was opened another way.
 */
export default function NextDraftButton({ currentId, disabled = false }: { currentId: string | undefined; disabled?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queue = readDraftQueue(location.state, currentId);
  if (queue.length === 0) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      showChevron
      disabled={disabled}
      className="min-h-11 md:min-h-0"
      title={`${queue.length} more unposted ${queue.length === 1 ? 'invoice' : 'invoices'} after this one in your list`}
      onClick={() => navigate(`/invoices/${queue[0]}`, { replace: true, state: { nextDrafts: queue.slice(1) } })}
    >
      Next draft
      <span className="font-normal text-secondary tabular-nums">{queue.length} left</span>
    </Button>
  );
}
