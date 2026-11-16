import { type ReactNode } from 'react';
import { X } from 'lucide-react';
import Button from './Button';
import Badge from './Badge';

export interface BulkAction {
  key: string;
  label: string;
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
  /** Redesigned screens: a green-tint strip above the list with full-size (44px on phone) buttons. Off keeps the classic header look. */
  bar?: boolean;
}

/**
 * Inline action bar that appears when items are selected in a DataTable.
 * Shows selection count + action buttons. Slots into page header area.
 */
export default function BulkActionBar({ selectedCount, actions, onDeselectAll, bar = false }: BulkActionBarProps) {
  if (selectedCount === 0) return null;

  if (bar) {
    return (
      <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 rounded-lg border border-crx-green/20 bg-crx-green-tint px-3 py-2">
        <span className="text-sm font-medium text-nav-dark tabular-nums">{selectedCount} selected</span>
        <button
          type="button"
          onClick={onDeselectAll}
          className="h-11 md:h-10 rounded-lg px-2 text-sm font-medium text-crx-green hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green/30"
        >
          Deselect
        </button>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {actions.map((action) => (
            <Button
              key={action.key}
              variant={action.variant || 'secondary'}
              icon={action.icon}
              onClick={action.onClick}
              loading={action.loading}
              disabled={action.disabled}
              className="h-11 md:h-10"
            >
              {action.label}
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
