import { useEffect, useState, useMemo, useCallback, type ReactNode } from 'react';
import { Search, ArrowUpDown, ArrowUp, ArrowDown, Pencil, X, Save } from 'lucide-react';
import EmptyState, { LoadFailedState } from './EmptyState';
import Button from './Button';
import UnsavedChangesModal from './UnsavedChangesModal';
import ConfirmModal from './ConfirmModal';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';

const EDIT_PAGE_SIZE = 50;

export interface EditableColumn<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
  /** Enable inline editing for this column */
  editable?: boolean;
  /** Input type when editing */
  editType?: 'text' | 'number' | 'decimal' | 'select' | 'toggle';
  /** Options for select type: { value, label } */
  editOptions?: Array<{ value: string; label: string }>;
  /** Accessible name for the built-in edit control. */
  editAriaLabel?: string | ((row: T) => string);
  /** Min value for number type */
  editMin?: number;
  /** Step for number inputs */
  editStep?: string;
  /** Format display value (e.g. currency formatting) */
  formatValue?: (value: unknown) => string;
  /** Custom render for edit mode — overrides editType when provided */
  editRender?: (
    row: T,
    getCellValue: (colKey: string) => unknown,
    setCellValue: (colKey: string, value: unknown) => void
  ) => ReactNode;
}

interface EditableDataTableProps<T> {
  data: T[];
  columns: EditableColumn<T>[];
  rowKey: keyof T & string;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchKeys?: string[];
  /** Optional row matcher for pages that share search rules across multiple layouts. */
  searchMatcher?: (row: T, search: string) => boolean;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  filters?: ReactNode;
  loading?: boolean;
  /** The rows failed to load: say so (with Try again when onRetry is set) instead of the empty message. */
  loadError?: boolean;
  onRetry?: () => void;
  /**
   * Called with a map of rowId -> changed fields when user clicks Save.
   * Return false to keep edit mode and dirty rows intact; true/undefined closes edit mode.
   */
  onSave?: (changes: Map<string, Record<string, unknown>>) => Promise<void | boolean>;
  /** Whether edit mode is available */
  canEdit?: boolean;
  /** Called when inline editing starts or ends. */
  onEditModeChange?: (editing: boolean) => void;
  /** Extra actions to render next to the Edit/Save buttons */
  headerActions?: ReactNode;
}

