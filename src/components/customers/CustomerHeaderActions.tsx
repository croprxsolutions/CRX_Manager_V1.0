import { useNavigate } from 'react-router-dom';
import { ClipboardList, Copy, FileText, MessageSquarePlus, PhoneCall, RotateCcw, SprayCan, Truck, Zap } from 'lucide-react';
import Button from '../ui/Button';
import ActionMenu, { type ActionMenuItem } from '../ui/ActionMenu';

interface CustomerHeaderActionsProps {
  customerId: string;
  /** Admins and sales reps start quotes, orders, deliveries and jobs. */
  canSell: boolean;
  canReactivate: boolean;
  reactivateDisabled: boolean;
  /** The customer has at least one quote loaded, so "Repeat last quote" has something to copy. */
  hasLastQuote: boolean;
  onReactivate: () => void;
  onRepeatLastQuote: () => void;
  onLogCall: () => void;
  onCreateTask: () => void;
  onSeasonSummary: () => void;
}

const tall = 'min-h-11 md:min-h-10';

/**
 * The customer page's top actions. Selling comes first with full labels; the less common
 * actions sit in a "More" menu so the header stays one short row.
 */
export default function CustomerHeaderActions({
  customerId,
  canSell,
  canReactivate,
  reactivateDisabled,
  hasLastQuote,
  onReactivate,
  onRepeatLastQuote,
  onLogCall,
  onCreateTask,
  onSeasonSummary,
}: CustomerHeaderActionsProps) {
  const navigate = useNavigate();
  const go = (path: string) => navigate(path);
  const forCustomer = `customer_id=${customerId}`;

  const moreItems: ActionMenuItem[] = [
    ...(canSell
      ? [
          { id: 'sell-deliver', label: 'Sell & deliver now', icon: <Zap className="h-4 w-4" />, onAction: () => go(`/deliveries?quickDeliver=1&${forCustomer}`) },
          { id: 'new-job', label: 'New job', icon: <SprayCan className="h-4 w-4" />, onAction: () => go(`/jobs/new?${forCustomer}`) },
        ]
      : []),
    { id: 'create-task', label: 'Create task', icon: <MessageSquarePlus className="h-4 w-4" />, onAction: onCreateTask },
    ...(canSell
      ? [{ id: 'season-summary', label: 'Season summary', icon: <FileText className="h-4 w-4" />, onAction: onSeasonSummary }]
      : []),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 md:justify-end">
      {canReactivate && (
        <Button variant="primary" className={tall} icon={<RotateCcw className="h-4 w-4" />} disabled={reactivateDisabled} onClick={onReactivate}>
          Reactivate
        </Button>
      )}
      {canSell && (
        <>
          <Button variant="primary" className={tall} icon={<FileText className="h-4 w-4" />} onClick={() => go(`/quotes/new?${forCustomer}`)}>
            New quote
          </Button>
          {hasLastQuote && (
            <Button variant="secondary" className={tall} icon={<Copy className="h-4 w-4" />} onClick={onRepeatLastQuote}>
              Repeat last quote
            </Button>
          )}
          <Button variant="secondary" className={tall} icon={<ClipboardList className="h-4 w-4" />} onClick={() => go(`/orders/new?${forCustomer}`)}>
            New order
          </Button>
          <Button variant="secondary" className={tall} icon={<Truck className="h-4 w-4" />} onClick={() => go(`/deliveries/new?${forCustomer}`)}>
            Schedule delivery
          </Button>
        </>
      )}
      <Button variant="secondary" className={tall} icon={<PhoneCall className="h-4 w-4" />} onClick={onLogCall}>
        Log call
      </Button>
      <ActionMenu label="More actions" items={moreItems} trigger={{ text: 'More', variant: 'secondary' }} />
    </div>
  );
}
