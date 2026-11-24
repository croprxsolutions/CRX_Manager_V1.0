/**
 * QuoteBuilder.test.tsx — Tests for the quote builder page
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { todayInBusinessTz } from '../lib/dateUtils';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { Link, MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter, useParams } from 'react-router-dom';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockFrom,
  mockRpc,
  mockToast,
  mockNavigate,
  dirtyStates,
  mockGenerateQuotePdf,
  mockSendEmail,
  mockNotifyLargeOrder,
  mockTrackBusinessEvent,
  mockSendOrderConfirmedEmail,
  mockResetIdempotencyKey,
  quoteIdempotencyState,
  quoteIdempotencyHandles,
  sharedResetKeyFor,
} = vi.hoisted(() => {
  // Generations are PER SCOPE, mirroring the real hook's per-scope Map. A single
  // shared counter would let a reset on quote B change the key later handed back
  // for quote A, which the real hook never does — a test written against that
  // stub would be asserting a property of the mock, not of the page.
  const quoteIdempotencyState = {
    generations: new Map<string, number>(),
    generationFor(scope: string) { return this.generations.get(scope) ?? 0; },
    bump(scope: string) { this.generations.set(scope, this.generationFor(scope) + 1); },
    reset() { this.generations.clear(); },
  };
  // One handle per scope, created once — see the useIdempotencyKey mock below for
  // why identity stability is load-bearing rather than tidiness.
  const mockResetIdempotencyKey = vi.fn((scope: string = '') => { quoteIdempotencyState.bump(scope); });
  const sharedResetKeyFor = (scopeValue: string) => mockResetIdempotencyKey(scopeValue);
  const quoteIdempotencyHandles = new Map<string, {
    getKey: () => string;
    resetKey: () => void;
    resetKeyFor: (scopeValue: string) => void;
  }>();
  return {
    mockFrom: vi.fn(),
    mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
    mockToast: vi.fn(),
    mockNavigate: vi.fn(),
    dirtyStates: [] as boolean[],
    mockGenerateQuotePdf: vi.fn(() => ({ output: () => new Blob(['quote']) })),
    mockSendEmail: vi.fn(),
    mockNotifyLargeOrder: vi.fn(),
    mockTrackBusinessEvent: vi.fn(),
    mockSendOrderConfirmedEmail: vi.fn(),
    mockResetIdempotencyKey,
    quoteIdempotencyState,
    quoteIdempotencyHandles,
    sharedResetKeyFor,
  };
});

/**
 * Build a Supabase-like chain mock using real Promises.
 * Every chained method returns `self`, and `.then()` resolves with `result`.
 */
function buildChain(
  result: { data: unknown; error: unknown },
  onSelect?: (columns: unknown) => void,
): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) {
    self[m] = method;
  }
  self.select = (columns: unknown) => {
    onSelect?.(columns);
    return self;
  };
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

function buildPendingChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) {
    self[m] = method;
  }
  const promise = new Promise(() => {});
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

function buildUpdateChain(
  readResult: { data: unknown; error: unknown },
  updateResult: { data: unknown; error: unknown },
): Record<string, unknown> {
  let updated = false;
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['insert', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  self.update = (..._args: unknown[]) => {
    updated = true;
    return self;
  };
  self.select = (..._args: unknown[]) => self;
  const resolve = () => Promise.resolve(updated ? updateResult : readResult);
  self.then = (...args: Parameters<Promise<unknown>['then']>) => resolve().then(...args);
  self.catch = (...args: Parameters<Promise<unknown>['catch']>) => resolve().catch(...args);
  self.finally = (...args: Parameters<Promise<unknown>['finally']>) => resolve().finally(...args);
  return self;
}

// Fixtures already carry cost; the admin cost read (get_admin_cost_fields) passes rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
  withAdminNestedCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));

vi.mock('../lib/db', async () => {
  // Use the REAL sanitizeError. A hand-written stub shaped
  // `e instanceof Error ? e.message : …` re-implements the defect this PR fixes
  // and would stay green against a fully regressed screen; a stub that just
  // reads `.message` skips the redaction entirely, so schema-identifier leaks
  // could not be caught here either.
  const { sanitizeError } = await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  );
  // Use the REAL assertRpcResult for the same reason. The stub `vi.fn((d) => d)` is a
  // passthrough that never throws, which DELETES the ambiguous-reply path — an empty
  // payload with no error — from every test in this file. That path is precisely what
  // the F1 ordering exists to handle, so under the stub a screen that retires its
  // idempotency key before checking the reply stays green. Import the real one so the
  // defect can be expressed here at all (aliased-reset sweep, 2026-09-05).
  const { assertRpcResult } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const hasRpcCode = (error: { message?: string }, code: string) => (
    error.message === code
    || error.message?.startsWith(`${code}:`) === true
    || error.message?.startsWith(`${code} `) === true
  );
  // Quote history now comes from get_quote_versions (cost is admin-only, 20261019230000); the
  // fixtures still describe it as the quote_versions table, so serve the RPC from that table.
  const rpcWithQuoteVersions = (name: string, args?: unknown) => (name === 'get_quote_versions'
    ? Promise.resolve(mockFrom('quote_versions') as PromiseLike<{ data?: unknown; error?: unknown } | undefined>)
      .then((r) => ({ data: r?.data ?? [], error: r?.error ?? null }))
    : mockRpc(name, args));
  return {
    supabase: { from: mockFrom, rpc: rpcWithQuoteVersions },
    supabaseUntyped: { from: mockFrom, rpc: rpcWithQuoteVersions },
    checkMutationResult: vi.fn(),
    assertRpcResult,
    hasRpcCode,
    RpcErrorCodes: {
      AUTH_REQUIRED: 'AUTH_REQUIRED', ACTOR_MISMATCH: 'ACTOR_MISMATCH',
      INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE', BOOKING_QUANTITY_INVALID: 'BOOKING_QUANTITY_INVALID',
      BOOKING_PRODUCT_INVALID: 'BOOKING_PRODUCT_INVALID', BOOKING_OVERDRAWN: 'BOOKING_OVERDRAWN',
      BOOKING_CLOSED: 'BOOKING_CLOSED', EMPTY_DRAW: 'EMPTY_DRAW',
      BOOKED_PRICE_REQUIRED: 'BOOKED_PRICE_REQUIRED', COST_BASIS_REQUIRED: 'COST_BASIS_REQUIRED',
      DRAW_ALLOCATION_MISMATCH: 'DRAW_ALLOCATION_MISMATCH', QUOTE_STALE_WRITE: 'QUOTE_STALE_WRITE',
      CUSTOMER_STALE_WRITE: 'CUSTOMER_STALE_WRITE', COMMISSION_SPLIT_CONFLICT: 'COMMISSION_SPLIT_CONFLICT',
      IDEMPOTENCY_PAYLOAD_CONFLICT: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
      QUOTE_VERSION_LEGACY_UNTRUSTED: 'QUOTE_VERSION_LEGACY_UNTRUSTED',
      QUOTE_RESEND_REQUIRED: 'QUOTE_RESEND_REQUIRED',
    },
    rpcCodeDetail: (error: { message?: string }, code: string) => (
      hasRpcCode(error, code) ? (error.message ?? '').slice(code.length + 1).trim() : null
    ),
    rpcAuthErrorMessage: (error: { message?: string }) => (
      hasRpcCode(error, 'AUTH_REQUIRED') || hasRpcCode(error, 'ACTOR_MISMATCH')
        ? 'Your sign-in could not be verified. Refresh the page and try again.'
        : null
    ),
    sanitizeError,
  };
});

// The signed-in role; a test may change it to re-run the reference load (a role change does).
const authState = vi.hoisted(() => ({ role: 'admin' }));

// The credit line (To-Do 1.8) has its own tests; its RPC would consume these tests' save_quote answers.
// The saved tier re-read (KI-105) answers Tier 1, like the fixtures' customers; a test overrides it.
const mockReadAssignedTier = vi.hoisted(() => vi.fn(async (_customerId: string) => 1));
vi.mock('../components/quotes/QuoteCustomerChecks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/quotes/QuoteCustomerChecks')>()),
  QuoteCreditStatus: () => null,
}));
vi.mock('../lib/customerTier', () => ({ readAssignedTier: mockReadAssignedTier }));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: authState.role, full_name: 'Test Admin' }, role: authState.role }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../hooks/useIdempotencyKey', () => ({
  // The mock MUST honour intentScope. A scope-blind stub returns one key for every
  // quote, so a regression test for "quote B must not inherit A's unresolved key"
  // would pass against a completely unscoped hook — it would prove a property of
  // the mock rather than of the page. The real hook keys a Map by
  // [operation, userId, intentScope]; this mirrors the scope half of that.
  // The returned functions MUST be identity-stable per scope, as the real hook's
  // useCallback ones are. A fresh object literal per render looks harmless and is
  // not: `fetchQuote` takes `resetSaveQuoteIdempotencyKey` as a dependency, so an
  // unstable identity re-creates it every render, re-runs the load effect, and the
  // page loads forever — every test then sees only the skeleton. That is a defect
  // in the mock, not in the page, and it is exactly the shape a mock must not
  // introduce: it made a correct component look broken (#618 + #603 merge).
  useIdempotencyKey: (_operation: string, _userId: string, intentScope = '') => {
    const cached = quoteIdempotencyHandles.get(intentScope);
    if (cached) return cached;
    const handle = {
      getKey: () => `test-idem-key-${intentScope}-${quoteIdempotencyState.generationFor(intentScope)}`,
      resetKey: () => mockResetIdempotencyKey(intentScope),
      // One key per named scope until that scope is retired, as the real hook does.
      getKeyFor: (scopeValue: string) =>
        `test-idem-key-${scopeValue}-${quoteIdempotencyState.generationFor(scopeValue)}`,
      // Retires a NAMED scope rather than the rendered one, as the real hook does.
      // Without this the page could not retire the key of a quote it has left.
      //
      // Shared across every scope, because the real hook memoizes `resetKeyFor` on
      // [operation, userId] alone — it does NOT move when the scope changes. A
      // per-scope copy here would be stable within a scope and unstable across one,
      // which is precisely the identity change `fetchQuote` must not see.
      resetKeyFor: sharedResetKeyFor,
    };
    quoteIdempotencyHandles.set(intentScope, handle);
    return handle;
  },
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: (dirty: boolean) => {
    dirtyStates.push(dirty);
    return ({
    setDirty: vi.fn(),
    confirmNavigation: vi.fn(() => true),
    showModal: false,
    handleConfirm: vi.fn(),
    handleCancel: vi.fn(),
    });
  },
}));

const { mockSentryCaptureMessage, mockSentryCaptureException } = vi.hoisted(() => ({
  mockSentryCaptureMessage: vi.fn(),
  mockSentryCaptureException: vi.fn(),
}));
vi.mock('../lib/sentry', () => ({
  Sentry: { captureMessage: mockSentryCaptureMessage, captureException: mockSentryCaptureException },
}));

vi.mock('../lib/productParents', () => {
  const empty = { parents: [], byProduct: new Map(), index: new Map() };
  return { useProductParents: () => empty, searchProductParents: async () => [] };
});
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: mockNotifyLargeOrder, notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: mockTrackBusinessEvent }));
vi.mock('../lib/orderConfirmedEmail', () => ({ sendOrderConfirmedEmail: mockSendOrderConfirmedEmail }));
vi.mock('../lib/dateUtils', () => ({
  localDatePlusDays: vi.fn(() => '2026-04-15'),
  localToday: vi.fn(() => '2026-03-16'),
  todayInBusinessTz: vi.fn(() => '2026-03-16'),
  parseLocalDate: (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  },
}));
vi.mock('../components/quotes/PdfPagePreview', () => ({
  default: ({ blob }: { blob: Blob & { tag?: string } }) => <div data-testid="pdf-preview" data-tag={blob.tag} />,
}));
vi.mock('../lib/quotePdf', () => ({ downloadQuotePdf: vi.fn(), generateQuotePdf: mockGenerateQuotePdf }));
vi.mock('../lib/emailService', () => ({ sendEmail: mockSendEmail, pdfToBase64: vi.fn(), buildEmailHtml: vi.fn(() => '<p>test</p>') }));
vi.mock('../lib/rupCompliance', () => ({
  checkRUPCompliance: vi.fn().mockResolvedValue({ compliant: true, warnings: [], rupProductNames: [] }),
}));
// A stand-in with the real editor's percentage boxes (same labels), so a test can read and type the split.
vi.mock('../components/ui/CommissionSplitEditor', () => ({
  default: ({ value, onChange, disabled }: { value: { splits: Array<{ recipient: string; percentage: number }> }; onChange: (v: unknown) => void; disabled?: boolean }) => (
    <div data-testid="commission-split-editor">CommissionSplitEditor
      {value.splits.map((split, i) => (
        <input key={i} type="number" aria-label={`Commission percentage for split ${i + 1}`} data-recipient={split.recipient} value={split.percentage} disabled={disabled}
          onChange={(e) => onChange({ splits: value.splits.map((s, j) => (j === i ? { ...s, percentage: Number(e.target.value) } : s)) })} />
      ))}
    </div>
  ),
}));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));
// Has its own tests (LastChargedPrices.test.tsx); here a marker stands in, so its load and Retry stay
// out of these tests while who sees it is still checked.
const mockUseLastCharged = vi.hoisted(() => vi.fn());
vi.mock('../components/quotes/LastChargedPrices', () => ({ LastChargedPricesCard: () => <div data-testid="last-charged-card" /> }));
vi.mock('../hooks/useLastChargedPrices', () => ({
  // A test may return loaded data from mockUseLastCharged; otherwise it stays loading.
  useLastChargedPrices: (...args: unknown[]) => mockUseLastCharged(...args)
    ?? { products: [], state: { status: 'loading' }, retry: () => {} },
}));

import { preferredQuoteNotes } from '../lib/quoteNotes';
import QuoteBuilder from './QuoteBuilder';
import { downloadQuotePdf } from '../lib/quotePdf';
import { PRODUCT_COLUMNS, QUOTE_ITEM_COLUMNS } from '../lib/costFields';
// The REAL provider, not a stand-in. The hazard these tests cover is a property
// of the real one: it is mounted above the route, so its approval dialog — and
// the retry parked behind it — survive a navigation between quotes.
import { BelowCostApprovalProvider } from '../contexts/BelowCostApprovalContext';

function renderQuoteBuilder(id?: string) {
  const path = id ? `/quotes/${id}/edit` : '/quotes/new';
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/quotes/new" element={<QuoteBuilder />} />
        <Route path="/quotes/:id/edit" element={<QuoteBuilder />} />
      </Routes>
    </MemoryRouter>,
  );
}

// Save is enabled only while the quote has unsaved changes (repeated clicks on an unchanged
// quote sent duplicate saves), so a test that saves makes one real edit first. It types into
// the bottom note, which no test here asserts.
async function makeAnEdit(text = 'Edited before saving') {
  fireEvent.change(await screen.findByLabelText('Note at the bottom of the quote'), { target: { value: text } });
}

/**
 * Jump from one quote to another WITHOUT unmounting QuoteBuilder — the same reused
 * instance production gets, because no `<x>/:id` route in src/App.tsx carries a
 * `key` prop. A `<Link>` is used rather than `useNavigate`, which this file mocks.
 */
function renderQuoteBuilderWithQuoteSwitch(fromId: string, toId: string) {
  return render(
    <MemoryRouter initialEntries={[`/quotes/${fromId}/edit`]}>
      <Link to={`/quotes/${toId}/edit`}>Jump to quote B</Link>
      <Routes>
        <Route path="/quotes/:id/edit" element={<QuoteBuilder />} />
      </Routes>
    </MemoryRouter>,
  );
}