function OtherPageUnsavedCount({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="text-xs text-amber-700" role="status">{count} unsaved not shown</span>;
}

function isNavigationBlocked(blocker: ReturnType<typeof useUnsavedChanges>): boolean {
  return blocker.state === 'blocked';
}

function resetBlockerWhenClean(
  dirtyCount: number,
  blocker: ReturnType<typeof useUnsavedChanges>,
): void {
  if (dirtyCount === 0 && blocker.state === 'blocked') blocker.reset?.();
}

function requestEditCancel(
  dirtyCount: number,
  cancelEdit: () => void,
  openConfirmation: () => void,
): void {
  if (dirtyCount > 0) openConfirmation();
  else cancelEdit();
}

function discardRowsMessage(count: number): string {
  return `Discard edits to ${count} ${count === 1 ? 'row' : 'rows'}?`;
}

function countDirtyRowsOffPage(
  editing: boolean,
  dirtyRows: Map<string, Record<string, unknown>>,
  currentPageIds: Set<string>,
): number {
  if (!editing) return 0;
  return [...dirtyRows.keys()].filter((id) => !currentPageIds.has(id)).length;
}

function EditPagination({
  editing,
  loadError,
  total,
  page,
  maxPage,
  onPrevious,
  onNext,
}: {
  editing: boolean;
  loadError: boolean;
  total: number;
  page: number;
  maxPage: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (!editing || loadError || total <= EDIT_PAGE_SIZE) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3" aria-label="Edit table pagination">
      <span className="text-sm text-secondary">
        Showing {page * EDIT_PAGE_SIZE + 1}–{Math.min((page + 1) * EDIT_PAGE_SIZE, total)} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onPrevious} disabled={page === 0}>
          Previous
        </Button>
        <Button variant="secondary" size="sm" onClick={onNext} disabled={page === maxPage}>
          Next
        </Button>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function EditableDataTable<T extends Record<string, any>>({
  data,
  columns,
  rowKey,
  searchable = false,
  searchPlaceholder = 'Search...',
  searchKeys = [],
  searchMatcher,
  onRowClick,
  emptyTitle = 'No data found',
  emptyDescription,
  emptyAction,
  filters,
  loading = false,
  loadError = false,
  onRetry,
  onSave,
  canEdit = false,
  onEditModeChange,
  headerActions,
}: EditableDataTableProps<T>) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [editMode, setEditMode] = useState(false);
  const [editPage, setEditPage] = useState(0);
  const [dirtyRows, setDirtyRows] = useState<Map<string, Record<string, unknown>>>(new Map());
  const [saving, setSaving] = useState(false);
  const [cancelConfirmationOpen, setCancelConfirmationOpen] = useState(false);

  const dirtyCount = dirtyRows.size;
  const blocker = useUnsavedChanges(editMode && dirtyCount > 0);

  useEffect(() => {
    resetBlockerWhenClean(dirtyCount, blocker);
  }, [blocker, dirtyCount]);

  const filtered = useMemo(() => {
    let result = data;
    if (search) {
      if (searchMatcher) {
        result = result.filter((row) => searchMatcher(row, search));
      } else if (searchKeys.length > 0) {
        const lower = search.toLowerCase();
        result = result.filter((row) =>
          searchKeys.some((key) => {
            const val = row[key];
            return val != null && String(val).toLowerCase().includes(lower);
          })
        );
      }
    }
    if (sortKey) {
      result = [...result].sort((a, b) => {
        const aVal = a[sortKey];
        const bVal = b[sortKey];
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
        }
        const cmp = String(aVal).localeCompare(String(bVal));
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return result;
  }, [data, search, searchKeys, searchMatcher, sortKey, sortDir]);

  const maxEditPage = Math.max(0, Math.ceil(filtered.length / EDIT_PAGE_SIZE) - 1);
  const currentEditPage = Math.min(editPage, maxEditPage);

  useEffect(() => {
    setEditPage(0);
  }, [filtered.length]);

  const pageRows = useMemo(() => {
    if (!editMode) return filtered;
    const from = currentEditPage * EDIT_PAGE_SIZE;
    return filtered.slice(from, from + EDIT_PAGE_SIZE);
  }, [currentEditPage, editMode, filtered]);

  const currentPageIds = new Set(pageRows.map((row) => String(row[rowKey])));
  const otherPageDirtyCount = countDirtyRowsOffPage(editMode, dirtyRows, currentPageIds);

  const toggleSort = (key: string) => {
    setEditPage(0);
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const getCellValue = useCallback(
    (row: T, colKey: string) => {
      const id = String(row[rowKey]);
      const dirty = dirtyRows.get(id);
      if (dirty && colKey in dirty) return dirty[colKey];
      return row[colKey];
    },
    [dirtyRows, rowKey]
  );

  const setCellValue = useCallback(
    (row: T, colKey: string, value: unknown) => {
      const id = String(row[rowKey]);
      setDirtyRows((prev) => {
        const next = new Map(prev);
        const existing = next.get(id) || {};
        // If value matches original, remove it from dirty
        if (value === row[colKey] || (value === '' && row[colKey] == null)) {
          const rest = { ...existing };
          delete rest[colKey];
          if (Object.keys(rest).length === 0) {
            next.delete(id);
          } else {
            next.set(id, rest);
          }
        } else {
          next.set(id, { ...existing, [colKey]: value });
        }
        return next;
      });
    },
    [rowKey]
  );

  const handleEnterEdit = () => {
    setEditMode(true);
    onEditModeChange?.(true);
    setEditPage(0);
    setDirtyRows(new Map());
  };

  const handleCancelEdit = () => {
    setEditMode(false);
    setDirtyRows(new Map());
    setCancelConfirmationOpen(false);
    onEditModeChange?.(false);
  };

  const handleRequestCancelEdit = () => {
    requestEditCancel(dirtyCount, handleCancelEdit, () => setCancelConfirmationOpen(true));
  };

  const handleSave = async () => {
    // Never save edits to rows a failed load has hidden from view.
    if (!onSave || dirtyCount === 0 || loadError) return;
    setSaving(true);
    try {
      const shouldCloseEditMode = await onSave(dirtyRows);
      if (shouldCloseEditMode !== false) {
        setEditMode(false);
        setDirtyRows(new Map());
        onEditModeChange?.(false);
      }
    } catch {
      // parent handles error toast
    } finally {
      setSaving(false);
    }
  };

  const renderEditCell = (row: T, col: EditableColumn<T>) => {
    // Custom edit renderer takes priority over built-in editType
    if (col.editRender) {
      return col.editRender(
        row,
        (colKey) => getCellValue(row, colKey),
        (colKey, val) => setCellValue(row, colKey, val)
      );
    }

    const value = getCellValue(row, col.key);

    if (col.editType === 'toggle') {
      return (
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => setCellValue(row, col.key, e.target.checked)}
            className="sr-only peer"
          />
          <div className="relative w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-crx-green/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-crx-green" />
        </label>
      );
    }

    if (col.editType === 'select' && col.editOptions) {
      return (
        <select
          aria-label={typeof col.editAriaLabel === 'function' ? col.editAriaLabel(row) : col.editAriaLabel ?? col.header}
          value={String(value ?? '')}
          onChange={(e) => setCellValue(row, col.key, e.target.value)}
          className="w-full px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 bg-white"
        >
          <option value="">—</option>
          {col.editOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    if (col.editType === 'number' || col.editType === 'decimal') {
      return (
        <input
          type="number"
          aria-label={typeof col.editAriaLabel === 'function' ? col.editAriaLabel(row) : col.editAriaLabel ?? col.header}
          value={value != null ? String(value) : ''}
          min={col.editMin ?? 0}
          step={col.editStep ?? 'any'}
          onChange={(e) => {
            const raw = e.target.value;
            setCellValue(
              row,
              col.key,
              raw === '' ? null : col.editType === 'decimal' ? raw : parseFloat(raw),
            );
          }}
          className="w-full px-2 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
        />
      );
    }

    // Default: text
    return (
      <input
        type="text"
        value={String(value ?? '')}
        onChange={(e) => setCellValue(row, col.key, e.target.value)}
        className="w-full px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
      />
    );
  };

  return (
    <div>
      {/* Header row: search + filters + edit controls */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="flex flex-col sm:flex-row gap-3 flex-1">
          {searchable && (
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setEditPage(0);
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
                  transition-colors"
              />
            </div>
          )}
          {filters && <div className="flex gap-2 flex-wrap">{filters}</div>}
        </div>

        {/* Edit mode controls */}
        <div className="flex flex-wrap gap-2 items-center shrink-0">
          {headerActions}
          {canEdit && !editMode && !loadError && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Pencil className="w-4 h-4" />}
              onClick={handleEnterEdit}
            >
              Edit
            </Button>
          )}
          {editMode && (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon={<X className="w-4 h-4" />}
                onClick={handleRequestCancelEdit}
                disabled={saving}
              >
                Cancel
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  icon={<Save className="w-4 h-4" />}
                  onClick={handleSave}
                  loading={saving}
                  disabled={dirtyCount === 0 || loadError}
                >
                  Save{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
                </Button>
                <OtherPageUnsavedCount count={otherPageDirtyCount} />
              </div>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      ) : loadError ? (
        <LoadFailedState onRetry={onRetry} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          action={emptyAction}
        />
      ) : (
        <div className="overflow-x-auto">
          {/* Every cell is locked while a save runs: a save closes edit mode and clears the edits it
              was handed, so anything typed meanwhile would vanish without being saved. */}
          <fieldset disabled={saving} className="min-w-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-4 py-3 text-left font-medium text-secondary ${col.className || ''}`}
                  >
                    {col.sortable ? (
                      <button
                        onClick={() => toggleSort(col.key)}
                        aria-label={`Sort by ${col.header}${sortKey === col.key ? (sortDir === 'asc' ? ', sorted ascending' : ', sorted descending') : ''}`}
                        className="inline-flex items-center gap-1 hover:text-nav-dark transition-colors"
                      >
                        {col.header}
                        {sortKey === col.key ? (
                          sortDir === 'asc' ? (
                            <ArrowUp className="w-3.5 h-3.5" />
                          ) : (
                            <ArrowDown className="w-3.5 h-3.5" />
                          )
                        ) : (
                          <ArrowUpDown className="w-3.5 h-3.5 opacity-40" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const id = String(row[rowKey]);
                const isDirty = dirtyRows.has(id);
                return (
                  <tr
                    key={id}
                    onClick={!editMode && onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={!editMode && onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } } : undefined}
                    tabIndex={!editMode && onRowClick ? 0 : undefined}
                    role={!editMode && onRowClick ? 'button' : undefined}
                    className={`
                      border-b border-gray-50 transition-colors
                      ${isDirty ? 'bg-amber-50' : ''}
                      ${!editMode && onRowClick ? 'cursor-pointer hover:bg-crx-green-tint focus:outline-none focus:ring-2 focus:ring-crx-green/30' : ''}
                    `}
                  >
                    {columns.map((col) => (
                      <td key={col.key} className={`px-4 py-2 ${col.className || ''}`}>
                        {editMode && col.editable
                          ? renderEditCell(row, col)
                          : col.render
                            ? col.render(row)
                            : (row[col.key] as ReactNode) ?? '-'}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </fieldset>
        </div>
      )}
      <EditPagination
        editing={editMode}
        loadError={loadError}
        total={filtered.length}
        page={currentEditPage}
        maxPage={maxEditPage}
        onPrevious={() => setEditPage((page) => Math.max(0, page - 1))}
        onNext={() => setEditPage((page) => Math.min(maxEditPage, page + 1))}
      />
      <UnsavedChangesModal
        open={isNavigationBlocked(blocker)}
        disableLeave={saving}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
      <ConfirmModal
        open={cancelConfirmationOpen}
        onClose={() => setCancelConfirmationOpen(false)}
        onConfirm={handleCancelEdit}
        title="Discard edits?"
        message={discardRowsMessage(dirtyCount)}
        confirmLabel="Discard edits"
        cancelLabel="Stay"
        variant="warning"
      />
    </div>
  );
}
