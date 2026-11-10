import { type ReactNode } from 'react';
import { X } from 'lucide-react';
import Button from './Button';
import Badge from './Badge';

export interface BulkAction {
  key: string;
  label: string;
  /** dock mode, and bar mode below lg: the short visible text (the full label stays the accessible name). */
  shortLabel?: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
}

interface BulkActionBarProps {
  selectedCount: number;
  actions: BulkAction[];
  onDeselectAll: () => void;
  /** Redesigned screens: a 48px green strip that fills its slot (count, Deselect, then the actions on the right). Off keeps the classic header look. */
  bar?: boolean;
  /** Redesigned phone screens: pinned to the viewport bottom just above MobileBottomNav, three equal 44px buttons. */
  dock?: boolean;
}

/**
 * Inline action bar that appears when items are selected in a DataTable.
 * Shows selection count + action buttons. Slots into page header area.
 */
export default function BulkActionBar({ selectedCount, actions, onDeselectAll, bar = false, dock = false }: BulkActionBarProps) {
  if (selectedCount === 0) return null;

  const deselect = (
    <button
      type="button"
      onClick={onDeselectAll}
      className="h-11 md:h-10 shrink-0 rounded-lg px-2 text-sm font-medium text-crx-green hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green/30"
    >
      Deselect
    </button>
  );

  if (dock) {
    return (
      // Offset = MobileBottomNav (min-h-11 + 1px border + safe area), as QuoteBuilder's phone bottom bar.
      <div role="region" aria-label="Bulk actions" className="fixed inset-x-0 bottom-[calc(2.75rem+1px+env(safe-area-inset-bottom))] z-20 flex flex-col gap-1 border-t border-gray-200 bg-white px-4 pt-1 pb-3 shadow-[0_-1px_4px_rgba(0,0,0,0.08)]">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-nav-dark tabular-nums">{selectedCount} selected</span>
          {deselect}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {actions.map((action) => (
            <Button
              key={action.key}
              variant={action.variant || 'secondary'}
              icon={action.icon}
              onClick={action.onClick}
              loading={action.loading}
              disabled={action.disabled}
              aria-label={action.label}
              className="h-11 px-2"
            >
              {action.shortLabel ?? action.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  if (bar) {
    return (
      <div role="region" aria-label="Bulk actions" className="flex h-full min-h-12 items-center gap-2 bg-crx-green-light pl-4 pr-3">
        <span className="shrink-0 text-sm font-semibold text-nav-dark tabular-nums">{selectedCount} selected</span>
        {deselect}
        {/* Narrow cards (sidebar open below lg) get the short labels; scrolls only as a last resort. */}
        <div className="ml-auto flex min-w-0 gap-2 overflow-x-auto scrollbar-hide">
          {actions.map((action) => (
            <Button
              key={action.key}
              variant={action.variant || 'secondary'}
              icon={action.icon}
              onClick={action.onClick}
              loading={action.loading}
              disabled={action.disabled}
              aria-label={action.shortLabel ? action.label : undefined}
              className="h-10 shrink-0"
            >
              {action.shortLabel ? (
                <>
                  <span className="lg:hidden">{action.shortLabel}</span>
                  <span className="hidden lg:inline">{action.label}</span>
                </>
              ) : action.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Badge variant="info" size="md">
        {selectedCount} selected
      </Badge>
      <button
        onClick={onDeselectAll}
        className="inline-flex items-center gap-1 text-xs text-secondary hover:text-nav-dark transition-colors"
      >
        <X className="w-3.5 h-3.5" />
        Deselect
      </button>
      <div className="w-px h-5 bg-gray-200 mx-1" />
      {actions.map((action) => (
        <Button
          key={action.key}
          variant={action.variant || 'secondary'}
          size="sm"
          icon={action.icon}
          onClick={action.onClick}
          loading={action.loading}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}
