import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Tags } from 'lucide-react';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Card from '../ui/Card';
import DataTable, { type Column } from '../ui/DataTable';
import { supabase, supabaseUntyped } from '../../lib/db';
import { sanitizeError } from '../../lib/errorSanitizer';
import { fetchAllRows, pageWithList } from '../../lib/pagedRead';
import { loadGroupingOpen } from '../../lib/productParentProposals';
import {
  buildNameBrandReport,
  NAME_BRAND_GROUP_LABELS,
  type BrandRow,
  type NameBrandGroup,
  type NameBrandProduct,
  type NameBrandReport,
  type NameBrandRow,
} from '../../lib/productNameBrands';
import { Sentry } from '../../lib/sentry';

type GroupFilter = NameBrandGroup | 'ALL';

interface Loaded {
  report: NameBrandReport;
  parentNames: ReadonlyMap<string, string>;
  loadedAt: Date;
}

interface OwnBrandRow extends BrandRow { product_id: string }
interface ParentBrandRow extends BrandRow { parent_id: string; status: string }
interface MemberRow { product_id: string; parent_id: string }
interface ParentRow { id: string; name: string }

function rowsOrThrow<T>(result: { data: T[] | null; error: { message: string } | null }): T[] {
  if (result.error) throw result.error;
  return result.data ?? [];
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
}

// Six reads, all or nothing: a failed brand read must never make branded products look like they have no list.
async function loadReport(): Promise<Omit<Loaded, 'loadedAt'>> {
  const [products, ownBrands, members, parents, parentBrands, groupingOpen] = await Promise.all([
    fetchAllRows<NameBrandProduct>((from, to) => pageWithList(supabase
      .from('products')
      .select('id, product_name, is_active', { count: 'exact' })
      .order('product_name')
      .order('id')
      .range(from, to))).then(rowsOrThrow),
    fetchAllRows<OwnBrandRow>((from, to) => pageWithList(supabase
      .from('product_brands')
      .select('id, product_id, brand_name, is_currently_sourced', { count: 'exact' })
      .order('id')
      .range(from, to))).then(rowsOrThrow),
    // Untyped client: the parent tables are not in the generated types yet.
    fetchAllRows<MemberRow>((from, to) => pageWithList(supabaseUntyped
      .from('product_parent_members')
      .select('product_id, parent_id', { count: 'exact' })
      .order('product_id')
      .range(from, to))).then(rowsOrThrow),
    fetchAllRows<ParentRow>((from, to) => pageWithList(supabaseUntyped
      .from('product_parents')
      .select('id, name', { count: 'exact' })
      .order('id')
      .range(from, to))).then(rowsOrThrow),
    fetchAllRows<ParentBrandRow>((from, to) => pageWithList(supabaseUntyped
      .from('product_parent_brands')
      .select('id, parent_id, brand_name, status, is_currently_sourced', { count: 'exact' })
      .order('id')
      .range(from, to))).then(rowsOrThrow),
    loadGroupingOpen(),
  ]);
  const report = buildNameBrandReport(products, {
    parentOf: new Map(members.map((member) => [member.product_id, member.parent_id])),
    ownBrands: groupBy(ownBrands, (row) => row.product_id),
    activeParentBrands: groupBy(parentBrands.filter((row) => row.status === 'active'), (row) => row.parent_id),
    groupingOpen,
  });
  return { report, parentNames: new Map(parents.map((parent) => [parent.id, parent.name])) };
}

function BrandChips({ label, names, tone }: { label: string; names: string[]; tone: 'warning' | 'info' | 'default' }) {
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-secondary">{label}:</span>
      {names.map((name) => <Badge key={name} variant={tone}>{name}</Badge>)}
    </div>
  );
}

function RowDetails({ row, parentNames }: { row: NameBrandRow; parentNames: ReadonlyMap<string, string> }) {
  const listOnly = row.onListOnly.map((brand) => (brand.isCurrentlySourced ? brand.name : `${brand.name} (not currently sourced)`));
  return (
    <div className="space-y-1">
      {row.group === 'no_list' && <BrandChips label="Brands in the name" names={row.nameBrands.brands} tone="info" />}
      {row.group === 'no_name_brands' && <BrandChips label="On the brand list" names={listOnly} tone="default" />}
      {row.group === 'disagrees' && (
        <>
          <BrandChips label="In the name, not on the list" names={row.inNameOnly} tone="warning" />
          <BrandChips label="On the list, not in the name" names={listOnly} tone="warning" />
          {row.spelledDifferently.map((pair) => (
            <p key={`${pair.inName}|${pair.onList.name}`} className="text-xs text-amber-800">
              Spelled differently? “{pair.inName}” in the name, “{pair.onList.name}” on the list
            </p>
          ))}
        </>
      )}
      {row.nameBrands.maybeCutOff && (
        <p className="text-xs text-amber-800">“{row.nameBrands.maybeCutOff}” may be cut off: fix the name rather than add it as a brand.</p>
      )}
      {row.parentId && <p className="text-xs text-secondary">Brand list from parent “{parentNames.get(row.parentId) ?? 'unknown'}”</p>}
    </div>
  );
}

