import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface PhoneSectionProps {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * Folds a part of a page on phones and shows it as usual from the md breakpoint up. Folding only hides
 * the content, so fields stay mounted and keep what was typed. Not a <details>: a closed one cannot be
 * shown on desktop by CSS, and this keeps desktop free of any width logic.
 */
export default function PhoneSection({ id, title, open, onToggle, children }: PhoneSectionProps) {
  return (
    <div className="max-md:mb-2">
      <button
        id={id}
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
        className="flex min-h-11 w-full scroll-mt-20 items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left text-lg font-semibold font-heading text-nav-dark shadow-card focus:outline-none focus:ring-2 focus:ring-crx-green/40 disabled:opacity-50 md:hidden"
      >
        {title}
        <ChevronDown aria-hidden="true" className={`h-5 w-5 shrink-0 text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <div id={`${id}-body`} className={`phone-section-body space-y-4 ${open ? 'max-md:mt-2' : 'max-md:hidden'}`}>
        {children}
      </div>
    </div>
  );
}