// A RECENT timestamp, not a literal. These fixtures once hardcoded
// a fixed created_at of 2026‑07‑25T00:00:00Z — a time bomb: useStaleQuoteCheck computes
// floor((Date.now() − created_at) / day) > 30, so on 2026-08-25T00:00:00Z (exactly
// created + 31 days) every conversion-path test silently detoured into the
// stale-quote guard and CI went permanently red on EVERY branch at midnight UTC.
// Five days old keeps the fixtures far from the staleness threshold forever, and a
// midnight-anchored ISO string keeps the rendered date deterministic within a run.
const RECENT_QUOTE_CREATED_AT = `${new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;

// The quote header read embeds its customer (customer:customers(*)); the page takes the customer's
// name and contact details from it, and refuses to save a quote whose customer did not load.
const QUOTE_FIXTURE_CUSTOMER = { id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true };

function makeQuoteFixture(status: 'draft' | 'sent' | 'revised' | 'accepted' = 'draft', rowVersion?: number) {
  const quote = {
    id: `quote-${status}-${rowVersion ?? 'legacy'}`,
    quote_number: 'Q-version-test',
    customer_id: 'customer-1',
    customer: QUOTE_FIXTURE_CUSTOMER,
    created_by: 'user-1',
    tier: 1,
    valid_days: 30,
    header_notes: 'Version test header',
    footer_notes: '',
    status,
    is_planned: false,
    commission_split: { splits: [] },
    created_at: RECENT_QUOTE_CREATED_AT,
    // The expiry a send stores; the emailed PDF shows it (20261027040000).
    expires_at: '2026-11-25',
    ...(rowVersion === undefined ? {} : { row_version: rowVersion }),
  };
  const product = {
    id: 'product-1',
    product_name: 'Product',
    is_active: true,
    current_cost: 6,
    tier1_price: 10,
    unit_size: 'gal',
    inventory_unit: 'gal',
  };
  const section = {
    id: 'section-1',
    quote_id: quote.id,
    section_name: 'Products',
    sort_order: 0,
    section_notes: null,
    section_header_notes: null,
    needed_by_date: null,
    field_id: null,
  };
  const item = {
    id: 'item-1',
    quote_id: quote.id,
    section_id: section.id,
    product_id: product.id,
    sort_order: 0,
    product,
    calc_mode: 'units_direct',
    total_units_needed: 2,
    price_per_unit: 10,
    price_override: null,
    current_cost: 6,
    suggested_rate: null,
    actual_rate: null,
    rate_unit: null,
    oz_per_acre: null,
    price_per_acre: null,
    acres: null,
    unit_size: 'gal',
    profit: 8,
    total_price: 20,
    net_margin: 40,
    notes: null,
    price_unit: null,
  };
  return { quote, product, section, item };
}

function configureDrawDownFixture(
  drawError: { message: string; details?: string; code?: string },
  { failRecoveryLoad = false }: { failRecoveryLoad?: boolean } = {},
) {
  const fixture = makeQuoteFixture('sent', 7);
  let quoteItemReads = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'quote_items') quoteItemReads += 1;
    if (table === 'quote_items' && failRecoveryLoad && quoteItemReads >= 3) {
      return buildChain({ data: null, error: { message: 'booking balance unavailable' } });
    }
    const data = table === 'quotes'
      ? fixture.quote
      : table === 'quote_sections'
        ? [fixture.section]
        : table === 'quote_items'
          ? [fixture.item]
          : table === 'customers'
            ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
            : table === 'products'
              ? [fixture.product]
              : [];
    return buildChain({ data, error: null });
  });
  mockRpc.mockImplementation((name: string) => Promise.resolve(
    name === 'draw_down_quote'
      ? { data: null, error: drawError }
      : { data: null, error: null },
  ));
  return { ...fixture, quoteItemReads: () => quoteItemReads };
}

async function submitOneUnitDraw(quoteId: string) {
  renderQuoteBuilder(quoteId);
  const createOrderButton = await screen.findByRole('button', { name: 'Create order' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
  fireEvent.click(createOrderButton);
  fireEvent.click(await screen.findByRole('menuitem', { name: /Draw part of booking/ }));
  expect(mockToast).not.toHaveBeenCalledWith('warning', 'Save the quote before drawing down the booking');
  const dialog = await screen.findByRole('dialog', { name: 'Create order from booking' });
  const quantity = await within(dialog).findByRole('spinbutton', { name: 'Quantity to draw for Product' });
  fireEvent.change(quantity, { target: { value: '1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
}

// The by-id read of a saved quote's section fields, held open until the test releases it.
function holdFieldReadById() {
  let release!: (result: { data: unknown; error: unknown }) => void;
  const read = new Promise<{ data: unknown; error: unknown }>((resolve) => { release = resolve; });
  let readsById = 0;
  const fieldsChain = () => {
    let byId = false;
    const self: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'order', 'limit', 'range', 'ilike', 'is']) self[m] = () => self;
    self.in = () => { byId = true; readsById += 1; return self; };
    const settle = () => (byId ? read : Promise.resolve({ data: [], error: null }));
    self.then = (...args: Parameters<Promise<unknown>['then']>) => settle().then(...args);
    self.catch = (...args: Parameters<Promise<unknown>['catch']>) => settle().catch(...args);
    self.finally = (...args: Parameters<Promise<unknown>['finally']>) => settle().finally(...args);
    return self;
  };
  return { fieldsChain, release, read, readsById: () => readsById };
}

const FAR_FIELD_FARM = { id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true };
const HOME_QUARTER_OF_CUSTOMER_1 = { id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 80, measured_acres: null, override_acres: null };

// Picks Far Field Farm while the saved field is loading, then lets the field (the original
// customer's) arrive: the only path that clears a saved section field on open.
async function pickCustomerThenReleaseField(held: ReturnType<typeof holdFieldReadById>, afterPick?: () => void) {
  await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));
  const customerBox = screen.getByRole('combobox', { name: 'Customer' });
  fireEvent.change(customerBox, { target: { value: 'Far' } });
  fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
  expect(customerBox).toHaveValue('Far Field Farm');
  afterPick?.();
  await act(async () => {
    held.release({ data: [HOME_QUARTER_OF_CUSTOMER_1], error: null });
    await held.read;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('QuoteBuilder', () => {
  const NOTES_PLACEHOLDER = 'Notes visible at the top of the quote...';
  const openMoreMenu = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    return within(screen.getByRole('menu')).getAllByRole('menuitem').map((el) => el.textContent);
  };

  it.each([
    { role: 'sales_rep', creator: 'other-user', locked: true },
    { role: 'sales_rep', creator: null, locked: true },
    { role: 'sales_rep', creator: 'user-1', locked: false },
    { role: 'admin', creator: 'other-user', locked: false },
  ])('keeps draft edits creator/admin-only: $role, creator $creator', async ({ role, creator, locked }) => {
    authState.role = role;
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, created_by: creator, salesman_id: 'user-1' };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote
      : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [fixture.item]
        : table === 'products' ? [fixture.product] : [], error: null }));
    renderQuoteBuilder(quote.id);
    const notes = await screen.findByPlaceholderText(NOTES_PLACEHOLDER);
    for (const control of [notes, screen.getByRole('combobox', { name: 'Customer' }),
      screen.getByRole('spinbutton', { name: 'Quantity' }), screen.getByPlaceholderText('Section name')]) {
      if (locked) expect(control).toBeDisabled(); else expect(control).toBeEnabled();
    }
    if (locked) {
      expect(screen.getByText(/Only this draft’s creator or an admin can edit it/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Save draft/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument();
      expect(screen.queryByText('Add a section')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Preview & send' })).not.toBeInTheDocument();
    } else {
      expect(screen.queryByText(/Only this draft’s creator/)).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /Save draft/ }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('button', { name: 'Preview & send' }).length).toBeGreaterThan(0);
    }
    const menu = await openMoreMenu();
    expect(menu.includes('Book as order')).toBe(!locked);
    expect(menu.includes('Cancel quote')).toBe(!locked);
    expect(menu).toContain('Download PDF');
    expect(mockRpc.mock.calls.some(([name]) => name === 'save_quote')).toBe(false);
  });

  it('keeps Schedule job working on another rep’s planned draft without saving the draft', async () => {
    authState.role = 'sales_rep';
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, created_by: 'other-user', is_planned: true };
    const section = { ...fixture.section, field_id: 'field-1' };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote
      : table === 'quote_sections' ? [section] : table === 'quote_items' ? [fixture.item]
        : table === 'products' ? [fixture.product] : table === 'fields' ? [HOME_QUARTER_OF_CUSTOMER_1] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === 'create_job_from_quote_section' ? { job_id: 'job-1881' } : null, error: null,
    }));
    renderQuoteBuilder(quote.id);
    const schedule = await screen.findByRole('button', { name: 'Schedule job' });
    expect(schedule).toBeEnabled();
    expect(screen.getByText(/Only this draft’s creator or an admin can edit it/)).toBeInTheDocument();
    fireEvent.click(schedule);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule anyway' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('create_job_from_quote_section', expect.objectContaining({
      p_quote_id: quote.id, p_section_id: section.id, p_performed_by: 'user-1',
    })));
    expect(mockRpc.mock.calls.some(([name]) => name === 'save_quote')).toBe(false);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-1881'));
  });

  it('keeps another rep’s revised booking price edits available', async () => {
    authState.role = 'sales_rep';
    const fixture = makeQuoteFixture('sent', 7);
    const quote = { ...fixture.quote, status: 'revised', created_by: 'other-user' };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote
      : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [fixture.item]
        : table === 'products' ? [fixture.product] : [], error: null }));
    renderQuoteBuilder(quote.id);
    expect(await screen.findByRole('spinbutton', { name: 'Price per unit' })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: /Save changes/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Only this draft’s creator/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Create order' })[0]).toBeEnabled();
  });

  it('lets a rep create a draft, follow the saved route and keep editing and saving it', async () => {
    authState.role = 'sales_rep';
    const fixture = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? fixture.quote
      : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [fixture.item]
        : table === 'products' ? [fixture.product] : table === 'customers' ? [{ ...QUOTE_FIXTURE_CUSTOMER, default_commission_split: { splits: [] } }] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'save_quote'
      ? { quote_id: fixture.quote.id, row_version: 7, item_ids: {} }
      : name === 'generate_quote_number' ? 'Q-new-owner' : null, error: null }));
    const router = createMemoryRouter([{ path: '/quotes/new', element: <QuoteBuilder /> },
      { path: '/quotes/:id', element: <QuoteBuilder /> }], { initialEntries: ['/quotes/new'] });
    mockNavigate.mockImplementation((path: string) => { void router.navigate(path); });
    const view = render(<RouterProvider router={router} />);
    try {
      fireEvent.change(await screen.findByRole('combobox', { name: 'Customer' }), { target: { value: 'Farm' } });
      fireEvent.click(await screen.findByRole('option', { name: /Farm/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Add one' }));
      fireEvent.click(screen.getByRole('button', { name: /Select product/i }));
      const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
      fireEvent.click(within(picker.closest('[role="dialog"]') as HTMLElement).getAllByText(fixture.product.product_name).slice(-1)[0]);
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantity' }), { target: { value: '2' } });
      fireEvent.click(screen.getAllByRole('button', { name: /Save draft/ })[0]);
      await waitFor(() => expect(router.state.location.pathname).toBe(`/quotes/${fixture.quote.id}`));
      const notes = await screen.findByDisplayValue(fixture.quote.header_notes);
      expect(notes).toBeEnabled();
      expect(screen.getByRole('spinbutton', { name: 'Quantity' })).toBeEnabled();
      expect(screen.queryByText(/Only this draft’s creator/)).not.toBeInTheDocument();
      fireEvent.change(notes, { target: { value: 'Own follow-up edit' } });
      fireEvent.click(screen.getAllByRole('button', { name: /Save draft/ })[0]);
      await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote')).toHaveLength(2));
      expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({ p_quote_id: fixture.quote.id,
        p_quote_payload: expect.objectContaining({ header_notes: 'Own follow-up edit' }) }));
    } finally {
      view.unmount();
      mockNavigate.mockReset();
      router.dispose();
    }
  });

  it('refuses an already-open Book as order confirmation after admin access changes to a non-owner rep', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, created_by: 'other-user' };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote
      : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [fixture.item]
        : table === 'products' ? [fixture.product] : [], error: null }));
    const view = renderQuoteBuilder(quote.id);
    await openMoreMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Book as order' }));
    await screen.findByRole('alertdialog', { name: 'Book as order?' });
    authState.role = 'sales_rep';
    view.rerender(<MemoryRouter initialEntries={[`/quotes/${quote.id}/edit`]}><Routes>
      <Route path="/quotes/:id/edit" element={<QuoteBuilder />} />
    </Routes></MemoryRouter>);
    const dialog = await screen.findByRole('alertdialog', { name: 'Book as order?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Book as order' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Only this draft’s creator or an admin can edit it.'));
    expect(mockRpc.mock.calls.some(([name]) => ['save_quote', 'create_quote_version', 'convert_quote_to_order'].includes(name))).toBe(false);
  });

  it.each(['admin', 'sales_rep'])('uses line-rounded totals in the %s save payload without exposing costs', async (role) => {
    authState.role = role;
    const { quote, product: baseProduct, section, item } = makeQuoteFixture('draft', 7);
    const product = { ...baseProduct, current_cost: role === 'admin' ? 0.01 : 0, tier1_price: 1 };
    const items = ['item-a', 'item-b'].map((id) => ({ ...item, id, product, current_cost: product.current_cost,
      price_per_unit: 1, total_units_needed: 0.5, total_price: 0.5, profit: role === 'admin' ? 0.49 : 0, net_margin: 98 }));
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote
      : table === 'quote_sections' ? [section] : table === 'quote_items' ? items
        : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'save_quote' ? { quote_id: quote.id, row_version: 8 } : null, error: null }));
    renderQuoteBuilder(quote.id);
    const summary = await screen.findByRole('region', { name: 'Summary' });
    const figure = (label: string) => within(summary).queryByText(label)?.nextElementSibling?.textContent;
    await waitFor(() => expect(figure('Quote total')).toBe('$1.00'));
    if (role === 'admin') {
      expect(figure('Total cost')).toBe('$0.02');
      expect(figure('Profit · margin')).toContain('$0.98');
      expect(figure('Profit · margin')).toContain('98.0%');
    } else {
      expect(within(summary).queryByText('Total cost')).not.toBeInTheDocument();
      expect(within(summary).queryByText('Profit · margin')).not.toBeInTheDocument();
    }
    fireEvent.change(screen.getByPlaceholderText(NOTES_PLACEHOLDER), { target: { value: 'Totals check' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Save draft/ })[0]);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ total_price: 1, total_cost: role === 'admin' ? 0.02 : 0,
        total_profit: role === 'admin' ? 0.98 : 1, total_margin_pct: role === 'admin' ? 98 : 100 }),
    })));
  });

  it('prefers customer-facing quoting guidance and falls back to the grower description', () => {
    expect(preferredQuoteNotes({ quoting_notes: 'Customer quote guidance', notes: 'Grower copy' }))
      .toBe('Customer quote guidance');
    expect(preferredQuoteNotes({ quoting_notes: null, notes: 'Grower copy' }))
      .toBe('Grower copy');
    expect(preferredQuoteNotes({ quoting_notes: '   ', notes: '  Grower copy  ' }))
      .toBe('Grower copy');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    quoteIdempotencyState.reset();
    quoteIdempotencyHandles.clear();
    sessionStorage.clear();
    dirtyStates.length = 0;
    authState.role = 'admin';
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === 'generate_quote_number' ? 'Q-2026-0042' : null, error: null,
    }));
    mockSendEmail.mockResolvedValue({ deduplicated: false });
  });

  it('prices from the searched customer\'s tier and clears a section field of another customer', async () => {
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'customers'
        ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }]
        : table === 'fields'
          ? [{ id: 'field-9', field_name: 'North Forty', customer_id: 'customer-9', total_acres: 40, measured_acres: null, override_acres: null }]
          : [],
      error: null,
    }));
    renderQuoteBuilder();

    const fieldBox = await screen.findByRole('combobox', { name: 'Field for Section 1' });
    fireEvent.change(fieldBox, { target: { value: 'No' } });
    fireEvent.click(await screen.findByRole('option', { name: /North Forty/ }));
    expect(fieldBox).toHaveValue('North Forty');

    const customerBox = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));

    expect(customerBox).toHaveValue('Far Field Farm');
    expect(screen.getByDisplayValue('Tier 3')).toBeInTheDocument();
    // North Forty belongs to another customer, so the section no longer names it, and the
    // user is told to check that section's acres (Luna, #1017).
    await waitFor(() => expect(fieldBox).toHaveValue(''));
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining("Check those lines' acres"));
  });

  it('drops the acres a cleared section field filled in when the customer changes, and keeps typed acres', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const typedItem = { ...item, id: 'item-2', sort_order: 1, acres: 15 };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item, typedItem]
            : table === 'customers'
              ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }]
              : table === 'fields'
                ? [{ id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 80, measured_acres: 40, override_acres: null }]
                : table === 'products'
                  ? [product]
                  : [],
      error: null,
    }));
    renderQuoteBuilder(quote.id);

    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    // The second line's acres are typed by hand, and happen to equal the field's.
    await waitFor(() => expect(screen.getAllByLabelText('Acres')).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText('Acres')[1], { target: { value: '40' } });
    fireEvent.change(fieldBox, { target: { value: 'Ho' } });
    fireEvent.click(await screen.findByRole('option', { name: /Home Quarter/ }));
    // The pick fills the empty line's acres from the field (measured before total); typed acres stay.
    await waitFor(() => expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['40', '40']));

    const customerBox = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));

    // Home Quarter belongs to another customer: the section drops it and the acres it filled in.
    await waitFor(() => expect(fieldBox).toHaveValue(''));
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['', '40']);
  });

  it('drops the acres a field filled in when the field is cleared or replaced by hand, and keeps typed acres', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const typedItem = { ...item, id: 'item-2', sort_order: 1, acres: 15 };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item, typedItem]
            : table === 'fields'
              ? [
                { id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 40, measured_acres: null, override_acres: null },
                { id: 'field-2', field_name: 'North Eighty', customer_id: 'customer-1', total_acres: 80, measured_acres: null, override_acres: null },
              ]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    renderQuoteBuilder(quote.id);
    const acres = () => screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(acres()).toHaveLength(2));

    fireEvent.change(fieldBox, { target: { value: 'Ho' } });
    fireEvent.click(await screen.findByRole('option', { name: /Home Quarter/ }));
    await waitFor(() => expect(acres()).toEqual(['40', '15']));

    // Replacing the field swaps in the new field's acres; the typed line is untouched.
    fireEvent.change(fieldBox, { target: { value: 'No' } });
    fireEvent.click(await screen.findByRole('option', { name: /North Eighty/ }));
    await waitFor(() => expect(acres()).toEqual(['80', '15']));

    // Clearing the field drops the acres it filled in.
    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    await waitFor(() => expect(fieldBox).toHaveValue(''));
    expect(acres()).toEqual(['', '15']);
  });

  it('refuses to clear a saved field while it is still loading, then clears it once loaded, keeping saved acres', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            ? [{ ...item, acres: 80 }]
            : table === 'products'
              ? [product]
              : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);
    const acres = () => screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value);
    await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    expect(mockToast).toHaveBeenCalledWith('error', "This section's field is still loading. Try again in a moment.");
    expect(acres()).toEqual(['80']);

    await act(async () => {
      held.release({ data: [{ ...HOME_QUARTER_OF_CUSTOMER_1, total_acres: 80 }], error: null });
      await held.read;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const fieldBox = screen.getByRole('combobox', { name: /^Field for/ });
    expect(fieldBox).toHaveValue('Home Quarter');
    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    await waitFor(() => expect(fieldBox).toHaveValue(''));
    expect(acres()).toEqual(['80']);
  });

  it('keeps a saved field whose read failed locked, with its acres and the refresh warning', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            ? [{ ...item, acres: 80 }]
            : table === 'products'
              ? [product]
              : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);
    await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));
    await act(async () => {
      held.release({ data: null, error: { message: 'fields unavailable' } });
      await held.read;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The read failed: the field cannot be cleared (its acres cannot be attributed, and clearing it
    // would drop the refresh-before-saving warning), and nothing changes.
    expect(screen.getByText("This quote's fields could not be loaded. Refresh the page before saving.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    expect(mockToast).toHaveBeenCalledWith('error', "This section's field could not be loaded. Refresh the page before changing it.");
    expect(screen.getByRole('button', { name: /^Clear field/ })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
    expect(screen.getByText("This quote's fields could not be loaded. Refresh the page before saving.")).toBeInTheDocument();
  });

  it('keeps a saved line\'s acres when its field is replaced after reopening, even when they match the old field', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            // Typed by hand as 80, the same as the saved field's acres; the source is not stored.
            ? [{ ...item, acres: 80 }]
            : table === 'fields'
              ? [
                { id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 80, measured_acres: null, override_acres: null },
                { id: 'field-2', field_name: 'North Field', customer_id: 'customer-1', total_acres: 120, measured_acres: null, override_acres: null },
              ]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    renderQuoteBuilder(quote.id);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(fieldBox).toHaveValue('Home Quarter'));

    fireEvent.change(fieldBox, { target: { value: 'No' } });
    fireEvent.click(await screen.findByRole('option', { name: /North Field/ }));
    await waitFor(() => expect(fieldBox).toHaveValue('North Field'));
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
    expect(mockToast).toHaveBeenCalledWith('warning', "This section's saved lines keep their acres. Check them against the new field.");
  });

  it('keeps a line\'s unit price when a late-loading foreign field is cleared', async () => {
    const { quote, product: baseProduct, section, item } = makeQuoteFixture('draft', 7);
    // Tier 3 differs from the tier-1 price the saved line starts at.
    const product = { ...baseProduct, tier3_price: 7 };
    const savedItem = { ...item, acres: 80, product };
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            ? [savedItem]
            : table === 'customers'
              ? [FAR_FIELD_FARM]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);

    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    // The customer pick re-prices the line for its tier; clearing the field afterwards must not
    // re-price it again.
    const unitPrice = () => (screen.getByLabelText('Price per unit') as HTMLInputElement).value;
    let priceAfterPick = '';
    await pickCustomerThenReleaseField(held, () => { priceAfterPick = unitPrice(); });
    expect(fieldBox).toHaveValue('');
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
    expect(Number(priceAfterPick)).toBe(7);
    expect(unitPrice()).toBe(priceAfterPick);
  });

  it('keeps a saved rate line\'s acres and total when its foreign field is cleared, product or not', async () => {
    const { quote, section, item } = makeQuoteFixture('draft', 7);
    const unreadableItem = {
      ...item, product: null, calc_mode: 'rate_acres', actual_rate: 1, rate_unit: 'gal',
      acres: 80, total_units_needed: 80, total_price: 800, profit: 320,
    };
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            ? [unreadableItem]
            : table === 'customers'
              ? [FAR_FIELD_FARM]
              : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);

    await screen.findByRole('combobox', { name: /^Field for/ });
    expect(screen.getAllByText('$800.00').length).toBeGreaterThan(0);
    await pickCustomerThenReleaseField(held);
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
    expect(screen.getAllByText('$800.00').length).toBeGreaterThan(0);
  });

  it('clears a saved section field of the original customer when it loads after another customer was picked', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const savedSection = { ...section, field_id: 'field-1' };
    // The saved line's acres came from its field; the second line's were typed.
    const fieldItem = { ...item, acres: 80 };
    const typedItem = { ...item, id: 'item-2', sort_order: 1, acres: 15 };
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [fieldItem, typedItem]
            : table === 'customers'
              ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    })));

    renderQuoteBuilder(quote.id);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    // While the saved field is still loading, the user picks a different customer; the saved
    // field then arrives: it belongs to the ORIGINAL customer, so the section drops it.
    await pickCustomerThenReleaseField(held);
    expect(fieldBox).toHaveValue('');
    expect(screen.queryByDisplayValue('Home Quarter')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80', '15']);
  });

  it('does not clear quote B\'s saved field when a field read started for quote A lands after the switch', async () => {
    const { quote: quoteA, product, section, item } = makeQuoteFixture('draft', 7);
    // B belongs to another customer but keeps the same saved field (it was moved after B was saved).
    const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header', customer_id: 'customer-2' };
    const savedSection = { ...section, field_id: 'field-1' };
    const savedItem = { ...item, acres: 80 };
    const held = holdFieldReadById();
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? (quoteReads++ === 0 ? quoteA : quoteB)
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [savedItem]
            : table === 'products'
              ? [product]
              : [],
      error: null,
    })));

    renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
    await screen.findByDisplayValue('Quote B header');

    // A's read lands while B is open: B was only opened, so its saved field and acres stay.
    await act(async () => {
      held.release({ data: [HOME_QUARTER_OF_CUSTOMER_1], error: null });
      await held.read;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole('combobox', { name: /^Field for/ })).toHaveValue('Home Quarter');
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
  });

  it('clears a foreign saved field when the customer is picked away and back while the field loads', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const savedSection = { ...section, field_id: 'field-1' };
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [{ ...item, acres: 80 }]
            : table === 'customers'
              ? [FAR_FIELD_FARM, QUOTE_FIXTURE_CUSTOMER]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));

    // Far Field Farm is picked, then the quote's own customer again, before the field arrives.
    const customerBox = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    fireEvent.change(customerBox, { target: { value: 'Farm' } });
    fireEvent.click(await screen.findByRole('option', { name: /^Farm/ }));
    expect(customerBox).toHaveValue('Farm');

    // The field belongs to neither: the picks count, so the section drops it.
    await act(async () => {
      held.release({ data: [{ ...HOME_QUARTER_OF_CUSTOMER_1, customer_id: 'customer-elsewhere' }], error: null });
      await held.read;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fieldBox).toHaveValue('');
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
  });

  it('clears quote B\'s foreign field when a customer is picked on B before quote A\'s field read lands', async () => {
    const { quote: quoteA, product, section, item } = makeQuoteFixture('draft', 7);
    const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header', customer_id: 'customer-2' };
    const savedSection = { ...section, field_id: 'field-1' };
    const savedItem = { ...item, acres: 80 };
    const held = holdFieldReadById();
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? (quoteReads++ === 0 ? quoteA : quoteB)
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [savedItem]
            : table === 'customers'
              ? [FAR_FIELD_FARM]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    })));

    renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
    await screen.findByDisplayValue('Quote B header');

    // On B the user picks another customer; A's read then lands with the original customer's field.
    await pickCustomerThenReleaseField(held);
    expect(screen.getByRole('combobox', { name: /^Field for/ })).toHaveValue('');
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
  });

  it('keeps a saved section field that now belongs to another customer when the quote is only opened (CodeRabbit, #1017)', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const savedSection = { ...section, field_id: 'field-1' };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [item]
            : table === 'fields'
              // The field was moved to another customer after the quote was saved.
              ? [{ id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-elsewhere', total_acres: 80, measured_acres: null, override_acres: null }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));

    renderQuoteBuilder(quote.id);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(fieldBox).toHaveValue('Home Quarter'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fieldBox).toHaveValue('Home Quarter');
  });

  it('clears the product list and blocks new lines when a reload of the products fails', async () => {
    let productsFail = false;
    let failedReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'products') return buildChain({ data: [], error: null });
      if (!productsFail) {
        return buildChain({ data: [{ id: 'product-1', product_name: 'Alpha Herbicide', is_active: true }], error: null });
      }
      failedReads += 1;
      return buildChain({ data: null, error: { message: 'products unavailable' } });
    });
    const view = renderQuoteBuilder();
    expect(await screen.findByRole('button', { name: 'Add one' })).toBeInTheDocument();
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('products'));
    expect(screen.queryByText(/Products failed to load/)).not.toBeInTheDocument();

    // A role change re-runs the reference load; this time the product read fails.
    productsFail = true;
    authState.role = 'sales';
    view.rerender(
      <MemoryRouter initialEntries={['/quotes/new']}>
        <Routes>
          <Route path="/quotes/new" element={<QuoteBuilder />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Products failed to load\. Refresh the page before adding products or saving this quote\./)).toBeInTheDocument();
    expect(failedReads).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Add one' }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Products failed to load. Refresh the page before adding products.');
    // No line was added: the section still offers its first line.
    expect(screen.getByRole('button', { name: 'Add one' })).toBeInTheDocument();
  });

  it('no line can be added or priced, and nothing saved, until the products and unit conversions finish loading', async () => {
    // The product read is held open until the test releases it; until then every unit
    // would convert at a factor of 1, so the page must refuse to add, price or save.
    let releaseProducts!: (result: { data: unknown; error: unknown }) => void;
    const productsRead = new Promise<{ data: unknown; error: unknown }>((resolve) => { releaseProducts = resolve; });
    const heldChain = () => {
      const self: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'or', 'not', 'order', 'limit', 'range', 'in', 'is']) self[m] = () => self;
      self.then = (...args: Parameters<Promise<unknown>['then']>) => productsRead.then(...args);
      self.catch = (...args: Parameters<Promise<unknown>['catch']>) => productsRead.catch(...args);
      self.finally = (...args: Parameters<Promise<unknown>['finally']>) => productsRead.finally(...args);
      return self;
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'products') return heldChain();
      return buildChain({
        data: table === 'customers' ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }] : [],
        error: null,
      });
    });
    renderQuoteBuilder();

    const customerBox = await screen.findByRole('combobox', { name: 'Customer' });
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    expect(customerBox).toHaveValue('Far Field Farm');

    // Adding a line is refused while the products load.
    fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
    expect(screen.getByRole('button', { name: 'Add one' })).toBeInTheDocument();

    // Saving is refused too, before any save reaches the server.
    mockToast.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.'));
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());

    // Once the products land, adding a line works.
    await act(async () => {
      releaseProducts({ data: [{ id: 'product-1', product_name: 'Alpha Herbicide', is_active: true }], error: null });
      await productsRead;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mockToast.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Add one' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add one' })).not.toBeInTheDocument());
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
  });

  it('refuses a customer, tier or section field change while saved lines exist and products are still loading, then allows it', async () => {
    // Repricing a saved line before unit conversions load would convert at a factor of 1.
    let releaseProducts!: (result: { data: unknown; error: unknown }) => void;
    const productsRead = new Promise<{ data: unknown; error: unknown }>((resolve) => { releaseProducts = resolve; });
    const heldChain = () => {
      const self: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'or', 'not', 'order', 'limit', 'range', 'in', 'is']) self[m] = () => self;
      self.then = (...args: Parameters<Promise<unknown>['then']>) => productsRead.then(...args);
      self.catch = (...args: Parameters<Promise<unknown>['catch']>) => productsRead.catch(...args);
      self.finally = (...args: Parameters<Promise<unknown>['finally']>) => productsRead.finally(...args);
      return self;
    };
    const product = { id: 'product-1', product_name: 'Alpha Herbicide', is_active: true, tier1_price: 10, tier2_price: 9, tier3_price: 8 };
    const quote = {
      id: 'quote-77', quote_number: 'Q-2026-0077', customer_id: null, tier: 1, valid_days: 30,
      header_notes: null, footer_notes: null, status: 'draft', is_planned: false, commission_split: null,
      created_at: RECENT_QUOTE_CREATED_AT,
    };
    const section = {
      id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 1, section_notes: null,
      section_header_notes: null, needed_by_date: null, field_id: null,
    };
    const item = {
      id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 1, product,
      calc_mode: 'units_direct', total_units_needed: 1, price_per_unit: 10, price_override: null, suggested_rate: null,
      actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: null,
      total_price: 10, notes: null, price_unit: null,
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'products') return heldChain();
      const data = table === 'quotes' ? quote
        : table === 'quote_sections' ? [section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }]
              : table === 'fields' ? [{ id: 'field-9', field_name: 'North Forty', customer_id: null, total_acres: 40, is_active: true }]
                : [];
      return buildChain({ data, error: null });
    });
    renderQuoteBuilder(quote.id);

    // A field's acres would reprice the saved line, so the field pick waits too (CodeRabbit, #1017).
    const fieldBox = await screen.findByRole('combobox', { name: 'Field for Products' });
    fireEvent.focus(fieldBox);
    fireEvent.change(fieldBox, { target: { value: 'North' } });
    fireEvent.click(await screen.findByRole('option', { name: /North Forty/ }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
    expect(fieldBox).toHaveValue('');
    mockToast.mockClear();

    const customerBox = await screen.findByRole('combobox', { name: 'Customer' });
    fireEvent.focus(customerBox);
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
    expect(customerBox).toHaveValue('');
    const tierSelect = screen.getByDisplayValue('Tier 1');
    fireEvent.change(tierSelect, { target: { value: '2' } });
    expect(tierSelect).toHaveValue('1');

    await act(async () => {
      releaseProducts({ data: [product], error: null });
      await productsRead;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mockToast.mockClear();
    fireEvent.focus(customerBox);
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    expect(customerBox).toHaveValue('Far Field Farm');
    expect(screen.getByDisplayValue('Tier 3')).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
  });

  it('renders the Quote Builder heading for a new quote', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'New quote' })).toBeInTheDocument();
    });
  });

  it('uses the server quote number without deriving a browser year', async () => {
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === 'generate_quote_number' ? 'Q-2026-9876' : null, error: null,
    }));
    renderQuoteBuilder();
    expect(await screen.findByText('Q-2026-9876')).toBeInTheDocument();
    expect(mockFrom).not.toHaveBeenCalledWith('quotes');
  });

  it('waits for server numbering before enabling Save Draft', async () => {
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'customers' ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }] : [],
      error: null,
    }));
    let resolveNumber!: (result: { data: string; error: null }) => void;
    const number = new Promise<{ data: string; error: null }>((resolve) => { resolveNumber = resolve; });
    mockRpc.mockImplementation((name: string) => name === 'generate_quote_number'
      ? number : Promise.resolve({ data: null, error: null }));
    renderQuoteBuilder();
    const save = await screen.findByRole('button', { name: 'Save draft' });
    expect(save).toBeDisabled();
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('quote number'));
    await act(async () => resolveNumber({ data: 'Q-2026-9876', error: null }));
    expect(await screen.findByText('Q-2026-9876')).toBeInTheDocument();
    // The number alone is nothing to save: Save stays disabled until the quote changes.
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'No changes to save');
    const customer = await screen.findByRole('combobox', { name: 'Customer' });
    fireEvent.change(customer, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    await waitFor(() => expect(save).toBeEnabled());
  });

  it.each(['error', 'empty', 'blank', 'throw'])('refuses to invent a quote number after a server %s', async (failure) => {
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'customers' ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }] : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'generate_quote_number') return Promise.resolve({ data: null, error: null });
      if (failure === 'throw') return Promise.reject(new Error('offline'));
      return Promise.resolve({ data: failure === 'blank' ? '' : null, error: failure === 'error' ? { message: 'unavailable', code: 'P0001', details: 'number allocation refused', hint: 'retry later' } : null });
    });
    renderQuoteBuilder();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to generate quote number. Use Retry quote number to try again.'));
    const customer = await screen.findByRole('combobox', { name: 'Customer' });
    fireEvent.change(customer, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'A quote number could not be confirmed. Use Retry quote number to try again.'));
    expect(mockFrom).not.toHaveBeenCalledWith('quotes');
    expect(screen.queryByText(/^Q-\d{4}-\d+$/)).not.toBeInTheDocument();
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    if (failure === 'error') {
      expect(mockSentryCaptureException).toHaveBeenCalledWith(expect.objectContaining({
        message: 'unavailable', code: 'P0001', details: 'number allocation refused', hint: 'retry later',
      }), { extra: expect.objectContaining({
        context: 'generate_quote_number', code: 'P0001', details: 'number allocation refused', hint: 'retry later',
      }) });
    }
  });

  it('keeps a confirmed new-quote number when a role change reloads reference data', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === 'generate_quote_number' ? 'Q-2026-9876' : null, error: null,
    }));
    const view = renderQuoteBuilder();
    expect(await screen.findByText('Q-2026-9876')).toBeInTheDocument();
    const productReads = () => mockFrom.mock.calls.filter(([table]) => table === 'products').length;
    const readsBefore = productReads();

    authState.role = 'sales';
    view.rerender(
      <MemoryRouter initialEntries={['/quotes/new']}>
        <Routes>
          <Route path="/quotes/new" element={<QuoteBuilder />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(productReads()).toBeGreaterThan(readsBefore));
    expect(screen.getByText('Q-2026-9876')).toBeInTheDocument();
    expect(mockRpc.mock.calls.filter(([name]) => name === 'generate_quote_number')).toHaveLength(1);
  });

  it('retries a failed quote number without clearing the form', async () => {
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'customers' ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }] : [],
      error: null,
    }));
    let numberAvailable = false;
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'generate_quote_number' && !numberAvailable
      ? { data: null, error: { message: 'unavailable' } }
      : { data: name === 'generate_quote_number' ? 'Q-2026-9876' : null, error: null }));
    renderQuoteBuilder();
    const retry = await screen.findByRole('button', { name: 'Retry quote number' });
    const customer = await screen.findByRole('combobox', { name: 'Customer' });
    fireEvent.change(customer, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    numberAvailable = true;
    fireEvent.click(retry);
    expect(await screen.findByText('Q-2026-9876')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry quote number' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('Far Field Farm');
  });

  it('opens the exact receipt-proven order after a changed draw intent', async () => {
    const priorOrderId = '99999999-9999-9999-9999-999999999999';
    const { quote } = configureDrawDownFixture({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: JSON.stringify({
        operation: 'draw_down_quote',
        result: { order_id: priorOrderId, order_number: 'O-EXISTING' },
      }),
    });

    await submitOneUnitDraw(quote.id);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(`/orders/${priorOrderId}`));
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('already created an order'),
    );
    expect(screen.queryByRole('dialog', { name: 'Create order from booking' })).not.toBeInTheDocument();
  });

  it('sends the operator to Orders when a changed-intent receipt cannot be opened', async () => {
    const fixture = configureDrawDownFixture({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: JSON.stringify({ operation: 'draw_down_quote', result: null }),
    });

    await submitOneUnitDraw(fixture.quote.id);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('prior outcome could not be opened'),
    ));
    expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Check Orders for this booking before drawing again'),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('booking balance was reloaded; try again'),
    );
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringMatching(/^\/orders\//));
    expect(screen.queryByRole('dialog', { name: 'Create order from booking' })).not.toBeInTheDocument();
  });

  // S14 (KI-11): the reply to Partial Order is lost after the server made the order, and the rep
  // reloads. The in-memory key is gone, so a fresh tap would make a second order. The screen keeps
  // the unconfirmed draw in this tab and offers to finish it with its original key.
  describe('a lost Partial Order reply, then a reload', () => {
    const drawCalls = () => mockRpc.mock.calls
      .filter(([name]) => name === 'draw_down_quote')
      .map(([, args]) => args as { p_idempotency_key: string; p_draws: unknown[] });

    async function reloadAndOpenDraw(quoteId: string) {
      cleanup();
      // A reload loses the hook's memory: a fresh key would be minted for this booking.
      quoteIdempotencyState.bump(quoteId);
      renderQuoteBuilder(quoteId);
      const createOrderButton = await screen.findByRole('button', { name: 'Create order' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
      fireEvent.click(createOrderButton);
      fireEvent.click(await screen.findByRole('menuitem', { name: /Draw part of booking/ }));
      return screen.findByRole('dialog', { name: 'Create order from booking' });
    }

    it('finishes the unconfirmed draw with its original key, so it is made once', async () => {
      const fixture = configureDrawDownFixture({ message: 'Failed to fetch' });
      await submitOneUnitDraw(fixture.quote.id);
      await waitFor(() => expect(drawCalls()).toHaveLength(1));
      const first = drawCalls()[0];

      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'draw_down_quote'
        ? { data: { status: 'created', order_id: 'order-1', order_number: 'ORD-1', fully_drawn: false }, error: null }
        : { data: null, error: null }));
      const dialog = await reloadAndOpenDraw(fixture.quote.id);
      expect(await within(dialog).findByText(/got no reply/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Finish it' }));

      await waitFor(() => expect(drawCalls()).toHaveLength(2));
      expect(drawCalls()[1].p_idempotency_key).toBe(first.p_idempotency_key);
      expect(drawCalls()[1].p_draws).toEqual(first.p_draws);
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-1'));
      expect(sessionStorage.length).toBe(0);
    });

    it('offers nothing to finish after a confirmed draw', async () => {
      const fixture = configureDrawDownFixture({ message: 'unused' });
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'draw_down_quote'
        ? { data: { status: 'created', order_id: 'order-1', order_number: 'ORD-1', fully_drawn: false }, error: null }
        : { data: null, error: null }));
      await submitOneUnitDraw(fixture.quote.id);
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-1'));

      const dialog = await reloadAndOpenDraw(fixture.quote.id);
      await within(dialog).findByRole('spinbutton');
      expect(within(dialog).queryByText(/got no reply/)).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: 'Finish it' })).not.toBeInTheDocument();
    });

    it('forgets the unconfirmed draw once the server refuses its key', async () => {
      const fixture = configureDrawDownFixture({ message: 'IDEMPOTENCY_ACTOR_MISMATCH' });
      await submitOneUnitDraw(fixture.quote.id);
      await waitFor(() => expect(mockResetIdempotencyKey).toHaveBeenCalled());
      expect(sessionStorage.length).toBe(0);
    });

    it('keeps the draw for a hand check when the server refuses its receipt', async () => {
      const fixture = configureDrawDownFixture({ message: 'IDEMPOTENCY_RESULT_INVALID' });
      await submitOneUnitDraw(fixture.quote.id);
      await waitFor(() => expect(mockResetIdempotencyKey).toHaveBeenCalled());
      expect(sessionStorage.length).toBe(2); // the kept draw and its booking version (KI-190)

      const dialog = await reloadAndOpenDraw(fixture.quote.id);
      expect(await within(dialog).findByRole('button', { name: 'I checked' })).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: 'Finish it' })).not.toBeInTheDocument();
    });

    it('does not send a draw when the browser cannot keep its safety note', async () => {
      const fixture = configureDrawDownFixture({ message: 'Failed to fetch' });
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
      await submitOneUnitDraw(fixture.quote.id);
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('could not keep a safety note')));
      expect(drawCalls()).toHaveLength(0);
      setItem.mockRestore();
    });

    it('keeps an earlier lost draw when a later retry is refused before its receipt is read', async () => {
      const fixture = configureDrawDownFixture({ message: 'Failed to fetch' });
      await submitOneUnitDraw(fixture.quote.id);
      await waitFor(() => expect(drawCalls()).toHaveLength(1));

      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'draw_down_quote'
        ? { data: null, error: { code: 'P0001', message: 'DRAW_DOWN_CUTOVER_IN_PROGRESS' } }
        : { data: null, error: null }));
      let dialog = await reloadAndOpenDraw(fixture.quote.id);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Finish it' }));
      await waitFor(() => expect(drawCalls()).toHaveLength(2));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Finish it' })).not.toBeDisabled());
      expect(sessionStorage.length).toBe(2); // the kept draw and its booking version (KI-190)

      dialog = await reloadAndOpenDraw(fixture.quote.id);
      expect(await within(dialog).findByText(/got no reply/)).toBeInTheDocument();
    });

    it('will not finish a draw older than the server keeps its receipt', async () => {
      const fixture = configureDrawDownFixture({ message: 'Failed to fetch' });
      await submitOneUnitDraw(fixture.quote.id);
      await waitFor(() => expect(drawCalls()).toHaveLength(1));

      const dialog = await reloadAndOpenDraw(fixture.quote.id);
      const finish = await within(dialog).findByRole('button', { name: 'Finish it' });
      const stored = JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);
      sessionStorage.setItem(sessionStorage.key(0)!, JSON.stringify({ ...stored, sentAt: stored.sentAt - 24 * 60 * 60 * 1000 - 1 }));
      fireEvent.click(finish);

      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('can no longer be finished safely')));
      expect(drawCalls()).toHaveLength(1);
      expect(within(dialog).queryByRole('button', { name: 'Finish it' })).not.toBeInTheDocument();

      // A new draw is refused too, until the rep says they checked the booking's orders.
      fireEvent.change(await within(dialog).findByRole('spinbutton'), { target: { value: '1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(mockToast.mock.calls.filter(([, text]) => String(text).includes('can no longer be finished safely'))).toHaveLength(2));
      expect(drawCalls()).toHaveLength(1);
      fireEvent.click(within(dialog).getByRole('button', { name: 'I checked' }));
      expect(sessionStorage.length).toBe(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(drawCalls()).toHaveLength(2));
      expect(drawCalls()[1].p_idempotency_key).not.toBe(drawCalls()[0].p_idempotency_key);
    });

    it('offers nothing to finish after the server clearly refused the draw', async () => {
      const fixture = configureDrawDownFixture({ code: 'P0001', message: 'BOOKING_OVERDRAWN: only 5 gal left' });
      await submitOneUnitDraw(fixture.quote.id);
      await waitFor(() => expect(drawCalls()).toHaveLength(1));
      await waitFor(() => expect(sessionStorage.length).toBe(0));

      const dialog = await reloadAndOpenDraw(fixture.quote.id);
      await within(dialog).findByRole('spinbutton');
      expect(within(dialog).queryByText(/got no reply/)).not.toBeInTheDocument();
    });
  });

  it('maps a malformed draw product to a governed operator error', async () => {
    const fixture = configureDrawDownFixture({ message: 'BOOKING_PRODUCT_INVALID: draw product id must be a UUID' });

    await submitOneUnitDraw(fixture.quote.id);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'A draw line has an invalid product reference. Refresh the booking and try again.',
    ));
  });

  it('retires another actor retry and reloads the booking balance in the open modal', async () => {
    const fixture = configureDrawDownFixture({ message: 'IDEMPOTENCY_ACTOR_MISMATCH' });

    await submitOneUnitDraw(fixture.quote.id);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('belongs to another signed-in user'),
    ));
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(fixture.quoteItemReads()).toBeGreaterThanOrEqual(3);
    const dialog = screen.getByRole('dialog', { name: 'Create order from booking' });
    expect(within(dialog).getByRole('spinbutton')).toHaveValue(null);
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringMatching(/^\/orders\//));
  });

  it('does not claim the booking balance reloaded when mismatch recovery reads fail', async () => {
    const fixture = configureDrawDownFixture(
      { message: 'IDEMPOTENCY_ACTOR_MISMATCH' },
      { failRecoveryLoad: true },
    );

    await submitOneUnitDraw(fixture.quote.id);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('booking balance could not be reloaded'),
    ));
    expect(mockToast).not.toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('booking balance was reloaded'),
    );
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Create order from booking' })).not.toBeInTheDocument();
  });

  // Item 10 (Mason 2026-10-26/27): a customer may take more than is left on a booking. The rep
  // sees how much over, the booked and today's price, and chooses (today's by default); the extra
  // becomes its own order (20261029110000).
  describe('taking more than is left on a booking', () => {
    async function openDrawAndEnter(qty: string, { booked, drawn }: { booked?: number; drawn?: number } = {}) {
      const fixture = configureDrawDownFixture({ message: 'unused' });
      // Today's tier price rose to $11.00 after the booking at $10.00.
      const product = { ...fixture.product, tier1_price: 11 };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? fixture.quote
          : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [{ ...fixture.item, product, total_units_needed: booked ?? fixture.item.total_units_needed }]
          : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
          : table === 'products' ? [product]
          : table === 'quote_product_draws' && drawn != null ? [{ product_id: product.id, quantity_drawn: drawn }]
          : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'draw_down_quote'
        ? { data: { status: 'created', order_id: 'order-1', order_number: 'ORD-1', fully_drawn: true,
            extra_order_id: 'order-2', extra_order_number: 'ORD-2' }, error: null }
        : { data: null, error: null }));
      renderQuoteBuilder(fixture.quote.id);
      const createOrderButton = await screen.findByRole('button', { name: 'Create order' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
      fireEvent.click(createOrderButton);
      fireEvent.click(await screen.findByRole('menuitem', { name: /Draw part of booking/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Create order from booking' });
      fireEvent.change(await within(dialog).findByRole('spinbutton'), { target: { value: qty } });
      return dialog;
    }
    function sentDraws() {
      const call = mockRpc.mock.calls.find(([name]) => name === 'draw_down_quote');
      return (call?.[1] as { p_draws: unknown[] }).p_draws;
    }

    it('shows how much over, both prices, and defaults to today’s price', async () => {
      const dialog = await openDrawAndEnter('3');
      expect(within(dialog).getByText(/1 gal over the booking/)).toBeInTheDocument();
      expect(within(dialog).getByText(/Booked \$10\.00/)).toBeInTheDocument();
      expect(within(dialog).getByText(/today \$11\.00/)).toBeInTheDocument();
      expect(within(dialog).getByRole('radio', { name: /Today's price/ })).toBeChecked();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(sentDraws()).toEqual([{ product_id: 'product-1', quantity: 3, extra_price: 'today' }]));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('ORD-2')));
    });

    // KI-190: Partial Order draws against the booking the rep reviewed, like Whole Convert.
    it('sends the booking version this screen showed', async () => {
      const dialog = await openDrawAndEnter('1');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => {
        const call = mockRpc.mock.calls.find(([name]) => name === 'draw_down_quote');
        expect((call?.[1] as { p_expected_row_version?: unknown }).p_expected_row_version).toBe(7);
      });
    });

    it('a booking that changed since it was opened is refused: nothing ordered, reload asked', async () => {
      const dialog = await openDrawAndEnter('1');
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'draw_down_quote'
        ? { data: null, error: { code: 'P0001', message: 'QUOTE_STALE_WRITE: this booking changed since you opened it' } }
        : { data: null, error: null }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('changed since you opened it')));
      expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create order from booking' })).not.toBeInTheDocument());
      expect(await screen.findByText('Reload this quote before saving?')).toBeInTheDocument();
    });

    it('refuses locally when the booking moved on between loading this screen and opening the dialog', async () => {
      const fixture = configureDrawDownFixture({ message: 'unused' });
      const tables = (quote: unknown) => (table: string) => buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
          : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
          : table === 'products' ? [fixture.product]
          : [],
        error: null,
      });
      mockFrom.mockImplementation(tables(fixture.quote));
      renderQuoteBuilder(fixture.quote.id);
      const createOrderButton = await screen.findByRole('button', { name: 'Create order' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
      // Another rep drew from the booking: the database is now at version 8, this screen at 7.
      mockFrom.mockImplementation(tables({ ...fixture.quote, row_version: 8 }));
      fireEvent.click(createOrderButton);
      fireEvent.click(await screen.findByRole('menuitem', { name: /Draw part of booking/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Create order from booking' });
      fireEvent.change(await within(dialog).findByRole('spinbutton'), { target: { value: '1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('changed since you opened it')));
      expect(mockRpc.mock.calls.some(([name]) => name === 'draw_down_quote')).toBe(false);
      expect(await screen.findByText('Reload this quote before saving?')).toBeInTheDocument();
    });

    it('sends the booked price when the rep picks it', async () => {
      const dialog = await openDrawAndEnter('3');
      fireEvent.click(within(dialog).getByRole('radio', { name: /Booked price/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(sentDraws()).toEqual([{ product_id: 'product-1', quantity: 3, extra_price: 'booked' }]));
    });

    // S02: bookings are saved to 0.01, so a draw of 333.333 would leave 0.001 that nothing can draw.
    it('refuses a quantity with more than 2 decimal places before sending', async () => {
      const dialog = await openDrawAndEnter('1.555');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('at most 2 decimal places')));
      expect(mockRpc.mock.calls.some(([name]) => name === 'draw_down_quote')).toBe(false);
    });

    it('sends a quantity in whole hundredths', async () => {
      const dialog = await openDrawAndEnter('1.55');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(sentDraws()).toEqual([{ product_id: 'product-1', quantity: 1.55 }]));
    });

    // S02's closing draw: 50 - (16.67 + 16.67) is 16.659999999999997 in floats, which showed as the
    // amount left and made a typed 16.66 look 3.55e-15 over the booking.
    it('shows what is left in whole hundredths and treats the exact closing draw as not over', async () => {
      const dialog = await openDrawAndEnter('16.66', { booked: 50, drawn: 33.34 });
      expect(within(dialog).getByText('16.66 gal')).toBeInTheDocument();
      expect(within(dialog).queryByText(/over the booking/)).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(sentDraws()).toEqual([{ product_id: 'product-1', quantity: 16.66 }]));
    });

    it('a draw within what is left sends no price choice and shows no over line', async () => {
      const dialog = await openDrawAndEnter('1');
      expect(within(dialog).queryByText(/over the booking/)).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
      await waitFor(() => expect(sentDraws()).toEqual([{ product_id: 'product-1', quantity: 1 }]));
    });
  });

  it('shows loading skeleton while fetching data for existing quote', () => {
    mockFrom.mockImplementation(() => buildPendingChain());
    mockRpc.mockImplementation(() => new Promise(() => {}));
    renderQuoteBuilder('quote-123');
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders customer select dropdown', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Select a customer...')).toBeInTheDocument();
    });
  });

  it('shows Save Draft button', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByText('Save draft')).toBeInTheDocument();
    });
  });

  it('renders breadcrumbs with Quotes link and New Quote', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByText('Quotes')).toBeInTheDocument();
      expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('New quote')).toBeInTheDocument();
    });
  });

  it('lists legacy-format saved versions instead of hiding the quote history', async () => {
    const { quote, product, section, item } = makeQuoteFixture('sent', 7);
    // The exact shape of the rows that exist in production: written by the original frontend
    // writer, with the quote fields at the top level and no `quote` key. The strict snapshot
    // validator cannot read these, and dropping them used to remove the Versions button
    // entirely from any quote whose saved versions were all in this shape.
    const legacySnapshot = {
      quote_number: 'Q-version-test',
      customer_id: 'customer-1',
      customer_name: 'Farm',
      tier: 1,
      valid_days: 30,
      header_notes: null,
      footer_notes: null,
      commission_split: null,
      totals: { total_price: 1234 },
      sections: [],
    };
    const legacyRow = (id: string, versionNumber: number, sentAt: string) => ({
      id,
      quote_id: quote.id,
      version_number: versionNumber,
      sent_by: 'profile-1',
      sent_at: sentAt,
      sent_method: null,
      snapshot_data: legacySnapshot,
      pdf_url: null,
      notes: null,
      restore_trusted_at: null,
    });
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : table === 'quote_versions'
                  ? [
                      legacyRow('version-2', 2, '2026-03-16T15:43:15.915Z'),
                      legacyRow('version-1', 1, '2026-03-16T15:42:47.023Z'),
                    ]
                  : [],
      error: null,
    }));

    renderQuoteBuilder(quote.id);

    fireEvent.click(await screen.findByRole('tab', { name: /^History/ }));

    // Both rows are listed, and neither claims an item count or a total — those could only
    // come from a snapshot this build has already refused to read.
    expect(await screen.findAllByText(/Saved in an older format/)).toHaveLength(2);
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();

    // The old behaviour warned the operator on every single load and reported to Sentry.
    // A legacy snapshot is expected historical data, not an incident.
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('could not be displayed'));
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled();

    // Listing a row must not make it actionable: an unreadable snapshot can reach neither the
    // compare view nor restore. Without this, adding an onClick to the row would still pass.
    const legacyRowNode = screen.getAllByText(/Saved in an older format/)[0].closest('div')?.parentElement;
    expect(legacyRowNode).toBeTruthy();
    expect(legacyRowNode).not.toHaveAttribute('role');
    expect(legacyRowNode).not.toHaveAttribute('tabindex');
    fireEvent.click(legacyRowNode!);
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument();
  });

  it('keeps version history in saved order when a newer version is unreadable', async () => {
    // Codex on #592: the page rendered every readable version and then every unreadable one, so
    // a quote whose NEWEST version is unreadable displayed it underneath the older readable
    // ones — v2, v1, v3 — and the history claimed an order the data does not have.
    const { quote, product, section, item } = makeQuoteFixture('sent', 7);
    const versionRow = (
      id: string,
      versionNumber: number,
      sentAt: string,
      snapshotData: unknown,
    ) => ({
      id,
      quote_id: quote.id,
      version_number: versionNumber,
      sent_by: 'profile-1',
      sent_at: sentAt,
      sent_method: null,
      snapshot_data: snapshotData,
      pdf_url: null,
      notes: null,
      restore_trusted_at: null,
    });
    // The legacy shape the strict validator refuses: quote fields at the top level, no `quote` key.
    const unreadableSnapshot = {
      quote_number: 'Q-version-order',
      customer_id: 'customer-1',
      customer_name: 'Farm',
      tier: 1,
      valid_days: 30,
      header_notes: null,
      footer_notes: null,
      commission_split: null,
      totals: { total_price: 4321 },
      sections: [],
    };
    const readableSnapshot = (totalPrice: number) => ({
      quote: {
        quote_number: 'Q-version-order',
        customer_id: 'customer-1',
        tier: 1,
        status: 'sent',
        total_price: totalPrice,
        total_cost: 0,
        total_profit: totalPrice,
        total_margin_pct: 100,
        valid_days: 30,
        expires_at: null,
        header_notes: null,
        footer_notes: null,
        is_planned: false,
        commission_split: null,
      },
      sections: [],
    });

    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : table === 'quote_versions'
                  // The server returns one version_number-descending sequence; the newest is the
                  // one this build cannot read.
                  ? [
                      versionRow('version-3', 3, '2026-03-16T15:44:00.000Z', unreadableSnapshot),
                      versionRow('version-2', 2, '2026-03-16T15:43:00.000Z', readableSnapshot(200)),
                      versionRow('version-1', 1, '2026-03-16T15:42:00.000Z', readableSnapshot(100)),
                    ]
                  : [],
      error: null,
    }));

    renderQuoteBuilder(quote.id);

    fireEvent.click(await screen.findByRole('tab', { name: /^History/ }));

    // Guard the fixture: if all three landed in one bucket the ordering claim would be vacuous.
    expect(await screen.findByText(/Saved in an older format/)).toBeInTheDocument();
    expect(screen.getAllByText(/Saved in an older format/)).toHaveLength(1);

    expect(screen.getAllByText(/^v\d+$/).map((node) => node.textContent))
      .toEqual(['v3', 'v2', 'v1']);
  });

  it('reports an unreadable version the server stamped as restorable instead of calling it old', async () => {
    // restore_trusted_at is set only by the current writer, so a row carrying it should always
    // parse. One that does not is corruption or writer/validator drift — the user sees the same
    // "unavailable" either way, so the alarm has to fire on our side.
    const { quote, product, section, item } = makeQuoteFixture('sent', 7);
    const unreadableTrustedRow = {
      id: 'version-9',
      quote_id: quote.id,
      version_number: 9,
      sent_by: 'profile-1',
      sent_at: '2026-09-06T10:00:00.000Z',
      sent_method: null,
      snapshot_data: { quote_number: 'Q-drift', totals: { total_price: 10 }, sections: [] },
      pdf_url: null,
      notes: null,
      restore_trusted_at: '2026-09-06T10:00:01.000Z',
    };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : table === 'quote_versions'
                  ? [unreadableTrustedRow]
                  : [],
      error: null,
    }));

    renderQuoteBuilder(quote.id);

    fireEvent.click(await screen.findByRole('tab', { name: /^History/ }));

    expect(await screen.findByText('Details unavailable')).toBeInTheDocument();
    // Calling it an older format would be a guess: the server says this row is current.
    expect(screen.queryByText(/Saved in an older format/)).not.toBeInTheDocument();
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      'server-trusted quote version failed snapshot validation',
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('handles quote not found gracefully when editing invalid ID', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: null, error: null }));
    renderQuoteBuilder('nonexistent-id');
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'Quote not found');
    });
    expect(mockNavigate).toHaveBeenCalledWith('/quotes');
  });

  it('renders the commission split editor', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByTestId('commission-split-editor')).toBeInTheDocument();
    });
  });

  it('loads and renders the real Product family on a persisted quote row', async () => {
    const product = {
      id: '11111111-1111-4111-8111-111111111111',
      product_name: 'Exact Product',
      sku: 'SKU-EXACT',
      is_active: true,
      inventory_unit: 'gal',
      packaging_variant: '2 x 2.5 gal',
      return_policy: 'returnable',
      is_full_tote_only: false,
      product_family: { name: 'Family Alpha' },
    };
    const quote = {
      id: 'quote-123',
      quote_number: 'Q-2026-0123',
      customer_id: null,
      tier: 1,
      valid_days: 30,
      header_notes: null,
      footer_notes: null,
      status: 'draft',
      is_planned: false,
      commission_split: null,
      created_at: RECENT_QUOTE_CREATED_AT,
    };
    const section = {
      id: 'section-1',
      quote_id: quote.id,
      section_name: 'Products',
      sort_order: 1,
      section_notes: null,
      section_header_notes: null,
      needed_by_date: null,
      field_id: null,
    };
    const item = {
      id: 'item-1',
      quote_id: quote.id,
      section_id: section.id,
      product_id: product.id,
      sort_order: 1,
      product,
      calc_mode: 'units_direct',
      total_units_needed: 1,
      price_per_unit: 1000,
      price_override: null,
      current_cost: 700,
      suggested_rate: null,
      actual_rate: null,
      rate_unit: null,
      oz_per_acre: null,
      price_per_acre: null,
      acres: null,
      unit_size: null,
      profit: 300,
      total_price: 1000,
      net_margin: 30,
      notes: null,
      price_unit: null,
    };
    const quoteItemSelects: unknown[] = [];

    mockFrom.mockImplementation((table: string) => {
      const data = table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'products'
              ? [product]
              : [];
      return buildChain(
        { data, error: null },
        table === 'quote_items' ? (columns) => quoteItemSelects.push(columns) : undefined,
      );
    });

    renderQuoteBuilder(quote.id);

    expect(await screen.findByText('SKU-EXACT · Family Alpha · 2 x 2.5 gal')).toBeInTheDocument();
    expect(screen.getByText('Return: returnable')).toBeInTheDocument();
    expect(quoteItemSelects).toContain(`${QUOTE_ITEM_COLUMNS}, product:products(${PRODUCT_COLUMNS}, product_family:product_families(name))`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves a stale edit until Reload Quote replaces it and sends the refreshed version on the next save', async () => {
    const quote = { id: 'quote-stale', quote_number: 'Q-stale', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const reloadedQuote = { ...quote, header_notes: 'Newer header', row_version: 8 };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : reloadedQuote) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote' ? { data: null, error: { message: 'QUOTE_STALE_WRITE' } } : { data: null, error: null }));
    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue('Original header');
    fireEvent.change(header, { target: { value: 'Unsaved header edit' } });
    fireEvent.click(screen.getByText('Save draft'));
    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 7, header_notes: 'Unsaved header edit' }),
    }));
    const readsBeforeKeepEditing = quoteReads;
    fireEvent.click(screen.getByText('Keep editing'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());
    expect((screen.getByDisplayValue('Unsaved header edit') as HTMLTextAreaElement).value).toBe('Unsaved header edit');
    expect(quoteReads).toBe(readsBeforeKeepEditing);

    fireEvent.click(screen.getByText('Save draft'));
    await screen.findByText('Reload Quote');
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect((screen.getByDisplayValue('Newer header') as HTMLTextAreaElement).value).toBe('Newer header'));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    await makeAnEdit();
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 8, header_notes: 'Newer header' }),
    })));
  });

  // save_quote refuses QUOTE_ITEM_AMBIGUOUS_COST when a saved quote holds two
  // lines of one product and the save does not say which line is which.
  it('names every saved line on each save so two lines of one product keep their own costs', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const secondLine = { ...item, id: 'item-2', sort_order: 1, total_units_needed: 5, total_price: 50, profit: 20 };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item, secondLine] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    let saves = 0;
    mockRpc.mockImplementation((name: string, args: { p_sections?: Array<{ items: Array<{ client_key: string }> }> }) => {
      if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
      saves += 1;
      // Mint visibly new ids so the next save can only send them if the page installed this map.
      const itemIds = Object.fromEntries((args.p_sections ?? []).flatMap((s) => s.items)
        .map((line, index) => [line.client_key, `saved-${saves}-${index}`]));
      return Promise.resolve({ data: { status: 'saved', quote_id: quote.id, row_version: 7 + saves, item_ids: itemIds }, error: null });
    });
    const sentLines = (call: number) => (mockRpc.mock.calls.filter(([name]) => name === 'save_quote')[call][1] as {
      p_sections: Array<{ items: Array<{ id: string | null; client_key: string; product_id: string }> }>;
    }).p_sections.flatMap((s) => s.items);

    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue('Version test header');
    fireEvent.change(header, { target: { value: 'First edit' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(saves).toBe(1));
    const first = sentLines(0);
    expect(first.map((line) => line.id)).toEqual(['item-1', 'item-2']);
    expect(first.every((line) => line.product_id === product.id && line.client_key)).toBe(true);
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));

    fireEvent.change(screen.getByDisplayValue('First edit'), { target: { value: 'Second edit' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(saves).toBe(2));
    expect(sentLines(1).map((line) => line.id)).toEqual(['saved-1-0', 'saved-1-1']);
  });

  // save_quote kept a section (and the spray job scheduled from it) only when the save names it (20270125110000).
  it('names each saved section on every save and installs the ids the save returns', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    let saves = 0;
    mockRpc.mockImplementation((name: string, args: { p_sections?: Array<{ client_key: string }> }) => {
      if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
      saves += 1;
      // The first reply carries no map (a receipt cached before it existed); the second mints new ids.
      const sectionIds = saves === 1 ? undefined : Object.fromEntries((args.p_sections ?? []).map((s) => [s.client_key, `sec-${saves}`]));
      return Promise.resolve({ data: { status: 'saved', quote_id: quote.id, row_version: 7 + saves, item_ids: {}, section_ids: sectionIds }, error: null });
    });
    const sent = (call: number) => mockRpc.mock.calls.filter(([name]) => name === 'save_quote')[call][1] as {
      p_quote_payload: { section_ids_v1?: boolean };
      p_sections: Array<{ id: string | null; client_key: string }>;
    };
    const edit = async (from: string, to: string, count: number) => {
      fireEvent.change(await screen.findByDisplayValue(from), { target: { value: to } });
      fireEvent.click(screen.getByText('Save draft'));
      await waitFor(() => expect(saves).toBe(count));
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    };

    renderQuoteBuilder(quote.id);
    await edit('Version test header', 'First edit', 1);
    expect(sent(0).p_quote_payload.section_ids_v1).toBe(true);
    expect(sent(0).p_sections.map((s) => s.id)).toEqual([section.id]);
    expect(sent(0).p_sections[0].client_key).toBeTruthy();
    // No map in the reply: the sections were re-created, so the old id is not sent again.
    await edit('First edit', 'Second edit', 2);
    expect(sent(1).p_sections.map((s) => s.id)).toEqual([null]);
    await edit('Second edit', 'Third edit', 3);
    expect(sent(2).p_sections.map((s) => s.id)).toEqual(['sec-2']);
  });

  it('warns that a section with a live job keeps its lines and that a new name, notes or date does not reach the job', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, is_planned: true };
    const section = { ...fixture.section, field_id: 'field-1' };
    const job = { id: 'job-7', job_number: 'J-7', status: 'scheduled', quote_section_id: section.id };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote
      : table === 'quote_sections' ? [section] : table === 'quote_items' ? [fixture.item]
        : table === 'products' ? [fixture.product] : table === 'fields' ? [HOME_QUARTER_OF_CUSTOMER_1]
          : table === 'jobs' ? [job] : [], error: null }));
    renderQuoteBuilder(quote.id);
    expect(await screen.findByText(/Job J-7 was scheduled from this section. Its products, quantities, prices, needed-by date and field stay as booked; a new name or notes here does not change the job/)).toBeInTheDocument();
  });

  it('refuses Schedule job on a section whose id a save did not return, and says to save and reload', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, is_planned: true };
    const section = { ...fixture.section, field_id: 'field-1' };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote
      : table === 'quote_sections' ? [section] : table === 'quote_items' ? [fixture.item]
        : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
          : table === 'products' ? [fixture.product] : table === 'fields' ? [HOME_QUARTER_OF_CUSTOMER_1] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: quote.id, row_version: 8, item_ids: {} }, error: null }
      : { data: null, error: null }));
    renderQuoteBuilder(quote.id);
    fireEvent.change(await screen.findByDisplayValue('Version test header'), { target: { value: 'First edit' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule job' }));
    // No draft confirmation first: the rep is told at once (Sol round 3 LOW).
    expect(screen.queryByRole('button', { name: 'Schedule anyway' })).not.toBeInTheDocument();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'This section is not saved yet. Save the quote, then reload it if this message comes back, before scheduling a job from it.'));
    expect(mockRpc.mock.calls.some(([name]) => name === 'create_job_from_quote_section')).toBe(false);
  });

  // Bookings Phase A (20270127110000): timing and confidence per section, on every booking, not only Planned ones; never on the PDF.
  it('sends each section’s timing and confidence, and a timing pick fills an empty needed-by date', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, is_planned: false };
    const section = { ...fixture.section, timing: 'pre_plant', confidence: 'firm' };
    // '{}' parses to the default windows; with no row the Timing pick stays off (a failed read).
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'app_settings' ? { setting_value: '{}' } : table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [fixture.item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [fixture.product] : [], error: null }));
    let saves = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
      saves += 1;
      return Promise.resolve({ data: { status: 'saved', quote_id: quote.id, row_version: 7 + saves, item_ids: {}, section_ids: {} }, error: null });
    });
    const sentSection = (call: number) => (mockRpc.mock.calls.filter(([name]) => name === 'save_quote')[call][1] as {
      p_sections: Array<{ timing: string | null; confidence: string | null; needed_by_date: string | null }>;
    }).p_sections[0];

    renderQuoteBuilder(quote.id);
    const timing = await screen.findByLabelText('Timing') as HTMLSelectElement;
    await waitFor(() => expect(timing.value).toBe('pre_plant'));
    expect((screen.getByLabelText('Confidence') as HTMLSelectElement).value).toBe('firm');
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: 'maybe' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(saves).toBe(1));
    expect(sentSection(0)).toMatchObject({ timing: 'pre_plant', confidence: 'maybe', needed_by_date: null });
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));

    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'late_summer' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(saves).toBe(2));
    expect(sentSection(1).timing).toBe('late_summer');
    expect(sentSection(1).needed_by_date).toBe('2026-07-16');
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));

    // Sol (2026-11-20) MED: an auto-filled date follows a later timing change; a typed date stays.
    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'pre_plant' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(saves).toBe(3));
    expect(sentSection(2).needed_by_date).toBe('2026-03-16');
  });

  it('a date a timing pick filled still follows a later timing change on another day (Luna MED)', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, is_planned: false };
    const section = { ...fixture.section, timing: null, confidence: null, needed_by_date: null };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'app_settings' ? { setting_value: '{}' } : table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [fixture.item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [fixture.product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: quote.id, row_version: 8, item_ids: {}, section_ids: {} }, error: null }
      : { data: null, error: null }));
    try {
      renderQuoteBuilder(quote.id);
      const timing = await screen.findByLabelText('Timing') as HTMLSelectElement;
      await waitFor(() => expect(timing).not.toBeDisabled());
      fireEvent.change(timing, { target: { value: 'pre_plant' } }); // fills today, 2026-03-16
      vi.mocked(todayInBusinessTz).mockReturnValue('2026-03-20');
      fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'late_summer' } });
      fireEvent.click(screen.getByText('Save draft'));
      await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'save_quote')).toBe(true));
      const sent = (mockRpc.mock.calls.find(([name]) => name === 'save_quote')![1] as {
        p_sections: Array<{ timing: string | null; needed_by_date: string | null }>;
      }).p_sections[0];
      expect(sent).toMatchObject({ timing: 'late_summer', needed_by_date: '2026-07-16' });
    } finally {
      vi.mocked(todayInBusinessTz).mockReturnValue('2026-03-16');
    }
  });

  it('a timing change keeps a needed-by date the rep chose', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, is_planned: false };
    const section = { ...fixture.section, timing: 'pre_plant', confidence: 'firm', needed_by_date: '2030-05-05' };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'app_settings' ? { setting_value: '{}' } : table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [fixture.item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [fixture.product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: quote.id, row_version: 8, item_ids: {}, section_ids: {} }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const timing = await screen.findByLabelText('Timing') as HTMLSelectElement;
    await waitFor(() => expect(timing.value).toBe('pre_plant'));
    await waitFor(() => expect(timing).not.toBeDisabled());
    fireEvent.change(timing, { target: { value: 'late_summer' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'save_quote')).toBe(true));
    const sent = (mockRpc.mock.calls.find(([name]) => name === 'save_quote')![1] as {
      p_sections: Array<{ timing: string | null; needed_by_date: string | null }>;
    }).p_sections[0];
    expect(sent).toMatchObject({ timing: 'late_summer', needed_by_date: '2030-05-05' });
  });

  it('a timing pick on a section with a live job leaves its needed-by date empty (the job locks it)', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, is_planned: true };
    const section = { ...fixture.section, field_id: 'field-1', needed_by_date: null };
    const job = { id: 'job-7', job_number: 'J-7', status: 'scheduled', quote_section_id: section.id };
    // Serve the timing windows so the pick is live and only the job rule can keep the date empty.
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'app_settings' ? { setting_value: '{}' } : table === 'quotes' ? quote
      : table === 'quote_sections' ? [section] : table === 'quote_items' ? [fixture.item]
        : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
          : table === 'products' ? [fixture.product] : table === 'fields' ? [HOME_QUARTER_OF_CUSTOMER_1]
            : table === 'jobs' ? [job] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: quote.id, row_version: 8, item_ids: {}, section_ids: {} }, error: null }
      : { data: null, error: null }));
    renderQuoteBuilder(quote.id);
    await screen.findByText(/Job J-7 was scheduled from this section/);
    await waitFor(() => expect(screen.getByLabelText('Timing')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'in_season' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'save_quote')).toBe(true));
    const sent = (mockRpc.mock.calls.find(([name]) => name === 'save_quote')![1] as {
      p_sections: Array<{ timing: string | null; needed_by_date: string | null }>;
    }).p_sections[0];
    expect(sent).toMatchObject({ timing: 'in_season', needed_by_date: null });
  });

  it('shows another rep’s booking’s timing and confidence read-only', async () => {
    const fixture = makeQuoteFixture('revised', 7);
    const quote = { ...fixture.quote, is_planned: true, created_by: 'other-rep' };
    const section = { ...fixture.section, timing: 'in_season', confidence: 'likely' };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [fixture.item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [fixture.product] : [], error: null }));
    mockRpc.mockResolvedValue({ data: null, error: null });
    authState.role = 'sales_rep';
    try {
      renderQuoteBuilder(quote.id);
      const timing = await screen.findByLabelText('Timing') as HTMLSelectElement;
      await waitFor(() => expect(timing.value).toBe('in_season'));
      expect(timing).toBeDisabled();
      expect(screen.getByLabelText('Confidence')).toBeDisabled();
      // The price-only path refuses a planning change, so the date is read-only too.
      for (const seg of screen.getAllByRole('spinbutton', { name: /Needed by/ })) expect(seg).toHaveAttribute('aria-disabled', 'true');
    } finally {
      authState.role = 'admin';
    }
  });

  it('stops naming a line as its saved line once it is switched to another product, even if switched back', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const alpha = { ...fixture.product, product_name: 'Alpha Chem' };
    const beta = { ...fixture.product, id: 'product-2', product_name: 'Beta Chem' };
    const first = { ...fixture.item, product: alpha };
    const second = { ...fixture.item, id: 'item-2', sort_order: 1, product: alpha };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? fixture.quote : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [first, second] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [alpha, beta] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: fixture.quote.id, row_version: 8, item_ids: {} }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(fixture.quote.id);
    const pick = async (lineIndex: number, productName: string) => {
      fireEvent.click((await screen.findAllByRole('button', { name: /Alpha Chem|Beta Chem/ }))[lineIndex]);
      const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
      const dialog = picker.closest('[role="dialog"]') as HTMLElement;
      fireEvent.click(within(dialog).getByText(productName));
      await waitFor(() => expect(screen.queryByPlaceholderText('Search by name, SKU, category, or vendor...')).not.toBeInTheDocument());
    };
    await pick(0, 'Beta Chem');
    await pick(0, 'Alpha Chem');
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    const lines = (mockRpc.mock.calls.find(([name]) => name === 'save_quote')![1] as {
      p_sections: Array<{ items: Array<{ id: string | null; product_id: string }> }>;
    }).p_sections.flatMap((s) => s.items);
    expect(lines.map((line) => [line.id, line.product_id])).toEqual([[null, 'product-1'], ['item-2', 'product-1']]);
  });

  it('shows Reload/review for a stale draft save after another tab sent the quote', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? {
          data: null,
          error: {
            code: 'P0001',
            message: 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving',
          },
        }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue(quote.header_notes);
    fireEvent.change(header, { target: { value: 'Keep stale draft edit for review' } });
    fireEvent.click(screen.getByText('Save draft'));

    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep stale draft edit for review')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({
        status: 'draft',
        row_version_expected: 7,
        header_notes: 'Keep stale draft edit for review',
      }),
    }));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.anything());
  });

  /**
   * F1, ALIASED-RESET CLASS — driven through the real save handler rather than read
   * off the source.
   *
   * `save_quote` answering `{ data: null, error: null }` is the AMBIGUOUS reply: no
   * error came back, but the payload is empty, so this tab cannot tell whether the
   * quote committed. assertRpcResult exists to reject exactly that. Retiring the key
   * before that check — which is what main did, through the destructured rename the
   * literal `resetKey()` sweep could not see — sends the operator's retry under a
   * BRAND-NEW key. The server cannot recognise a key it has never seen, so it writes
   * the quote a second time.
   *
   * The two assertions bind the PAIR: the key is not retired, AND the retry actually
   * travels under the original key. Asserting only the first would still pass if the
   * retry minted a fresh key some other way.
   */
  it('keeps the save_quote key when the reply is empty, so the retry replays instead of double-writing', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    // An empty success envelope on every attempt: the reply stays ambiguous, so the
    // key must stay put no matter how many times the operator presses Save.
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));

    renderQuoteBuilder(quote.id);
    await makeAnEdit();
    fireEvent.click(await screen.findByText('Save draft'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quote.id}-0`,
    })));
    expect(
      mockResetIdempotencyKey,
      'an empty save_quote reply is ambiguous — the key must survive it so a retry can replay',
    ).not.toHaveBeenCalled();

    // The reply was ambiguous, so the quote still has unsaved changes: the retry needs no new edit.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled());
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => {
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(saves.length).toBeGreaterThan(1);
    });
    const saveKeys = mockRpc.mock.calls
      .filter(([name]) => name === 'save_quote')
      .map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);
    expect(
      new Set(saveKeys),
      'every retry of an unresolved save must carry the SAME key, or the server writes the quote twice',
    ).toEqual(new Set([`test-idem-key-${quote.id}-0`]));
  });

  /**
   * The half of the ambiguous-reply space the test above does NOT cover.
   *
   * `{ data: null }` is rejected by assertRpcResult, which throws before the key is
   * ever retired — so that test passes even against code that retires first and
   * checks later. `{ data: {} }` is the reply that actually gets through:
   * assertRpcResult rejects only a MISSING reply, so an empty object reaches the
   * caller looking like a success that simply has no id in it.
   *
   * On an edit route the old code then read `result.quote_id || quoteId` and took the
   * id straight off the URL, so the unverified save reported itself as confirmed AND
   * its key was gone. On a create there is no URL id to borrow, so the retry minted a
   * fresh key the server could not recognise and wrote the quote a second time.
   */
  it('keeps the save_quote key when the reply is an empty OBJECT, not just when it is missing', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: {}, error: null }));

    renderQuoteBuilder(quote.id);
    await makeAnEdit();
    fireEvent.click(await screen.findByText('Save draft'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quote.id}-0`,
    })));
    expect(
      mockResetIdempotencyKey,
      'an empty save_quote OBJECT is ambiguous — retiring the key here is what writes the quote twice',
    ).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('came back without an ID'));

    // The reply was ambiguous, so the quote still has unsaved changes: the retry needs no new edit.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled());
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => {
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(saves.length).toBeGreaterThan(1);
    });
    const saveKeys = mockRpc.mock.calls
      .filter(([name]) => name === 'save_quote')
      .map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);
    expect(new Set(saveKeys)).toEqual(new Set([`test-idem-key-${quote.id}-0`]));
  });

  /**
   * Retaining the key is only half a retry. The server fingerprints the WHOLE request
   * — `md5(quote_id || quote_payload || sections || performed_by)` in
   * 20260812115236_quote_items_cost_at_quote_snapshot.sql:348 — and answers a replay
   * whose fingerprint differs with IDEMPOTENCY_PAYLOAD_CONFLICT rather than the cached
   * result. `expires_at` was built from `Date.now()` on every save, so the retry this
   * page instructs the operator to perform sent a different millisecond every time and
   * could never redeem the key it had just been told to keep.
   *
   * `Date.now` is forced to advance here on purpose. Two clicks in a real test run can
   * land inside the same millisecond, and this test would then pass against the very
   * bug it exists to catch.
   *
   * Covered on the EDIT path. The create path builds its payload from the same lines
   * with the same frozen clock and differs only in the scope string (`'new'`), but
   * driving a create to a save through this harness needs a customer and an item
   * selected in the UI, so create is reasoned, not executed, here.
   */
  it('sends a byte-identical payload on the retry, not just an identical key', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    // First attempt is ambiguous, so the key is retained. Second attempt is the retry.
    mockRpc
      .mockImplementationOnce(() => Promise.resolve({ data: {}, error: null }))
      .mockImplementation(() => Promise.resolve({
        data: { quote_id: quote.id, row_version: 8 },
        error: null,
      }));

    renderQuoteBuilder(quote.id);
    await screen.findByText('Save draft');
    await makeAnEdit();

    let clock = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 60_000;
      return clock;
    });

    try {
      fireEvent.click(screen.getByText('Save draft'));
      await waitFor(() => {
        expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote').length).toBe(1);
      });
      expect(mockResetIdempotencyKey).not.toHaveBeenCalled();

      // The reply was ambiguous, so the quote still has unsaved changes: the retry needs no new edit.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled());
      fireEvent.click(screen.getByText('Save draft'));
      await waitFor(() => {
        expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote').length).toBe(2);
      });

      const saves = mockRpc.mock.calls
        .filter(([name]) => name === 'save_quote')
        .map(([, args]) => args as {
          p_idempotency_key: string;
          p_quote_payload: Record<string, unknown>;
          p_sections: unknown;
        });

      expect(saves[1].p_idempotency_key).toBe(saves[0].p_idempotency_key);
      expect(
        saves[1].p_quote_payload.expires_at,
        'expires_at moved between attempts, so the server fingerprint cannot match',
      ).toBe(saves[0].p_quote_payload.expires_at);
      // Everything the server hashes, not only the field that regressed.
      expect(saves[1].p_quote_payload).toEqual(saves[0].p_quote_payload);
      expect(saves[1].p_sections).toEqual(saves[0].p_sections);

      // The retry redeemed the receipt, so the key is finally retired.
      await waitFor(() => expect(mockResetIdempotencyKey).toHaveBeenCalled());
    } finally {
      nowSpy.mockRestore();
    }
  });

  // Item 9 (Mason 2026-10-26/27): a booking runs to season end (Sept 30) unless the rep picks a
  // date. The database applies the pick at each send; the screen sends it with every save.
  describe('expiry: season end or a picked date', () => {
    function serveDraft(overrides: Record<string, unknown>) {
      const { quote, product, section, item } = makeQuoteFixture('draft', 7);
      const served = { ...quote, ...overrides };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? served
          : table === 'quote_sections' ? [section]
          : table === 'quote_items' ? [item]
          : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
          : table === 'products' ? [product]
          : [],
        error: null,
      }));
      mockRpc.mockImplementation(() => Promise.resolve({ data: { quote_id: served.id, row_version: 8 }, error: null }));
      return served;
    }
    // Expires is a kit Dropdown (trigger button + listbox); a picked date shows in the kit DatePicker.
    const expiresTrigger = () => screen.getByRole('button', { name: /Expires/ });
    const expiryDay = () => ['month', 'day', 'year'].map((t) => within(screen.getByRole('group', { name: 'Expiry date' }))
      .getAllByRole('spinbutton').find((el) => el.getAttribute('data-type') === t)!.textContent).join('/');
    async function saveDraftPayload() {
      await makeAnEdit();
      fireEvent.click(screen.getByText('Save draft'));
      await waitFor(() => {
        expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote').length).toBe(1);
      });
      const [, args] = mockRpc.mock.calls.find(([name]) => name === 'save_quote')!;
      return (args as { p_quote_payload: Record<string, unknown> }).p_quote_payload;
    }

    it('keeps a picked date and sends it as the expiry', async () => {
      const quote = serveDraft({ chosen_expiry_date: '2026-12-15' });
      renderQuoteBuilder(quote.id);
      await screen.findByText('Save draft');

      expect(expiresTrigger()).toHaveTextContent('Pick a date');
      expect(expiryDay()).toBe('12/15/2026');
      const payload = await saveDraftPayload();
      expect(payload.chosen_expiry_date).toBe('2026-12-15');
      expect(payload.expires_at).toBe('2026-12-15');
    });

    it('switching to season end clears the pick and shows Sept 30', async () => {
      const quote = serveDraft({ chosen_expiry_date: '2026-12-15' });
      renderQuoteBuilder(quote.id);
      await screen.findByText('Save draft');

      fireEvent.click(expiresTrigger());
      // "Today" is pinned to 2026-03-16 above: season 2026, which ends Sept 30, 2026.
      fireEvent.click(screen.getByRole('option', { name: 'Sep 30, 2026 (season end)' }));
      expect(screen.queryByRole('group', { name: 'Expiry date' })).not.toBeInTheDocument();
      expect(expiresTrigger()).toHaveTextContent('Sep 30, 2026 (season end)');
      const payload = await saveDraftPayload();
      expect(payload.chosen_expiry_date).toBeNull();
      expect(payload.expires_at).toBe('2026-09-30');
      expect(payload).not.toHaveProperty('valid_days');
    });

    it('expiry "Pick a date" opens the DatePicker', async () => {
      const quote = serveDraft({ chosen_expiry_date: null });
      renderQuoteBuilder(quote.id);
      await screen.findByText('Save draft');
      expect(screen.queryByRole('group', { name: 'Expiry date' })).not.toBeInTheDocument();

      fireEvent.click(expiresTrigger());
      fireEvent.click(screen.getByRole('option', { name: 'Pick a date' }));
      expect(expiresTrigger()).toHaveTextContent('Pick a date');
      expect(await screen.findByRole('group', { name: 'Expiry date' })).toBeInTheDocument();
      const payload = await saveDraftPayload();
      expect(payload.chosen_expiry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(payload.expires_at).toBe(payload.chosen_expiry_date);
      // The DatePicker shows the same plain day the quote stores.
      const [y, m, d] = String(payload.chosen_expiry_date).split('-').map(Number);
      expect(expiryDay()).toBe(`${m}/${d}/${y}`);
    });

    it('a quote with no pick opens on season end', async () => {
      const quote = serveDraft({ chosen_expiry_date: null });
      renderQuoteBuilder(quote.id);
      await screen.findByText('Save draft');

      expect(expiresTrigger()).toHaveTextContent('Sep 30, 2026 (season end)');
      expect((await saveDraftPayload()).chosen_expiry_date).toBeNull();
    });
  });

  /**
   * Only ONE of this page's eleven dialog openers is a save_quote conflict.
   *
   * The other ten are lifecycle actions — decline, email, version restore, convert,
   * book-as-order — that own no save_quote key at all. Recording the save scope at
   * those sites made the dialog claim an origin it did not have, so the reload it
   * offered retired a save_quote receipt whose own reply had never been validated.
   */
  it('does not let a decline-originated recovery reload release the save_quote key', async () => {
    const quote = { id: 'quote-decline-key', quote_number: 'Q-decline-key', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Local note', footer_notes: '', status: 'sent', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quotes') {
        return buildUpdateChain(
          { data: quote, error: null },
          { data: [{ ...quote, status: 'declined', row_version: 9 }], error: null },
        );
      }
      const data = table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [];
      return buildChain({ data, error: null });
    });

    renderQuoteBuilder(quote.id);
    await screen.findByDisplayValue('Local note');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Decline quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline quote' }));

    fireEvent.click(await screen.findByText('Reload Quote'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());

    expect(
      mockResetIdempotencyKey,
      'a decline owns no save_quote key, so the recovery reload it opens must retire none',
    ).not.toHaveBeenCalled();
  });

  /**
   * The cost of F1 retention, paid for by scoping — raised by the gpt-5.6-sol review
   * of dff631f1 as the QuoteBuilder mirror of a finding already fixed in
   * CustomerDetail.
   *
   * Retaining the key past an ambiguous reply is the whole point of F1, but a
   * page-wide key then OUTLIVES the quote it was minted for. QuoteBuilder does not
   * remount when only `:id` changes, so quote B's save would go out under quote A's
   * unresolved key. The server fingerprints the payload against the cached key and
   * answers IDEMPOTENCY_PAYLOAD_CONFLICT — it fails closed, so there is no
   * cross-quote write — but B gets a conflict dialog it did nothing to earn.
   *
   * The fix scopes the key to the quote the RPC actually targets. This test binds
   * that: it deliberately reads the key OFF THE WIRE for B, so it fails if the scope
   * argument is dropped (both quotes would then share `test-idem-key--0`).
   */
  it('does not hand quote B the unresolved key minted for quote A', async () => {
    const { quote: quoteA, product, section, item } = makeQuoteFixture('draft', 7);
    const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (quoteReads++ === 0 ? quoteA : quoteB)
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    // Ambiguous on every attempt, so A's key is still outstanding when B is opened.
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));

    renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
    await makeAnEdit();
    fireEvent.click(await screen.findByText('Save draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quoteA.id}-0`,
    })));
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
    await screen.findByDisplayValue('Quote B header');

    await makeAnEdit();
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => {
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(saves.length).toBeGreaterThan(1);
    });
    const saveKeys = mockRpc.mock.calls
      .filter(([name]) => name === 'save_quote')
      .map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);
    const lastSaveKey = saveKeys[saveKeys.length - 1];
    expect(
      lastSaveKey,
      "quote B must mint its OWN key — inheriting A's unresolved key earns B a conflict dialog it did not cause",
    ).toBe(`test-idem-key-${quoteB.id}-0`);
  });

  /**
   * The second-order cost of scoping the key, raised by the gpt-5.6-sol review of
   * 5dad64e2 as a NEW interaction the scoping itself created.
   *
   * `reloadAfterStaleSave` releases the CURRENT render's scope. While one page-wide key
   * existed that was always the right one. Once the key is scoped, the stale-save dialog
   * — which stays open across a route change — can be recovered on a DIFFERENT quote:
   * clicking Reload would then retire quote B's key and strand quote A's rejected one,
   * so returning to A replays the same rejected key and re-opens the same conflict.
   *
   * The recovery is now bound to the quote that produced it. Retaining A's key is the
   * safe direction: a retained key can still replay, a wrongly retired one cannot.
   */
  it('retires neither quote\'s key when A\'s conflict dialog is recovered after a route change', async () => {
    const { quote: quoteA, product, section, item } = makeQuoteFixture('draft', 7);
    const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (quoteReads++ === 0 ? quoteA : quoteB)
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: null, error: { message: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } }
        : { data: null, error: null },
    ));

    renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
    await makeAnEdit();
    fireEvent.click(await screen.findByText('Save draft'));
    // A's save is rejected, so A's recovery dialog opens.
    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();

    // The operator navigates to B with that dialog still open, then recovers it.
    fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
    await screen.findByDisplayValue('Quote B header');
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());

    expect(
      mockResetIdempotencyKey,
      "recovering A's conflict must not retire quote B's key — B never had an unresolved save",
    ).not.toHaveBeenCalledWith(quoteB.id);
    // And it must not retire A's key either, even though A's dialog is what closed.
    //
    // An earlier revision did retire it, on the reasoning that a payload-rejected key
    // can only ever be rejected again. That was a duplicate-write hazard: the key
    // rejects the CHANGED payload, but replaying the ORIGINAL one returns the server's
    // cached receipt, which on a create is the only way to learn the id of a row that
    // may already have committed. Retiring it lets a later retry insert twice.
    //
    // Retaining costs one unearned conflict dialog on returning to A, which self-heals
    // on A's own reload. That is the cheaper side of the trade, so this asserts the
    // key survives.
    expect(
      mockResetIdempotencyKey,
      "A's key is the receipt handle for a create that may have committed — recovery on another quote must not retire it",
    ).not.toHaveBeenCalledWith(quoteA.id);
  });

  it('recovers a legacy cached save after the migration boundary and releases its unusable key', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    let saveAttempts = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
      saveAttempts += 1;
      return Promise.resolve(saveAttempts === 1
        ? { data: null, error: { message: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } }
        : { data: { quote_id: quote.id, row_version: 8 }, error: null });
    });

    renderQuoteBuilder(quote.id);
    await makeAnEdit();
    fireEvent.click(await screen.findByText('Save draft'));

    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenLastCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quote.id}-0`,
    }));
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    await makeAnEdit();
    fireEvent.click(screen.getByText('Save draft'));
    // The fresh key's save; a cost refresh may follow it.
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quote.id}-1`,
    })));
  });

  it('keeps a pre-migration existing Quote save compatible when both tokens are absent', async () => {
    const { quote, product, section, item } = makeQuoteFixture();
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    await makeAnEdit();
    fireEvent.click(await screen.findByText('Save draft'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: null }),
    })));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version'));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('reloads a pre-migration Quote after a commission-split conflict without requiring a row-version token', async () => {
    const { quote, product, section, item } = makeQuoteFixture();
    const reloadedQuote = {
      ...quote,
      header_notes: 'Saved by the other workflow',
      commission_split: { splits: [{ sales_rep_id: 'admin-1', percentage: 100 }] },
    };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : reloadedQuote)
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: null, error: { code: 'P0001', message: 'COMMISSION_SPLIT_CONFLICT: changed elsewhere' } }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue(quote.header_notes);
    fireEvent.change(header, { target: { value: 'Unsaved local edit' } });
    fireEvent.click(screen.getByText('Save draft'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload Quote' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('Saved by the other workflow')).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('stable saved quote'));
  });

  it('adopts an exact N+1 save token and sends it on the next same-page save', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    let saveCalls = 0;
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: ++saveCalls === 1 ? 8 : 9 }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    await makeAnEdit();
    fireEvent.click(await screen.findByText('Save draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 7 }),
    })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toHaveAttribute('title', 'No changes to save'));
    await makeAnEdit('Second edit');
    await waitFor(() => expect(screen.getByText('Save draft')).not.toBeDisabled());

    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => {
      const quoteSaves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(quoteSaves).toHaveLength(2);
      expect(quoteSaves[1][1]).toEqual(expect.objectContaining({
        p_quote_payload: expect.objectContaining({ row_version_expected: 8 }),
      }));
    });
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version'));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('rejects a missing authoritative save token after a numeric Quote token was loaded', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    await makeAnEdit();
    fireEvent.click(await screen.findByText('Save draft'));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('save-protection version could not be confirmed'),
    ));
    expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 7 }),
    }));
  });

  it('keeps a pre-migration same-page reopen compatible when its reread remains tokenless', async () => {
    const { quote, product, section, item } = makeQuoteFixture('accepted');
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'revert_quote_status'
      ? { data: { success: true, old_status: 'accepted', new_status: 'sent' }, error: null }
      : name === 'save_quote'
        ? { data: { quote_id: quote.id }, error: null }
        : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Un-accept' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this quote being reopened?'), {
      target: { value: 'Corrected customer request' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Un-accept' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Quote reopened to sent.'));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version'));
    fireEvent.click(await screen.findByRole('button', { name: 'Revise quote' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: null }),
    })));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version'));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('keeps a committed direct decline visible and opens recovery when its returned version jumps from 7 to 9', async () => {
    const quote = { id: 'quote-direct-jump', quote_number: 'Q-direct-jump', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Keep this local note', footer_notes: '', status: 'sent', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quotes') {
        return buildUpdateChain(
          { data: quote, error: null },
          { data: [{ ...quote, status: 'declined', row_version: 9 }], error: null },
        );
      }
      const data = table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [];
      return buildChain({ data, error: null });
    });

    renderQuoteBuilder(quote.id);
    fireEvent.change(await screen.findByDisplayValue('Keep this local note'), { target: { value: 'Keep this local edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Decline quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline quote' }));

    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();
    expect(screen.getAllByText('Declined')).not.toHaveLength(0);
    expect(screen.getByDisplayValue('Keep this local edit')).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('another edit may have completed'));
  });

  it('keeps the conflict dialog and every local quote edit when Reload cannot read sections', async () => {
    const quote = { id: 'quote-partial', quote_number: 'Q-partial', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let sectionReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quote_sections' && ++sectionReads > 1) return buildChain({ data: null, error: { message: 'sections unavailable' } });
      const data = table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [];
      return buildChain({ data, error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'QUOTE_STALE_WRITE' } });
    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue('Original header');
    fireEvent.change(header, { target: { value: 'Keep this quote edit' } });
    fireEvent.click(screen.getByText('Save draft'));
    await screen.findByText('Reload Quote');
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('current edits were kept')));
    expect(screen.getByText('Reload Quote')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this quote edit')).toBeInTheDocument();
  });

  it('keeps the conflict dialog and local quote when the header version changes during Reload', async () => {
    const quote = { id: 'quote-unstable-reload', quote_number: 'Q-unstable', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const changedQuote = { ...quote, header_notes: 'Other writer header', row_version: 8 };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => {
      const quoteData = table === 'quotes'
        ? (++quoteReads <= 2 ? quote : quoteReads === 3 ? changedQuote : { row_version: 9 })
        : null;
      return buildChain({ data: table === 'quotes' ? quoteData : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'QUOTE_STALE_WRITE' } });
    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue('Original header');
    fireEvent.change(header, { target: { value: 'Keep this quote edit' } });
    fireEvent.click(screen.getByText('Save draft'));
    await screen.findByText('Reload Quote');
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('stable saved quote')));
    expect(screen.getByText('Reload Quote')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this quote edit')).toBeInTheDocument();
  });

  it('uses the reread token after reopening before the next revise/save', async () => {
    const quote = { id: 'quote-reopen', quote_number: 'Q-reopen', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : { row_version: 8 }) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'revert_quote_status'
      ? { data: { success: true, old_status: 'accepted', new_status: 'sent' }, error: null }
      : { data: { quote_id: quote.id, row_version: 9 }, error: null }));
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Un-accept' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this quote being reopened?'), { target: { value: 'Corrected customer request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Un-accept' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revise quote' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 8 }),
    })));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('fails closed instead of adopting a jumped post-reopen token', async () => {
    const quote = { id: 'quote-jumped-token', quote_number: 'Q-jumped', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : { row_version: 9 }) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'revert_quote_status'
      ? { data: { success: true, old_status: 'accepted', new_status: 'sent' }, error: null }
      : { data: { quote_id: quote.id, row_version: 10 }, error: null }));
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Un-accept' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this quote being reopened?'), { target: { value: 'Corrected customer request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Un-accept' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version could not be confirmed')));
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote reopened to sent.');
    fireEvent.click(await screen.findByRole('button', { name: 'Revise quote' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: null }),
    })));
  });

  it('keeps the committed reopened status and gives refresh guidance when its token reread fails', async () => {
    const quote = { id: 'quote-reopen-read-fail', quote_number: 'Q-reopen-read-fail', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quotes') {
        quoteReads += 1;
        return buildChain(quoteReads <= 2 ? { data: quote, error: null } : { data: null, error: { message: 'row version read failed' } });
      }
      return buildChain({ data: table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : [], error: null });
    });
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'revert_quote_status'
      ? { data: { success: true, old_status: 'accepted', new_status: 'sent' }, error: null }
      : { data: null, error: null }));
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Un-accept' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this quote being reopened?'), { target: { value: 'Corrected customer request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Un-accept' }));
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('was reopened'));
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote reopened to sent.');
  });

  it('uses the reread token after freezing a quote before the next revise/save', async () => {
    const quote = { id: 'quote-freeze', quote_number: 'Q-freeze', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    let quoteSaves = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : { row_version: 9 }) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: ++quoteSaves === 1 ? 8 : 10 }, error: null }
      : { data: { version_number: 1, row_version: 9 }, error: null }));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:quote'), revokeObjectURL: vi.fn() });
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as presented' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.objectContaining({
      p_expected_row_version: 8,
    })));
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
    fireEvent.click(await screen.findByRole('button', { name: 'Revise quote' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 9 }),
    })));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('locks the form while Mark as presented is still recording the version (Sol #1980 r5)', async () => {
    const quote = { id: 'quote-present-lock', quote_number: 'Q-lock', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let finishVersion: (value: unknown) => void = () => {};
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => name === 'save_quote'
      ? Promise.resolve({ data: { quote_id: quote.id, row_version: 8 }, error: null })
      : name === 'create_quote_version'
        ? new Promise((resolve) => { finishVersion = resolve; })
        : Promise.resolve({ data: null, error: null }));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:quote'), revokeObjectURL: vi.fn() });
    renderQuoteBuilder(quote.id);
    expect(await screen.findByDisplayValue('Products')).toBeEnabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as presented' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.anything()));
    // Version still recording: an edit made now would not be in the sent booking.
    expect(screen.getByDisplayValue('Products')).toBeDisabled();
    finishVersion({ data: { version_number: 1, row_version: 9 }, error: null });
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
  });

  it('requires a numeric reload and a new confirmed freeze before retrying an aborted email', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    let recoveryReadMode: 'jumped' | 'tokenless' | 'stable' | 'refrozen' = 'jumped';
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2
            ? quote
            : recoveryReadMode === 'tokenless'
              ? { ...quote, status: 'sent', row_version: undefined }
              : { ...quote, status: 'sent', row_version: recoveryReadMode === 'refrozen' ? 10 : 9 })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation(() => Promise.resolve({
      data: {
        version_number: 1,
        status: 'created',
        row_version: recoveryReadMode === 'refrozen' ? 10 : 8,
      },
      error: null,
    }));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to grower' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('save-protection version could not be confirmed'),
    ));
    expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('email was NOT sent'),
    );
    fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Email to grower' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('email was NOT sent'),
    ));
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.stringContaining('Quote emailed'));

    recoveryReadMode = 'tokenless';
    fireEvent.click(screen.getByRole('button', { name: 'Reload Quote' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('stable saved quote'),
    ));
    expect(screen.getByText('Reload Quote')).toBeInTheDocument();
    expect(mockSendEmail).not.toHaveBeenCalled();

    recoveryReadMode = 'stable';
    fireEvent.click(screen.getByRole('button', { name: 'Reload Quote' }));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());
    recoveryReadMode = 'refrozen';
    fireEvent.click(screen.getByRole('button', { name: 'Email to grower' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'create_quote_version')).toHaveLength(2);
  });

  it('creates and confirms a new version before emailing an already-sent quote after remount', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const { product, section, item } = fixture;
    const quote = { ...fixture.quote, status: 'sent' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : { ...quote, row_version: 8 })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'create_quote_version'
        ? { data: { version_number: 2, status: 'created', row_version: 8 }, error: null }
        : { data: null, error: null },
    ));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to grower' }));

    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.objectContaining({
      p_quote_id: quote.id,
      p_method: 'emailed',
      p_expected_row_version: 7,
    }));
    // The PDF carries the expiry this send stored, read as a local date, not created_at + valid_days.
    expect(mockGenerateQuotePdf).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: new Date(2026, 10, 25).toISOString() }),
      expect.anything(),
    );
    expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('Quote emailed'));
  });

  it('does not email the quote when the expiry its send stored cannot be read', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const { product, section, item } = fixture;
    const quote = { ...fixture.quote, status: 'sent' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : quoteReads === 3 ? { ...quote, row_version: 8 } : { ...quote, row_version: 8, expires_at: null })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'create_quote_version'
        ? { data: { version_number: 2, status: 'created', row_version: 8 }, error: null }
        : { data: null, error: null },
    ));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to grower' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('expiry date could not be read')));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('replays the same version key and original token after the snapshot succeeds but email delivery fails', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    let createVersionCalls = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : { ...quote, status: 'sent', row_version: 8 })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'create_quote_version') {
        createVersionCalls += 1;
        return Promise.resolve({
          data: {
            version_number: 1,
            status: createVersionCalls === 1 ? 'created' : 'duplicate',
            row_version: 8,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mockSendEmail
      .mockRejectedValueOnce(new Error('email transport failed'))
      .mockResolvedValueOnce({ deduplicated: false });

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to grower' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'email transport failed'));

    fireEvent.click(screen.getByRole('button', { name: 'Email to grower' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(2));

    const versionCalls = mockRpc.mock.calls.filter(([name]) => name === 'create_quote_version');
    expect(versionCalls).toHaveLength(2);
    expect(versionCalls[0][1]).toEqual(expect.objectContaining({
      p_expected_row_version: 7,
    }));
    expect(versionCalls[1][1]).toEqual(expect.objectContaining({
      p_idempotency_key: versionCalls[0][1].p_idempotency_key,
      p_expected_row_version: 7,
    }));
    expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('Quote emailed'));
  });

  it('uses the cached post token when the first lifecycle response is lost', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    let createVersionCalls = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : { ...quote, status: 'sent', row_version: 8 })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'create_quote_version') {
        createVersionCalls += 1;
        return Promise.resolve(createVersionCalls === 1
          ? { data: null, error: { message: 'network response lost' } }
          : {
              data: {
                version_number: 1,
                status: 'duplicate',
                row_version: 8,
              },
              error: null,
            });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to grower' }));
    // ASSERTION DELIBERATELY CHANGED (H5 follow-up). This waited on the canned
    // literal 'Failed to email the quote', which only appeared because the
    // create_quote_version failure — a PLAIN OBJECT from a non-throwing rpc, so
    // `err instanceof Error` was false — had its real message discarded. The
    // subject of this test is the cached post token, not the toast text; it now
    // waits on the reason the server actually gave.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'network response lost'));
    expect(mockSendEmail).not.toHaveBeenCalled();
    // The message reaching the operator went through the REAL sanitizer, so a
    // raw schema identifier could never have been passed along with it.
    const shownHere = mockToast.mock.calls.map((c) => String(c[1])).join(' | ');
    expect(shownHere).not.toMatch(/permission denied for|schema cache|relation "/i);

    fireEvent.click(screen.getByRole('button', { name: 'Email to grower' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));

    const versionCalls = mockRpc.mock.calls.filter(([name]) => name === 'create_quote_version');
    expect(versionCalls).toHaveLength(2);
    expect(versionCalls[1][1]).toEqual(expect.objectContaining({
      p_idempotency_key: versionCalls[0][1].p_idempotency_key,
      p_expected_row_version: 7,
    }));
    expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument();
  });

  it('holds a stale version action key until a stable reload, then retries with the refreshed quote token', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    let createVersionCalls = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2
            ? quote
            : { ...quote, row_version: quoteReads <= 4 ? 8 : 9 })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'create_quote_version') {
        createVersionCalls += 1;
        return Promise.resolve(createVersionCalls === 1
          ? { data: null, error: { message: 'QUOTE_STALE_WRITE' } }
          : { data: { version_number: 2, status: 'created', row_version: 9 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to grower' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload Quote' })).toBeInTheDocument());
    expect(mockSendEmail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Email to grower' }));
    expect(createVersionCalls).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Reload Quote' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument());
    // ONE release, not two. The version-action key is retired, because this reload is
    // that action's own recovery. The save_quote key is NOT, because no save_quote
    // conflict happened here — an email/version failure opened this dialog. The
    // second release this once expected was the coupling CodeRabbit flagged at
    // CustomerDetail:964: a lifecycle recovery retiring a whole-record save receipt
    // whose own reply was never validated.
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Email to grower' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.objectContaining({
      p_expected_row_version: 8,
    }));
  });

  it('converts a sent quote in one step, without saving it as accepted first (KI-12)', async () => {
    const fixture = makeQuoteFixture('sent', 7);
    const quote = { ...fixture.quote, created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [fixture.product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'convert_quote_to_order'
      ? { data: { status: 'converted', order_id: 'order-1', order_number: 'O-1', warnings: [] }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create order' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-1'));
    // The RPC accepts the quote in the same transaction as the order, against the loaded token.
    expect(mockRpc).toHaveBeenCalledWith(
      'convert_quote_to_order',
      expect.objectContaining({ p_quote_id: quote.id, p_expected_row_version: 7 }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
  });

  it('leaves the quote status alone when the conversion fails', async () => {
    const fixture = makeQuoteFixture('sent', 7);
    const quote = { ...fixture.quote, created_at: new Date().toISOString() };
    const quoteUpdates: unknown[] = [];
    mockFrom.mockImplementation((table: string) => {
      const chain = buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [fixture.product]
                  : [],
        error: null,
      });
      if (table === 'quotes') {
        chain.update = (values: unknown) => {
          quoteUpdates.push(values);
          return chain;
        };
      }
      return chain;
    });
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'convert_quote_to_order'
      ? { data: null, error: { message: 'COST_BASIS_REQUIRED: a line has no cost' } }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create order' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('no recorded cost')));
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(quoteUpdates).toEqual([]);
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining('/orders/'));
  });

  // Item 11 (Mason 2026-10-26): a rep is warned when cost has gone up since a line was quoted,
  // without seeing any cost number (20261030090000 returns yes/no flags only).
  describe('cost-rise warning for reps', () => {
    function serveSentQuote(alerts: Array<{ quote_item_id: string; cost_rose: boolean; below_cost: boolean }>) {
      const fixture = makeQuoteFixture('sent', 7);
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? fixture.quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [fixture.product]
                  : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_quote_cost_alerts'
        ? { data: alerts, error: null }
        : { data: null, error: null }));
      return fixture;
    }

    it('tells a rep the cost has gone up, with no numbers', async () => {
      authState.role = 'sales_rep';
      const fixture = serveSentQuote([{ quote_item_id: 'item-1', cost_rose: true, below_cost: false }]);
      renderQuoteBuilder(fixture.quote.id);
      expect(await screen.findByText('Cost has gone up since this was quoted.')).toBeInTheDocument();
      expect(mockRpc).toHaveBeenCalledWith('get_quote_cost_alerts', { p_quote_id: fixture.quote.id });
      expect(screen.queryByText(/today \$/)).not.toBeInTheDocument();
    });

    it('tells a rep when the price is below today’s cost', async () => {
      authState.role = 'sales_rep';
      const fixture = serveSentQuote([{ quote_item_id: 'item-1', cost_rose: true, below_cost: true }]);
      renderQuoteBuilder(fixture.quote.id);
      expect(await screen.findByText("Below today's cost: converting needs an admin's approval.")).toBeInTheDocument();
      expect(screen.queryByText('Cost has gone up since this was quoted.')).not.toBeInTheDocument();
    });

    it('does not ask for the flags for an admin, who sees the costs themselves', async () => {
      const fixture = serveSentQuote([{ quote_item_id: 'item-1', cost_rose: true, below_cost: false }]);
      renderQuoteBuilder(fixture.quote.id);
      await screen.findByRole('spinbutton', { name: 'Price per unit' });
      expect(mockRpc).not.toHaveBeenCalledWith('get_quote_cost_alerts', expect.anything());
      expect(screen.queryByText('Cost has gone up since this was quoted.')).not.toBeInTheDocument();
    });
  });

  // Item 11a / KI-82: after Save an admin sees the cost the database recorded for each saved line,
  // not the cost the page loaded with, and the just-saved quote is not marked as changed.
  it('shows each saved line’s recorded cost after Save, without marking the quote changed', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string, args?: unknown) => {
      if (name === 'save_quote') {
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string; price_per_unit: number }> }> }).p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: line.price_per_unit },
        }, error: null });
      }
      if (name === 'get_admin_cost_fields') {
        // The database recorded $7.00 for the saved line, today's cost for the product; the page
        // loaded both at $6.00.
        const table = (args as { p_table: string }).p_table;
        return Promise.resolve({ data: table === 'quote_items'
          ? { 'item-1': { current_cost: 7, profit: 6, net_margin: 30, cost_at_quote_cents: 700 } }
          : { 'product-1': { current_cost: 7 } }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    await screen.findByText('$6.00');
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    await makeAnEdit();
    fireEvent.click(screen.getByText('Save draft'));

    expect(await screen.findByText('$7.00')).toBeInTheDocument();
    // Today's cost is re-read too, so the line never shows a stale "today" beside the recorded cost.
    expect(screen.queryByText(/today \$6\.00/)).not.toBeInTheDocument();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_admin_cost_fields', { p_table: 'products', p_ids: ['product-1'] }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_admin_cost_fields', { p_table: 'quote_items', p_ids: ['item-1'] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dirtyStates[dirtyStates.length - 1]).toBe(false);
  });

  describe('sent-price lock (To-Do 1.2)', () => {
    // A revised quote whose V1 was sent at 10.00; the catalog tier 1 price is 12.00 today.
    function configureLockedQuote(quoteTier = 1, todayTier1Price = 12) {
      const fixture = makeQuoteFixture('sent', 7);
      const quote = { ...fixture.quote, status: 'revised', created_at: new Date().toISOString(), tier: quoteTier };
      const product = { ...fixture.product, tier1_price: todayTier1Price };
      const item = { ...fixture.item, product };
      const sentVersion = {
        id: 'version-1',
        quote_id: quote.id,
        version_number: 1,
        sent_by: 'user-1',
        sent_at: '2026-10-25T15:00:00.000Z',
        sent_method: 'presented',
        snapshot_data: {
          quote: {
            quote_number: quote.quote_number, customer_id: 'customer-1', tier: 1, status: 'sent',
            total_price: 20, total_cost: 12, total_profit: 8, total_margin_pct: 40, valid_days: 30,
            expires_at: null, header_notes: null, footer_notes: null, is_planned: false, commission_split: null,
          },
          sections: [{
            section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null,
            needed_by_date: null,
            items: [{
              quote_item_id: 'item-1', price_override: null, product_id: 'product-1', product_name: 'Product',
              sku: null, sort_order: 0, notes: null, price_per_unit: 10, current_cost: 6, suggested_rate: null,
              actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null,
              total_units_needed: 2, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40,
              calc_mode: 'units_direct', price_unit: null,
            }],
          }],
        },
        pdf_url: null,
        notes: null,
        restore_trusted_at: '2026-10-25T15:00:00.000Z',
      };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [product]
                  : table === 'quote_versions' ? [sentVersion]
                    : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8, item_ids: { } }, error: null }
        : name === 'restore_quote_version'
          ? { data: { status: 'restored', restored_from_version: 1, quote_id: quote.id, row_version: 8 }, error: null }
          : { data: null, error: null }));
      return { quote, sentVersion };
    }
    const savedLine = () => (mockRpc.mock.calls.find(([name]) => name === 'save_quote')?.[1] as {
      p_sections: Array<{ items: Array<{ id: string | null; price_per_unit: number; price_override: number | null; use_todays_price: boolean }> }>;
    }).p_sections[0].items[0];

    // KI-105 (Sol): "Use Tier N" must not change only the label while the lines keep another tier's price.
    it('"Use Tier 1" on a sent Tier 2 quote moves its locked lines to the current Tier 1 price', async () => {
      const { quote } = configureLockedQuote(2);
      renderQuoteBuilder(quote.id);
      const price = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(price).toBeEnabled());
      expect(price).toHaveValue(10);
      fireEvent.click(await screen.findByRole('button', { name: 'Switch to Tier 1' }));

      expect(screen.queryByText(/this quote uses Tier/)).not.toBeInTheDocument();
      expect(price).toHaveValue(12);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' }));
      fireEvent.click(screen.getByRole('button', { name: /^Save (draft|changes)$/ }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      expect(savedLine()).toMatchObject({ id: 'item-1', price_per_unit: 12, use_todays_price: true });
    });

    it('picking the sent tier again after "Use Tier 1" puts back the sent price (Sol, #1605)', async () => {
      const { quote } = configureLockedQuote(2);
      renderQuoteBuilder(quote.id);
      const price = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(price).toBeEnabled());
      fireEvent.click(await screen.findByRole('button', { name: 'Switch to Tier 1' }));
      expect(price).toHaveValue(12);
      fireEvent.change(screen.getByDisplayValue('Tier 1'), { target: { value: '2' } });

      expect(price).toHaveValue(10);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Keep Tier 2' }));
      fireEvent.click(screen.getByRole('button', { name: /^Save (draft|changes)$/ }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      expect(savedLine()).toMatchObject({ id: 'item-1', price_per_unit: 10, use_todays_price: false });
    });

    it('keeps the sent price through an edit after the catalog price rose', async () => {
      const { quote } = configureLockedQuote();
      renderQuoteBuilder(quote.id);
      expect(await screen.findByText(/Prices stay as sent in version 1/)).toBeInTheDocument();
      const units = await screen.findByRole('spinbutton', { name: 'Quantity' });
      await waitFor(() => expect(units).toBeEnabled());
      fireEvent.change(units, { target: { value: '3' } });
      expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toHaveValue(10);
      fireEvent.click(screen.getByRole('button', { name: /^Save (draft|changes)$/ }));

      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      expect(savedLine()).toMatchObject({ id: 'item-1', price_per_unit: 10, price_override: null, use_todays_price: false });
    });

    it('gives the Use today link a real 40px box at md, with no pseudo hit area', async () => {
      const { quote } = configureLockedQuote();
      renderQuoteBuilder(quote.id);
      const link = await screen.findByRole('button', { name: 'Use today $12.00' });
      expect(link.className).toContain('md:min-h-10');
      expect(link.className).not.toContain('md:after:h-8');
      expect(link.className).not.toContain('after:');
    });

    // Item 10b (Mason 2026-10-27, 20261029120000): a changed price applies without a re-send; a
    // higher one needs the rep's "grower agreed" tick. Until then (#1105) it needed a re-send.
    it('takes today\'s price on one line only when asked, with no re-send but the grower\'s OK', async () => {
      const { quote } = configureLockedQuote();
      renderQuoteBuilder(quote.id);
      fireEvent.click(await screen.findByRole('button', { name: 'Use today $12.00' }));

      expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toHaveValue(12);
      expect(screen.getByText('Sent at $10.00')).toBeInTheDocument();
      expect(screen.queryByText(/Prices or lines changed after version 1 was sent/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' }));
      fireEvent.click(screen.getByRole('button', { name: /^Save (draft|changes)$/ }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      expect(savedLine()).toMatchObject({ id: 'item-1', price_per_unit: 12, price_override: null, use_todays_price: true, grower_confirmed: true });
    });

    it('keeps the price the database stored at the last save, not the one loaded', async () => {
      const { quote } = configureLockedQuote();
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string; price_per_unit: number }> }> })
          .p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: line.price_per_unit },
        }, error: null });
      });
      renderQuoteBuilder(quote.id);
      const price = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(price).toBeEnabled());
      fireEvent.change(price, { target: { value: '11' } });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $11.00 (was $10.00)' }));
      fireEvent.click(screen.getByRole('button', { name: /^Save (draft|changes)$/ }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      // The save succeeded, so the quote is clean again and Save waits for the next change.
      await waitFor(() => expect(screen.getByRole('button', { name: /^Save (draft|changes)$/ })).toHaveAttribute('title', 'No changes to save'));

      // Clearing the manual price returns the line to what the database now holds (11), not 10.
      fireEvent.click(screen.getByRole('button', { name: 'Reset the manual price' }));
      expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toHaveValue(11);
    });

    it('names a line by the row id its save returned, not only the id it loaded with', async () => {
      const { quote, sentVersion } = configureLockedQuote();
      // The sent version names the row the next save returns (item-2), as for a line added and
      // saved since the page loaded: its local item never carries that id.
      sentVersion.snapshot_data.sections[0].items[0].quote_item_id = 'item-2';
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string; price_per_unit: number }> }> })
          .p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-2' },
          item_prices: { [line.client_key]: line.price_per_unit },
        }, error: null });
      });
      renderQuoteBuilder(quote.id);
      expect(await screen.findByText('New since version 1')).toBeInTheDocument();
      const units = await screen.findByRole('spinbutton', { name: 'Quantity' });
      await waitFor(() => expect(units).toBeEnabled());
      fireEvent.change(units, { target: { value: '3' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save (draft|changes)$/ }));

      await waitFor(() => expect(screen.queryByText('New since version 1')).not.toBeInTheDocument());
      expect(screen.queryByText(/Prices or lines changed after version 1 was sent/)).not.toBeInTheDocument();
    });

    it('asks for a reload when the database stored a different price than the screen shows', async () => {
      const { quote } = configureLockedQuote();
      // The catalog moved to 13.00 after the page loaded at 12.00: save_quote prices today's line at 13.
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string }> }> }).p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: 13 },
        }, error: null });
      });
      renderQuoteBuilder(quote.id);
      fireEvent.click(await screen.findByRole('button', { name: 'Use today $12.00' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' }));
      fireEvent.click(screen.getByRole('button', { name: /^Save (draft|changes)$/ }));

      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('Reload the quote to see the saved prices')));
      expect(await screen.findByRole('button', { name: 'Reload Quote' })).toBeInTheDocument();
    });

    it('opens a new quote whose create stored a different price, instead of a reload that cannot recover it', async () => {
      // On /quotes/new the reload dialog cannot load the quote (the route names none) and the next
      // save would send no quote id, creating a second quote. The create opens the saved quote.
      const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true,
          default_commission_split: { splits: [{ recipient: 'Rep', percentage: 100 }] } }]
          : table === 'products' ? [product]
            : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name === 'generate_quote_number') return Promise.resolve({ data: 'Q-2026-0042', error: null });
        if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string }> }> }).p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: 'quote-new', row_version: 1,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: 13 },
        }, error: null });
      });
      renderQuoteBuilder();
      const customerBox = await screen.findByRole('combobox', { name: 'Customer' });
      fireEvent.change(customerBox, { target: { value: 'Farm' } });
      fireEvent.click(await screen.findByRole('option', { name: /Farm/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
      fireEvent.click(await screen.findByRole('button', { name: /Select product/ }));
      const picker = await screen.findByRole('dialog');
      fireEvent.click(await within(picker).findByRole('button', { name: /T1 price/ }));
      fireEvent.change(await screen.findByRole('spinbutton', { name: 'Quantity' }), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/quotes/quote-new', { replace: true }));
      expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('Check the saved prices before sending it'));
      expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument();
    });

    it('does not mark the quote presented when its save stored a different price than the preview showed', async () => {
      const { quote } = configureLockedQuote();
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: { version_number: 2, row_version: 9 }, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string }> }> }).p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: 13 },
        }, error: null });
      });
      vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:quote'), revokeObjectURL: vi.fn() });
      renderQuoteBuilder(quote.id);
      fireEvent.click(await screen.findByRole('button', { name: 'Use today $12.00' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Mark as presented' }));

      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('Reload the quote to see the saved prices')));
      expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything());
      expect(mockRpc).not.toHaveBeenCalledWith('create_quote_version', expect.anything());
    });

    // Quotes UI redesign, Feedback fixes: same apply, then a toast built from the page's rounded totals.
    it('Use today\'s prices shows the result toast', async () => {
      const { quote } = configureLockedQuote();
      renderQuoteBuilder(quote.id);
      const price = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(price).toBeEnabled());
      expect(price).toHaveValue(10);
      mockToast.mockClear();
      fireEvent.click(screen.getByRole('button', { name: "Use today's prices" }));

      expect(price).toHaveValue(12);
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith(
        'success',
        "1 line now uses today's Tier 1 prices. Total went from $20.00 to $24.00. Save draft to keep it.",
      );
    });

    it('Use today\'s prices with nothing to change says so', async () => {
      const { quote } = configureLockedQuote(1, 10);
      renderQuoteBuilder(quote.id);
      const price = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(price).toBeEnabled());
      mockToast.mockClear();
      fireEvent.click(screen.getByRole('button', { name: "Use today's prices" }));

      expect(price).toHaveValue(10);
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith('info', "Prices already match today's Tier 1 prices. Nothing changed.");
    });

    it('rewinds to the version last sent in one confirmed step', async () => {
      const { quote, sentVersion } = configureLockedQuote();
      // A line the customer was not sent still needs a re-send (a changed price no longer does).
      sentVersion.snapshot_data.sections[0].items[0].quote_item_id = 'item-2';
      renderQuoteBuilder(quote.id);
      fireEvent.click(await screen.findByRole('button', { name: 'Rewind to version 1' }));
      const dialog = await screen.findByRole('alertdialog', { name: 'Rewind to version 1?' });
      expect(within(dialog).getByText(/every section's Timing and Confidence are cleared/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Rewind to version 1' }));

      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(
        'restore_quote_version',
        expect.objectContaining({ p_quote_id: quote.id, p_version_id: 'version-1' }),
      ));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Restored from version 1'));
    });
  });

  // KI-105 (Mason, 2026-11-05): anyone may quote at a tier other than the customer's assigned one, but
  // only on purpose: Save needs "Use Tier N" or the "Quote at Tier M anyway" tick. Screen only.
  describe('tier check (KI-105)', () => {
    function renderDraftAtTier(quoteTier: number) {
      const fixture = makeQuoteFixture('draft', 7);
      const quote = { ...fixture.quote, tier: quoteTier };
      const product = { ...fixture.product, tier2_price: 9 };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [{ ...fixture.item, product, price_per_unit: quoteTier === 2 ? 9 : 10 }]
              : table === 'products' ? [product]
                : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8 }, error: null }
        : { data: null, error: null }));
      renderQuoteBuilder(quote.id);
    }
    const save = () => fireEvent.click(screen.getByRole('button', { name: /^Save (draft|changes)$/ }));
    const saveCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'save_quote');

    it('refuses Save at another tier until "Quote at Tier 2 anyway" is ticked', async () => {
      renderDraftAtTier(2);
      expect(await screen.findByText('This customer is assigned Tier 1; this quote uses Tier 2.')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toBeEnabled());
      await makeAnEdit();
      save();
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('This customer is assigned Tier 1.')));
      expect(saveCalls()).toHaveLength(0);

      fireEvent.click(screen.getByRole('checkbox', { name: 'Keep Tier 2' }));
      save();
      await waitFor(() => expect(saveCalls()).toHaveLength(1));
      expect(saveCalls()[0][1]).toMatchObject({ p_quote_payload: expect.objectContaining({ tier: 2 }) });
    });

    it('"Use Tier 1" switches the quote and its prices back, and Save needs nothing more', async () => {
      renderDraftAtTier(2);
      const price = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(price).toBeEnabled());
      expect(price).toHaveValue(9);
      fireEvent.click(await screen.findByRole('button', { name: 'Switch to Tier 1' }));
      expect(price).toHaveValue(10);
      expect(screen.queryByText(/this quote uses Tier/)).not.toBeInTheDocument();
      save();
      await waitFor(() => expect(saveCalls()).toHaveLength(1));
      expect(saveCalls()[0][1]).toMatchObject({ p_quote_payload: expect.objectContaining({ tier: 1 }) });
    });

    it('checks the tier the customer has now, not the one loaded with the quote (Sol)', async () => {
      renderDraftAtTier(1);
      await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toBeEnabled());
      await makeAnEdit();
      expect(screen.queryByText(/this quote uses Tier/)).not.toBeInTheDocument();
      mockReadAssignedTier.mockResolvedValueOnce(2);
      save();
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('This customer is assigned Tier 2.')));
      expect(saveCalls()).toHaveLength(0);
      expect(await screen.findByText('This customer is assigned Tier 2; this quote uses Tier 1.')).toBeInTheDocument();
    });

    it('a tick for the old assigned tier does not carry over when the assigned tier changes', async () => {
      renderDraftAtTier(2);
      await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toBeEnabled());
      await makeAnEdit();
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep Tier 2' }));
      mockReadAssignedTier.mockResolvedValueOnce(3);
      save();
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('This customer is assigned Tier 3.')));
      expect(saveCalls()).toHaveLength(0);
      expect(screen.getByRole('checkbox', { name: 'Keep Tier 2' })).not.toBeChecked();
    });

    it('abandons a save whose tier changed while the assigned tier was being read (Luna, #1605)', async () => {
      renderDraftAtTier(1);
      await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toBeEnabled());
      await makeAnEdit();
      let answer: (tier: number) => void = () => {};
      mockReadAssignedTier.mockImplementationOnce(() => new Promise<number>((resolve) => { answer = resolve; }));
      save();
      await waitFor(() => expect(mockReadAssignedTier).toHaveBeenCalled());
      fireEvent.change(screen.getByDisplayValue('Tier 1'), { target: { value: '2' } });
      answer(1);
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'The price tier or customer changed while saving. Save again.'));
      expect(saveCalls()).toHaveLength(0);
    });

    it('a tick does not survive leaving the quote and coming back (Luna, #1605)', async () => {
      const fixture = makeQuoteFixture('draft', 7);
      const quoteA = { ...fixture.quote, tier: 2 };
      const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header' };
      const reads = [quoteA, quoteA, quoteB, quoteB, quoteA]; // each load reads the quote twice
      let quoteReads = 0;
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? reads[Math.min(quoteReads++, reads.length - 1)]
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [{ ...fixture.item, price_per_unit: 9 }]
              : table === 'products' ? [{ ...fixture.product, tier2_price: 9 }]
                : [],
        error: null,
      }));
      render(
        <MemoryRouter initialEntries={[`/quotes/${quoteA.id}/edit`]}>
          <Link to={`/quotes/${quoteB.id}/edit`}>To B</Link>
          <Link to={`/quotes/${quoteA.id}/edit`}>To A</Link>
          <Routes><Route path="/quotes/:id/edit" element={<QuoteBuilder />} /></Routes>
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Keep Tier 2' }));
      expect(screen.getByRole('checkbox', { name: 'Keep Tier 2' })).toBeChecked();
      fireEvent.click(screen.getByRole('link', { name: 'To B' }));
      await screen.findByDisplayValue('Quote B header');
      fireEvent.click(screen.getByRole('link', { name: 'To A' }));
      await waitFor(() => expect(screen.queryByDisplayValue('Quote B header')).not.toBeInTheDocument());
      expect(await screen.findByRole('checkbox', { name: 'Keep Tier 2' })).not.toBeChecked();
    });

    it('refuses Save when the assigned tier cannot be read', async () => {
      renderDraftAtTier(1);
      await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toBeEnabled());
      await makeAnEdit();
      mockReadAssignedTier.mockRejectedValueOnce(new Error('network'));
      save();
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', "The customer's price tier could not be checked. Try again in a moment."));
      expect(saveCalls()).toHaveLength(0);
    });
  });

  // Item 10b (Mason 2026-10-27): a booked price on a sent booking changes straight away, with no
  // re-send. A higher price needs the rep's "grower agreed" tick; a lower one does not
  // (20261029120000 records each change).
  describe('changing a booked price on a sent booking', () => {
    async function openRevisedAndSetPrice(price: string) {
      const fixture = makeQuoteFixture('sent', 7);
      const quote = { ...fixture.quote, status: 'revised', created_at: new Date().toISOString() };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [fixture.product]
                  : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8, item_ids: {} }, error: null }
        : { data: null, error: null }));
      renderQuoteBuilder(quote.id);
      const priceInput = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(priceInput).toBeEnabled());
      fireEvent.change(priceInput, { target: { value: price } });
      fireEvent.blur(priceInput);
    }
    const savedLine = () => {
      const call = mockRpc.mock.calls.find(([name]) => name === 'save_quote');
      return (call?.[1] as { p_sections: Array<{ items: Array<Record<string, unknown>> }> }).p_sections[0].items[0];
    };

    it('a higher price needs the "grower agreed" tick before it saves', async () => {
      await openRevisedAndSetPrice('12');
      const tick = await screen.findByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' });
      fireEvent.click(screen.getByText('Save changes'));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Grower agreed')));
      expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote')).toHaveLength(0);

      fireEvent.click(tick);
      fireEvent.click(screen.getByText('Save changes'));
      await waitFor(() => expect(savedLine()).toMatchObject({ price_override: 12, grower_confirmed: true }));
    });

    it('a lower price saves with no tick', async () => {
      await openRevisedAndSetPrice('9');
      expect(screen.queryByRole('checkbox', { name: /Grower agreed/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Save changes'));
      await waitFor(() => expect(savedLine()).toMatchObject({ price_override: 9 }));
      expect(savedLine()).not.toHaveProperty('grower_confirmed');
    });
  });

  it('saves an edited revised quote as revised, then converts it with the new token', async () => {
    const fixture = makeQuoteFixture('sent', 7);
    const quote = { ...fixture.quote, status: 'revised', created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [fixture.product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: 8, item_ids: { } }, error: null }
      : name === 'convert_quote_to_order'
        ? { data: { status: 'converted', order_id: 'order-3', order_number: 'O-3', warnings: [] }, error: null }
        : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const units = await screen.findByRole('spinbutton', { name: 'Quantity' });
    await waitFor(() => expect(units).toBeEnabled());
    fireEvent.change(units, { target: { value: '3' } });
    const opener = screen.getByRole('button', { name: 'Create order' });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-3'));
    const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
    expect(saves).toHaveLength(1);
    expect((saves[0][1] as { p_quote_payload: { status: string } }).p_quote_payload.status).toBe('revised');
    expect(mockRpc).toHaveBeenCalledWith(
      'convert_quote_to_order',
      expect.objectContaining({ p_quote_id: quote.id, p_expected_row_version: 8 }),
    );
  });

  it('resumes an accepted quote through convert without saving it', async () => {
    const fixture = makeQuoteFixture('accepted', 7);
    const quote = { ...fixture.quote, created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [fixture.product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'convert_quote_to_order'
      ? { data: { status: 'already_converted', order_id: 'order-4', warnings: [] }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create order' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-4'));
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('already converted'));
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(mockTrackBusinessEvent).not.toHaveBeenCalled();
    expect(mockSendOrderConfirmedEmail).not.toHaveBeenCalled();
  });

  it('Book as Order marks the draft sent, then converts it without an accepted save', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 3 ? quote : { ...quote, status: 'sent', row_version: 9 })
        : table === 'quote_sections' ? [section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8, item_ids: {} }, error: null }
        : name === 'create_quote_version'
          ? { data: { version_number: 1, status: 'created', row_version: 9 }, error: null }
          : name === 'convert_quote_to_order'
            ? { data: { status: 'converted', order_id: 'order-5', order_number: 'O-5', warnings: [] }, error: null }
            : { data: null, error: null },
    ));

    renderQuoteBuilder(quote.id);
    await waitFor(() => {
      if (!screen.queryByRole('menu')) fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const bookAsOrderOpener = screen.getByRole('menuitem', { name: 'Book as order' });
      expect(bookAsOrderOpener).not.toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(bookAsOrderOpener);
      expect(screen.getByRole('alertdialog', { name: 'Book as order?' })).toBeInTheDocument();
    });
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Book as order?' })).getByRole('button', { name: 'Book as order' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-5'));
    const saveStatuses = mockRpc.mock.calls
      .filter(([name]) => name === 'save_quote')
      .map(([, args]) => (args as { p_quote_payload: { status: string } }).p_quote_payload.status);
    expect(saveStatuses).toEqual(['draft']);
    expect(mockRpc).toHaveBeenCalledWith(
      'convert_quote_to_order',
      expect.objectContaining({ p_quote_id: quote.id, p_expected_row_version: 9 }),
    );
  });

  it('keeps a saved line at its quoted cost through an edit, and shows today\'s cost beside it', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    // The product costs 8.00 today; the line was quoted at 6.00.
    const product = { ...fixture.product, current_cost: 8 };
    const item = { ...fixture.item, product };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? fixture.quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: fixture.quote.id, row_version: 8, item_ids: {} }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(fixture.quote.id);
    expect(await screen.findByText('today $8.00 · up')).toBeInTheDocument();
    const units = await screen.findByRole('spinbutton', { name: 'Quantity' });
    await waitFor(() => expect(units).toBeEnabled());
    fireEvent.change(units, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    const saveArgs = mockRpc.mock.calls.find(([name]) => name === 'save_quote')?.[1] as {
      p_sections: Array<{ items: Array<{ id: string | null; current_cost: number; profit: number; total_units_needed: number }> }>;
    };
    const savedLine = saveArgs.p_sections[0].items[0];
    expect(savedLine.id).toBe('item-1');
    expect(savedLine.total_units_needed).toBe(3);
    expect(savedLine.current_cost).toBe(6);
    expect(savedLine.profit).toBe(12);
  });

  it('prices a replacement row at today\'s cost, not the cost recorded for the row it replaced', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    // The product costs 8.00 today; row item-1 was quoted at 6.00.
    const product = { ...fixture.product, current_cost: 8 };
    const item = { ...fixture.item, product };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? fixture.quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [product]
                : [],
      error: null,
    }));
    // The save stores this line as a new row (as after switching its product away and back),
    // which the server stamps at today's cost.
    let saves = 0;
    mockRpc.mockImplementation((name: string, args?: unknown) => {
      if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
      const line = (args as { p_sections: Array<{ items: Array<{ client_key: string }> }> }).p_sections[0].items[0];
      saves += 1;
      return Promise.resolve({ data: { quote_id: fixture.quote.id, row_version: 7 + saves, item_ids: { [line.client_key]: 'item-9' } }, error: null });
    });
    type SaveArgs = { p_sections: Array<{ items: Array<{ id: string | null; current_cost: number }> }> };
    const saveCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'save_quote').map(([, a]) => (a as SaveArgs).p_sections[0].items[0]);

    renderQuoteBuilder(fixture.quote.id);
    const units = await screen.findByRole('spinbutton', { name: 'Quantity' });
    await waitFor(() => expect(units).toBeEnabled());
    fireEvent.change(units, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    // The save succeeded, so the quote is clean again until the next change below.
    await waitFor(() => expect(screen.getByRole('button', { name: /Save draft/ })).toHaveAttribute('title', 'No changes to save'));

    fireEvent.change(units, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    expect(saveCalls()[1]).toMatchObject({ id: 'item-9', current_cost: 8 });
  });

  it('locks the quote and the Cancel button while Convert checks for a recent order', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, status: 'sent', created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => (table === 'orders'
      // The recent-order lookup never answers, so the test sees the page mid-lookup.
      ? buildPendingChain()
      : buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [fixture.product]
                  : [],
        error: null,
      })));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: 8, item_ids: {} }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create order' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    // Convert works from the quote as it was clicked, so it cannot be edited or cancelled now.
    await waitFor(() => expect(screen.getByDisplayValue(quote.header_notes)).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(mockRpc).not.toHaveBeenCalledWith('convert_quote_to_order', expect.anything());
  });

  it('locks the quote while it converts to an order, then opens the order', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, status: 'sent', created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [fixture.product]
                : [],
      error: null,
    }));
    let releaseConvert!: () => void;
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_quote') {
        return Promise.resolve({ data: { quote_id: quote.id, row_version: 8, item_ids: {} }, error: null });
      }
      if (name === 'convert_quote_to_order') {
        return new Promise((resolve) => {
          releaseConvert = () => resolve({ data: { status: 'converted', order_id: 'order-2', order_number: 'O-2', warnings: [] }, error: null });
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create order' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('convert_quote_to_order', expect.anything()));

    // An edit made now would not be in the order, and the page leaves for it afterwards.
    expect(screen.getByDisplayValue(quote.header_notes)).toBeDisabled();
    expect(screen.getByRole('switch', { name: /^Planned program/ })).toBeDisabled();
    releaseConvert();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-2'));
  });

  it('stops Book as Order when mark-presented cannot confirm the frozen quote token', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 3 ? quote : { row_version: 10 })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8 }, error: null }
        : name === 'create_quote_version'
          ? { data: { version_number: 1, status: 'created', row_version: 9 }, error: null }
          : { data: null, error: null },
    ));

    renderQuoteBuilder(quote.id);
    await waitFor(() => {
      if (!screen.queryByRole('menu')) fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const bookAsOrderOpener = screen.getByRole('menuitem', { name: 'Book as order' });
      expect(bookAsOrderOpener).not.toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(bookAsOrderOpener);
      expect(screen.getByRole('alertdialog', { name: 'Book as order?' })).toBeInTheDocument();
    });
    const initialBookDialog = screen.getByRole('alertdialog', { name: 'Book as order?' });
    fireEvent.click(within(initialBookDialog).getByRole('button', { name: 'Book as order' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('save-protection version could not be confirmed'),
    ));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('quote was frozen'));
    fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
    const retryBookDialog = await screen.findByRole('alertdialog', { name: 'Book as order?' });
    expect(within(retryBookDialog).getByText('Mark this quote as sent and convert it to an order now?')).toBeInTheDocument();
    fireEvent.click(within(retryBookDialog).getByRole('button', { name: 'Book as order' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Reload the quote, then try Book as Order again'),
    ));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('quote was frozen'));
    expect(mockRpc).not.toHaveBeenCalledWith('convert_quote_to_order', expect.anything());
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.stringContaining('marked as presented'));
  });

  // ── Route changes must never save the quote the operator left ─────────────
  //
  // App.tsx routes both `quotes/new` and `quotes/:id` to one <QuoteBuilder />
  // with no `key`, so moving between two saved quotes re-runs the id effect on
  // the SAME mounted component: quoteId, the form contents and the save target
  // all survive the navigation. These tests drive a real data router the same
  // way, with deliberately delayed loads, and mount the real page.

  /**
   * Suspends forever when the route names `on`. Rendered AFTER <QuoteBuilder/>
   * inside a Suspense boundary, so QuoteBuilder's render for the new id has
   * already run by the time this unwinds and React throws the attempt away.
   */
  const foreverPending = new Promise(() => {});
  function SuspendForever({ on }: { on: string }) {
    const { id } = useParams();
    if (id === on) throw foreverPending;
    return null;
  }

  function openableGate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open };
  }

  /**
   * A Supabase-like chain that decides its result LAZILY, when the query is
   * finally awaited. Every `.eq()` has landed by then, so the resolver can see
   * which quote is being requested and hold that quote's load open.
   */
  function buildLazyChain(
    resolveResult: (filters: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  ): Record<string, unknown> {
    const filters: Record<string, unknown> = {};
    const self: Record<string, unknown> = {};
    const passthrough = (..._args: unknown[]) => self;
    const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'neq',
      'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
      'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
      'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
      'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
    for (const m of methods) self[m] = passthrough;
    self.eq = (column: unknown, value: unknown) => {
      filters[String(column)] = value;
      return self;
    };
    // Recorded so the resolver can tell a load's OPENING header read (the only
    // one that joins the customer) from the confirm-version read that follows
    // it. That is what lets one quote be loaded twice with different content.
    self.select = (columns: unknown) => {
      filters.__select = columns;
      return self;
    };
    let started: Promise<{ data: unknown; error: unknown }> | null = null;
    const run = () => {
      if (!started) started = resolveResult(filters);
      return started;
    };
    self.then = (...args: Parameters<Promise<unknown>['then']>) => run().then(...args);
    self.catch = (...args: Parameters<Promise<unknown>['catch']>) => run().catch(...args);
    self.finally = (...args: Parameters<Promise<unknown>['finally']>) => run().finally(...args);
    return self;
  }

  function makeSwitchFixture(id: string, quoteNumber: string) {
    const base = makeQuoteFixture('draft');
    const quote = { ...base.quote, id, quote_number: quoteNumber };
    const section = { ...base.section, id: `section-${id}`, quote_id: id };
    const item = { ...base.item, id: `item-${id}`, quote_id: id, section_id: section.id };
    return { quote, section, item, product: base.product };
  }

  /**
   * Per-load control for ONE quote id: entry `n` applies to the n-th load of
   * that quote. `wait` holds that load open; `quoteNumber` gives it distinct
   * content so the test can tell which of two loads of the SAME quote installed.
   */
  type QuoteLoadPlan = Record<string, { wait?: Promise<void>; quoteNumber?: string }[]>;

  function renderQuoteSwitch(
    fixtures: ReturnType<typeof makeSwitchFixture>[],
    gates: Record<string, Promise<void>>,
    options: {
      failSectionsFor?: string;
      loadPlan?: QuoteLoadPlan;
      belowCostApproval?: boolean;
      suspendOn?: string;
      startOnNewQuote?: boolean;
    } = {},
  ) {
    const byId = new Map(fixtures.map((f) => [f.quote.id, f]));
    const loadCounts = new Map<string, number>();
    mockFrom.mockImplementation((table: string) => buildLazyChain(async (filters) => {
      const requestedId = String(filters.quote_id ?? filters.id ?? '');
      const fixture = byId.get(requestedId);
      // A load opens with the header read that joins the customer; the later
      // read of the same table is the confirm-version read within that load.
      const opensALoad = table === 'quotes'
        && String(filters.__select ?? '').includes('customer:customers');
      let step: { wait?: Promise<void>; quoteNumber?: string } | undefined;
      if (opensALoad) {
        const nth = loadCounts.get(requestedId) ?? 0;
        loadCounts.set(requestedId, nth + 1);
        step = options.loadPlan?.[requestedId]?.[nth];
      }
      if (step?.wait) await step.wait;
      const gate = gates[requestedId];
      if (fixture && gate) await gate;
      switch (table) {
        case 'quotes':
          if (!fixture) return { data: null, error: null };
          return {
            data: step?.quoteNumber
              ? { ...fixture.quote, quote_number: step.quoteNumber }
              : fixture.quote,
            error: null,
          };
        case 'quote_sections':
          return options.failSectionsFor === requestedId
            ? { data: null, error: { message: 'sections unavailable' } }
            : { data: fixture ? [fixture.section] : [], error: null };
        case 'quote_items':
          return { data: fixture ? [fixture.item] : [], error: null };
        case 'customers':
          return {
            data: [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }],
            error: null,
          };
        case 'products':
          return { data: [fixtures[0].product], error: null };
        default:
          return { data: [], error: null };
      }
    }));
    // A render React BEGINS and then throws away. `suspendOn` names the quote id
    // whose render suspends and never resolves: QuoteBuilder is rendered first
    // with the new id, then the sibling below suspends, so React discards the
    // whole attempt and the PREVIOUS quote stays committed on screen. Production
    // discards renders for its own reasons — an interrupted transition, an error
    // retry — and this is the deterministic way to reproduce one. The scaffold
    // creates the interruption; it never touches the ref under test.
    const routeElement = options.suspendOn
      ? (
        <Suspense fallback={<div>route suspended</div>}>
          <QuoteBuilder />
          <SuspendForever on={options.suspendOn} />
        </Suspense>
      )
      : <QuoteBuilder />;
    const router = createMemoryRouter(
      // `quotes/:id` is App.tsx's real pattern for a saved quote. Using it here
      // means both ids resolve to the SAME route, so React Router reuses the
      // element instead of remounting it — which is precisely the condition
      // these tests exist to cover.
      [
        ...(options.startOnNewQuote ? [{ path: '/quotes/new', element: routeElement }] : []),
        { path: '/quotes/:id', element: routeElement },
      ],
      { initialEntries: [options.startOnNewQuote ? '/quotes/new' : `/quotes/${fixtures[0].quote.id}`] },
    );
    // Mounted OUTSIDE the router, mirroring App.tsx's RootLayout: the provider
    // sits above the route, so navigating between quotes neither unmounts the
    // approval dialog nor abandons the retry waiting on it.
    render(options.belowCostApproval
      ? <BelowCostApprovalProvider><RouterProvider router={router} /></BelowCostApprovalProvider>
      : <RouterProvider router={router} />);
    return router;
  }

  async function goToQuote(router: ReturnType<typeof createMemoryRouter>, id: string) {
    await act(async () => { await router.navigate(`/quotes/${id}`); });
  }

  async function flushPendingWork() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it('ignores a late new-quote number after a saved quote opens', async () => {
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    let resolveNumber!: (result: { data: string; error: null }) => void;
    const number = new Promise<{ data: string; error: null }>((resolve) => { resolveNumber = resolve; });
    mockRpc.mockImplementation((name: string) => name === 'generate_quote_number'
      ? number : Promise.resolve({ data: null, error: null }));
    const router = renderQuoteSwitch([quoteB], {}, { startOnNewQuote: true });
    await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'generate_quote_number')).toBe(true));

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    await act(async () => resolveNumber({ data: 'Q-2026-9999', error: null }));
    await flushPendingWork();
    expect(screen.queryByText('Q-2026-9999')).not.toBeInTheDocument();
    expect(screen.getAllByText('Q-BBB-2')).not.toHaveLength(0);
  });

  it('stops presenting quote A once the route points at a quote B that has not loaded', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const gateB = openableGate();
    const router = renderQuoteSwitch([quoteA, quoteB], { 'quote-b': gateB.opened });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await screen.findByRole('button', { name: /Save draft/ });

    await goToQuote(router, 'quote-b');

    // The URL says quote B. Quote A's form must not still be sitting there
    // looking current, and its Save button must not still be live: the save
    // target is quoteId, which is still A until B installs.
    await waitFor(() => expect(screen.queryAllByText('Q-AAA-1')).toHaveLength(0));
    expect(screen.queryAllByText('Q-BBB-2')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Save draft/ })).not.toBeInTheDocument();
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());

    gateB.open();
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);
  });

  it('drops quote B late response after the operator has already moved on to quote C', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const quoteC = makeSwitchFixture('quote-c', 'Q-CCC-3');
    const gateB = openableGate();
    const router = renderQuoteSwitch([quoteA, quoteB, quoteC], { 'quote-b': gateB.opened });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);

    // A -> B (slow) -> C (fast). C wins the race and installs first.
    await goToQuote(router, 'quote-b');
    await goToQuote(router, 'quote-c');
    expect(await screen.findAllByText('Q-CCC-3')).not.toHaveLength(0);

    // B's reply finally arrives. It describes a quote the page left two
    // navigations ago, so it must install nothing.
    gateB.open();
    await flushPendingWork();

    expect(screen.getAllByText('Q-CCC-3')).not.toHaveLength(0);
    expect(screen.queryAllByText('Q-BBB-2')).toHaveLength(0);
  });

  // The next two tests exist to keep each HALF of the load guard load-bearing.
  // Every test above navigates between DIFFERENT quotes, where the route binding
  // alone is enough — so on those alone the call-order half could be deleted
  // with the suite still green, and vice versa. These two separate the halves.

  it('keeps the newer load of the SAME quote when the older one lands last', async () => {
    // A -> B -> A on ONE quote. Both loads are for quote A and the route ends on
    // quote A, so the route binding cannot tell them apart: only CALL ORDER can.
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-STALE');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const firstOpenOfA = openableGate();
    const router = renderQuoteSwitch([quoteA, quoteB], {}, {
      loadPlan: {
        'quote-a': [
          { wait: firstOpenOfA.opened, quoteNumber: 'Q-AAA-STALE' },
          { quoteNumber: 'Q-AAA-FRESH' },
        ],
      },
    });

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    await goToQuote(router, 'quote-a');
    expect(await screen.findAllByText('Q-AAA-FRESH')).not.toHaveLength(0);

    // The very first open of quote A now replies, last. It is the same record
    // the URL names, but it is an OLDER read of it, so it must install nothing.
    firstOpenOfA.open();
    await flushPendingWork();

    expect(screen.getAllByText('Q-AAA-FRESH')).not.toHaveLength(0);
    expect(screen.queryAllByText('Q-AAA-STALE')).toHaveLength(0);
  });

  it('refuses a reload started from a stale closure even though it holds the newest load serial', async () => {
    // reloadAfterStaleSave calls fetchQuote with the quoteId captured in its
    // closure. Fired after the operator has moved on, that call MINTS THE
    // NEWEST serial for the quote they left - so call order cannot catch it and
    // would actively certify the stale snapshot. Only the route binding can.
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: null, error: { message: 'QUOTE_STALE_WRITE' } }
        : { data: null, error: null },
    ));
    const router = renderQuoteSwitch([quoteA, quoteB], {}, {
      failSectionsFor: 'quote-b',
      loadPlan: { 'quote-a': [{}, { quoteNumber: 'Q-AAA-RELOADED' }] },
    });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);

    // Save quote A and lose the version race, which opens the reload dialog.
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await screen.findByRole('button', { name: /Reload Quote/i });

    // Move to quote B; its load fails. Quote A's form - and this still-open dialog -
    // no longer come back under quote B's address: the page says quote B could not be
    // loaded (To-Do 10.5), so the stale reload cannot even be fired.
    await goToQuote(router, 'quote-b');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Could not load the complete quote'),
    ));
    expect(await screen.findByText('This quote could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reload Quote/i })).not.toBeInTheDocument();
    await flushPendingWork();
    expect(screen.queryAllByText('Q-AAA-RELOADED')).toHaveLength(0);
    // The reload never completed, so the key that may represent a committed
    // save must NOT have been rotated.
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();
  });

  // Raised by the exact-SHA gpt-5.6-sol review of `a9793c311`, as a P2. The save
  // guard reads the load serial, and the serial is a SHARED resource: a doomed load
  // that takes a number on its way to rejecting itself supersedes whatever is
  // legitimately in flight for the quote on screen. Refusing at the door is the
  // only place that cannot burn one.
  it('refuses a doomed reload at the door, without reading the database or taking a load serial', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: null, error: { message: 'QUOTE_STALE_WRITE' } }
        : { data: null, error: null },
    ));
    const router = renderQuoteSwitch([quoteA, quoteB], {}, {
      failSectionsFor: 'quote-b',
      loadPlan: { 'quote-a': [{}, { quoteNumber: 'Q-AAA-RELOADED' }] },
    });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await screen.findByRole('button', { name: /Reload Quote/i });

    // Move to quote B. The reload dialog's closure still names quote A, so firing
    // it now is a load for a quote the operator has left.
    await goToQuote(router, 'quote-b');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Could not load the complete quote'),
    ));

    // The failed switch shows quote B's failed state, so the reload dialog that
    // names quote A is gone: the doomed reload has no button to start it.
    expect(await screen.findByText('This quote could not be loaded')).toBeInTheDocument();
    const readsAfterFailedSwitch = mockFrom.mock.calls.filter((c) => c[0] === 'quotes').length;
    expect(screen.queryByRole('button', { name: /Reload Quote/i })).not.toBeInTheDocument();
    await flushPendingWork();

    // No read of quote A is issued afterwards, so no serial is consumed.
    expect(mockFrom.mock.calls.filter((c) => c[0] === 'quotes').length)
      .toBe(readsAfterFailedSwitch);
    expect(screen.queryAllByText('Q-AAA-RELOADED')).toHaveLength(0);
  });

  it('a failed switch shows quote B could not be loaded, with no Save, Close or Revert over quote A', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const router = renderQuoteSwitch([quoteA, quoteB], {}, { failSectionsFor: 'quote-b' });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);

    // Quote A's form used to stay under quote B's URL, where Save was refused but
    // Close / Revert (which send the URL's quote B) were still offered from quote A's
    // status. The page now says quote B could not be loaded instead.
    await goToQuote(router, 'quote-b');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Could not load the complete quote'),
    ));

    expect(await screen.findByText('This quote could not be loaded')).toBeInTheDocument();
    expect(screen.queryAllByText('Q-AAA-1')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Save draft/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close|Revert/ })).not.toBeInTheDocument();
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('revert_quote_status', expect.anything());
  });

  // ── ...and neither may a save's REPLY ──────────────────────────────────────
  //
  // The refusal above runs before the request is sent, so it cannot cover state
  // written after the reply lands. `save_quote` installs the authoritative
  // row-version token, the commission baseline and (for a create) `quoteId`, and
  // its callers then clear dirty, toast and navigate. A route change during the
  // round trip puts all of that on the wrong quote.

  function withRowVersion(fixture: ReturnType<typeof makeSwitchFixture>, rowVersion: number) {
    return { ...fixture, quote: { ...fixture.quote, row_version: rowVersion } };
  }

  /**
   * The empty-reply branch sits ABOVE `editingSessionChanged()`, so it needed its own
   * session check — raised as a P2 by the exact-SHA gpt-5.6-sol review of `451727ee9`.
   *
   * An ambiguous `{}` reply for quote A that lands after the operator has moved to
   * quote B must still retain A's key, but it must not SAY anything: an unqualified
   * "the save came back without an ID" toast over quote B reads as a failure of the
   * quote on screen, which is the same route-reply leak the guard below exists to
   * stop. Silence plus retention is the correct pair here.
   */
  it('stays silent about quote A empty reply once the operator has moved to quote B', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    let saveCalls = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveCalls += 1;
      if (saveCalls === 1) {
        await saveReply.opened;
        // The ambiguous reply: no error, and no receipt in it.
        return { data: {}, error: null };
      }
      return { data: { quote_id: 'quote-b', row_version: 12 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {});

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(saveCalls).toBe(1));

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    expect(
      mockToast.mock.calls.map((c) => String(c[1])).join(' | '),
      "quote A's ambiguous reply must not report a failure over quote B",
    ).not.toMatch(/came back without an ID/);

    // Retention is the other half of the pair: A's key must survive, unretired.
    expect(mockResetIdempotencyKey).not.toHaveBeenCalledWith('quote-a');
  });

  it('drops a late save_quote reply for quote A rather than installing its token on quote B', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    let saveCalls = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveCalls += 1;
      if (saveCalls === 1) {
        await saveReply.opened;
        // Quote A's own authoritative token, one past the 3 it loaded with.
        return { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
      }
      return { data: { quote_id: 'quote-b', row_version: 12 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {});

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(saveCalls).toBe(1));

    // Leave for quote B while quote A's save is still in flight.
    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    // Quote A's success is not quote B's.
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote saved as draft');

    // The decisive check. Quote B's own token must still be the one it saves
    // against — proving quote A's reply neither replaced it nor cleared it.
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: 'quote-b',
      p_quote_payload: expect.objectContaining({ row_version_expected: 11 }),
      // Generation 0 for quote B's OWN scope, not 1 for a shared one. #618 wrote
      // this as `test-idem-key-1` because a page-wide key had to ROTATE off quote
      // A's committed save before B could safely use it. #603 scopes the key per
      // quote, so B never held A's key to begin with and there is nothing for A's
      // save to rotate away from B. The hazard #618 was guarding against is gone
      // rather than merely re-checked — but the assertion still binds it, because
      // a regression to a page-wide key would hand B `test-idem-key--1` here.
      p_idempotency_key: 'test-idem-key-quote-b-0',
    })));
  });

  it('keeps quote A failed save off quote B, and says which quote failed', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      await saveReply.opened;
      return { data: null, error: { message: 'QUOTE_STALE_WRITE' } };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {});

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    // Quote A's stale-write recovery dialog must not appear over quote B, whose
    // own record is untouched and has nothing to recover.
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
    // But the failure is not swallowed either: the operator left believing quote
    // A saved, and it did not. The toast names it, because the page they are
    // looking at is a different quote.
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Q-AAA-1'));
    // ...and it must not claim a rollback it cannot know about. A reply lost in
    // transit after PostgreSQL committed arrives through this same error branch,
    // which is exactly why the retry key is retained. Raised as a P2 on this branch.
    const [, failureMessage] = mockToast.mock.calls.find(
      (call) => call[0] === 'error' && String(call[1]).includes('Q-AAA-1'),
    )!;
    expect(failureMessage).not.toMatch(/were not stored|was not saved|no changes were/i);
    expect(failureMessage).toMatch(/could not be confirmed/i);
  });

  // Raised by the exact-SHA gpt-5.6-sol review of this branch, as CRX-1/High.
  // A route-only binding is not enough, because a route id is not unique over
  // time: leave quote A for B and come back, and the id matches again. The reply
  // would then be accepted into a DIFFERENT editing session of the same quote and
  // report edits saved that were never sent. The load serial separates the two
  // sessions, because returning to quote A re-runs its load.
  it('drops a late save_quote reply for quote A after the operator left and came BACK to quote A', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    let saveCalls = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveCalls += 1;
      if (saveCalls === 1) {
        await saveReply.opened;
        // Quote A's own authoritative token, one past the 3 its FIRST load held.
        return { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
      }
      return { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {}, {
      // The second load of quote A carries distinct content, so the test can tell
      // which of the two editing sessions of the SAME quote is on screen.
      loadPlan: { 'quote-a': [{}, { quoteNumber: 'Q-AAA-REOPENED' }] },
    });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(saveCalls).toBe(1));

    // Leave quote A with its save still in flight, then come straight back to it.
    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);
    await goToQuote(router, 'quote-a');
    expect(await screen.findAllByText('Q-AAA-REOPENED')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    // The reply belongs to the session the operator abandoned, so it may not
    // report success over the freshly loaded one — that dirty-clear would mark
    // edits made after the return as saved when they were never sent.
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote saved as draft');

    // The decisive check. The reopened session loaded at version 3, so version 3
    // is what it must still save against — proving the abandoned save's token
    // was neither installed over it nor cleared.
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: 'quote-a',
      p_quote_payload: expect.objectContaining({ row_version_expected: 3 }),
    })));
  });

  // Raised by the exact-SHA gpt-5.6-sol review of `e403d00a3`, as a P2 — the
  // shadow of this branch's own guard. `routeQuoteIdRef` was written DURING
  // RENDER, so a render React began and then discarded moved it even though the
  // previous quote was still the committed screen. The save guard reads that ref,
  // so it would drop a VALID reply after the database had committed: the save
  // succeeds, the data is right, and only the confirmation is suppressed — the
  // operator saves again and lands in stale-write recovery on a money document.
  it('accepts quote A save reply when a render for quote B was discarded before commit', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      await saveReply.opened;
      return { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {}, { suspendOn: 'quote-b' });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));

    // Begin a navigation to quote B whose render never completes. Quote A is
    // still what the operator is looking at, and its load never got superseded:
    // passive effects do not run for a discarded render, so the load serial has
    // not moved either. Only a render-time route write could have moved.
    await goToQuote(router, 'quote-b');
    expect(screen.getAllByText('Q-AAA-1')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    // The decisive check. This save belongs to the quote still on screen, so its
    // reply must be installed and confirmed, not discarded.
    expect(mockToast).toHaveBeenCalledWith('success', 'Quote saved as draft');
    // ...and the authoritative token it carried must be what the next save uses.
    await makeAnEdit('Second edit');
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: 'quote-a',
      p_quote_payload: expect.objectContaining({ row_version_expected: 4 }),
    })));
  });

  // Raised by the exact-SHA gpt-5.6-sol review of `d6b12058b`, as a P2. A payload
  // conflict is not merely "unconfirmed": the server has bound this key to a
  // DIFFERENT payload and can never accept the current one under it again. The
  // in-route branch recovers through the reload dialog, which rotates the key —
  // but that dialog cannot be shown for a quote the operator has left, so the
  // moved-session return used to strand the key poisoned for the life of the
  // component. The key is scoped by operation and user, not by record, so every
  // later save of ANY quote repeated the same conflict.
  it('retires a payload-conflicted key on the reopen, not on the conflict, and not on another quote', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const quoteC = withRowVersion(makeSwitchFixture('quote-c', 'Q-CCC-3'), 7);
    const saveReply = openableGate();
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      await saveReply.opened;
      return { data: null, error: { message: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } };
    });
    const router = renderQuoteSwitch([quoteA, quoteB, quoteC], {}, {
      loadPlan: { 'quote-a': [{}, { quoteNumber: 'Q-AAA-REOPENED' }] },
    });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));

    // Leave quote A, then let its conflict reply land.
    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);
    saveReply.open();
    await flushPendingWork();

    // Quote A's recovery dialog still may not open over quote B.
    expect(screen.queryByRole('button', { name: /Reload Quote/i })).not.toBeInTheDocument();
    // And the key is a RECEIPT as well as a retry token — it may stand for a save
    // that committed and lost its reply — so the conflict alone must not retire
    // it. #603 shipped that shortcut and reverted it the same day.
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();

    // A complete authoritative load of a DIFFERENT quote must not count either:
    // it resolves nothing about what happened to quote A. This step exists because
    // without it the scoping half of the check is unprovable — the conflict lands
    // after quote B has already finished loading, so quote B alone can never
    // exercise it.
    await goToQuote(router, 'quote-c');
    expect(await screen.findAllByText('Q-CCC-3')).not.toHaveLength(0);
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();

    // Reopening quote A IS the authoritative reload the receipt was waiting for.
    await goToQuote(router, 'quote-a');
    expect(await screen.findAllByText('Q-AAA-REOPENED')).not.toHaveLength(0);
    expect(mockResetIdempotencyKey).toHaveBeenCalled();

    // The decisive check: the next save carries a FRESH key, so it is no longer
    // rejected by a key the server bound to an earlier payload.
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: 'quote-a',
      // Generation 1 within quote A's OWN scope: the reopen retired A's key, and
      // only A's. Scoped by #603, so the spelling carries the quote id.
      p_idempotency_key: 'test-idem-key-quote-a-1',
    })));
  });

  // ── ...and neither may an approval given while looking at another quote ────
  //
  // Raised by the exact-SHA gpt-5.6-sol review of `d6b12058b`, as a High. The
  // below-cost dialog is GLOBAL and mounted above the route, so the send it is
  // holding survives a navigation — and it names the product, never the quote.
  // The operator can therefore be shown "approve this below-cost price" while
  // looking at quote B and, by approving, write quote A.
  const BELOW_COST_ERROR = {
    message: 'BELOW_COST_REASON_REQUIRED: {"operation":"save_quote","product_name":"Roundup PowerMAX"}',
  };

  async function approveBelowCost() {
    const reasonBox = await screen.findByLabelText(/Approval reason/i);
    // The dialog clears its reason in an effect when it opens. Under React 19
    // that effect can still be queued when the box first appears, and a reason
    // typed before it runs is wiped — Approve stays disabled and the click sends
    // nothing (CI, PR #930). The dialog moves focus inside itself only after that
    // effect has run (Modal focuses from a frame its own open effect schedules, and
    // nothing in the dialog uses autoFocus), so type once it has. The enabled check
    // turns any wipe this misses into a plain failure rather than a short count.
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
    fireEvent.change(reasonBox, { target: { value: 'matched a competitor quote' } });
    const approve = screen.getByRole('button', { name: /Approve and Retry/i });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await flushPendingWork();
  }

  // The positive control for the test below. Without it, a broken dialog harness
  // — no retry ever sent — would satisfy the refusal assertions perfectly.
  it('sends the below-cost retry when the operator is still on the quote being approved', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveArgs: unknown[] = [];
    mockRpc.mockImplementation(async (name: string, args: unknown) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveArgs.push(args);
      return saveArgs.length === 1
        ? { data: null, error: BELOW_COST_ERROR }
        : { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
    });
    renderQuoteSwitch([quoteA, quoteB], {}, { belowCostApproval: true });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));

    await approveBelowCost();

    expect(saveArgs).toHaveLength(2);
    expect(saveArgs[1]).toEqual(expect.objectContaining({ p_quote_id: 'quote-a' }));
    expect(mockToast).toHaveBeenCalledWith('success', 'Quote saved as draft');
  });

  it('refuses the below-cost retry for quote A once the operator has moved to quote B', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    let saveCalls = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveCalls += 1;
      return saveCalls === 1
        ? { data: null, error: BELOW_COST_ERROR }
        : { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {}, { belowCostApproval: true });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await makeAnEdit();
    fireEvent.click(await screen.findByRole('button', { name: /Save draft/ }));
    // Quote A's save is now parked on the dialog rather than on the network.
    await screen.findByLabelText(/Approval reason/i);

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);
    // The dialog is still up, over quote B, and nothing on it says quote A —
    // which is exactly why the approval it collects cannot be trusted to mean
    // quote A. It names a product and a shortfall, and no record at all.
    expect(screen.getByRole('button', { name: /Approve and Retry/i })).toBeInTheDocument();
    expect(screen.queryAllByText(/Q-AAA-1/)).toHaveLength(0);

    await approveBelowCost();

    // The decisive check. The retry is never sent, so quote A is not written
    // from consent the operator gave while looking at a different quote.
    expect(saveCalls).toBe(1);
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote saved as draft');
    // Not silent, either: they approved something, so they are told it did not
    // apply and to which quote. Nothing was written on this path — the first
    // attempt was rejected by PostgreSQL — so unlike the lost-reply message this
    // one is entitled to say the quote was not saved.
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Q-AAA-1'));
    const [, refusalMessage] = mockToast.mock.calls.find(
      (call) => call[0] === 'error' && String(call[1]).includes('Q-AAA-1'),
    )!;
    expect(refusalMessage).toMatch(/was not saved/i);
  });
  describe('header and actions (Quotes UI redesign)', () => {
    function renderAtStatus(status: string, isPlanned = true, orders: unknown[] = []) {
      const quote = { id: `quote-${status}`, quote_number: 'Q-HDR-1', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, created_by: 'user-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status, is_planned: isPlanned, commission_split: { splits: [] }, row_version: 1, created_at: RECENT_QUOTE_CREATED_AT };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? quote : table === 'customers' ? [QUOTE_FIXTURE_CUSTOMER] : table === 'orders' ? orders : [],
        error: null,
      }));
      renderQuoteBuilder(quote.id);
    }

    async function loaded() {
      await screen.findByRole('heading', { level: 1, name: 'Q-HDR-1' });
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    }

    const header = () => screen.getByTestId('quote-header');
    const menuItemNames = () => screen.queryAllByRole('menuitem')
      .filter((el) => el.getAttribute('aria-disabled') !== 'true')
      .map((el) => el.querySelector('[slot="label"]')?.textContent ?? el.textContent ?? '');

    function stubPhone() {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 767px)', media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }));
    }

    /**
     * Every action a user can run from the header (and, on a phone, the bottom bar): enabled buttons
     * plus enabled items of both menus. On a phone the preview icon and the green Preview & send are
     * one action, so names are de-duplicated there.
     */
    function availableActions(phone = false): string[] {
      const regions = [header(), screen.queryByTestId('quote-bottom-bar')].filter((el): el is HTMLElement => !!el);
      const names: string[] = [];
      for (const region of regions) {
        for (const button of within(region).getAllByRole('button')) {
          // Skips the menu triggers (their items are read below), help tips and the Quotes breadcrumb.
          const name = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
          if ((button as HTMLButtonElement).disabled || ['More actions', 'Create order', 'More info', 'Quotes'].includes(name)) continue;
          names.push(name === 'Preview and send' ? 'Preview & send' : name);
        }
      }
      fireEvent.click(within(header()).getByRole('button', { name: 'More actions' }));
      names.push(...menuItemNames());
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      const createOrder = regions.map((r) => within(r).queryByRole('button', { name: 'Create order' })).find(Boolean);
      if (createOrder) {
        fireEvent.click(createOrder);
        names.push(...menuItemNames());
        fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      }
      return (phone ? [...new Set(names)] : names).sort();
    }

    /** Today's show and enable conditions (QuoteBuilder before the redesign), one action name each. */
    function todaysActions(status: string, role: string, planned: boolean): string[] {
      const open = status === 'sent' || status === 'revised';
      const names = ['Download PDF', 'Customer view (hide costs)', 'Save as template', 'Roll over to next season'];
      if (status === 'draft') names.push('Save draft');
      if (status === 'revised') names.push('Save changes'); // a revised quote saves as revised
      if (status === 'draft' || open) names.push('Preview & send');
      // Added on purpose (Mason, 2026-11-24): saves, then emails the grower, wherever the quote can be saved.
      if (status === 'draft' || status === 'revised') names.push('Save and email');
      if (status === 'draft') names.push('Book as order');
      if (open || status === 'accepted') names.push('Convert whole booking');
      if (open) names.push('Draw part of booking…', "Close short (grower won't take the rest)", 'Decline quote');
      if (open && planned) names.push('Close as applied (we applied the product)');
      if (status === 'sent') names.push('Revise quote');
      if (status === 'draft' || open) names.push('Cancel quote');
      if (role === 'admin' && ['accepted', 'declined', 'expired', 'cancelled'].includes(status)) {
        names.push(status === 'accepted' ? 'Un-accept' : 'Reopen');
      }
      return names.sort();
    }

    it('draft: Preview & send is the green button', async () => {
      renderAtStatus('draft');
      await loaded();
      const preview = within(header()).getByRole('button', { name: 'Preview & send' });
      expect(preview.className).toContain('bg-crx-green');
      expect(within(header()).getByRole('button', { name: 'Save draft' }).className).not.toContain('bg-crx-green');
      expect(within(header()).queryByRole('button', { name: 'Create order' })).not.toBeInTheDocument();
    });

    it('sent: Create order is green, Revise quote is visible, Decline and Cancel are in More', async () => {
      renderAtStatus('sent');
      await loaded();
      expect(within(header()).getByRole('button', { name: 'Create order' }).className).toContain('bg-crx-green');
      expect(within(header()).getByRole('button', { name: 'Revise quote' })).toBeInTheDocument();
      expect(within(header()).getByRole('button', { name: 'Preview & send' }).className).not.toContain('bg-crx-green');
      expect(within(header()).queryByRole('button', { name: /Decline|Cancel quote/ })).not.toBeInTheDocument();
      fireEvent.click(within(header()).getByRole('button', { name: 'More actions' }));
      const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((el) => el.textContent);
      expect(items.slice(-2)).toEqual(['Decline quote', 'Cancel quote']);
      expect(screen.getByRole('menuitem', { name: 'Cancel quote' }).className).toContain('text-red-700');
    });

    it('admin sees Reopen in More on a declined quote; a sales rep does not', async () => {
      renderAtStatus('declined');
      await loaded();
      fireEvent.click(within(header()).getByRole('button', { name: 'More actions' }));
      expect(screen.getByRole('menuitem', { name: 'Reopen' })).toBeInTheDocument();
      cleanup();

      authState.role = 'sales_rep';
      renderAtStatus('declined');
      await loaded();
      fireEvent.click(within(header()).getByRole('button', { name: 'More actions' }));
      expect(screen.queryByRole('menuitem', { name: 'Reopen' })).not.toBeInTheDocument();
    });

    it('shows the plain status label and Unsaved changes from the dirty flag', async () => {
      renderAtStatus('closed_short');
      await loaded();
      expect(within(header()).getByText('Closed short')).toBeInTheDocument();
      expect(within(header()).queryByText('Unsaved changes')).not.toBeInTheDocument();
      cleanup();

      renderAtStatus('draft');
      await loaded();
      fireEvent.change(screen.getByPlaceholderText(/top of the quote|header notes/i), { target: { value: 'Changed' } });
      expect(await within(header()).findByText('Unsaved changes')).toBeInTheDocument();
    });

    it('phone: top bar with back, number, preview and More; Save draft and the green action stay at the bottom', async () => {
      stubPhone();
      try {
        renderAtStatus('sent', true, [{ id: 'order-hdr-1', order_number: 'O-HDR-1' }]);
        await loaded();
        // The quote's orders stay reachable on a phone.
        expect(within(await screen.findByLabelText('Transaction thread')).getByText(/O-HDR-1/)).toBeInTheDocument();
        const top = header();
        expect(within(top).getByRole('link', { name: 'Back to quotes' })).toHaveAttribute('href', '/quotes');
        expect(within(top).getByRole('button', { name: 'Preview and send' })).toBeInTheDocument();
        const bar = screen.getByTestId('quote-bottom-bar');
        expect(within(bar).getByRole('button', { name: 'Create order' }).className).toContain('bg-crx-green');
        // Sent quotes cannot be saved as a draft (the button was always disabled), so the bar holds only the green action.
        expect(within(bar).queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
        // The visible secondaries join the menu on a phone.
        fireEvent.click(within(top).getByRole('button', { name: 'More actions' }));
        expect(screen.getByRole('menuitem', { name: 'Revise quote' })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Download PDF' })).toBeInTheDocument();
        cleanup();

        renderAtStatus('draft');
        await loaded();
        const draftBar = screen.getByTestId('quote-bottom-bar');
        expect(within(draftBar).getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
        expect(within(draftBar).getByRole('button', { name: 'Preview & send' }).className).toContain('bg-crx-green');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // Review Focus 3: no status gains an action it does not have today, and none loses one.
    it.each(['draft', 'sent', 'revised', 'accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short'])(
      '%s: the header offers exactly today’s actions to an admin and a sales rep',
      async (status) => {
        try {
          for (const phone of [false, true]) {
            if (phone) stubPhone();
            for (const role of ['admin', 'sales_rep']) {
              for (const planned of [true, false]) {
                authState.role = role;
                dirtyStates.length = 0;
                renderAtStatus(status, planned);
                await loaded();
                // Save is still offered, but only once there is something to save: on a just-loaded
                // quote it is shown disabled, so it is checked on its own and the first edit enables it.
                const saveLabel = status === 'draft' ? 'Save draft' : status === 'revised' ? 'Save changes' : null;
                expect(availableActions(phone), `${status} / ${role} / planned=${planned} / phone=${phone}`)
                  .toEqual(todaysActions(status, role, planned).filter((name) => name !== saveLabel));
                if (saveLabel) {
                  const saves = () => screen.getAllByRole('button', { name: saveLabel });
                  for (const save of saves()) {
                    expect(save).toBeDisabled();
                    expect(save).toHaveAttribute('title', 'No changes to save');
                  }
                  await makeAnEdit();
                  await waitFor(() => { for (const save of saves()) expect(save).toBeEnabled(); });
                }
                cleanup();
              }
            }
          }
        } finally {
          vi.unstubAllGlobals();
        }
      },
    );
  });

  describe('notices, summary strip and details (Quotes UI redesign)', () => {
    function serve(status: 'draft' | 'sent', settlement: Record<string, unknown> | null = null, quoteOverrides: Record<string, unknown> = {}) {
      const fixture = makeQuoteFixture(status, 7);
      const quote = { ...fixture.quote, ...quoteOverrides };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [QUOTE_FIXTURE_CUSTOMER]
                : table === 'products' ? [fixture.product]
                  : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_booking_settlement'
        ? { data: settlement, error: null }
        : { data: null, error: null }));
      renderQuoteBuilder(quote.id);
      return quote;
    }
    const summary = () => screen.getByRole('region', { name: 'Summary' });
    // Each figure is a label with its value right after it.
    const figure = (label: string) => within(summary()).queryByText(label)?.nextElementSibling?.textContent ?? null;

    it('summary shows total, cost, profit and margin for admin', async () => {
      serve('draft');
      // The fixture line: 2 gal at $10.00 (cost $6.00), so $20.00, cost $12.00, profit $8.00, 40.0%.
      await waitFor(() => expect(figure('Quote total')).toBe('$20.00'));
      expect(figure('Total cost')).toBe('$12.00');
      expect(figure('Profit · margin')).toBe('$8.00 · 40.0%');
    });

    it('summary hides cost, profit and margin for a sales rep and in Customer view', async () => {
      authState.role = 'sales_rep';
      serve('draft');
      await waitFor(() => expect(figure('Quote total')).toBe('$20.00'));
      expect(within(summary()).queryByText('Total cost')).not.toBeInTheDocument();
      expect(within(summary()).queryByText('Profit · margin')).not.toBeInTheDocument();
      expect(summary().textContent).not.toMatch(/\$12\.00|\$8\.00|40\.0%/);
      cleanup();

      authState.role = 'admin';
      serve('draft');
      await waitFor(() => expect(figure('Total cost')).toBe('$12.00'));
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      expect(screen.getByLabelText('Confidence')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: /Customer view/ }));
      expect(figure('Quote total')).toBe('$20.00');
      expect(screen.queryByLabelText('Confidence')).not.toBeInTheDocument();
      expect(within(summary()).queryByText('Total cost')).not.toBeInTheDocument();
      expect(within(summary()).queryByText('Profit · margin')).not.toBeInTheDocument();
      expect(summary().textContent).not.toMatch(/\$12\.00|\$8\.00|40\.0%/);
    });

    it('booking figures show only when the settlement shows today', async () => {
      const settlement = { found: true, booked_cents: 10000, drawn_cents: 2500, remaining_cents: 7500, prepay_remaining_cents: 0, prepay_earmarked_cents: 0, prepay_applied_cents: 0, lines: [] };
      serve('sent', settlement);
      await waitFor(() => expect(figure('Booked')).toBe('$100.00'));
      expect(figure('Drawn')).toBe('$25.00');
      expect(figure('Left to draw')).toBe('$75.00');
      expect(within(summary()).getByRole('progressbar', { name: 'Drawn of booked' })).toHaveAttribute('aria-valuenow', '25');
      // Valid list markup: every child of a dl item is a dt or dd.
      for (const item of Array.from(summary().querySelectorAll('dl > div'))) {
        expect(Array.from(item.children).map((el) => el.tagName)).toEqual(['DT', 'DD']);
      }
      cleanup();

      // Not found: no booking figures, as the settlement card is hidden today.
      serve('sent', { found: false });
      await waitFor(() => expect(figure('Quote total')).toBe('$20.00'));
      expect(within(summary()).queryByText('Booked')).not.toBeInTheDocument();
      cleanup();

      // A draft cannot be drawn from, so the settlement never shows.
      serve('draft', settlement);
      await waitFor(() => expect(figure('Quote total')).toBe('$20.00'));
      expect(within(summary()).queryByText('Booked')).not.toBeInTheDocument();
      expect(within(summary()).queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('tier mismatch appears in the tier helper line with Switch to Tier N and Keep Tier M', async () => {
      serve('draft', null, { tier: 2 });
      const field = await screen.findByTestId('tier-field');
      expect(await within(field).findByText('This customer is assigned Tier 1; this quote uses Tier 2.')).toBeInTheDocument();
      const keep = within(field).getByRole('checkbox', { name: 'Keep Tier 2' });
      fireEvent.click(keep);
      expect(keep).toBeChecked();
      fireEvent.click(within(field).getByRole('button', { name: 'Switch to Tier 1' }));
      await waitFor(() => expect(within(field).queryByText(/this quote uses Tier/)).not.toBeInTheDocument());
      expect(within(field).getByRole('button', { name: /Pricing tier/ })).toHaveTextContent('Tier 1');
    });

    it('Planned program switch keeps its disabled rules', async () => {
      serve('draft');
      const draftSwitch = await screen.findByRole('switch', { name: /^Planned program/ });
      await waitFor(() => expect(draftSwitch).toBeEnabled());
      // Moved off the header: only the Planned chip shows there.
      expect(within(screen.getByTestId('quote-header')).queryByRole('switch')).not.toBeInTheDocument();
      fireEvent.click(draftSwitch);
      expect(draftSwitch).toBeChecked();
      expect(within(screen.getByTestId('quote-header')).getByText('Planned')).toBeInTheDocument();
      cleanup();

      // A sent quote cannot be edited until it is revised (!canEdit && isEditing).
      serve('sent');
      const sentSwitch = await screen.findByRole('switch', { name: /^Planned program/ });
      await screen.findByRole('button', { name: 'Revise quote' });
      expect(sentSwitch).toBeDisabled();
    });
  });

  describe('tabs (Quotes UI redesign)', () => {
    const SETTLEMENT = { found: true, booked_cents: 10000, drawn_cents: 2500, remaining_cents: 7500, prepay_remaining_cents: 0, prepay_earmarked_cents: 0, prepay_applied_cents: 0, lines: [] };
    const readableSnapshot = (quoteId: string, total: number) => ({
      quote: {
        quote_number: 'Q-tabs', customer_id: 'customer-1', tier: 1, status: 'sent', total_price: total,
        total_cost: 0, total_profit: total, total_margin_pct: 100, valid_days: 30, expires_at: null,
        header_notes: null, footer_notes: null, is_planned: false, commission_split: null,
      },
      sections: [],
      quote_id: quoteId,
    });
    function serveTabs(status: 'draft' | 'sent', opts: { settlement?: Record<string, unknown> | null; versions?: number } = {}) {
      const fixture = makeQuoteFixture(status, 7);
      const { quote } = fixture;
      const versions = Array.from({ length: opts.versions ?? 0 }, (_, i) => {
        const n = (opts.versions ?? 0) - i;
        return {
          id: `version-${n}`, quote_id: quote.id, version_number: n, sent_by: 'profile-1',
          sent_at: `2026-03-16T15:4${n}:00.000Z`, sent_method: null, pdf_url: null, notes: null,
          restore_trusted_at: null, snapshot_data: readableSnapshot(quote.id, 100 * n),
        };
      });
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [QUOTE_FIXTURE_CUSTOMER]
                : table === 'products' ? [fixture.product]
                  : table === 'quote_versions' ? versions
                    : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_booking_settlement'
        ? { data: opts.settlement ?? null, error: null }
        : { data: null, error: null }));
      renderQuoteBuilder(quote.id);
    }
    const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);

    it('Products is the default tab and a plain draft shows only the tabs that apply', async () => {
      serveTabs('draft');
      const products = await screen.findByRole('tab', { name: /^Products/ });
      expect(products).toHaveAttribute('aria-selected', 'true');
      expect(products).toHaveTextContent('1');
    });

    it('Booking balance shows exactly when the settlement shows today, and keeps its per-product table', async () => {
      serveTabs('sent', { settlement: { ...SETTLEMENT, lines: [{ product_id: 'p', product_name: 'Tab Product', booked_qty: 5, drawn_qty: 1, remaining_qty: 4 }] } });
      fireEvent.click(await screen.findByRole('tab', { name: 'Booking balance' }));
      expect(await screen.findByText('Tab Product')).toBeInTheDocument();
      // The strip is the only place that shows Booked once the tab's duplicate figures are gone.
      expect(screen.getAllByText('Booked')).toHaveLength(2); // strip label + table header
      expect(screen.queryByText('Remaining to draw')).not.toBeInTheDocument();
      cleanup();

      serveTabs('sent', { settlement: { found: false } });
      await screen.findByRole('tab', { name: /^Products/ });
      expect(screen.queryByRole('tab', { name: 'Booking balance' })).not.toBeInTheDocument();
      cleanup();

      serveTabs('draft', { settlement: SETTLEMENT });
      await screen.findByRole('tab', { name: /^Products/ });
      expect(screen.queryByRole('tab', { name: 'Booking balance' })).not.toBeInTheDocument();
    });

    it('Last charged shows under its four conditions only', async () => {
      serveTabs('draft');
      expect(await screen.findByRole('tab', { name: 'Last charged' })).toBeInTheDocument();
      expect(screen.queryByTestId('last-charged-card')).not.toBeInTheDocument();
      // The data loads with the page (Products showing), not when the tab opens.
      await waitFor(() => expect(mockUseLastCharged).toHaveBeenCalledWith(
        'customer-1',
        [expect.objectContaining({ productId: expect.any(String) })],
        true,
      ));
      fireEvent.click(screen.getByRole('tab', { name: 'Last charged' }));
      expect(screen.getByTestId('last-charged-card')).toBeInTheDocument();

      // Customer View hides it, and the selected tab falls back to Products for good.
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Customer view/ }));
      expect(screen.queryByRole('tab', { name: 'Last charged' })).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Products/ })).toHaveAttribute('aria-selected', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Leave customer view/ }));
      // Leaving Customer View brings the tab back, but the page stays on Products.
      expect(await screen.findByRole('tab', { name: 'Last charged' })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tab', { name: /^Products/ })).toHaveAttribute('aria-selected', 'true');
      cleanup();

      // A sales rep sees it; another role never does.
      authState.role = 'sales_rep';
      serveTabs('draft');
      expect(await screen.findByRole('tab', { name: 'Last charged' })).toBeInTheDocument();
      cleanup();

      authState.role = 'driver';
      mockUseLastCharged.mockClear();
      serveTabs('draft');
      await screen.findByRole('tab', { name: /^Products/ });
      expect(screen.queryByRole('tab', { name: 'Last charged' })).not.toBeInTheDocument();
      expect(mockUseLastCharged).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
      cleanup();

      // No customer, no tab.
      authState.role = 'admin';
      renderQuoteBuilder();
      await screen.findByRole('tab', { name: /^Products/ });
      expect(screen.queryByRole('tab', { name: 'Last charged' })).not.toBeInTheDocument();
    });

    it('a customer with no product lines has no Last charged tab', async () => {
      const fixture = makeQuoteFixture('draft', 7);
      const emptySection = { ...fixture.section };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? fixture.quote
          : table === 'quote_sections' ? [emptySection]
            : table === 'customers' ? [QUOTE_FIXTURE_CUSTOMER]
              : table === 'products' ? [fixture.product]
                : [],
        error: null,
      }));
      renderQuoteBuilder(fixture.quote.id);
      await screen.findByRole('tab', { name: /^Products/ });
      await screen.findByDisplayValue('Version test header');
      expect(screen.queryByRole('tab', { name: 'Last charged' })).not.toBeInTheDocument();
    });

    it('an empty Booking balance tab says nothing is booked', async () => {
      serveTabs('sent', { settlement: SETTLEMENT });
      fireEvent.click(await screen.findByRole('tab', { name: 'Booking balance' }));
      expect(screen.getByText('Nothing booked on this quote yet.')).toBeInTheDocument();
    });

    it('the Booking balance tab is called Booking on a phone', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 767px)', media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }));
      try {
        serveTabs('sent', { settlement: SETTLEMENT });
        expect(await screen.findByRole('tab', { name: 'Booking' })).toBeInTheDocument();
        expect(screen.queryByRole('tab', { name: 'Booking balance' })).not.toBeInTheDocument();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('History shows with the version count, keeps compare and restore, and the menu item is gone', async () => {
      serveTabs('draft', { versions: 2 });
      const history = await screen.findByRole('tab', { name: /^History/ });
      expect(history).toHaveTextContent('2');
      expect(tabNames()).toEqual(expect.arrayContaining([expect.stringMatching(/^History/)]));
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      expect(screen.queryByRole('menuitem', { name: /Version history/ })).not.toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

      fireEvent.click(history);
      fireEvent.click(await screen.findByText('v2'));
      fireEvent.click(screen.getByRole('button', { name: /Compare/ }));
      expect(screen.getByText('Comparing V2 vs Current')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Exit compare/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Restore$/ }));
      expect(screen.getByText('Restore V2? Timing and Confidence will be cleared.')).toBeInTheDocument();
    });

    it('a quote with no saved versions has no History tab', async () => {
      serveTabs('draft');
      await screen.findByRole('tab', { name: /^Products/ });
      expect(screen.queryByRole('tab', { name: /^History/ })).not.toBeInTheDocument();
    });
  });

  describe('sections and lines (Quotes UI redesign)', () => {
    // A window this many px wide: every max-width media query answers as a browser would.
    function stubWidth(px: number) {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: px <= Number(/max-width: (\d+)px/.exec(query)?.[1] ?? Infinity), media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }));
    }
    const stubPhone = () => stubWidth(390);

    // A draft with two lines of one product: 2 gal ($20.00, cost $6.00, profit $8.00, 40.0%) and 3 gal ($30.00).
    function serveLines(productName = 'Product', firstPatch: Record<string, unknown> = {}, status: 'draft' | 'sent' | 'revised' | 'accepted' = 'draft') {
      const fixture = makeQuoteFixture(status, 7);
      const product = { ...fixture.product, product_name: productName };
      const first = { ...fixture.item, product, ...firstPatch };
      const second = { ...fixture.item, id: 'item-2', sort_order: 1, product, total_units_needed: 3, total_price: 30, profit: 12 };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? fixture.quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [first, second]
              : table === 'customers' ? [QUOTE_FIXTURE_CUSTOMER]
                : table === 'products' ? [product]
                  : [],
        error: null,
      }));
      renderQuoteBuilder(fixture.quote.id);
    }
    async function loaded() {
      const prices = await screen.findAllByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(prices[0]).toBeEnabled());
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    }
    const quoteTotal = () => within(screen.getByRole('region', { name: 'Summary' })).getByText('Quote total').nextElementSibling?.textContent;
    const priceInputs = () => screen.queryAllByRole('spinbutton', { name: 'Price per unit' });

    it('removing a line with a product asks first and names product, amount and new total', async () => {
      serveLines();
      await loaded();
      expect(quoteTotal()).toBe('$50.00');

      fireEvent.click(screen.getByRole('button', { name: 'Actions for line 1 in Products' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /^Remove line/ }));
      let dialog = await screen.findByRole('alertdialog', { name: 'Remove this line?' });
      expect(dialog).toHaveTextContent('Product, 2 gal, $20.00. The quote total drops to $30.00.');
      expect(priceInputs()).toHaveLength(2);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep line' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Remove this line?' })).not.toBeInTheDocument());
      expect(priceInputs()).toHaveLength(2);
      expect(quoteTotal()).toBe('$50.00');

      fireEvent.click(screen.getByRole('button', { name: 'Actions for line 1 in Products' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /^Remove line/ }));
      dialog = await screen.findByRole('alertdialog', { name: 'Remove this line?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove line' }));
      await waitFor(() => expect(priceInputs()).toHaveLength(1));
      expect(quoteTotal()).toBe('$30.00');
    });

    it('removing a blank line does not ask', async () => {
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'products' ? [{ id: 'product-1', product_name: 'Alpha Herbicide', is_active: true }] : [],
        error: null,
      }));
      renderQuoteBuilder();
      await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('products'));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
      expect(await screen.findByRole('button', { name: /Select product/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Actions for line 1 in Section 1' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /^Remove line/ }));
      expect(screen.queryByRole('alertdialog', { name: 'Remove this line?' })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('button', { name: /Select product/ })).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Add one' })).toBeInTheDocument();
    });

    // Review Focus 2: a sales rep and Customer view never see a line's cost, profit or margin.
    it('line cost and margin column is absent for a sales rep and in Customer view', async () => {
      const lineTable = () => screen.getByRole('columnheader', { name: 'Total' }).closest('table') as HTMLElement;
      const costText = /\$6\.00|today \$|\$8\.00 · 40\.0%|40\.0%/;

      // Admin control: the column and its figures are there.
      serveLines();
      await loaded();
      expect(screen.getByRole('columnheader', { name: 'Cost · margin' })).toBeInTheDocument();
      expect(lineTable().textContent).toMatch(costText);
      cleanup();

      authState.role = 'sales_rep';
      serveLines();
      await loaded();
      expect(screen.queryByRole('columnheader', { name: 'Cost · margin' })).not.toBeInTheDocument();
      expect(lineTable().textContent).not.toMatch(costText);
      cleanup();

      authState.role = 'admin';
      serveLines();
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Customer view/ }));
      expect(screen.queryByRole('columnheader', { name: 'Cost · margin' })).not.toBeInTheDocument();
      expect(lineTable().textContent).not.toMatch(costText);
      cleanup();

      // Line cards (phone): the same rule.
      stubPhone();
      try {
        serveLines();
        await loaded();
        expect(screen.getByRole('article', { name: 'Line 1, Product' }).textContent).toMatch(costText);
        cleanup();

        authState.role = 'sales_rep';
        serveLines();
        await loaded();
        expect(screen.getByRole('article', { name: 'Line 1, Product' }).textContent).not.toMatch(costText);
        cleanup();

        authState.role = 'admin';
        serveLines();
        await loaded();
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        fireEvent.click(screen.getByRole('menuitem', { name: /Customer view/ }));
        expect(screen.getByRole('article', { name: 'Line 1, Product' }).textContent).not.toMatch(costText);
      } finally {
        vi.unstubAllGlobals();
      }
      cleanup();

      // 1024 to 1279 px: cards too; an admin's cost shows, still never for a rep or in Customer view.
      stubWidth(1024);
      try {
        serveLines();
        await loaded();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.getByRole('article', { name: 'Line 1, Product' }).textContent).toMatch(costText);
        cleanup();

        authState.role = 'sales_rep';
        serveLines();
        await loaded();
        expect(screen.getByRole('article', { name: 'Line 1, Product' }).textContent).not.toMatch(costText);
        cleanup();

        authState.role = 'admin';
        serveLines();
        await loaded();
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        fireEvent.click(screen.getByRole('menuitem', { name: /Customer view/ }));
        expect(screen.getByRole('article', { name: 'Line 1, Product' }).textContent).not.toMatch(costText);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // A quote that can't be edited takes no edits at all, so it never shows "Unsaved changes" it can't save.
    it.each(['accepted', 'sent'] as const)('a %s quote shows its fields disabled and no add actions; collapse and tabs still work', async (status) => {
      serveLines('Product', {}, status);
      await screen.findAllByRole('spinbutton', { name: 'Price per unit' });
      // The Needed-by date picker's segments are spinbuttons that mark themselves aria-disabled.
      for (const input of screen.getAllByRole('spinbutton')) {
        if (input.getAttribute('aria-disabled') !== 'true') expect(input).toBeDisabled();
      }
      expect(screen.getAllByRole('spinbutton', { name: /Needed by/ }).length).toBeGreaterThan(0);
      expect(screen.getByRole('textbox', { name: 'Section name' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: /Note at the top/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Pricing tier/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Actions for line 1 in Products' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: /Add product/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Add a section/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Add a note for this section/ })).not.toBeInTheDocument();
      expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();

      const collapse = screen.getByRole('button', { name: 'Collapse section' });
      expect(collapse).toBeEnabled();
      fireEvent.click(collapse);
      expect(screen.getByRole('button', { name: 'Expand section' })).toBeEnabled();
      const tabs = screen.getAllByRole('tab');
      expect(tabs.length).toBeGreaterThan(1);
      for (const tab of tabs) expect(tab).toBeEnabled();
    });

    it('a draft keeps every field editable', async () => {
      serveLines();
      await loaded();
      for (const input of screen.getAllByRole('spinbutton')) expect(input).toBeEnabled();
      expect(screen.getByRole('textbox', { name: 'Section name' })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Add product/ })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Add a section/ })).toBeEnabled();
    });

    // A revised quote is a live booking: the server refuses revised -> draft, so its save keeps it revised.
    it('a revised quote offers Save changes, which saves it as revised, never as a draft', async () => {
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { quote_id: 'quote-revised-7', row_version: 8, item_ids: {} }, error: null }
        : { data: null, error: null }));
      serveLines('Product', {}, 'revised');
      await loaded();
      expect(screen.queryByRole('button', { name: /Save draft/ })).not.toBeInTheDocument();
      await makeAnEdit();
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      const args = mockRpc.mock.calls.find(([name]) => name === 'save_quote')?.[1] as { p_quote_payload: { status: string } };
      expect(args.p_quote_payload.status).toBe('revised');
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Changes saved. Send the quote again when it is ready.'));
      cleanup();
      mockRpc.mockClear();

      // A draft still saves as a draft.
      serveLines();
      await loaded();
      expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
      await makeAnEdit();
      fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      const draftArgs = mockRpc.mock.calls.find(([name]) => name === 'save_quote')?.[1] as { p_quote_payload: { status: string } };
      expect(draftArgs.p_quote_payload.status).toBe('draft');
    });

    // Repeated clicks on an unchanged quote sent duplicate saves (Taha): Save waits for a change.
    it.each([['draft', 'Save draft'], ['revised', 'Save changes']] as const)(
      'a %s quote enables %s only while it has unsaved changes',
      async (status, label) => {
        mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
          ? { data: { quote_id: `quote-${status}-7`, row_version: 8, item_ids: {} }, error: null }
          : { data: null, error: null }));
        serveLines('Product', {}, status);
        await loaded();
        const save = () => screen.getByRole('button', { name: label });
        expect(save()).toBeDisabled();
        expect(save()).toHaveAttribute('title', 'No changes to save');

        // A lower price, so a revised quote needs no "grower agreed" tick.
        fireEvent.change(priceInputs()[0], { target: { value: '9' } });
        fireEvent.blur(priceInputs()[0]);
        await waitFor(() => expect(save()).toBeEnabled());
        expect(save()).not.toHaveAttribute('title');

        fireEvent.click(save());
        await waitFor(() => expect(save()).toHaveAttribute('title', 'No changes to save'));
        expect(save()).toBeDisabled();
        expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote')).toHaveLength(1);
      },
    );

    // Changing a value and typing the old one back left Save on (Taha): clean means "same as saved".
    it('an edit changed back to the saved value turns Save draft off again', async () => {
      serveLines();
      await loaded();
      const save = () => screen.getByRole('button', { name: 'Save draft' });
      const note = await screen.findByLabelText('Note at the bottom of the quote');
      const savedNote = (note as HTMLTextAreaElement).value;
      const savedPrice = (priceInputs()[0] as HTMLInputElement).value;

      fireEvent.change(note, { target: { value: `${savedNote} extra` } });
      await waitFor(() => expect(save()).toBeEnabled());
      fireEvent.change(note, { target: { value: savedNote } });
      await waitFor(() => expect(save()).toBeDisabled());

      fireEvent.change(priceInputs()[0], { target: { value: '9' } });
      fireEvent.blur(priceInputs()[0]);
      await waitFor(() => expect(save()).toBeEnabled());
      fireEvent.change(priceInputs()[0], { target: { value: savedPrice } });
      fireEvent.blur(priceInputs()[0]);
      await waitFor(() => expect(save()).toBeDisabled());
      expect(save()).toHaveAttribute('title', 'No changes to save');
      expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
    });

    it('a failed save keeps Save draft enabled, so the user can retry without another edit', async () => {
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: null, error: { message: 'connection reset' } }
        : { data: null, error: null }));
      serveLines();
      await loaded();
      fireEvent.change(priceInputs()[0], { target: { value: '9' } });
      fireEvent.blur(priceInputs()[0]);
      const save = () => screen.getByRole('button', { name: 'Save draft' });
      await waitFor(() => expect(save()).toBeEnabled());

      fireEvent.click(save());
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.anything()));
      await waitFor(() => expect(save()).toBeEnabled());
      expect(save()).not.toHaveAttribute('title');

      fireEvent.click(save());
      await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote')).toHaveLength(2));
    });

    it('Edit note opens the line note, Done shows it, and Save draft sends it', async () => {
      serveLines();
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'Actions for line 1 in Products' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /note$/ }));
      const note = await screen.findByRole('textbox', { name: 'Line note' });
      fireEvent.change(note, { target: { value: 'Apply before rain' } });
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.queryByRole('textbox', { name: 'Line note' })).not.toBeInTheDocument();
      expect(screen.getByText('Note: Apply before rain')).toBeInTheDocument();

      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { quote_id: 'quote-draft-7', row_version: 8, item_ids: {} }, error: null }
        : { data: null, error: null }));
      fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      const saveArgs = mockRpc.mock.calls.find(([name]) => name === 'save_quote')?.[1] as {
        p_sections: Array<{ items: Array<{ id: string | null; notes: string | null }> }>;
      };
      expect(saveArgs.p_sections[0].items[0]).toMatchObject({ id: 'item-1', notes: 'Apply before rain' });
    });

    // Found at 768 px: the sr-only "Line actions" header is absolutely positioned; without a positioned
    // scroller it escapes the table's overflow and widens the page.
    it('the line table scrolls inside a positioned wrapper', async () => {
      serveLines();
      await loaded();
      const wrapper = screen.getByRole('columnheader', { name: 'Total' }).closest('table')?.parentElement;
      expect(wrapper).toHaveClass('relative', 'overflow-x-auto');
      expect(within(wrapper as HTMLElement).getByText('Line actions')).toHaveClass('sr-only');
    });

    // Product table v2 (#6): the table fits its card from 1280 px; below that each line is a card.
    const firstRow = () => within(screen.getByRole('columnheader', { name: 'Total' }).closest('table') as HTMLElement).getAllByRole('row')[1];

    it('from 1280 px the line table fits its card, with $/acre under each Total and cost in its own column', async () => {
      stubWidth(1280);
      try {
        serveLines('Product', { price_per_acre: 2.5 });
        await loaded();
        const table = screen.getByRole('columnheader', { name: 'Total' }).closest('table') as HTMLElement;
        expect(table).toHaveClass('table-fixed', 'w-full');
        expect(table.className).not.toMatch(/min-w-\[/);
        expect(screen.getByRole('columnheader', { name: 'Rate per acre' })).toBeInTheDocument();
        expect(screen.queryByRole('columnheader', { name: '$/acre' })).not.toBeInTheDocument();
        expect(screen.queryByRole('article')).not.toBeInTheDocument();

        const cells = within(firstRow()).getAllByRole('cell');
        expect(cells[6].textContent).toMatch(/^\$20\.00\$2\.50 \/ acre/);
        const second = within(table).getAllByRole('row')[2];
        expect(within(second).getAllByRole('cell')[6].textContent).toMatch(/^\$30\.00– \/ acre/);
        expect(screen.getByRole('columnheader', { name: 'Cost · margin' })).toBeInTheDocument();
        expect(cells[6].textContent).toBe('$20.00$2.50 / acre');
        expect(cells[7].textContent).toMatch(/\$8\.00 · 40\.0%$/);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('below 1280 px each line is a card: 4 labelled fields (2 across on a phone), then $/acre and the total', async () => {
      stubWidth(1279);
      try {
        serveLines('Product', { price_per_acre: 2.5 });
        await loaded();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        const card = screen.getByRole('article', { name: 'Line 1, Product' });
        const fields = card.querySelector('.grid') as HTMLElement;
        expect(fields).toHaveClass('grid-cols-2', 'md:@min-[36rem]:grid-cols-4');
        expect(Array.from(fields.children, (f) => f.firstElementChild?.textContent)).toEqual(['Rate per acre', 'Acres', 'Quantity', 'Price']);
        expect(within(card).getByText('$2.50 / acre')).toBeInTheDocument();
        expect(within(card).getByText('$20.00')).toBeInTheDocument();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('each number and its unit share one box, and every control keeps its label', async () => {
      serveLines('Product', { price_unit: 'gal', rate_unit: 'gal' });
      await loaded();
      const row = firstRow();
      const boxOf = (name: string) => within(row).getByRole('spinbutton', { name }).parentElement as HTMLElement;

      expect(within(boxOf('Actual rate')).getByRole('button', { name: /Rate unit/ })).toHaveTextContent('gal');
      expect(within(boxOf('Price per unit')).getByRole('button', { name: /Price unit/ })).toHaveTextContent('/ gal');
      expect(boxOf('Quantity')).toHaveTextContent('gal');
      // Entered by hand keeps its green box and caption.
      expect(boxOf('Quantity')).toHaveClass('border-crx-green');
      expect(within(row).getByText('Entered by hand')).toBeInTheDocument();
      expect(within(row).getByRole('spinbutton', { name: 'Acres' })).toHaveClass('text-right', 'tabular-nums');
      for (const name of ['Actual rate', 'Quantity', 'Price per unit']) {
        expect(within(boxOf(name)).getByRole('spinbutton', { name })).toHaveClass('text-right', 'tabular-nums');
      }

      // The box clips the trigger's own ring, so keyboard focus marks the unit trigger inside it.
      const priceUnit = within(boxOf('Price per unit')).getByRole('button', { name: /Price unit/ });
      fireEvent.keyDown(document.body, { key: 'Tab' });
      act(() => priceUnit.focus());
      expect(priceUnit).toHaveAttribute('data-focus-visible', 'true');
      expect(priceUnit.closest('.w-auto\\!')?.className).toMatch(/\[&_button\[data-focus-visible\]\]:ring-2/);
      act(() => priceUnit.blur());

      fireEvent.change(within(row).getByRole('spinbutton', { name: 'Price per unit' }), { target: { value: '12' } });
      expect(boxOf('Price per unit')).toHaveClass('border-amber-400');
      expect(within(row).getByRole('button', { name: 'Reset the manual price' })).toBeInTheDocument();
    });

    it('the section header always shows the Section total', async () => {
      serveLines();
      await loaded();
      const caption = screen.getByText('Section total');
      expect(caption.nextElementSibling).toHaveTextContent('$50.00');
      // A phone shows the amount only; the caption is still read out.
      expect(caption).toHaveClass('max-md:sr-only');
    });

    // Review Focus 1: a long name wraps on the 360 px card instead of being cut off behind a tooltip.
    it('a line card at 360 px keeps a 60-character product name readable', async () => {
      const longName = 'Synthetic pre-emerge herbicide concentrate, long label names';
      expect(longName).toHaveLength(60);
      stubPhone();
      try {
        serveLines(longName);
        await loaded();
        const card = screen.getByRole('article', { name: `Line 1, ${longName}` });
        expect(within(card).queryByRole('table')).not.toBeInTheDocument();
        const name = within(card).getByText(longName);
        expect(name.className).toMatch(/break-words/);
        for (let el: HTMLElement | null = name; el && el !== card; el = el.parentElement) {
          expect(el.className).not.toMatch(/\btruncate\b|line-clamp|text-ellipsis/);
        }
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('the product cell shows the last charge only once the Last charged data has loaded', async () => {
      mockUseLastCharged.mockReturnValue({
        products: [],
        state: { status: 'loaded', requestKey: 'customer-1|product-1', byProduct: new Map([['product-1', { product_id: 'product-1', unit_price_cents: 870, price_tier: 1, unit_size: 'gal', charged_on: '2026-03-14', source: 'invoice' }]]) },
        retry: () => {},
      });
      try {
        serveLines();
        await loaded();
        expect(screen.getAllByText('Last charged $8.70 / gal on Mar 14, 2026')).toHaveLength(2);
        cleanup();

        mockUseLastCharged.mockReturnValue({ products: [], state: { status: 'loaded', requestKey: 'k', byProduct: new Map() }, retry: () => {} });
        serveLines();
        await loaded();
        expect(screen.getAllByText('First time for this customer')).toHaveLength(2);
        cleanup();

        mockUseLastCharged.mockReset();
        serveLines();
        await loaded();
        expect(screen.queryByText(/Last charged \$|First time for this customer/)).not.toBeInTheDocument();
      } finally {
        mockUseLastCharged.mockReset();
      }
    });
  });
  describe('preview and send dialog (Quotes UI redesign)', () => {
    function serveAt(status: string, customer: Record<string, unknown> = QUOTE_FIXTURE_CUSTOMER) {
      const fixture = makeQuoteFixture('draft', 7);
      const quote = { ...fixture.quote, status, customer };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes'
          ? quote
          : table === 'quote_sections'
            ? [fixture.section]
            : table === 'quote_items'
              ? [fixture.item]
              : table === 'customers'
                ? [customer]
                : table === 'products'
                  ? [fixture.product]
                  : [],
        error: null,
      }));
      renderQuoteBuilder(quote.id);
    }

    async function openPreview() {
      fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
      return screen.findByRole('dialog', { name: 'Preview and send' });
    }

    it("column chips keep today's defaults and toggle the same 12 columns", async () => {
      serveAt('draft');
      const dialog = await openPreview();
      const chips = within(within(dialog).getByRole('group', { name: 'Columns on the PDF' })).getAllByRole('button');
      expect(chips.map((c) => c.textContent)).toEqual([
        'Product', 'Category', 'Notes', 'Suggested rate', 'Rate', 'Unit', 'Acres', 'Quantity', 'Container', 'Price', '$/Acre', 'Total',
      ]);
      expect(chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent))
        .toEqual(['Product', 'Rate', 'Acres', 'Quantity', 'Price', 'Total']);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Category' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Total' }));
      expect(within(dialog).getByRole('button', { name: 'Category' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(dialog).getByRole('button', { name: 'Total' })).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
      await waitFor(() => expect(vi.mocked(downloadQuotePdf)).toHaveBeenCalledWith(
        expect.anything(),
        ['product', 'actual_rate', 'acres', 'qty', 'price_unit', 'category'],
      ));
    });

    it('toggling a chip redraws the preview with the new columns; the emailed PDF is built as before', async () => {
      const fixture = makeQuoteFixture('draft', 7);
      const quote = { ...fixture.quote, status: 'sent' };
      let quoteReads = 0;
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes'
          ? (++quoteReads <= 2 ? quote : { ...quote, row_version: 8 })
          : table === 'quote_sections'
            ? [fixture.section]
            : table === 'quote_items'
              ? [fixture.item]
              : table === 'customers'
                ? [QUOTE_FIXTURE_CUSTOMER]
                : table === 'products'
                  ? [fixture.product]
                  : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(
        name === 'create_quote_version'
          ? { data: { version_number: 2, status: 'created', row_version: 8 }, error: null }
          : { data: null, error: null },
      ));
      renderQuoteBuilder(quote.id);
      const defaults = ['product', 'actual_rate', 'acres', 'qty', 'price_unit', 'total_price'];
      const dialog = await openPreview();

      // The preview prints the same rich line data as Download, with the active columns.
      expect(mockGenerateQuotePdf).toHaveBeenCalledTimes(1);
      expect(mockGenerateQuotePdf).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sections: [expect.objectContaining({
            items: [expect.objectContaining({ category: '', inventory_unit: 'gal', unit_size: 'gal' })],
          })],
        }),
        defaults,
      );

      fireEvent.click(within(dialog).getByRole('button', { name: 'Category' }));
      await waitFor(() => expect(mockGenerateQuotePdf).toHaveBeenCalledTimes(2));
      expect(mockGenerateQuotePdf).toHaveBeenLastCalledWith(expect.anything(), [...defaults, 'category']);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Email to grower' }));
      await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
      expect(mockGenerateQuotePdf).toHaveBeenCalledTimes(3);
      // The email still builds its own PDF: the quote's saved issue date and the expiry its send stored.
      expect(mockGenerateQuotePdf).toHaveBeenLastCalledWith(
        expect.objectContaining({ created_at: RECENT_QUOTE_CREATED_AT, expires_at: new Date(2026, 10, 25).toISOString() }),
        [...defaults, 'category'],
      );
    });

    describe('preview rebuilds', () => {
      const tagged = (tag: string) => ({ output: () => Object.assign(new Blob([tag]), { tag }) });
      const deferred = () => {
        let resolve!: (v: unknown) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      };
      const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      afterEach(() => { vi.useRealTimers(); });

      it('shows only the latest columns when toggles overlap a build in flight', async () => {
        serveAt('draft');
        mockGenerateQuotePdf.mockImplementationOnce(() => tagged('A'));
        const dialog = await openPreview();
        expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-tag', 'A');
        vi.useFakeTimers();
        const category = within(dialog).getByRole('button', { name: 'Category' });
        const container = within(dialog).getByRole('button', { name: 'Container' });

        // A to B, build B in flight, then back to A: B's late result is dropped.
        const b = deferred();
        mockGenerateQuotePdf.mockImplementationOnce(() => b.promise as never);
        fireEvent.click(category);
        await advance(200);
        expect(screen.getByText('Updating preview…')).toBeInTheDocument();
        expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-tag', 'A');
        fireEvent.click(category);
        await act(async () => { b.resolve(tagged('B')); });
        await advance(500);
        expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-tag', 'A');
        expect(screen.queryByText('Updating preview…')).not.toBeInTheDocument();

        // A to B to C: B resolves after C was requested and is ignored.
        const b2 = deferred();
        const c = deferred();
        mockGenerateQuotePdf.mockImplementationOnce(() => b2.promise as never).mockImplementationOnce(() => c.promise as never);
        fireEvent.click(category);
        await advance(200);
        fireEvent.click(container);
        await advance(200);
        await act(async () => { c.resolve(tagged('C')); });
        await act(async () => { b2.resolve(tagged('B2')); });
        await advance(500);
        expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-tag', 'C');
      });

      it("drops a late first preview: quote A's after the page moves to quote B, and an older click's", async () => {
        const fixture = makeQuoteFixture('draft', 7);
        const quoteA = { ...fixture.quote, customer: QUOTE_FIXTURE_CUSTOMER };
        const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header' };
        let quoteReads = 0;
        mockFrom.mockImplementation((table: string) => buildChain({
          data: table === 'quotes'
            ? (quoteReads++ === 0 ? quoteA : quoteB)
            : table === 'quote_sections'
              ? [fixture.section]
              : table === 'quote_items'
                ? [fixture.item]
                : table === 'customers'
                  ? [QUOTE_FIXTURE_CUSTOMER]
                  : table === 'products'
                    ? [fixture.product]
                    : [],
          error: null,
        }));
        renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
        const a = deferred();
        mockGenerateQuotePdf.mockImplementationOnce(() => a.promise as never);
        fireEvent.click(await screen.findByRole('button', { name: 'Preview & send' }));
        fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
        await screen.findByDisplayValue('Quote B header');
        await act(async () => { a.resolve(tagged('A')); });
        expect(screen.queryByRole('dialog', { name: 'Preview and send' })).not.toBeInTheDocument();

        // On B, two quick clicks: the first build lands last and must not replace the second.
        const first = deferred();
        mockGenerateQuotePdf.mockImplementationOnce(() => first.promise as never).mockImplementationOnce(() => tagged('B2'));
        const preview = screen.getByRole('button', { name: 'Preview & send' });
        fireEvent.click(preview);
        fireEvent.click(preview);
        const dialog = await screen.findByRole('dialog', { name: 'Preview and send' });
        expect(within(dialog).getByTestId('pdf-preview')).toHaveAttribute('data-tag', 'B2');
        await act(async () => { first.resolve(tagged('B1')); });
        expect(within(dialog).getByTestId('pdf-preview')).toHaveAttribute('data-tag', 'B2');
      });

      it('keeps the last good pages and says so when a rebuild fails, then clears on success', async () => {
        serveAt('draft');
        mockGenerateQuotePdf.mockImplementationOnce(() => tagged('A'));
        const dialog = await openPreview();
        vi.useFakeTimers();
        mockGenerateQuotePdf.mockImplementationOnce(() => Promise.reject(new Error('boom')) as never);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Category' }));
        await advance(200);
        expect(screen.getByText('Preview could not update. Download and email use the columns you picked.')).toBeInTheDocument();
        expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-tag', 'A');

        mockGenerateQuotePdf.mockImplementationOnce(() => tagged('D'));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Container' }));
        await advance(200);
        expect(screen.queryByText(/Preview could not update/)).not.toBeInTheDocument();
        expect(screen.getByTestId('pdf-preview')).toHaveAttribute('data-tag', 'D');
      });
    });

    it('Email to grower is off with a reason when the quote is new, has unsaved changes, or the customer has no email', async () => {
      renderQuoteBuilder();
      let dialog = await openPreview();
      expect(within(dialog).getByRole('button', { name: 'Email to grower' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Email to grower' })).toHaveAccessibleDescription('Save the quote before emailing it.');
      expect(within(dialog).getByRole('button', { name: 'Save quote' })).toBeInTheDocument();
      cleanup();

      serveAt('draft');
      await screen.findByRole('heading', { level: 1, name: 'Q-version-test' });
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
      // A saved, unchanged quote: Email is on and there is nothing to save.
      dialog = await openPreview();
      expect(within(dialog).getByRole('button', { name: 'Email to grower' })).toBeEnabled();
      expect(within(dialog).queryByRole('button', { name: 'Save quote' })).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      fireEvent.change(screen.getByPlaceholderText(/top of the quote/i), { target: { value: 'Changed' } });
      dialog = await openPreview();
      expect(within(dialog).getByRole('button', { name: 'Email to grower' })).toBeDisabled();
      expect(within(dialog).getByText('Save the quote before emailing it.')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Save quote' })).toBeEnabled();
      cleanup();

      serveAt('draft', { ...QUOTE_FIXTURE_CUSTOMER, email: null });
      dialog = await openPreview();
      expect(within(dialog).getByText('No email address on file')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Email to grower' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Email to grower' })).toHaveAccessibleDescription('No email on file for this customer');
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('Save quote in the preview runs the page save, then Email to grower turns on without leaving the preview', async () => {
      serveAt('draft');
      await screen.findByRole('heading', { level: 1, name: 'Q-version-test' });
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { status: 'saved', quote_id: 'quote-version-test', row_version: 8, item_ids: {} }, error: null }
        : { data: null, error: null }));
      fireEvent.change(screen.getByPlaceholderText(/top of the quote/i), { target: { value: 'Changed' } });
      const dialog = await openPreview();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Save quote' }));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Email to grower' })).toBeEnabled());
      // The same save as the page's Save draft: one save_quote, as a draft, with the edit.
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(saves).toHaveLength(1);
      expect(saves[0][1]).toEqual(expect.objectContaining({ p_quote_payload: expect.objectContaining({ header_notes: 'Changed' }) }));
      expect(mockToast).toHaveBeenCalledWith('success', 'Quote saved as draft');
      expect(within(dialog).queryByRole('button', { name: 'Save quote' })).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Preview and send' })).toBeInTheDocument();
    });

    it('a new quote saved from the preview opens its saved page and the preview comes back ready to email', async () => {
      const fixture = makeQuoteFixture('draft', 7);
      mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? { ...fixture.quote, customer: QUOTE_FIXTURE_CUSTOMER }
        : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [fixture.item]
          : table === 'products' ? [fixture.product] : table === 'customers' ? [{ ...QUOTE_FIXTURE_CUSTOMER, default_commission_split: { splits: [] } }] : [], error: null }));
      mockRpc.mockImplementation((name: string) => Promise.resolve({ data: name === 'save_quote'
        ? { quote_id: fixture.quote.id, row_version: 7, item_ids: {} }
        : name === 'generate_quote_number' ? 'Q-new-preview' : null, error: null }));
      const router = createMemoryRouter([{ path: '/quotes/new', element: <QuoteBuilder /> },
        { path: '/quotes/:id', element: <QuoteBuilder /> }], { initialEntries: ['/quotes/new'] });
      mockNavigate.mockImplementation((path: string) => { void router.navigate(path); });
      const view = render(<RouterProvider router={router} />);
      try {
        fireEvent.change(await screen.findByRole('combobox', { name: 'Customer' }), { target: { value: 'Farm' } });
        fireEvent.click(await screen.findByRole('option', { name: /Farm/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Add one' }));
        fireEvent.click(screen.getByRole('button', { name: /Select product/i }));
        const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
        fireEvent.click(within(picker.closest('[role="dialog"]') as HTMLElement).getAllByText(fixture.product.product_name).slice(-1)[0]);
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantity' }), { target: { value: '2' } });
        const dialog = await openPreview();
        expect(within(dialog).getByRole('button', { name: 'Email to grower' })).toBeDisabled();

        fireEvent.click(within(dialog).getByRole('button', { name: 'Save quote' }));
        await waitFor(() => expect(router.state.location.pathname).toBe(`/quotes/${fixture.quote.id}`));
        // The saved quote loads (the page shows its skeleton meanwhile), then the preview is back.
        await screen.findByRole('heading', { level: 1, name: fixture.quote.quote_number });
        const reopened = await screen.findByRole('dialog', { name: 'Preview and send' });
        await waitFor(() => expect(within(reopened).getByRole('button', { name: 'Email to grower' })).toBeEnabled());
        expect(within(reopened).queryByRole('button', { name: 'Save quote' })).not.toBeInTheDocument();
        expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote')).toHaveLength(1);
      } finally {
        view.unmount();
        mockNavigate.mockReset();
        router.dispose();
      }
    });

    it('Ctrl+S saves the quote like Save draft, and does nothing with no changes or while a dialog is open', async () => {
      serveAt('draft');
      await screen.findByRole('heading', { level: 1, name: 'Q-version-test' });
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { status: 'saved', quote_id: 'quote-version-test', row_version: 8, item_ids: {} }, error: null }
        : { data: null, error: null }));
      const saveCount = () => mockRpc.mock.calls.filter(([name]) => name === 'save_quote').length;
      const ctrlS = () => act(async () => {
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
        await new Promise((r) => setTimeout(r, 0));
      });

      await ctrlS();
      expect(saveCount()).toBe(0);

      fireEvent.change(screen.getByPlaceholderText(/top of the quote/i), { target: { value: 'Changed' } });
      await openPreview();
      await ctrlS();
      expect(saveCount()).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));

      await ctrlS();
      await waitFor(() => expect(saveCount()).toBe(1));
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
      expect(mockToast).toHaveBeenCalledWith('success', 'Quote saved as draft');
    });

    it('Mark as presented is enabled only for draft and revised', async () => {
      for (const [status, enabled] of [['draft', true], ['revised', true], ['sent', false]] as const) {
        serveAt(status);
        const dialog = await openPreview();
        const button = within(dialog).getByRole('button', { name: 'Mark as presented' });
        if (enabled) expect(button).toBeEnabled();
        else expect(button).toBeDisabled();
        cleanup();
      }
    });
  });

  // Save and email (Mason, 2026-11-24): one button runs the page's Save, then, only when it went
  // through, the same send as Email to grower (same recipient, template and version freeze).
  describe('Save and email', () => {
    // A draft whose row_version moves as the server would: save_quote, then the email's freeze.
    function serveSaveAndEmail(customer: Record<string, unknown> = QUOTE_FIXTURE_CUSTOMER, saveError: unknown = null) {
      const fixture = makeQuoteFixture('draft', 7);
      const quote = { ...fixture.quote, customer };
      let rowVersion = 7;
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes'
          ? { ...quote, row_version: rowVersion }
          : table === 'quote_sections'
            ? [fixture.section]
            : table === 'quote_items'
              ? [fixture.item]
              : table === 'customers'
                ? [customer]
                : table === 'products'
                  ? [fixture.product]
                  : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => {
        if (name === 'save_quote') {
          if (saveError) return Promise.resolve({ data: null, error: saveError });
          rowVersion = 8;
          return Promise.resolve({ data: { status: 'saved', quote_id: quote.id, row_version: 8, item_ids: {} }, error: null });
        }
        if (name === 'create_quote_version') {
          rowVersion += 1;
          return Promise.resolve({ data: { version_number: 1, status: 'created', row_version: rowVersion }, error: null });
        }
        return Promise.resolve({ data: name === 'generate_quote_number' ? 'Q-2026-0042' : null, error: null });
      });
      renderQuoteBuilder(quote.id);
      return quote;
    }

    async function loadedClean() {
      await screen.findByRole('heading', { level: 1, name: 'Q-version-test' });
      await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    }

    const saveAndEmail = () => screen.getAllByRole('button', { name: 'Save and email' })[0];
    const rpcNames = () => mockRpc.mock.calls.map(([name]) => name);

    it('saves the edit, then emails the grower once, exactly as Email to grower does', async () => {
      const quote = serveSaveAndEmail();
      await loadedClean();
      fireEvent.change(screen.getByPlaceholderText(/top of the quote/i), { target: { value: 'Changed' } });

      fireEvent.click(saveAndEmail());

      await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
      // The page's own save first (as a draft, with the edit), then the email's version freeze.
      const names = rpcNames();
      expect(names.filter((n) => n === 'save_quote')).toHaveLength(1);
      expect(names.indexOf('save_quote')).toBeLessThan(names.indexOf('create_quote_version'));
      expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
        p_quote_payload: expect.objectContaining({ status: 'draft', header_notes: 'Changed' }),
      }));
      expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.objectContaining({
        p_quote_id: quote.id, p_method: 'emailed', p_expected_row_version: 8,
      }));
      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'grower@example.com', subject: 'Quote Q-version-test from Crop Rx Solutions', email_type: 'quote', resource_id: quote.id,
      }));
      expect(mockToast).toHaveBeenCalledWith('success', 'Quote saved as draft');
      expect(mockToast).toHaveBeenCalledWith('success', 'Quote emailed to grower@example.com');
      // Nothing more goes out afterwards.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
    });

    it('sends no email when the save fails, and shows the save error', async () => {
      serveSaveAndEmail(QUOTE_FIXTURE_CUSTOMER, { message: 'Save went wrong' });
      await loadedClean();
      fireEvent.change(screen.getByPlaceholderText(/top of the quote/i), { target: { value: 'Changed' } });

      fireEvent.click(saveAndEmail());

      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.anything()));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rpcNames()).not.toContain('create_quote_version');
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockToast).not.toHaveBeenCalledWith('success', expect.stringContaining('Quote emailed'));
    });

    it('sends no email when the save stops at a check (no customer picked on a new quote)', async () => {
      renderQuoteBuilder();
      await waitFor(() => expect(rpcNames()).toContain('generate_quote_number'));
      fireEvent.change(await screen.findByPlaceholderText(/top of the quote/i), { target: { value: 'Started' } });
      await waitFor(() => expect(saveAndEmail()).toBeEnabled());

      fireEvent.click(saveAndEmail());

      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.anything()));
      expect(rpcNames()).not.toContain('save_quote');
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('is off, with the reason, when the customer has no email on file', async () => {
      serveSaveAndEmail({ ...QUOTE_FIXTURE_CUSTOMER, email: null });
      await loadedClean();
      fireEvent.change(screen.getByPlaceholderText(/top of the quote/i), { target: { value: 'Changed' } });

      expect(saveAndEmail()).toBeDisabled();
      expect(saveAndEmail()).toHaveAccessibleDescription('No email on file for this customer');
      expect(saveAndEmail()).toHaveAttribute('title', 'No email on file for this customer');
      // The separate Save still works.
      expect(screen.getAllByRole('button', { name: /Save draft/ })[0]).toBeEnabled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('emails a saved quote with nothing unsaved straight away, without saving it again', async () => {
      serveSaveAndEmail();
      await loadedClean();

      fireEvent.click(saveAndEmail());

      await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
      expect(rpcNames()).not.toContain('save_quote');
      expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.objectContaining({ p_expected_row_version: 7 }));
    });

    it('emails a new quote once its saved page has opened', { timeout: 20000 }, async () => {
      const fixture = makeQuoteFixture('draft', 7);
      let rowVersion = 7;
      mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? { ...fixture.quote, row_version: rowVersion }
        : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [fixture.item]
          : table === 'products' ? [fixture.product]
            : table === 'customers' ? [{ ...QUOTE_FIXTURE_CUSTOMER, default_commission_split: { splits: [] } }] : [], error: null }));
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_quote_version') rowVersion += 1;
        return Promise.resolve({ data: name === 'save_quote'
          ? { quote_id: fixture.quote.id, row_version: 7, item_ids: {} }
          : name === 'create_quote_version' ? { version_number: 1, status: 'created', row_version: rowVersion }
            : name === 'generate_quote_number' ? 'Q-new-owner' : null, error: null });
      });
      const router = createMemoryRouter([{ path: '/quotes/new', element: <QuoteBuilder /> },
        { path: '/quotes/:id', element: <QuoteBuilder /> }], { initialEntries: ['/quotes/new'] });
      mockNavigate.mockImplementation((path: string) => { void router.navigate(path); });
      const view = render(<RouterProvider router={router} />);
      try {
        fireEvent.change(await screen.findByRole('combobox', { name: 'Customer' }), { target: { value: 'Farm' } });
        fireEvent.click(await screen.findByRole('option', { name: /Farm/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Add one' }));
        fireEvent.click(screen.getByRole('button', { name: /Select product/i }));
        const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
        fireEvent.click(within(picker.closest('[role="dialog"]') as HTMLElement).getAllByText(fixture.product.product_name).slice(-1)[0]);
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantity' }), { target: { value: '2' } });

        fireEvent.click(saveAndEmail());

        await waitFor(() => expect(router.state.location.pathname).toBe(`/quotes/${fixture.quote.id}`));
        await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
        const names = rpcNames();
        expect(names.filter((n) => n === 'save_quote')).toHaveLength(1);
        expect(names.indexOf('save_quote')).toBeLessThan(names.indexOf('create_quote_version'));
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'grower@example.com', resource_id: fixture.quote.id }));
      } finally {
        view.unmount();
        mockNavigate.mockReset();
        router.dispose();
      }
    });
  });
});

