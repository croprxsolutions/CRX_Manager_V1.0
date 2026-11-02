import { useEffect, useRef, useState } from 'react';

export interface JumpSection {
  id: string;
  label: string;
  count?: number;
}

interface SectionJumpBarProps {
  sections: JumpSection[];
  ariaLabel?: string;
}

/**
 * Sticky row of pills that jump to sections of one long page (Style D in
 * docs/workflows/UI_PATTERNS.md). Give each section the matching `id` and
 * `scroll-mt-32` so it lands below the top bar and this bar.
 */
export default function SectionJumpBar({ sections, ariaLabel = 'Jump to section' }: SectionJumpBarProps) {
  const [activeId, setActiveId] = useState(sections[0]?.id);
  // Callers pass a fresh array each render; re-observe only when the ids change.
  const navRef = useRef<HTMLElement>(null);
  const ids = sections.map((section) => section.id).join('|');
  // A replaced section list may no longer hold the active id; fall back to its first section.
  const currentId = sections.some((section) => section.id === activeId) ? activeId : sections[0]?.id;

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    // A section is "in view" once its top passes just under the two sticky bars.
    const observer = new IntersectionObserver(
      (entries) => {
        // Entries arrive in any order; the topmost section in view wins.
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-130px 0px -60% 0px' },
    );
    for (const id of ids.split('|')) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);

  // On a phone the active pill can sit past the edge of the row; slide it into view.
  useEffect(() => {
    const pill = navRef.current?.querySelector<HTMLElement>('[aria-current]');
    if (typeof pill?.scrollIntoView === 'function') pill.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentId]);

  return (
    <nav
      ref={navRef}
      aria-label={ariaLabel}
      className="sticky top-14 z-20 -mx-4 border-b border-gray-200 bg-cream/95 px-4 py-2 backdrop-blur-md md:top-16 lg:-mx-6 lg:px-6"
    >
      <div className="flex gap-1.5 overflow-x-auto [-webkit-overflow-scrolling:touch]">
        {sections.map((section) => {
          const isActive = section.id === currentId;
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              aria-current={isActive ? 'location' : undefined}
              onClick={() => setActiveId(section.id)}
              className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green focus-visible:ring-offset-2 md:min-h-9 ${
                isActive
                  ? 'border-crx-green bg-crx-green text-white'
                  : 'border-gray-300 bg-white text-nav-dark hover:bg-cream-dark'
              }`}
            >
              {section.label}
              {section.count !== undefined && (
                <span
                  className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs leading-none ${
                    isActive ? 'bg-white text-crx-green' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {section.count}
                </span>
              )}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
