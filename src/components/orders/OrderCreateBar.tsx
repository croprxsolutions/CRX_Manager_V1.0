import { Save } from 'lucide-react';
import Button from '../ui/Button';

interface OrderCreateBarProps {
  /** The order's running total in dollars, or null when this person does not see prices. */
  totalDollars: number | null;
  /** A rush order is priced later, so it has no total yet. */
  priceLater: boolean;
  saving: boolean;
  onCreate: () => void;
  /** 'bottom' is the phone bar stuck above the bottom navigation; 'inline' sits in the sticky desktop header. */
  placement: 'inline' | 'bottom';
}

const fmtUsd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);

/**
 * New Order's running total beside its Create Order button, kept on screen like the Quote
 * Builder's bars. Display only: the total is the page's own computed value.
 */
export default function OrderCreateBar({ totalDollars, priceLater, saving, onCreate, placement }: OrderCreateBarProps) {
  const total = totalDollars === null ? null : (
    <div className={`flex flex-col ${placement === 'bottom' ? 'min-w-0 flex-1' : 'items-end'}`} aria-live="polite">
      <span className="text-xs text-secondary">Order total</span>
      <span className="font-mono text-lg font-semibold leading-tight text-nav-dark tabular-nums">
        {priceLater ? 'Priced later' : fmtUsd(totalDollars)}
      </span>
    </div>
  );
  const button = (
    <Button
      onClick={onCreate}
      disabled={saving}
      icon={<Save className="w-4 h-4" />}
      className={placement === 'bottom' ? `min-h-11 ${total ? 'flex-[1.4]' : 'flex-1'}` : 'min-h-10'}
    >
      {saving ? 'Creating...' : 'Create Order'}
    </Button>
  );

  if (placement === 'bottom') {
    // Phone: sticky above MobileBottomNav (min-h-11 + 1px border + safe area); -mx-4 undoes AppLayout main p-4.
    // It sits in the page flow, so it never covers the last content. Same bar as the Quote Builder's.
    return (
      <div data-testid="order-bottom-bar" className="sticky bottom-[calc(2.75rem+1px+env(safe-area-inset-bottom))] z-20 -mx-4 flex items-center gap-3 border-t border-gray-200 bg-white px-4 pb-3.5 pt-2.5 shadow-[0_-1px_4px_rgba(0,0,0,0.08)]">
        {total}
        {button}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-4">
      {total}
      {button}
    </div>
  );
}
