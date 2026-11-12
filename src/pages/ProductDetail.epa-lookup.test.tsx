import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EpaLookupResult, Product } from '../types';

const H = vi.hoisted(() => ({
  product: {} as Product,
  invoke: vi.fn(),
  rpc: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  logActivity: vi.fn(),
  resetDraftKey: vi.fn(),
}));

function baseProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    product_name: 'Test Herbicide',
    sku: 'TEST-1',
    category: 'Herbicide',
    use_timings: [],
    vendor: 'Test Vendor',
    manufacturer: 'Current Manufacturer',
    container_size: 2.5,
    unit_size: 'gal',
    epa_registration: null,
    is_rup: false,
    signal_word: null,
    rei_hours: null,
    phi_days: null,
    product_form: 'liquid',
    inventory_unit: 'gal',
    container_unit: 'jug',
    container_type: 'Jug',
    current_cost: 50,
    cost_updated_date: null,
    tier1_price: 65,
    tier1_margin: null,
    tier1_gross_margin: null,
    tier2_price: 60,
    tier2_margin: null,
    tier2_gross_margin: null,
    tier3_price: 55,
    tier3_margin: null,
    tier3_gross_margin: null,
    tier1_price_per_acre: null,
    tier2_price_per_acre: null,
    tier3_price_per_acre: null,
    suggested_rate: null,
    rate_per_acre: null,
    rate_unit: null,
    max_label_rate: null,
    max_label_rate_unit: null,
    notes: null,
    internal_notes: null,
    quoting_notes: null,
    is_active: true,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
    pricing_version: overrides.pricing_version ?? 1,
  };
}

function lookupResult(overrides: Partial<EpaLookupResult> = {}): EpaLookupResult {
  return {
    found: true,
    regType: 'section3',
    eparegno: '264-849',
    productname: 'Test Herbicide',
    signalWordCanonical: 'Caution',
    needsManual: false,
    manufacturer: 'EPA Manufacturer',
    rupYn: 'No',
    productStatus: 'Active',
    isCancelled: false,
    activeIngredients: [{ name: 'Example active', percent: 42, pcCode: '12345', casNumber: null }],
    latestLabelPdfUrl: 'https://www3.epa.gov/pesticides/chem_search/ppls/example.pdf',
    labelPdfs: [{
      fileName: 'example.pdf',
      acceptedDate: '2026-06-01',
      url: 'https://www3.epa.gov/pesticides/chem_search/ppls/example.pdf',
    }],
    ...overrides,
  };
}

// The Vendors section has its own tests; these page tests do not mock its reads.
vi.mock('../components/products/ProductVendorsSection', () => ({ default: () => null }));
vi.mock('../components/products/ProductWeightCard', () => ({ default: () => null }));
vi.mock('../lib/db', async () => {
  const { hasRpcCode, RpcErrorCodes } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  function chainable(resolveWith: unknown) {
    const builder: Record<string, unknown> = {};
    let resolved = resolveWith;
    const self = () => builder;
    const methods = [
      'select', 'insert', 'update', 'upsert', 'delete',
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'or', 'not', 'match',
      'order', 'limit', 'range', 'single', 'csv', 'explain',
    ];
    for (const method of methods) builder[method] = vi.fn(self);
    builder.maybeSingle = vi.fn(() => {
      resolved = { data: H.product, error: null };
      return builder;
    });
    builder.then = vi.fn((resolve: (value: unknown) => void) => {
      Promise.resolve(resolved).then(resolve);
      return builder;
    });
    return builder;
  }

  const from = vi.fn((table: string) => table === 'products'
    ? chainable({ data: [H.product], error: null })
    : chainable({ data: [], error: null }));

  return {
    supabase: {
      from,
      functions: { invoke: H.invoke },
    },
    supabaseUntyped: { rpc: H.rpc },
    assertRpcResult: (data: unknown) => {
      if (data == null) throw new Error('RPC returned no data');
      return data;
    },
    checkMutationResult: vi.fn(),
    hasRpcCode,
    RpcErrorCodes,
    sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

// PAR-1: the page asks for the product's parent; these products have none (and the rpc spy stays EPA-only).
vi.mock('../lib/productParents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productParents')>()),
  getParentOfProduct: async () => null,
}));

// The brands section reads through its own RPC; keep it off H.rpc so these tests see only the EPA draft call.
vi.mock('../lib/productBrands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/productBrands')>()),
  getProductBrands: vi.fn(async () => ({ parentId: null, parentName: null, brands: [] })),
}));
// Same for the cancelled-registration read.
vi.mock('../lib/epaRegistrationStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/epaRegistrationStatus')>()),
  useCancelledRegistrations: () => ({ key: '', cancelled: new Map(), failed: false }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: H.toast }),
}));

// Admin cost comes from get_admin_cost_fields; the fixtures already carry it, so pass rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'admin-1', full_name: 'Admin User' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'product-1' }),
  useNavigate: () => H.navigate,
  useLocation: () => ({ pathname: '/products/product-1' }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', proceed: vi.fn(), reset: vi.fn() }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({
    getKey: () => 'epa-draft-key',
    getKeyFor: () => 'create-key',
    resetKeyFor: vi.fn(),
    resetKey: H.resetDraftKey,
  }),
}));

vi.mock('../lib/activityLogger', () => ({
  logActivity: H.logActivity,
}));

