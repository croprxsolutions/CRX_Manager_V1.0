import { useSyncExternalStore } from 'react';

/** A hook that is true while `query` matches; false with no matchMedia (tests = desktop). */
function mediaQueryHook(query: string) {
  const subscribe = (onChange: () => void) => {
    if (typeof window.matchMedia !== 'function') return () => {};
    const list = window.matchMedia(query);
    // Safari before 14 has only the older addListener/removeListener.
    if (typeof list.addEventListener !== 'function') {
      list.addListener(onChange);
      return () => list.removeListener(onChange);
    }
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  };
  const matchesNow = () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  return function useMediaQuery(): boolean {
    return useSyncExternalStore(subscribe, matchesNow, () => false);
  };
}

/** True below 768 px, for layouts that render one variant at a time instead of hiding the other with CSS. */
export const useIsPhone = mediaQueryHook('(max-width: 767px)');

/** True below 1280 px (Tailwind's xl), the same way: the quote line table becomes cards there. */
export const useIsBelowXl = mediaQueryHook('(max-width: 1279px)');
