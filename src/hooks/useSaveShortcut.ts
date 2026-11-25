import { useEffect } from 'react';
import { useLatestRef } from './useLatestRef';

/** An open dialog (a confirm, the unsaved-changes prompt, a preview) owns the keyboard; the page behind it does not. */
export function isModalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** The person is typing: a single-key shortcut must leave the key to the field. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Ctrl+S / Cmd+S presses the page's own Save button: the same handler, and only when that button
 * could be clicked (`enabled` mirrors its disabled state). The browser's "Save page" dialog is
 * always suppressed on these screens. Like a click, it first takes focus out of the field being
 * typed in, so a value a field commits on blur is in what is saved; the save then runs on the
 * next tick, after React has applied that value, and checks `enabled` again at that point.
 * `enabled` may be a function when the button's state depends on refs, read only at key time.
 * A press while the last save is still running does nothing, like a second click on a busy button.
 */
export function useSaveShortcut(onSave: () => unknown, enabled: boolean | (() => boolean)): void {
  const latest = useLatestRef({ onSave, enabled });
  useEffect(() => {
    // Set from the press until its save settles; a page that leaves cancels a save not yet started.
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canSave = () => {
      const { enabled: e } = latest.current;
      return !isModalOpen() && (typeof e === 'function' ? e() : e);
    };
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if (e.repeat || busy || !canSave()) return;
      busy = true;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      timer = setTimeout(() => {
        timer = undefined;
        if (!canSave()) { busy = false; return; }
        // The page's own save shows any failure; catch here so a rejection is not also unhandled.
        void Promise.resolve(latest.current.onSave()).catch(() => {}).finally(() => { busy = false; });
      }, 0);
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      clearTimeout(timer);
    };
  }, [latest]);
}
