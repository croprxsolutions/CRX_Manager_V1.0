import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryPositionRow } from '../../types';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), captureException: vi.fn(), useAuth: vi.fn() }));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { ...actual.supabase, rpc: mocks.rpc } };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));

import ProductStockCard from './ProductStockCard';

function position(overrides: Partial<InventoryPositionRow> = {}): InventoryPositionRow {
  return {
    inventory_id: 'inventory-a',
    product_id: 'product-a',
    product_name: 'Product A',
    inventory_unit: 'GAL',
    container_size: 2.5,
    container_type: 'Jug',
    vendor: 'Vendor',
    current_cost: 1234.56,
    location: 'Main Warehouse',
    unit_size: '2.5 GL',
    quantity_available: 12.25,
    quantity_prebooked: 0,
    quantity_on_order: 0,
    holds_qty: 0,
    job_holds_qty: 0,
    planned_qty: 0,
    delivered_ytd: 0,
    net_position: 12.25,
    reorder_point: 25,
    min_stock_level: 0,
    is_low_stock: true,
    ...overrides,
  };
}

function renderCard(productId = 'product-a', isActive = true) {
  return render(
    <MemoryRouter>
      <ProductStockCard productId={productId} isActive={isActive} />
    </MemoryRouter>,
  );
}