// Supplier evidence has its own focused tests. Keep this suite scoped to the
// EPA draft mutation so its assertions are not polluted by the history read.
vi.mock('../components/products/ProductPriceHistory', () => ({
  default: () => null,
}));

import ProductDetail from './ProductDetail';

async function runLookup(result: EpaLookupResult) {
  H.invoke.mockResolvedValueOnce({ data: result, error: null });
  const registrationInputs = await screen.findAllByLabelText('EPA Registration');
  await waitFor(() => expect(registrationInputs.length).toBeGreaterThan(0));
  fireEvent.change(registrationInputs[0], { target: { value: ' 264-849 ' } });

  const lookupButtons = await screen.findAllByRole('button', { name: /look up epa/i });
  fireEvent.click(lookupButtons[0]);
  await waitFor(() => expect(H.invoke).toHaveBeenCalledWith('epa-lookup', {
    body: { regNumber: '264-849' },
  }));
  const previewHeadings = await screen.findAllByText('EPA lookup preview');
  await waitFor(() => expect(previewHeadings.length).toBeGreaterThan(0));
}

async function applyDraft() {
  const applyButtons = await screen.findAllByRole('button', { name: /apply to product/i });
  fireEvent.click(applyButtons[0]);
  await waitFor(() => expect(H.rpc).toHaveBeenCalledWith(
    'create_label_draft',
    expect.any(Object),
  ));
}

describe('ProductDetail EPA lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.product = baseProduct();
    H.rpc.mockResolvedValue({ data: 'draft-1', error: null });
    H.logActivity.mockResolvedValue(undefined);
  });

  it('creates a supported-field draft and routes to Label Review', async () => {
    render(<ProductDetail />);
    await runLookup(lookupResult());
    await applyDraft();

    const params = H.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toMatchObject({
      p_product_id: 'product-1',
      p_signal_word: 'Caution',
      p_epa_registration: '264-849',
      p_confidence: 'high',
      p_status: 'pending',
      p_idempotency_key: 'epa-draft-key',
    });
    expect(params).not.toHaveProperty('p_rei_hours');
    expect(params).not.toHaveProperty('p_phi_days');
    expect(params).not.toHaveProperty('p_max_label_rate');
    await waitFor(() => expect(H.navigate).toHaveBeenCalledWith('/label-review'));
  });

  it('never proposes overwriting an existing signal word', async () => {
    H.product = baseProduct({ signal_word: 'Warning' });
    render(<ProductDetail />);
    await runLookup(lookupResult({ signalWordCanonical: 'Caution' }));

    const conflictMessages = await screen.findAllByText('Differs — review in Label Review');
    await waitFor(() => expect(conflictMessages.length).toBeGreaterThan(0));
    await applyDraft();

    const params = H.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.p_signal_word).toBeNull();
    expect(params.p_epa_registration).toBe('264-849');
    expect(params.p_source_note).toContain('Omitted per empty-fields-only policy');
  });

  it('flags an unknown signal word for manual review without passing a raw value', async () => {
    render(<ProductDetail />);
    const resultWithRawEvidence = {
      ...lookupResult({ signalWordCanonical: null, needsManual: true }),
      rawSignalWord: 'UNRECOGNIZED RAW VALUE',
    } as EpaLookupResult;
    await runLookup(resultWithRawEvidence);
    await applyDraft();

    const params = H.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.p_signal_word).toBeNull();
    expect(params.p_status).toBe('needs_manual');
    expect(params.p_confidence).toBe('medium');
    expect(JSON.stringify(params)).not.toContain('UNRECOGNIZED RAW VALUE');
  });

  it('shows a moved registration and offers nothing to apply', async () => {
    render(<ProductDetail />);
    H.invoke.mockResolvedValueOnce({
      data: lookupResult({ found: false, eparegno: '105211-77', productname: 'ROUNDUP ULTRA HERBICIDE', transferredTo: '105211-77' }),
      error: null,
    });
    const registrationInputs = await screen.findAllByLabelText('EPA Registration');
    fireEvent.change(registrationInputs[0], { target: { value: '264-849' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /look up epa/i }))[0]);

    expect(await screen.findByText(/EPA moved 264-849 to 105211-77 \(ROUNDUP ULTRA HERBICIDE\)/)).toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('warning', 'EPA moved registration 264-849 to 105211-77.');
    expect(screen.queryByRole('button', { name: /apply to product/i })).toBeNull();
    expect(H.rpc).not.toHaveBeenCalled();
  });

  it('blocks applying a lookup of a registration different from the product\'s saved one', async () => {
    // Product already has a saved registration; admin looks up a DIFFERENT number.
    // Empty-fields-only would keep the saved reg but still fill the signal word
    // from the unrelated lookup — wrong hazard word on a regulatory field. Block it.
    H.product = baseProduct({ epa_registration: '100-885', signal_word: null });
    render(<ProductDetail />);
    await runLookup(lookupResult({ eparegno: '264-849' }));

    const applyButtons = await screen.findAllByRole('button', { name: /apply to product/i });
    fireEvent.click(applyButtons[0]);

    await waitFor(() => expect(H.toast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('different registration number'),
    ));
    expect(H.rpc).not.toHaveBeenCalled();
    expect(H.navigate).not.toHaveBeenCalled();
  });
});
