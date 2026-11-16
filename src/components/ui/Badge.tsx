import type { ReactNode } from 'react';

export type BadgeVariant =
  | 'default'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'danger'
  // Hue variants for the quote screens' status palette (quoteBadgeVariant in src/lib/quoteStatusLabel.ts).
  | 'slate'
  | 'sky'
  | 'violet'
  | 'rose'
  | 'teal'
  | 'orange';

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  normalCase?: boolean;
  /** A small status dot before the label (quote screens). */
  dot?: boolean;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 text-gray-700 ring-1 ring-inset ring-gray-200',
  success: 'bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-200',
  warning: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200',
  error: 'bg-red-100 text-red-800 ring-1 ring-inset ring-red-200',
  info: 'bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-200',
  draft: 'bg-gray-100 text-gray-700 ring-1 ring-inset ring-gray-200',
  sent: 'bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-200',
  accepted: 'bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-200',
  declined: 'bg-red-100 text-red-800 ring-1 ring-inset ring-red-200',
  expired: 'bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-200',
  danger: 'bg-red-100 text-red-800 ring-1 ring-inset ring-red-200',
  slate: 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200',
  sky: 'bg-sky-100 text-sky-800 ring-1 ring-inset ring-sky-200',
  violet: 'bg-violet-100 text-violet-800 ring-1 ring-inset ring-violet-200',
  rose: 'bg-rose-100 text-rose-800 ring-1 ring-inset ring-rose-200',
  teal: 'bg-teal-100 text-teal-800 ring-1 ring-inset ring-teal-200',
  orange: 'bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-200',
};

const dotClasses: Record<BadgeVariant, string> = {
  default: 'bg-gray-500',
  success: 'bg-emerald-600',
  warning: 'bg-amber-600',
  error: 'bg-red-600',
  info: 'bg-blue-600',
  draft: 'bg-gray-500',
  sent: 'bg-blue-600',
  accepted: 'bg-emerald-600',
  declined: 'bg-red-600',
  expired: 'bg-orange-600',
  danger: 'bg-red-600',
  slate: 'bg-slate-500',
  sky: 'bg-sky-600',
  violet: 'bg-violet-600',
  rose: 'bg-rose-600',
  teal: 'bg-teal-600',
  orange: 'bg-orange-600',
};

// eslint-disable-next-line react-refresh/only-export-components
export const statusToBadgeVariant: Record<string, BadgeVariant> = {
  draft: 'draft',
  sent: 'sent',
  revised: 'info',
  accepted: 'accepted',
  declined: 'declined',
  expired: 'expired',
  closed_by_application: 'success',
  closed_short: 'warning',
  confirmed: 'success',
  partially_fulfilled: 'warning',
  fulfilled: 'success',
  cancelled: 'error',
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  submitted: 'info',
  partially_received: 'warning',
  fully_received: 'success',
  pending: 'warning',
  paid: 'success',
  overdue: 'error',
  posted: 'success',
  unposted: 'warning',
  voided: 'error',
  invoiced: 'success',
  requested: 'warning',
  approved: 'info',
  received: 'info',
  credited: 'success',
  rejected: 'error',
  unpaid: 'warning',
  partially_paid: 'info',
};

export default function Badge({ variant = 'default', children, size = 'sm', className = '', normalCase = false, dot = false }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center font-medium rounded-full ${dot ? 'gap-1.5' : ''}
        ${normalCase ? '' : 'capitalize'}
        ${variantClasses[variant]}
        ${size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'}
        ${className}
      `}
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClasses[variant]}`} aria-hidden="true" />}
      {children}
    </span>
  );
}
