/**
 * Ref callback for a fixed phone action bar: publishes its height as --page-bar-h on <html>, so the
 * update notice (UpdatePrompt) sits above the bar below md instead of covering it. React 19 runs the
 * returned cleanup when the bar goes, which clears the height.
 */
export function publishPageBarHeight(el: HTMLElement | null) {
  if (!el) return;
  const root = document.documentElement;
  const publish = () => root.style.setProperty('--page-bar-h', `${el.offsetHeight}px`);
  publish();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
  observer?.observe(el);
  return () => {
    observer?.disconnect();
    root.style.removeProperty('--page-bar-h');
  };
}
