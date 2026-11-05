import type { ReactNode } from 'react';
import Card from './Card';

interface SectionCardProps {
  id: string;
  icon: ReactNode;
  title: string;
  /** The section's main action, on the right of the band. */
  action?: ReactNode;
  children: ReactNode;
}

/**
 * Style D section (docs/workflows/UI_PATTERNS.md): a cream band with a green icon tile, a bold
 * Barlow heading and the section's main action, over the section body. `id` is the
 * SectionJumpBar target; `scroll-mt-32` lands it below the sticky bars.
 */
export default function SectionCard({ id, icon, title, action, children }: SectionCardProps) {
  return (
    <Card id={id} padding={false} className="scroll-mt-32 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-cream-dark px-4 py-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crx-green text-white">
            {icon}
          </span>
          <h2 className="font-heading text-2xl font-bold leading-none text-nav-dark">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}