function ProductCell({ row }: { row: NameBrandRow }) {
  return (
    <div className="space-y-1">
      <Link to={`/products/${row.productId}`} className="text-crx-green underline hover:text-crx-green-dark">{row.productName}</Link>
      <div className="flex flex-wrap gap-1">
        {!row.isActive && <Badge variant="default">Inactive</Badge>}
        {row.nameBrands.unclosed && <Badge variant="warning">Bracket not closed in the name</Badge>}
      </div>
    </div>
  );
}

const FILTERS: GroupFilter[] = ['ALL', 'disagrees', 'no_list', 'no_name_brands', 'unclosed_only'];

/**
 * CLN-3: product names whose bracketed brands differ from the product's brand list. Read-only: it only
 * reads tables and links each product to its page, where brands are edited as before.
 */
export default function NameBrandCheckSection() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GroupFilter>('ALL');
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await loadReport();
      // Only the latest load may show its result.
      if (sequence !== loadSequence.current) return;
      setLoaded({ ...result, loadedAt: new Date() });
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      Sentry.captureException(error instanceof Error ? error : new Error(sanitizeError(error)), {
        tags: { page: 'label_data_quality', action: 'load_name_brand_check' },
      });
      setLoaded(null);
      setLoadError(sanitizeError(error));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  const rows = useMemo(() => {
    const all = loaded?.report.rows ?? [];
    return filter === 'ALL' ? all : all.filter((row) => row.group === filter);
  }, [loaded, filter]);
  const parentNames = loaded?.parentNames ?? new Map<string, string>();

  const columns: Column<NameBrandRow>[] = [
    { key: 'productName', header: 'Product', render: (row) => <ProductCell row={row} /> },
    { key: 'group', header: 'Check', render: (row) => NAME_BRAND_GROUP_LABELS[row.group] },
    { key: 'details', header: 'Details', render: (row) => <RowDetails row={row} parentNames={parentNames} /> },
  ];

  const counts = (group: NameBrandGroup) => loaded?.report.rows.filter((row) => row.group === group).length ?? 0;

  return (
    <Card>
      <div className="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2">
            <Tags className="h-5 w-5 text-crx-green" />
            <h2 className="font-semibold text-nav-dark">Brands in product names</h2>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-secondary">
            Products whose name lists brands in brackets that differ from the product’s brand list. Open a product to fix its
            name or its brands. This check changes nothing.
          </p>
          {loaded && (
            <p className="mt-1 text-xs text-secondary">
              Loaded {loaded.loadedAt.toLocaleString()} · {loaded.report.agreeCount.toLocaleString()} agree
              {' · '}{loaded.report.neitherCount.toLocaleString()} have no brands in the name or the list
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          showChevron={false}
          icon={<RefreshCw className="h-4 w-4" />}
          loading={loading}
          disabled={loading}
          onClick={() => void load()}
        >
          Reload
        </Button>
      </div>
      {loadError && <p className="mb-3 text-sm text-red-700" role="alert">This check could not be loaded: {loadError}</p>}
      <DataTable
        data={rows}
        columns={columns}
        loading={loading && !loaded}
        loadError={Boolean(loadError)}
        onRetry={() => void load()}
        searchable
        searchPlaceholder="Search product names"
        searchKeys={['productName']}
        emptyTitle="No products to show"
        mobileRow={(row) => (
          <div className="space-y-1 px-4 py-3">
            <ProductCell row={row} />
            <p className="text-xs font-medium text-nav-dark">{NAME_BRAND_GROUP_LABELS[row.group]}</p>
            <RowDetails row={row} parentNames={parentNames} />
          </div>
        )}
        filters={(
          <select
            aria-label="Filter by check"
            value={filter}
            onChange={(event) => setFilter(event.target.value as GroupFilter)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          >
            {FILTERS.map((group) => (
              <option key={group} value={group}>
                {group === 'ALL' ? `All (${loaded?.report.rows.length ?? 0})` : `${NAME_BRAND_GROUP_LABELS[group]} (${counts(group)})`}
              </option>
            ))}
          </select>
        )}
      />
    </Card>
  );
}