// To-Do 10.5: a saved quote whose reads fail says so; it never shows an empty quote
// (whose Save would replace the real lines) or prices at a factor of 1.
describe('QuoteBuilder load failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quoteIdempotencyState.reset();
    quoteIdempotencyHandles.clear();
    sessionStorage.clear();
    dirtyStates.length = 0;
    authState.role = 'admin';
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  // Serves a saved quote; `fail` names a table whose read fails, and how.
  function serveQuote(
    fixture: ReturnType<typeof makeQuoteFixture>,
    fail: { table?: string; mode?: 'error' | 'nodata' } = {},
  ) {
    mockFrom.mockImplementation((table: string) => {
      if (table === fail.table) {
        return buildChain(fail.mode === 'nodata'
          ? { data: null, error: null }
          : { data: null, error: { message: 'connection reset' } });
      }
      const data = table === 'quotes'
        ? fixture.quote
        : table === 'quote_sections'
          ? [fixture.section]
          : table === 'quote_items'
            ? [fixture.item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [fixture.product]
                : [];
      return buildChain({ data, error: null });
    });
  }

  it.each([
    ['quotes', 'error'],
    ['quote_sections', 'nodata'],
    ['quote_items', 'nodata'],
  ] as const)('a first load whose %s read fails (%s) says the quote could not be loaded, with no Save, and Try again opens it', async (table, mode) => {
    const fixture = makeQuoteFixture('draft', 3);
    serveQuote(fixture, { table, mode });
    renderQuoteBuilder(fixture.quote.id);

    expect(await screen.findByText('This quote could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save draft/ })).not.toBeInTheDocument();

    serveQuote(fixture);
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: /Save draft/ })).toBeInTheDocument();
    expect(screen.queryByText('This quote could not be loaded')).not.toBeInTheDocument();
    expect(screen.getAllByText('Q-version-test').length).toBeGreaterThan(0);
  });

  it('a unit-conversion read that answers with no list counts as failed, so lines are not priced at a factor of 1', async () => {
    const fixture = makeQuoteFixture('draft', 3);
    serveQuote(fixture, { table: 'unit_conversions', mode: 'nodata' });
    renderQuoteBuilder(fixture.quote.id);

    await screen.findByRole('button', { name: /Save draft/ });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load unit conversions.'));
  });

  it('a failed booking settlement says so instead of hiding the booked / drawn / remaining card', async () => {
    const fixture = makeQuoteFixture('sent', 3);
    serveQuote(fixture);
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_booking_settlement'
      ? { data: null, error: { message: 'connection reset' } }
      : { data: null, error: null }));
    renderQuoteBuilder(fixture.quote.id);

    expect(await screen.findByText('The booking settlement could not be loaded')).toBeInTheDocument();

    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_booking_settlement'
      ? { data: { found: true, booked_cents: 12345, drawn_cents: 0, remaining_cents: 12345, prepay_remaining_cents: 0, prepay_earmarked_cents: 0, prepay_applied_cents: 0, lines: [] }, error: null }
      : { data: null, error: null }));
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    // "Booked" shows once, in the summary strip (the balance tab holds the per-product table).
    expect(await screen.findAllByText('Booked')).toHaveLength(1);
    expect(screen.queryByText('The booking settlement could not be loaded')).not.toBeInTheDocument();
  });
});

