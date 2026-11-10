import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  key: string;
  label: ReactNode;
  content: ReactNode;
  count?: number;
}

export interface TabsProps {
  tabs: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
  className?: string;
}

export default function Tabs({
  tabs,
  activeKey,
  onChange,
  ariaLabel = 'Tabs',
  className = '',
}: TabsProps) {
  const id = useId().replace(/:/g, '');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabListRef = useRef<HTMLDivElement | null>(null);

  // Keeps the active tab inside the tab bar. It moves only the bar sideways: never the page, and
  // not on a re-render that leaves the active tab alone (callers often pass a fresh `tabs` array).
  useEffect(() => {
    const list = tabListRef.current;
    const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !tab || typeof list.scrollTo !== 'function') return;
    const pad = 16;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < list.scrollLeft) list.scrollTo({ left: Math.max(0, left - pad), behavior: 'smooth' });
    else if (right > list.scrollLeft + list.clientWidth) list.scrollTo({ left: right - list.clientWidth + pad, behavior: 'smooth' });
  }, [activeKey]);

  const selectTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;

    onChange(tab.key);
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    selectTab(nextIndex);
  };

  return (
    <div className={`font-sub ${className}`}>
      <div className="relative">
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={ariaLabel}
          className="flex flex-nowrap gap-1 overflow-x-auto border-b border-gray-200 [-webkit-overflow-scrolling:touch]"
        >
          {tabs.map((tab, index) => {
            const isActive = tab.key === activeKey;
            const tabId = `${id}-tab-${index}`;
            const panelId = `${id}-panel-${index}`;

            return (
              <button
                key={tab.key}
                ref={(element) => { tabRefs.current[index] = element; }}
                id={tabId}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={panelId}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onChange(tab.key)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className={`
                  -mb-px inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 py-2 md:min-h-10 md:px-4
                  text-sm font-medium whitespace-nowrap transition-colors
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green
                  focus-visible:ring-offset-2
                  ${isActive
                    ? 'border-crx-green text-crx-green'
                    : 'border-transparent text-secondary hover:text-nav-dark'}
                `}
              >
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span
                    className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none tabular-nums ${
                      isActive
                        ? 'bg-crx-green text-white'
                        : 'bg-crx-green-light text-crx-green'
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-cream via-cream/80 to-transparent md:hidden"
        />
      </div>

      {tabs.map((tab, index) => {
        const isActive = tab.key === activeKey;

        return (
          <div
            key={tab.key}
            id={`${id}-panel-${index}`}
            role="tabpanel"
            aria-labelledby={`${id}-tab-${index}`}
            tabIndex={0}
            hidden={!isActive}
          >
            {isActive ? tab.content : null}
          </div>
        );
      })}
    </div>
  );
}
