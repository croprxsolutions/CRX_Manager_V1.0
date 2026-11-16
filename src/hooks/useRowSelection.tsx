import { useState, useMemo, useCallback, useEffect, type ReactNode } from 'react';
import type { Column } from '../components/ui/DataTable';

interface UseRowSelectionOptions<T> {
  /** The full data array being displayed (filtered view) */
  data: T[];
  /** Function to extract the unique ID from each row */
  getId: (row: T) => string;
  /** Optional: only rows passing this predicate are selectable */
  isSelectable?: (row: T) => boolean;
  /** Opt-in: whenever this changes, selected IDs not in it are dropped for good (default off). */
  pruneTo?: T[];
}

interface UseRowSelectionReturn<T> {
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  toggleAll: () => void;
  clearSelection: () => void;
  selectedCount: number;
  selectedRows: T[];
  allSelected: boolean;
}

/**
 * Manages multi-row selection state for DataTable pages.
 * Extracts the Set<string> + toggleSelect + toggleAll pattern
 * used in Invoices.tsx and Deliveries.tsx into a reusable hook.
 *
 * NOTE: `selected` is the raw Set of IDs (may contain stale IDs from
 * previously-visible rows). `selectedRows` / `selectedCount` are derived
 * from the *current* data — always use those for export / display.
 */
export function useRowSelection<T>({
  data,
  getId,
  isSelectable,
  pruneTo,
}: UseRowSelectionOptions<T>): UseRowSelectionReturn<T> {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!pruneTo) return;
    const keep = new Set(pruneTo.map(getId));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => keep.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [pruneTo, getId]);

  const selectableRows = useMemo(
    () => (isSelectable ? data.filter(isSelectable) : data),
    [data, isSelectable]
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      // Check if every selectable row is currently selected
      const allCurrentlySelected =
        selectableRows.length > 0 &&
        selectableRows.every((row) => prev.has(getId(row)));
      if (allCurrentlySelected) {
        return new Set();
      }
      return new Set(selectableRows.map(getId));
    });
  }, [selectableRows, getId]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  // Only rows in the CURRENT data that are selected — filters out stale IDs
  const selectedRows = useMemo(
    () => data.filter((row) => selected.has(getId(row))),
    [data, selected, getId]
  );

  // Derive count and allSelected from actual visible data, not raw Set size
  const selectedCount = selectedRows.length;
  const allSelected =
    selectableRows.length > 0 &&
    selectableRows.every((row) => selected.has(getId(row)));

  return {
    selected,
    toggleSelect,
    toggleAll,
    clearSelection,
    selectedCount,
    selectedRows,
    allSelected,
  };
}

/**
 * Creates a checkbox Column<T> to prepend to a DataTable's columns array.
 * Matches the exact checkbox style used in Invoices.tsx and Deliveries.tsx.
 */
export function createCheckboxColumn<T>(
  selected: Set<string>,
  toggleSelect: (id: string) => void,
  getId: (row: T) => string,
  isSelectable?: (row: T) => boolean,
  {
    getLabel,
    checkboxClassName = '',
  }: {
    /** Accessible name for each row's checkbox, e.g. "Select Q-0001". */
    getLabel?: (row: T) => string;
    /** Extra classes for each row's checkbox (opt-in, e.g. the brand accent colour). */
    checkboxClassName?: string;
  } = {},
): Column<T> {
  return {
    key: '_select',
    header: '',
    className: 'w-10',
    render: (row: T) => {
      const id = getId(row);
      const selectable = isSelectable ? isSelectable(row) : true;
      if (!selectable) return null;
      return (
        <input
          type="checkbox"
          aria-label={getLabel?.(row)}
          checked={selected.has(id)}
          onChange={(e) => {
            e.stopPropagation();
            toggleSelect(id);
          }}
          onClick={(e) => e.stopPropagation()}
          className={`w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green ${checkboxClassName}`.trimEnd()}
        />
      ) as ReactNode;
    },
  };
}