// USE-2 sheet 3.4: each line shows its product's label adjuvants; never blocks, never saved.
describe('QuoteBuilder label adjuvants', () => {
  const FOUR = [
    { kind: 'required', adjuvant_types: ['HS-MSO', 'MSO', 'COC'], preferred: 'HS-MSO' },
    { kind: 'required', adjuvant_types: ['AMS'], when: 'hard water', note: '8.5 lb per 100 gal' },
    { kind: 'recommended', adjuvant_types: ['Drift reduction'] },
    { kind: 'do_not_use', adjuvant_types: ['UAN', 'NIS'] },
  ];
  const row = (n: string, list: unknown) => ({ epa_registration: n, registration_status: 'active', cancelled_on: null, label_url: null, label_adjuvants: list, registration_version: 1 });

  beforeEach(() => {
    vi.clearAllMocks();
    quoteIdempotencyState.reset();
    quoteIdempotencyHandles.clear();
    sessionStorage.clear();
    dirtyStates.length = 0;
    authState.role = 'admin';
  });

  function serve(products: Array<Record<string, unknown>>, items: Array<Record<string, unknown>>, fixture: ReturnType<typeof makeQuoteFixture>) {
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? fixture.quote : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? items : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? products : [], error: null }));
  }

  it('shows every statement on a reopened quote, names the number, hides in customer view, and the quote still saves', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const product = { ...fixture.product, epa_registration: '100-1234' };
    serve([product], [{ ...fixture.item, product }], fixture);
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_epa_registrations'
      ? { data: [row('100-1234', FOUR)], error: null }
      : name === 'save_quote'
        ? { data: { status: 'saved', quote_id: fixture.quote.id, row_version: 8, item_ids: {} }, error: null }
        : { data: null, error: null }));

    renderQuoteBuilder(fixture.quote.id);
    const note = await screen.findByRole('note', { name: 'Label 100-1234 adjuvants' });
    expect(note).toHaveTextContent('Requires one of: HS-MSO (preferred), MSO, COC');
    expect(note).toHaveTextContent('When hard water: requires: AMS');
    expect(note).toHaveTextContent('8.5 lb per 100 gal');
    expect(note).toHaveTextContent('Recommended: Drift reduction');
    expect(note).toHaveTextContent('Do not use: UAN or NIS');
    expect(mockRpc).toHaveBeenCalledWith('get_epa_registrations', { p_numbers: ['100-1234'] });

    await makeAnEdit();
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    const sent = JSON.stringify(mockRpc.mock.calls.find(([name]) => name === 'save_quote')![1]);
    expect(sent).not.toContain('HS-MSO');

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Customer view/ }));
    await waitFor(() => expect(screen.queryByRole('note', { name: 'Label 100-1234 adjuvants' })).not.toBeInTheDocument());
  });

  it('never shows the first product\'s label after the line is switched before its read returns', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const alpha = { ...fixture.product, product_name: 'Alpha Chem', epa_registration: '100-1' };
    const beta = { ...fixture.product, id: 'product-2', product_name: 'Beta Chem', epa_registration: '200-2' };
    serve([alpha, beta], [{ ...fixture.item, product: alpha }], fixture);
    let releaseAlpha!: () => void;
    mockRpc.mockImplementation((name: string, args?: { p_numbers?: string[] }) => {
      if (name !== 'get_epa_registrations') return Promise.resolve({ data: null, error: null });
      if (args?.p_numbers?.[0] === '100-1') {
        return new Promise((resolve) => { releaseAlpha = () => resolve({ data: [row('100-1', [{ kind: 'required', adjuvant_types: ['COC'] }])], error: null }); });
      }
      return Promise.resolve({ data: [row('200-2', null)], error: null });
    });

    renderQuoteBuilder(fixture.quote.id);
    expect(await screen.findByText('Checking label…')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha Chem' }));
    const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
    fireEvent.click(within(picker.closest('[role="dialog"]') as HTMLElement).getByText('Beta Chem'));
    expect(await screen.findByText('Label 200-2: adjuvants not reviewed')).toBeInTheDocument();
    await act(async () => { releaseAlpha(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByText(/COC/)).not.toBeInTheDocument();
    expect(screen.queryByText(/100-1/)).not.toBeInTheDocument();
    expect(screen.getByText('Label 200-2: adjuvants not reviewed')).toBeInTheDocument();
  });

  it('says it could not check when the read fails, never "not reviewed"; a product with no number says nothing', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const alpha = { ...fixture.product, product_name: 'Alpha Chem', epa_registration: '100-1' };
    const plain = { ...fixture.product, id: 'product-2', product_name: 'Plain Chem', epa_registration: null };
    serve([alpha, plain], [{ ...fixture.item, product: alpha }, { ...fixture.item, id: 'item-2', sort_order: 1, product_id: plain.id, product: plain }], fixture);
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_epa_registrations'
      ? { data: null, error: { message: 'boom' } }
      : { data: null, error: null }));

    renderQuoteBuilder(fixture.quote.id);
    expect(await screen.findAllByText('Couldn\'t check the label')).toHaveLength(1);
    expect(screen.queryByText(/not reviewed/)).not.toBeInTheDocument();
  });
});

