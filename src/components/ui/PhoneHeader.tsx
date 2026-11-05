import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

interface PhoneHeaderProps {
  title: string;
  /** Small light-gray line above the title (a record number, a date). */
  eyebrow?: string | null;
  /** Shows a back arrow with this label. */
  back?: { label: string; onClick: () => void };
  /** Labelled steps of a step-by-step flow, and which one is current. */
  steps?: { labels: string[]; current: number };
  /** Controls on the right of the title (a view toggle). */
  action?: ReactNode;
  /** Extra rows under the title, such as a search box. */
  children?: ReactNode;
  className?: string;
}

/** Style D phone header (docs/workflows/UI_PATTERNS.md): a dark band with a large white title. */
export default function PhoneHeader({ title, eyebrow, back, steps, action, children, className = '' }: PhoneHeaderProps) {
  return (
    <header className={`bg-nav-dark px-4 pt-2 pb-4 text-white ${className}`.trim()}>
      {back && (
        <button
          type="button"
          onClick={back.onClick}
          className="-ml-2 inline-flex min-h-11 items-center gap-1.5 px-2 text-sm font-medium text-gray-300 hover:text-white"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" /> {back.label}
        </button>
      )}
      <div className={`flex items-center justify-between gap-3 ${back ? '' : 'pt-2'}`}>
        <div className="min-w-0">
          {eyebrow && <p className="text-xs font-medium tracking-wide text-gray-300">{eyebrow}</p>}
          <h1 className="font-heading text-[2rem] font-bold leading-tight break-words text-white">{title}</h1>
        </div>
        {action}
      </div>
      {steps && (
        <ol className="mt-3 flex gap-1.5" aria-label="Steps">
          {steps.labels.map((label, i) => {
            const reached = i <= steps.current;
            const isCurrent = i === steps.current;
            return (
              <li key={label} className="min-w-0 flex-1" aria-current={isCurrent ? 'step' : undefined}>
                <span aria-hidden="true" className={`block h-1.5 rounded-full ${reached ? 'bg-crx-green-on-dark' : 'bg-gray-600'}`} />
                <span className={`mt-1.5 block truncate text-xs ${isCurrent ? 'font-bold text-white' : reached ? 'text-crx-green-on-dark' : 'text-gray-400'}`}>
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {children}
    </header>
  );
}
