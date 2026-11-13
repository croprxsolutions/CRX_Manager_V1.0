import { useState, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import EmptyState, { LoadFailedState } from './EmptyState';
import { applyTableSearchSort, type SortDir } from '../../lib/tableSearchSort';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Rendered beside the header (outside the sort button), e.g. a HelpTip. */
  headerExtra?: ReactNode;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  searchable?: boolean;
  searchPlaceholder?: string;
  searchKeys?: string[];
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  filters?: ReactNode;
  /** Shown between the search/filter row and the rows, e.g. a selection bar. */
  belowFilters?: ReactNode;
  loading?: boolean;
  /** The rows failed to load: say so (with Try again when onRetry is set) instead of the empty message. */
  loadError?: boolean;
  onRetry?: () => void;
  /**
   * Optional CONTROLLED search/sort. When provided, the parent owns the in-table
   * search term and column sort (so it can reuse `applyTableSearchSort` to print
   * the exact displayed rows). When omitted, the table keeps its own internal
   * state — every existing caller is unaffected.
   */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  sortState?: { key: string | null; dir: SortDir };
  onSortChange?: (next: { key: string | null; dir: SortDir }) => void;
  /**
   * Phone layout (Style D in docs/workflows/UI_PATTERNS.md): below 768px each row renders
   * through this inside one white rounded list instead of the table. The row owns its own
   * tap targets; search, filters, empty and failed states stay shared with the table.
   */
  mobileRow?: (row: T) => ReactNode;
  /** The rows arrive already searched and sorted (a database page): show them as given. */
  serverSide?: boolean;
}

const PHONE_QUERY = '(max-width: 767px)';
const subscribePhone = (onChange: () => void) => {
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
// One layout at a time, so a long list is never rendered twice. No matchMedia (tests) = desktop.
const isPhoneNow = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;

/** The phone row renderer while the screen is phone-width, and the columns its sort select offers. */
function usePhoneLayout<T>(mobileRow: ((row: T) => ReactNode) | undefined, columns: Column<T>[]) {
  const isPhone = useSyncExternalStore(subscribePhone, isPhoneNow, () => false);
  const phoneRow = isPhone ? mobileRow : undefined;
  return { phoneRow, sortableColumns: phoneRow ? columns.filter((col) => col.sortable) : [] };
}

/** The phone list has no column headers, so its sort lives in a select. Renders nothing without sortable columns. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PhoneSortSelect<T extends Record<string, any>>({ columns, sortKey, sortDir, onChange }: {
  columns: Column<T>[];
  sortKey: string | null;
  sortDir: SortDir;
  onChange: (next: { key: string | null; dir: SortDir }) => void;
}) {
  if (columns.length === 0) return null;
  return (
    <select
      value={sortKey ? `${sortKey}:${sortDir}` : ''}
      onChange={(e) => {
        const [key, dir] = e.target.value.split(':');
        onChange(key ? { key, dir: dir as SortDir } : { key: null, dir: 'asc' });
      }}
      aria-label="Sort by"
      className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
    >
      <option value="">Sort: as listed</option>
      {columns.flatMap((col) => {
        const label = typeof col.header === 'string' ? col.header : col.key;
        return [
          <option key={`${col.key}:asc`} value={`${col.key}:asc`}>{label} ↑</option>,
          <option key={`${col.key}:desc`} value={`${col.key}:desc`}>{label} ↓</option>,
        ];
      })}
    </select>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function DataTable<T extends Record<string, any>>({
  data,
  columns,
  searchable,
  searchPlaceholder = 'Search...',
  searchKeys = [],
  onRowClick,
  emptyTitle = 'No data found',
  emptyDescription,
  emptyAction,
  filters,
  belowFilters,
  loading,
  loadError,
  onRetry,
  searchValue,
  onSearchChange,
  sortState,
  onSortChange,
  mobileRow,
  serverSide,
}: DataTableProps<T>) {
  const { phoneRow, sortableColumns } = usePhoneLayout(mobileRow, columns);
  // Internal fallback state — used only when the caller doesn't control it.
  const [searchInner, setSearchInner] = useState('');
  const [sortKeyInner, setSortKeyInner] = useState<string | null>(null);
  const [sortDirInner, setSortDirInner] = useState<SortDir>('asc');

  const controlledSearch = searchValue !== undefined && onSearchChange !== undefined;
  const controlledSort = sortState !== undefined && onSortChange !== undefined;

  const search = controlledSearch ? searchValue : searchInner;
  const setSearch = controlledSearch ? onSearchChange : setSearchInner;
  const sortKey = controlledSort ? sortState.key : sortKeyInner;
  const sortDir = controlledSort ? sortState.dir : sortDirInner;

  const filtered = useMemo(
    () => (serverSide ? data : applyTableSearchSort(data, searchKeys, search, sortKey, sortDir)),
    [serverSide, data, searchKeys, search, sortKey, sortDir]
  );

  const setSort = (next: { key: string | null; dir: SortDir }) => {
    if (controlledSort) {
      onSortChange(next);
    } else {
      setSortKeyInner(next.key);
      setSortDirInner(next.dir);
    }
  };

  const toggleSort = (key: string) => {
    const nextDir: SortDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';
    setSort(sortKey === key ? { key, dir: nextDir } : { key, dir: 'asc' });
  };


  return (
    <div>
      {(searchable || filters || sortableColumns.length > 0) && (
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          {searchable && (
            // sm:min-w-56: wide filter rows wrap instead of squeezing the search box; self-start keeps its icon centred.
            <div className="relative flex-1 sm:min-w-56 sm:self-start">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
                  transition-colors"
              />
            </div>
          )}
          {filters && <div className="flex gap-2 flex-wrap">{filters}</div>}
          <PhoneSortSelect columns={sortableColumns} sortKey={sortKey} sortDir={sortDir} onChange={setSort} />
        </div>
      )}
      {belowFilters}

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
      ) : phoneRow ? (
        <ul className="overflow-hidden rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
          {filtered.map((row, idx) => (
            <li key={idx}>{phoneRow(row)}</li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-cream-dark/50">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-4 py-3 text-left font-medium text-secondary ${col.className || ''}`}
                  >
                    <span className={col.headerExtra ? 'inline-flex items-center gap-2.5' : undefined}>
                    {col.sortable ? (
                      <button
                        onClick={() => toggleSort(col.key)}
                        aria-label={`Sort by ${typeof col.header === 'string' ? col.header : col.key}${sortKey === col.key ? (sortDir === 'asc' ? ', sorted ascending' : ', sorted descending') : ''}`}
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
                    {col.headerExtra}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => (
                <tr
                  key={idx}
                  onClick={() => onRowClick?.(row)}
                  onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  className={`
                    border-b border-gray-100 transition-colors even:bg-gray-50/50
                    ${onRowClick ? 'cursor-pointer hover:bg-crx-green-tint focus:outline-none focus:ring-2 focus:ring-crx-green/30' : ''}
                  `}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={`px-4 py-3 ${col.className || ''}`}>
                      {col.render
                        ? col.render(row)
                        : (row[col.key] as ReactNode) ?? '-'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
