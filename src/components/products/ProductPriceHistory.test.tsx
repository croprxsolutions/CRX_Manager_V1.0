import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetHistory, captureException } = vi.hoisted(() => ({ mockGetHistory: vi.fn(), captureException: vi.fn() }));

vi.mock('../../lib/sentry', () => ({ Sentry: { captureException } }));

vi.mock('../../lib/supplierPricing', async () => {
  const actual = await vi.importActual<typeof import('../../lib/supplierPricing')>(
    '../../lib/supplierPricing',
  );
  return { ...actual, getProductPriceHistory: mockGetHistory };
});

import ProductPriceHistory from './ProductPriceHistory';

describe('ProductPriceHistory', () => {
  it('shows all evidence streams, supplier unknown, and filters supplier-specific points', async () => {
    mockGetHistory.mockResolvedValue({
      product_id: 'product-1',
      summary: {
        product_id: 'product-1', supplier_quote_count: 2, comparable_quote_count: 1,
        replacement_cost_cents: 2_000n, replacement_cost_as_of: '2026-07-01',
        best_supplier: 'The Andersons', last_paid_cents: 2_200n,
        last_paid_as_of: '2026-07-04', recent_po_weighted_average_cents: 2_150n,
        recent_po_window: 'trailing_12_months', comparison_status: 'comparable', suppliers: [],
      },
      suppliers: [
        { id: 'vendor-1', name: 'The Andersons' },
        { id: 'vendor-2', name: 'Van Diest' },
      ],
      points: [
        {
          stream: 'supplier_observation', source_id: 'observation-1', vendor_id: 'vendor-1',
          supplier_name: 'The Andersons', cost_cents: 10_000n, normalized_cost_cents: 2_000n,
          occurred_at: '2026-07-01T12:00:00Z', detail: 'quote', provenance: {},
        },
        {
          stream: 'supplier_observation', source_id: 'observation-2', vendor_id: 'vendor-2',
          supplier_name: 'Van Diest', cost_cents: 9_000n, normalized_cost_cents: null,
          occurred_at: '2026-07-02T12:00:00Z', detail: 'quote', provenance: {},
        },
        {
          stream: 'selected_cost_basis', source_id: 'cost-1', vendor_id: null,
          supplier_name: null, cost_cents: 2_100n, normalized_cost_cents: 2_100n,
          occurred_at: '2026-07-03T12:00:00Z', detail: 'pricing_worksheet', provenance: {},
        },
        {
          stream: 'actual_purchase', source_id: 'po-1', vendor_id: null,
          supplier_name: 'supplier unknown', cost_cents: 2_200n, normalized_cost_cents: null,
          occurred_at: '2026-07-04T12:00:00Z', detail: 'actual_purchase', provenance: {},
        },
      ],
    });

    const selectSupplier = vi.fn();
    const selectPurchase = vi.fn();
    render(
      <ProductPriceHistory
        productId="product-1"
        costBasisWorkspace={{
          enabled: true,
          product: {
            id: 'product-1', product_name: 'Atrazine', sku: null, pricing_version: 1,
            current_cost_cents: 2_100n, tier1_margin_percent: '20',
            tier2_margin_percent: '15', tier3_margin_percent: '10',
          },
          current_basis: null,
          supplier_candidates: [{
            supplier_price_observation_id: 'observation-1', vendor_id: 'vendor-1',
            vendor_name: 'The Andersons', quoted_package_cost_cents: 10_000n,
            normalized_cost_cents: 2_000n, effective_from: '2026-07-01', price_kind: 'quote',
          }],
          purchase_candidates: [{
            purchase_order_item_id: 'po-1', purchase_order_id: 'purchase-1',
            po_number: 'PO-1', vendor_name: 'supplier unknown',
            normalized_cost_cents: 2_200n, purchased_at: '2026-07-04T12:00:00Z',
          }],
        }}
        onSelectSupplierBasis={selectSupplier}
        onSelectPurchaseBasis={selectPurchase}
      />,
    );

    await screen.findByText('supplier unknown');
    expect(screen.getAllByText('The Andersons')).toHaveLength(2);
    expect(screen.getAllByText('Van Diest')).toHaveLength(2);
    expect(screen.getByText('CRX selected basis')).toBeInTheDocument();
    expect(screen.getAllByText('Received PO cost').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Product supplier price history chart' })).toBeInTheDocument();
    const selectButtons = screen.getAllByRole('button', { name: 'Select as cost basis' });
    expect(selectButtons).toHaveLength(2);
    fireEvent.click(selectButtons[0]);
    fireEvent.click(selectButtons[1]);
    expect(selectSupplier).toHaveBeenCalledWith(expect.objectContaining({
      supplier_price_observation_id: 'observation-1',
    }));
    expect(selectPurchase).toHaveBeenCalledWith(expect.objectContaining({
      purchase_order_item_id: 'po-1',
    }));

    fireEvent.change(screen.getByLabelText('Filter supplier'), { target: { value: 'vendor-1' } });

    expect(screen.getAllByText('The Andersons')).toHaveLength(2);
    expect(screen.getAllByText('Van Diest')).toHaveLength(1);
    expect(screen.queryByText('supplier unknown')).not.toBeInTheDocument();
    expect(screen.getByText('CRX selected basis')).toBeInTheDocument();
  });

  it('places points on a real date axis, not evenly spaced (To-Do 0.4)', async () => {
    const point = (id: string, at: string, cents: bigint) => ({
      stream: 'selected_cost_basis' as const, source_id: id, vendor_id: null, supplier_name: null,
      cost_cents: cents, normalized_cost_cents: cents, occurred_at: at, detail: 'pricing_worksheet', provenance: {},
    });
    mockGetHistory.mockResolvedValue({
      product_id: 'product-2',
      summary: {
        product_id: 'product-2', supplier_quote_count: 0, comparable_quote_count: 0,
        replacement_cost_cents: null, replacement_cost_as_of: null, best_supplier: null,
        last_paid_cents: null, last_paid_as_of: null, recent_po_weighted_average_cents: null,
        recent_po_window: 'trailing_12_months', comparison_status: 'cannot_compare', suppliers: [],
      },
      suppliers: [],
      // Jul 1, Jul 2 and Jul 31: a day apart, then 29 days.
      points: [point('a', '2026-07-01T00:00:00Z', 1_000n), point('b', '2026-07-02T00:00:00Z', 1_100n), point('c', '2026-07-31T00:00:00Z', 1_200n)],
    });
    render(<ProductPriceHistory productId="product-2" />);
    const chart = await screen.findByRole('img', { name: 'Product supplier price history chart' });
    const xs = [...chart.querySelectorAll('circle')].map((c) => Number(c.getAttribute('cx')));
    expect(xs[0]).toBeCloseTo(5);
    expect(xs[1]).toBeCloseTo(5 + 90 / 30);
    expect(xs[2]).toBeCloseTo(95);
  });

  describe('failed and refreshed reads (Product Master Wave 2)', () => {
    const summary = {
      product_id: 'product-1', supplier_quote_count: 1, comparable_quote_count: 1,
      replacement_cost_cents: 2_000n, replacement_cost_as_of: '2026-07-01', best_supplier: 'The Andersons',
      last_paid_cents: null, last_paid_as_of: null, recent_po_weighted_average_cents: null,
      recent_po_window: 'trailing_12_months', comparison_status: 'comparable', suppliers: [],
    };
    const quote = (id: string, vendor: string, name: string) => ({
      stream: 'supplier_observation' as const, source_id: id, vendor_id: vendor, supplier_name: name,
      cost_cents: 2_000n, normalized_cost_cents: 2_000n, occurred_at: '2026-07-01T12:00:00Z', detail: 'quote', provenance: {},
    });
    const history = (suppliers: Array<[string, string]>, productId = 'product-1') => ({
      product_id: productId, summary,
      suppliers: suppliers.map(([id, name]) => ({ id, name })),
      points: suppliers.map(([id, name]) => quote(`obs-${id}`, id, name)),
    });
    const workspace = {
      enabled: true,
      product: {
        id: 'product-1', product_name: 'Atrazine', sku: null, pricing_version: 1, current_cost_cents: 2_000n,
        tier1_margin_percent: '20', tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: null,
      supplier_candidates: [{
        supplier_price_observation_id: 'obs-vendor-1', vendor_id: 'vendor-1', vendor_name: 'The Andersons',
        quoted_package_cost_cents: 2_000n, normalized_cost_cents: 2_000n, effective_from: '2026-07-01', price_kind: 'quote',
      }],
      purchase_candidates: [],
    };
    const card = (reloadToken: number) => (
      <ProductPriceHistory productId="product-1" costBasisWorkspace={workspace} reloadToken={reloadToken} onSelectSupplierBasis={vi.fn()} />
    );
    const selectButton = () => screen.getByRole('button', { name: 'Select as cost basis' });

    beforeEach(() => {
      mockGetHistory.mockReset();
      captureException.mockReset();
    });

    it('says a failed first read failed, never "no evidence", reports it, and Try again recovers', async () => {
      mockGetHistory.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(history([['vendor-1', 'The Andersons']]));
      render(card(0));
      expect(await screen.findByText('Supplier price history could not be loaded')).toBeInTheDocument();
      expect(screen.queryByText(/No supplier observations/)).not.toBeInTheDocument();
      expect(screen.queryByText('Replacement cost')).not.toBeInTheDocument();
      expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ extra: { context: 'product_price_history' } }));
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      expect(await screen.findByRole('button', { name: 'Select as cost basis' })).toBeEnabled();
    });

    it("treats another product's answer as a failed read", async () => {
      mockGetHistory.mockResolvedValueOnce(history([['vendor-1', 'The Andersons']], 'product-2'));
      render(card(0));
      expect(await screen.findByText('Supplier price history could not be loaded')).toBeInTheDocument();
      expect(screen.queryByText('The Andersons')).not.toBeInTheDocument();
    });

    it('turns Select as cost basis off from the moment a refresh starts, and while a failed refresh leaves it out of date', async () => {
      let failRefresh: (error: Error) => void = () => {};
      mockGetHistory
        .mockResolvedValueOnce(history([['vendor-1', 'The Andersons']]))
        .mockImplementationOnce(() => new Promise((_, reject) => { failRefresh = reject; }))
        .mockResolvedValueOnce(history([['vendor-1', 'The Andersons']]));
      const { rerender } = render(card(0));
      expect(await screen.findByRole('button', { name: 'Select as cost basis' })).toBeEnabled();

      rerender(card(1));
      // Off in the same render that brings the new token, before the new read answers.
      expect(selectButton()).toBeDisabled();
      expect(screen.getByRole('status')).toHaveTextContent('Refreshing supplier and purchase evidence');
      expect(screen.getByText('Replacement cost').closest('[aria-busy="true"]')).not.toBeNull();

      await act(async () => { failRefresh(new Error('network')); });
      expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh. This evidence may be out of date');
      expect(screen.getByText('Replacement cost')).toBeInTheDocument();
      expect(selectButton()).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      await vi.waitFor(() => expect(selectButton()).toBeEnabled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('keeps the supplier filter on a refresh while that supplier is still listed, and drops it when the supplier is gone', async () => {
      mockGetHistory
        .mockResolvedValueOnce(history([['vendor-1', 'The Andersons'], ['vendor-2', 'Van Diest']]))
        .mockResolvedValueOnce(history([['vendor-1', 'The Andersons'], ['vendor-2', 'Van Diest']]))
        .mockResolvedValueOnce(history([['vendor-1', 'The Andersons'], ['vendor-3', 'Helena']]));
      const { rerender } = render(card(0));
      await screen.findAllByText('Van Diest');
      fireEvent.change(screen.getByLabelText('Filter supplier'), { target: { value: 'vendor-2' } });
      expect(screen.getAllByText('The Andersons')).toHaveLength(1); // the option only

      rerender(card(1));
      await vi.waitFor(() => expect(mockGetHistory).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(screen.getByLabelText('Filter supplier')).toHaveValue('vendor-2');
      expect(screen.getAllByText('The Andersons')).toHaveLength(1);

      rerender(card(2));
      await vi.waitFor(() => expect(screen.getAllByText('Helena')).toHaveLength(2));
      expect(screen.getByLabelText('Filter supplier')).toHaveValue('');
      expect(screen.getAllByText('The Andersons')).toHaveLength(2);
    });
  });
});