describe('ProductStockCard', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.captureException.mockReset();
    mocks.useAuth.mockReturnValue({ role: 'admin', deniedPages: [] });
  });

  it('shows one location, reorder status, the returned time, and the Inventory link without cost', async () => {
    mocks.rpc.mockResolvedValue({ data: [position()], error: null });
    renderCard();

    expect(await screen.findByText('Main Warehouse')).toBeInTheDocument();
    expect(screen.getByText('12.25 GAL')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === 'Reorder point: 25')).toBeInTheDocument();
    expect(screen.getByText('Needs Reorder')).toBeInTheDocument();
    expect(screen.getByText(/^As of /)).toBeInTheDocument();
    expect(screen.queryByText(/1234\.56|1,234\.56/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Inventory' })).toHaveAttribute(
      'href',
      '/inventory?product=product-a',
    );
  });

  it('shows an exact total when the product has multiple locations', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        position({ inventory_id: 'inventory-a', location: 'North', quantity_available: 0.1 }),
        position({ inventory_id: 'inventory-b', location: 'South', quantity_available: 0.2 }),
      ],
      error: null,
    });
    renderCard();

    expect(await screen.findByText('North')).toBeInTheDocument();
    expect(screen.getByText('South')).toBeInTheDocument();
    expect(screen.getByText('Total on hand: 0.3 GAL')).toBeInTheDocument();
  });

  it('explains that stock is not shown when an inactive product has no rows', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    renderCard('product-a', false);

    expect(await screen.findByText(
      'Inventory does not list inactive products, so stock cannot be shown here.',
    )).toBeInTheDocument();
    expect(screen.queryByText('No stock recorded for this product.')).not.toBeInTheDocument();
  });

  it('shows no stock on hand and the on-order quantity for an on-order-only row', async () => {
    mocks.rpc.mockResolvedValue({
      data: [position({
        inventory_id: null,
        inventory_unit: null,
        location: null,
        quantity_available: 0,
        quantity_on_order: 14.5,
      })],
      error: null,
    });
    renderCard();

    expect(await screen.findByText('No location')).toBeInTheDocument();
    expect(screen.getByText('No stock on hand.')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === 'On order: 14.5 2.5 GL')).toBeInTheDocument();
    expect(screen.queryByText('No stock recorded for this product.')).not.toBeInTheDocument();
  });

  it('uses unit_size when inventory_unit is missing for rows and totals', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        position({ inventory_id: 'inventory-a', inventory_unit: null, unit_size: '2.5 GL', quantity_available: 0.1 }),
        position({ inventory_id: 'inventory-b', inventory_unit: null, unit_size: '2.5 GL', quantity_available: 0.2 }),
      ],
      error: null,
    });
    renderCard();

    expect(await screen.findByText((_, element) => element?.textContent === 'On hand: 0.1 2.5 GL')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === 'On hand: 0.2 2.5 GL')).toBeInTheDocument();
    expect(screen.getByText('Total on hand: 0.3 2.5 GL')).toBeInTheDocument();
  });

  it('does not total stock across different product sizes', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        position({ inventory_id: 'inventory-a', unit_size: '2.5 GL', quantity_available: 5 }),
        position({ inventory_id: 'inventory-b', unit_size: '30 GL', quantity_available: 7 }),
      ],
      error: null,
    });
    renderCard();

    expect(await screen.findByText((_, element) => element?.textContent === 'On hand: 5 GAL')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === 'On hand: 7 GAL')).toBeInTheDocument();
    expect(screen.queryByText(/Total on hand:/)).not.toBeInTheDocument();
  });

  it('keeps negative exact totals', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        position({ inventory_id: 'inventory-a', quantity_available: -0.3 }),
        position({ inventory_id: 'inventory-b', quantity_available: 0.2 }),
      ],
      error: null,
    });
    renderCard();

    expect(await screen.findByText('Total on hand: -0.1 GAL')).toBeInTheDocument();
  });

  it('sorts locations alphabetically and uses No location for an empty location', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        position({ inventory_id: 'inventory-z', location: 'Zulu' }),
        position({ inventory_id: 'inventory-a', location: 'Alpha' }),
        position({ inventory_id: 'inventory-empty', location: '  ' }),
      ],
      error: null,
    });
    renderCard();

    const locations = await screen.findAllByText(/^(No location|Alpha|Zulu)$/);
    expect(locations.map((element) => element.textContent)).toEqual(['No location', 'Alpha', 'Zulu']);
  });

  it('renders nothing and skips the stock read when this user is denied Inventory', () => {
    mocks.useAuth.mockReturnValue({ role: 'sales_rep', deniedPages: ['inventory'] });
    const { container } = renderCard();

    expect(container).toBeEmptyDOMElement();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('allows the stock card when deniedPages is missing', async () => {
    mocks.useAuth.mockReturnValue({ role: 'sales_rep' });
    mocks.rpc.mockResolvedValue({ data: [position()], error: null });
    renderCard();

    expect(await screen.findByText('Main Warehouse')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Inventory' })).toBeInTheDocument();
  });

  it('shows the shared failed state and successfully retries the read', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: new Error('network down') })
      .mockResolvedValueOnce({ data: [position({ quantity_available: 17.8 })], error: null });
    renderCard();

    expect(await screen.findByRole('alert')).toHaveTextContent('Stock could not be loaded');
    expect(screen.queryByText(/On hand:|Reorder point:|Total on hand:/)).not.toBeInTheDocument();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('17.8 GAL')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('keeps the on-order row while ignoring rows for other products', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        position({ inventory_id: 'inventory-b', product_id: 'product-b', location: 'Other Warehouse', quantity_available: 900 }),
        position({ inventory_id: null, location: 'Virtual row', quantity_available: 0, quantity_on_order: 8 }),
        position({ inventory_id: 'inventory-a', location: 'Kept Warehouse', quantity_available: 7 }),
      ],
      error: null,
    });
    renderCard();

    expect(await screen.findByText('Kept Warehouse')).toBeInTheDocument();
    expect(screen.getByText('Virtual row')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === 'On order: 8 GAL')).toBeInTheDocument();
    expect(screen.queryByText('Other Warehouse')).not.toBeInTheDocument();
    expect(screen.queryByText('900 GAL')).not.toBeInTheDocument();
  });

  it('does not install an older product response after the product changes', async () => {
    let resolveFirst!: (value: { data: unknown; error: unknown }) => void;
    let resolveSecond!: (value: { data: unknown; error: unknown }) => void;
    mocks.rpc
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const view = renderCard('product-a');

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    view.rerender(
      <MemoryRouter>
        <ProductStockCard productId="product-b" isActive />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    resolveSecond({ data: [position({ product_id: 'product-b', location: 'Current Product' })], error: null });
    expect(await screen.findByText('Current Product')).toBeInTheDocument();
    resolveFirst({ data: [position({ location: 'Old Product' })], error: null });

    await waitFor(() => expect(screen.queryByText('Old Product')).not.toBeInTheDocument());
    expect(screen.getByText('Current Product')).toBeInTheDocument();
  });

  it('shows Not set for a zero reorder point', async () => {
    mocks.rpc.mockResolvedValue({ data: [position({ reorder_point: 0 })], error: null });
    renderCard();

    expect(await screen.findByText((_, element) => element?.textContent === 'Reorder point: Not set')).toBeInTheDocument();
  });

  it.each([
    ['a missing list', { data: null, error: null }],
    ['a malformed list', { data: [{ product_id: 'product-a' }], error: null }],
  ])('shows a failure for %s', async (_description, reply) => {
    mocks.rpc.mockResolvedValue(reply);
    renderCard();

    expect(await screen.findByText('Stock could not be loaded')).toBeInTheDocument();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('0 GAL')).not.toBeInTheDocument());
  });
});
