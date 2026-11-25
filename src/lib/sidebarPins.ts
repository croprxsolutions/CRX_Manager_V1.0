/**
 * Menu links a person has pinned to the top of the office sidebar.
 *
 * Kept only in this browser (localStorage), one list per signed-in user id, so
 * two people sharing a computer keep their own pins. A pin remembers nothing but
 * a page address: the sidebar still runs every pinned link through its role and
 * deny-list filter, so a pin can never show a page the person cannot open.
 */
const KEY_PREFIX = 'crx-sidebar-pins:';

export function readPinnedPaths(userId: string | undefined): string[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(KEY_PREFIX + userId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function writePinnedPaths(userId: string | undefined, paths: string[]): void {
  if (!userId) return;
  try {
    localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(paths));
  } catch {
    // Storage full or blocked: the pin lasts until the page reloads.
  }
}

/** The list with `path` added at the end, or removed when it is already pinned. */
export function togglePinnedPath(paths: string[], path: string): string[] {
  return paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path];
}
