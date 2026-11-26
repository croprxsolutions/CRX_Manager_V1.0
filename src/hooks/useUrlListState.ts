import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SortDir } from '../lib/tableSearchSort';

/**
 * A list screen's search box, filters and sort, kept in the page address (?q=…&status=…) the way
 * CallLists and Deliveries keep theirs, so opening a record and pressing Back brings the same view back.
 *
 * `defaults` must be a constant (module level): a value equal to its default is left out of the
 * address, so the plain page address still means the plain list. Every change replaces the current
 * history entry, so typing in the search box never adds Back steps. Pass every change of one click in
 * one call: React Router does not queue two setSearchParams calls made in the same event.
 */
export function useUrlListState<K extends string>(
  defaults: Readonly<Record<K, string>>,
): [Record<K, string>, (changes: Partial<Record<K, string>>) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const signature = searchParams.toString();
  const values = useMemo(() => {
    const params = new URLSearchParams(signature);
    const read = {} as Record<K, string>;
    for (const key of Object.keys(defaults) as K[]) read[key] = params.get(key) ?? defaults[key];
    return read;
  }, [signature, defaults]);

  const update = useCallback((changes: Partial<Record<K, string>>) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes) as Array<[K, string | undefined]>) {
        if (value === undefined) continue;
        if (value === defaults[key]) next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace: true });
  }, [defaults, setSearchParams]);

  return [values, update];
}

export type ListSort = { key: string | null; dir: SortDir };

/** `?sort=total_price:desc` back to a sort; a key the screen cannot sort by is no sort. */
export function parseListSort(text: string, sortableKeys: readonly string[]): ListSort {
  const [key, dir] = text.split(':');
  if (!key || !sortableKeys.includes(key)) return { key: null, dir: 'asc' };
  return { key, dir: dir === 'desc' ? 'desc' : 'asc' };
}

/** A sort as its address value ('' = no sort). */
export function listSortParam(sort: ListSort): string {
  return sort.key ? `${sort.key}:${sort.dir}` : '';
}

/** One of the screen's choices, or the fallback for a value typed or left over in the address. */
export function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
