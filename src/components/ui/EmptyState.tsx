import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import Button from './Button';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-14 h-14 rounded-full bg-crx-green-light text-crx-green flex items-center justify-center mb-4">
        {icon || <Inbox className="w-6 h-6" strokeWidth={1.75} />}
      </div>
      <h3 className="text-lg font-semibold font-heading text-nav-dark mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-secondary mb-4 text-center max-w-sm">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}

/**
 * Shown in place of an empty list when the list's read FAILED. A failed read must
 * not look like "No … found": staff took that to mean the records were gone
 * (To-Do List 10.5).
 */
export function LoadFailedState({
  title = 'This list could not be loaded',
  onRetry,
}: {
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert">
      <EmptyState
        icon={<AlertTriangle className="w-6 h-6 text-amber-600" strokeWidth={1.75} />}
        title={title}
        description="This does not mean the records are gone. Check your connection and try again."
        action={
          onRetry ? (
            <Button variant="secondary" icon={<RefreshCw className="w-4 h-4" />} onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
