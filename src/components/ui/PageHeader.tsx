import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  accent?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Style D title (docs/workflows/UI_PATTERNS.md): the large bold Barlow heading. */
  large?: boolean;
}

/**
 * Single page-title component for office pages, built on the SplitHeading
 * brand motif (Barlow Semi Condensed heading + crx-green accent word).
 * Pure presentational shell — pages keep their own data/handlers below it.
 */
export default function PageHeader({ title, accent, subtitle, actions, large = false }: PageHeaderProps) {
  return (
    <header className="flex min-w-0 flex-col justify-between gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <h1 className={`truncate font-heading text-nav-dark sm:overflow-visible sm:whitespace-normal ${large ? 'text-4xl font-bold leading-tight' : 'text-2xl font-semibold'}`}>
          {title}
          {accent && (
            <>
              {' '}
              <span className="split-heading-accent">{accent}</span>
            </>
          )}
        </h1>
        {subtitle && <p className={`${large ? 'mt-1.5' : 'mt-1'} text-sm text-secondary`}>{subtitle}</p>}
      </div>
      {actions && <div className="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">{actions}</div>}
    </header>
  );
}
