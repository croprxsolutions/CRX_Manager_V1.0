/**
 * JobDetail.recipeTier.test.tsx — loading a recipe prices its lines at the job customer's tier.
 *
 * The page's customer list holds active customers only, and a recipe priced from that list fell
 * back to tier 1 when the job's customer was not on it. A job for an inactive tier-3 customer got
 * tier-1 recipe prices. The page now reads a customer missing from the list by id, and blocks
 * pricing when that read fails instead of assuming tier 1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, mockNavigate, mockCapture } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  mockCapture: vi.fn(),
}));

const CHAIN_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
  'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
  'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
  'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
  'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const m of CHAIN_METHODS) self[m] = () => self;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await (importOriginal() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    supabase: { from: mockFrom, rpc: mockRpc, storage: { from: vi.fn() } },
    checkMutationResult: vi.fn((result: { error?: unknown }) => {
      if (result?.error) throw result.error;
    }),
    assertRpcResult: vi.fn((d) => d),
    sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  };
});
vi.mock('../contexts/AuthContext', () => ({
  // A sales rep edits jobs and sees no cost, so the page reads no admin cost table.
  useAuth: () => ({ profile: { id: 'user-1', role: 'sales_rep', full_name: 'Test Rep' }, role: 'sales_rep' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: () => {} }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockCapture } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import JobDetail from './JobDetail';

// The job's customer is inactive, so the page's active-only customer list does not hold it.
const JOB = {
  id: 'job-1',
  job_number: 'J-0001',
  job_date: '2026-08-19',
  customer_id: 'cust-inactive',
  applicator_id: null,
  status: 'scheduled',
  customer: { farm_name: 'Old Farm' },
  vehicle: null,
  quote: null,
  quote_section: null,
  job_fields: [],
  job_chemicals: [],
  job_field_shares: [],
  applied_info: null,
};
const PRODUCT = {
  id: 'prod-1', product_name: 'Herbicide X', is_active: true, unit_size: 'gal', rate_unit: 'gal',
  current_cost: 5, tier1_price: 10, tier2_price: 9, tier3_price: 7,
};
const RECIPE = { id: 'recipe-1', name: 'Spring Mix', is_active: true };
const RECIPE_ITEM = {
  id: 'ri-1', recipe_id: 'recipe-1', product_id: 'prod-1', product_name: 'Herbicide X',
  quantity: 2, unit: 'gal', rate_per_acre: 1, sort_order: 0, notes: null, price_per_unit_cents: 0,
};

let customerByIdReads = 0;
let recipeItemReads = 0;

function serveTables(customerById: { data: unknown; error: unknown }) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') return buildChain({ data: JOB, error: null });
    if (table === 'customers') {
      // The list read pages with .range(); the by-id tier read ends in .maybeSingle().
      const chain = buildChain({ data: [{ id: 'cust-active', farm_name: 'Active Farm', assigned_tier: 1, is_active: true }], error: null });
      chain.maybeSingle = () => { customerByIdReads += 1; return buildChain(customerById); };
      return chain;
    }
    if (table === 'products') return buildChain({ data: [PRODUCT], error: null });
    if (table === 'blend_recipes') return buildChain({ data: [RECIPE], error: null });
    if (table === 'blend_recipe_items') { recipeItemReads += 1; return buildChain({ data: [RECIPE_ITEM], error: null }); }
    return buildChain({ data: [], error: null });
  });
}

async function loadRecipe() {
  const router = createMemoryRouter(
    [{ path: '/jobs/:id', element: <JobDetail /> }],
    { initialEntries: ['/jobs/job-1?tab=chemicals'] },
  );
  render(<RouterProvider router={router} />);
  fireEvent.click(await screen.findByRole('button', { name: /Select Recipe/ }));
  fireEvent.change(await screen.findByLabelText('Select recipe'), { target: { value: 'recipe-1' } });
  fireEvent.click(screen.getByRole('button', { name: /Load Recipe/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  customerByIdReads = 0;
  recipeItemReads = 0;
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('JobDetail recipe pricing tier', () => {
  it('prices a recipe at an inactive customer\'s own tier, read by id', async () => {
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null });
    await loadRecipe();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('from recipe')));
    expect(customerByIdReads).toBeGreaterThan(0);
    // Tier 3 is $7.00, not tier 1's $10.00.
    expect(screen.getByDisplayValue('700')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('1000')).not.toBeInTheDocument();
  });

  it('blocks pricing the recipe when the customer cannot be read, instead of using tier 1', async () => {
    const readError = { message: 'customer read failed' };
    serveTables({ data: null, error: readError });
    await loadRecipe();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      "This job's customer could not be loaded, so products cannot be priced. Refresh the page and try again.",
    ));
    expect(mockCapture).toHaveBeenCalledWith(readError, { tags: { source: 'fetch', action: 'load_job_customer_tier' } });
    expect(recipeItemReads).toBe(0);
    expect(screen.queryByDisplayValue('1000')).not.toBeInTheDocument();
  });
});
