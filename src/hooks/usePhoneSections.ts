import { useCallback, useState } from 'react';

/** Which of a page's PhoneSections are open, and a way to open one that holds a problem. */
export function usePhoneSections(initiallyOpen: readonly string[]) {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set(initiallyOpen));

  const toggle = useCallback((key: string) => {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  /** A refused save must not leave its field folded away. */
  const reveal = useCallback((key: string) => {
    setOpenKeys((current) => new Set(current).add(key));
    requestAnimationFrame(() => {
      const heading = document.getElementById(`phone-section-${key}`);
      // The toggle has no layout on desktop, where the page must not jump.
      if (heading?.offsetParent) heading.scrollIntoView({ block: 'start' });
    });
  }, []);

  const sectionProps = (key: string, forceOpen = false) => ({
    id: `phone-section-${key}`,
    open: forceOpen || openKeys.has(key),
    onToggle: () => toggle(key),
  });

  return { sectionProps, reveal };
}
