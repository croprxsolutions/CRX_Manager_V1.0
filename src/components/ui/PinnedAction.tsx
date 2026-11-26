import type { ReactNode } from 'react';

/**
 * Style D main action (docs/workflows/UI_PATTERNS.md): one full-width 56px green button pinned to
 * the bottom of a phone screen, 3.5rem up so it clears the bottom navigation. `className` goes on
 * the pinned wrapper (for example `md:hidden`), which must stay a direct child of the tall page.
 */
export default function PinnedAction({ onClick, disabled, loading, className = '', children }: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div data-pinned-action className={`sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-4 bg-cream/95 px-4 py-2 backdrop-blur ${className}`.trim()}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-crx-green font-heading text-xl font-bold text-white hover:bg-crx-green-hover active:scale-[0.99] disabled:opacity-50"
      >
        {children}
      </button>
    </div>
  );
}