// Mason, 17 Nov: a quote's commission split starts from the customer's split (plan 2026-11-18). A split typed by
// hand, or one a saved quote already has, is never replaced without the user choosing to.
describe('QuoteBuilder commission split from the customer', () => {
  const SPLIT = { splits: [{ recipient: 'Test Rep One', percentage: 60 }, { recipient: 'Test Rep Two', percentage: 40 }] };
  const withSplit = { id: 'customer-1', farm_name: 'Big Sky Farms 18', assigned_tier: 1, is_active: true, default_commission_split: SPLIT };
  const noSplit = { id: 'customer-2', farm_name: 'Cedar Creek Farms 12', assigned_tier: 1, is_active: true, default_commission_split: null };
  const percent = (n: number) => (screen.getByRole('spinbutton', { name: `Commission percentage for split ${n}` }) as HTMLInputElement).value;
  const FROM = "From Big Sky Farms 18's split.";
  const NONE = 'Cedar Creek Farms 12 has no split. Pick one.';
  const pick = async (name: string) => {
    const clear = screen.queryByRole('button', { name: 'Clear customer' });
    if (clear) fireEvent.click(clear);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Customer' }), { target: { value: name.split(' ')[0] } });
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    quoteIdempotencyState.reset();
    quoteIdempotencyHandles.clear();
    sessionStorage.clear();
    dirtyStates.length = 0;
    authState.role = 'admin';
  });

  function serveNew(customers: unknown[] = [withSplit, noSplit]) {
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'customers' ? customers : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'generate_quote_number' ? { data: 'Q-2026-0100', error: null } : { data: null, error: null }));
  }

  it.each(['admin', 'sales_rep'])('a new quote takes the picked customer\'s split and says where it came from (%s)', async (role) => {
    authState.role = role;
    serveNew();
    renderQuoteBuilder();
    await pick('Big Sky Farms 18');
    await waitFor(() => expect(percent(1)).toBe('60'));
    expect(percent(2)).toBe('40');
    expect(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' })).toHaveAttribute('data-recipient', 'Test Rep One');
    expect(screen.getByText(FROM)).toBeInTheDocument();
  });

  it('a customer with no split resets it to the blank row, never keeping the previous customer\'s split', async () => {
    serveNew();
    renderQuoteBuilder();
    await pick('Big Sky Farms 18');
    await waitFor(() => expect(percent(2)).toBe('40'));
    await pick('Cedar Creek Farms 12');
    await waitFor(() => expect(screen.queryByRole('spinbutton', { name: 'Commission percentage for split 2' })).not.toBeInTheDocument());
    expect(percent(1)).toBe('100');
    expect(screen.getByText(NONE)).toBeInTheDocument();
    expect(screen.queryByText(FROM)).not.toBeInTheDocument();
  });

  it('a split changed by hand is never replaced by a customer, and nothing asks', async () => {
    serveNew();
    renderQuoteBuilder();
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Commission percentage for split 1' }), { target: { value: '90' } });
    await pick('Big Sky Farms 18');
    await screen.findByRole('button', { name: 'Clear customer' });
    expect(percent(1)).toBe('90');
    expect(screen.queryByRole('spinbutton', { name: 'Commission percentage for split 2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use it' })).not.toBeInTheDocument();
    expect(screen.queryByText(FROM)).not.toBeInTheDocument();
  });

  it('editing the customer\'s split by hand removes "From …", and the next customer leaves the edit alone', async () => {
    serveNew();
    renderQuoteBuilder();
    await pick('Big Sky Farms 18');
    await waitFor(() => expect(screen.getByText(FROM)).toBeInTheDocument());
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' }), { target: { value: '70' } });
    await waitFor(() => expect(screen.queryByText(FROM)).not.toBeInTheDocument());
    await pick('Cedar Creek Farms 12');
    await screen.findByRole('button', { name: 'Clear customer' });
    expect(percent(1)).toBe('70');
    expect(percent(2)).toBe('40');
    expect(screen.queryByText(NONE)).not.toBeInTheDocument();
  });

  // Taha's manual test, 18 Nov: Big Sky, then Cedar Creek, kept 60/40 with no note at all.
  it('a touch that leaves the customer\'s split as it was does not count as an edit: the next customer still resets it', async () => {
    serveNew();
    renderQuoteBuilder();
    await pick('Big Sky Farms 18');
    await waitFor(() => expect(percent(1)).toBe('60'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' }), { target: { value: '61' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' }), { target: { value: '60' } });
    await pick('Cedar Creek Farms 12');
    await waitFor(() => expect(screen.queryByRole('spinbutton', { name: 'Commission percentage for split 2' })).not.toBeInTheDocument());
    expect(percent(1)).toBe('100');
    expect(screen.getByText(NONE)).toBeInTheDocument();
  });

  it('clearing the customer also drops a split that only came from them (Sol MED)', async () => {
    serveNew();
    renderQuoteBuilder();
    await pick('Big Sky Farms 18');
    await waitFor(() => expect(percent(2)).toBe('40'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear customer' }));
    await waitFor(() => expect(screen.queryByRole('spinbutton', { name: 'Commission percentage for split 2' })).not.toBeInTheDocument());
    expect(percent(1)).toBe('100');
    expect(screen.queryByText(FROM)).not.toBeInTheDocument();
  });

  it('after the customer is cleared, a split typed to match their old one still counts as typed (Sol MED)', async () => {
    serveNew();
    renderQuoteBuilder();
    await pick('Big Sky Farms 18');
    await waitFor(() => expect(percent(1)).toBe('60'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' }), { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear customer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear customer' })).not.toBeInTheDocument());
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' }), { target: { value: '60' } });
    await pick('Cedar Creek Farms 12');
    await screen.findByRole('button', { name: 'Clear customer' });
    expect(percent(1)).toBe('60');
    expect(percent(2)).toBe('40');
    expect(screen.queryByText(NONE)).not.toBeInTheDocument();
  });

  it('switching straight to another customer with a typed split keeps it typed, even when typed back to the first customer\'s (Sol MED)', async () => {
    serveNew();
    renderQuoteBuilder();
    await pick('Big Sky Farms 18');
    await waitFor(() => expect(percent(1)).toBe('60'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' }), { target: { value: '70' } });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Customer' }), { target: { value: 'Cedar' } });
    fireEvent.click(await screen.findByRole('option', { name: /Cedar Creek Farms 12/ }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('Cedar Creek Farms 12'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' }), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear customer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear customer' })).not.toBeInTheDocument());
    expect(percent(1)).toBe('60');
    expect(percent(2)).toBe('40');
  });

  it('a customer with a stored split that can\'t be used says so, rather than "has no split" (Sol LOW)', async () => {
    const unusable = { ...noSplit, id: 'customer-5', farm_name: 'Fox Hill Farms 5', default_commission_split: { splits: [{ recipient: 'A', percentage: '60' }, { recipient: 'B', percentage: '40' }] } };
    serveNew([unusable]);
    renderQuoteBuilder();
    await pick('Fox Hill Farms 5');
    expect(await screen.findByText("Fox Hill Farms 5's saved split can't be used. Pick one.")).toBeInTheDocument();
    expect(percent(1)).toBe('100');
  });

  it('a customer whose stored split is damaged is picked cleanly: tier set, the split can\'t be used (Sol HIGH)', async () => {
    const damaged = { ...noSplit, id: 'customer-4', farm_name: 'Elm Row Farms 4', assigned_tier: 2, default_commission_split: { splits: [null] } };
    serveNew([damaged]);
    renderQuoteBuilder();
    await pick('Elm Row Farms 4');
    expect(await screen.findByText("Elm Row Farms 4's saved split can't be used. Pick one.")).toBeInTheDocument();
    expect(percent(1)).toBe('100');
    expect(screen.getByRole('button', { name: /Pricing tier/ })).toHaveTextContent('Tier 2');
  });

  it('a saved quote keeps its own split when its customer changes, and nothing asks', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, customer_id: 'customer-2', customer: noSplit, commission_split: { splits: [{ recipient: 'Test Admin', percentage: 100 }] } };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [fixture.item] : table === 'customers' ? [withSplit, noSplit] : table === 'products' ? [fixture.product] : [], error: null }));
    renderQuoteBuilder(quote.id);
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' })).toHaveAttribute('data-recipient', 'Test Admin'));
    await pick('Big Sky Farms 18');
    await screen.findByRole('button', { name: 'Clear customer' });
    expect(percent(1)).toBe('100');
    expect(screen.getByRole('spinbutton', { name: 'Commission percentage for split 1' })).toHaveAttribute('data-recipient', 'Test Admin');
    expect(screen.queryByRole('spinbutton', { name: 'Commission percentage for split 2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use it' })).not.toBeInTheDocument();
    expect(screen.queryByText(/'s split\.|has no split/)).not.toBeInTheDocument();
  });
});
