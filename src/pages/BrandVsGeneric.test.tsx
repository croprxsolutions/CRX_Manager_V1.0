/**
 * BrandVsGeneric.test.tsx — the Brand vs Generic page is read-only since DM-1
 * (docs/plans/2026-11-06-product-DM1-BUILD-SHEET.md section 6): it lists the mappings and the
 * comparison, says ingredients move to each product's Chemistry section, and offers no add, edit
 * or delete to anyone. The database freezes ingredient_map in the DM-1 database PR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const H = vi.hoisted(() => ({
  state: {
    role: 'admin' as 'admin' | 'sales_rep',
    products: [] as Array<Record<string, unknown>>,
    mappings: [] as Array<Record<string, unknown>>,
    lastInsert: null as { table: string; payload: Record<string, unknown> } | null,
    lastUpdate: null as { table: string; payload: Record<string, unknown> } | null,
    lastDelete: null as { table: string } | null,
    // When set, every later read of the product list fails.
    failProductReads: false,
  },
}));

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  function makeFrom(table: string) {
    const op = { type: 'select' as 'select' | 'insert' | 'update' | 'delete' };
    let range: [number, number] = [0, Number.MAX_SAFE_INTEGER];
    // Lists are read page by page: serve the requested slice with the full count.
    const page = (rows: Array<Record<string, unknown>>) =>
      ({ data: rows.slice(range[0], range[1] + 1), error: null, count: rows.length });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: (from: number, to: number) => { range = [from, to]; return builder; },
      insert: (p: Record<string, unknown>) => { op.type = 'insert'; H.state.lastInsert = { table, payload: p }; return builder; },
      update: (p: Record<string, unknown>) => { op.type = 'update'; H.state.lastUpdate = { table, payload: p }; return builder; },
      delete: () => { op.type = 'delete'; H.state.lastDelete = { table }; return builder; },
      then: (resolve: (v: unknown) => unknown) => {
        if (op.type !== 'select') return resolve({ data: [{ id: 'new-id' }], error: null });
        if (table === 'products') {
          return resolve(H.state.failProductReads
            ? { data: null, error: { message: 'connection reset' }, count: null }
            : page(H.state.products));
        }
        if (table === 'ingredient_map') return resolve(page(H.state.mappings));
        return resolve({ data: [], error: null });
      },
    };
    return builder;
  }
  return { ...actual, supabase: { from: (t: string) => makeFrom(t) }, checkMutationResult: vi.fn() };
});

// Admin cost comes from get_admin_cost_fields; the fixtures already carry it, so pass rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminNestedCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: H.state.role, profile: { role: H.state.role }, user: { id: 'u' } }),
}));
// Stable toast fn: the component keeps `toast` in fetchData's useCallback deps,
// so a fresh vi.fn() per render would change fetchData every render and re-fire
// the load effect in a loop (leaving the table stuck on skeletons). One shared fn.
vi.mock('../components/ui/Toast', () => {
  const toast = vi.fn();
  return { useToast: () => ({ toast }) };
});
vi.mock('../lib/sentry', () => ({ Sentry: new Proxy({}, { get: () => () => undefined }) }));

// Import AFTER mocks are registered.
import BrandVsGeneric from './BrandVsGeneric';

const ROUNDUP = { id: 'p1', product_name: 'Roundup PowerMAX', is_active: true };
const GENERIC = { id: 'p2', product_name: 'Generic Glyphosate', is_active: true };

beforeEach(() => {
  cleanup(); // guard against any DOM leaked from a prior test/file in a shared worker
  H.state.role = 'admin';
  H.state.products = [ROUNDUP, GENERIC];
  H.state.mappings = [];
  H.state.lastInsert = null;
  H.state.lastUpdate = null;
  H.state.lastDelete = null;
  H.state.failProductReads = false;
});

afterEach(() => cleanup());
const MAPPING = {
  id: 'm1',
  fallback_branded_product: 'Roundup PowerMAX',
  branded_ingredient: 'Glyphosate',
  generic_product_id: 'p2',
  generic_has_bulk: true,
  notes: 'Cheaper in bulk',
  generic_product: GENERIC,
};

describe('BrandVsGeneric — read-only ingredient map', () => {
  for (const role of ['admin', 'sales_rep'] as const) {
    it(`lists mappings with no write controls for ${role}`, async () => {
      H.state.role = role;
      H.state.mappings = [MAPPING];
      render(<BrandVsGeneric />);
      await waitFor(() => expect(screen.getAllByText('Cheaper in bulk').length).toBeGreaterThan(0));
      expect(screen.getAllByText('Generic Glyphosate').length).toBeGreaterThan(0);
      expect(screen.getByRole('note')).toHaveTextContent('This list is read-only');
      expect(screen.queryByRole('button', { name: /Add Mapping/i })).toBeNull();
      expect(screen.queryByLabelText(/Edit mapping/i)).toBeNull();
      expect(screen.queryByLabelText(/Delete mapping/i)).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(H.state.lastInsert).toBeNull();
      expect(H.state.lastUpdate).toBeNull();
      expect(H.state.lastDelete).toBeNull();
    });
  }

  it('the comparison still shows the mapped generic for a selected product', async () => {
    H.state.mappings = [MAPPING];
    render(<BrandVsGeneric />);
    await waitFor(() => expect(screen.getAllByText('Cheaper in bulk').length).toBeGreaterThan(0));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p1' } });
    expect(await screen.findByText('Price')).toBeInTheDocument();
  });

  it('a failed load shows the error and no rows', async () => {
    H.state.mappings = [MAPPING];
    H.state.failProductReads = true;
    render(<BrandVsGeneric />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Cheaper in bulk')).not.toBeInTheDocument();
  });
});
