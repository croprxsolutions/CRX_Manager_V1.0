import { useSyncExternalStore } from 'react';

const PHONE_QUERY = '(max-width: 767px)';

const subscribe = (onChange: () => void) => {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  // Safari before 14 has only the older addListener/removeListener.
  if (typeof query.addEventListener !== 'function') {
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

// No matchMedia (tests) = desktop.
const isPhoneNow = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;

/** True below 768 px, for layouts that render one variant at a time instead of hiding the other with CSS. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, isPhoneNow, () => false);
}
