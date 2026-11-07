import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProductSearchPicker from './ProductSearchPicker';
import { textFromIlikePattern } from '../../lib/productSearch';
import { ilikeOrPattern } from '../../lib/recordSearch';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  or: vi.fn(),
  limit: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
  searchProductParents: vi.fn(),
  eq: vi.fn(),
}));

vi.mock('../../lib/productParents', () => ({ searchProductParents: mocks.searchProductParents }));

vi.mock('../../lib/db', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

function product(n: number) {
  return { id: `p-${n}`, product_name: `Product ${n}`, sku: `SKU-${n}`, rate_unit: 'oz', rate_per_acre: 8 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockReset();
  const builder: Record<string, unknown> = {};
  mocks.searchProductParents.mockResolvedValue([]);
  for (const m of ['select', 'order']) builder[m] = vi.fn(() => builder);
  builder.eq = mocks.eq.mockImplementation(() => builder);
  builder.or = mocks.or.mockImplementation(() => builder);
  builder.limit = mocks.limit;
  mocks.from.mockReturnValue(builder);
});

function renderPicker(onSelect = vi.fn()) {
  render(<ProductSearchPicker value="" selectedLabel="" onSelect={onSelect} ariaLabel="Product" />);
  return { input: screen.getByRole('combobox', { name: 'Product' }), onSelect };
}

describe('ProductSearchPicker', () => {
  it.each(['2,4-D', '34%', 'a_b', 'say "hi"', 'back\\slash', '\\%', 'a\\_b\\\\'])('reads the typed text %s back from its search pattern', (text) => {
    expect(textFromIlikePattern(ilikeOrPattern(text))).toBe(text);
  });

  it("finds a parent's sizes by its nickname and still asks for active products only", async () => {
    mocks.searchProductParents.mockResolvedValue([{ name: 'Atrazine 4L', nickname: 'Atz', sizes: [
      { product_id: '00000000-0000-0000-0000-000000000001', is_active: true }, { product_id: '00000000-0000-0000-0000-000000000002', is_active: true }] }]);
    mocks.limit.mockResolvedValue({ data: [product(1)], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Atz' } });
    await waitFor(() => expect(mocks.or).toHaveBeenCalled());
    expect(mocks.searchProductParents).toHaveBeenCalledWith('Atz');
    expect(mocks.or).toHaveBeenCalledWith('product_name.ilike."%Atz%",sku.ilike."%Atz%",id.in.(00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002)');
    expect(mocks.eq).toHaveBeenCalledWith('is_active', true);
  });

  it('spends the id list on active sizes only, so an active size past 200 inactive ones is still searched', async () => {
    const sizes = Array.from({ length: 250 }, (_, i) => ({ product_id: `inactive-${i}`, is_active: false }));
    sizes.push({ product_id: 'active-size', is_active: true });
    mocks.searchProductParents.mockResolvedValue([{ name: 'Big Parent', nickname: null, sizes }]);
    mocks.limit.mockResolvedValue({ data: [product(1)], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Big' } });
    await waitFor(() => expect(mocks.or).toHaveBeenCalled());
    expect(mocks.or).toHaveBeenCalledWith('product_name.ilike."%Big%",sku.ilike."%Big%",id.in.(active-size)');
    expect(screen.queryByText(/Too many matches/)).not.toBeInTheDocument();
  });

  it('asks for more text when more active sizes match than the id list can carry', async () => {
    const sizes = Array.from({ length: 201 }, (_, i) => ({ product_id: `size-${i}`, is_active: true }));
    mocks.searchProductParents.mockResolvedValue([{ name: 'Huge Parent', nickname: null, sizes }]);
    mocks.limit.mockResolvedValue({ data: [product(1)], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Huge' } });
    expect(await screen.findByText('Too many matches to list them all. Keep typing to narrow the list.')).toBeInTheDocument();
    expect(mocks.or.mock.calls[0][0].split(',').length).toBe(2 + 200);
  });

  it('asks for more text when the parent search hits its 50-parent cap, even with no rows', async () => {
    mocks.searchProductParents.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ name: `P${i}`, nickname: null, sizes: [] })));
    mocks.limit.mockResolvedValue({ data: [], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'P' } });
    expect(await screen.findByText('Too many matches to list them all. Keep typing to narrow the list.')).toBeInTheDocument();
    expect(screen.queryByText('No matching active products')).not.toBeInTheDocument();
  });

  it('still searches names and SKUs when the parent search fails', async () => {
    mocks.searchProductParents.mockRejectedValue(new Error('down'));
    mocks.limit.mockResolvedValue({ data: [product(3)], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Prod' } });
    expect(await screen.findByRole('option', { name: /Product 3/ })).toBeInTheDocument();
    expect(mocks.or).toHaveBeenCalledWith('product_name.ilike."%Prod%",sku.ilike."%Prod%"');
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('searches active products in the database and returns the picked product', async () => {
    mocks.limit.mockResolvedValue({ data: [product(596)], error: null });
    const { input, onSelect } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Product 596' } });
    fireEvent.click(await screen.findByRole('option', { name: /Product 596/ }));
    expect(mocks.from).toHaveBeenCalledWith('products');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-596', rate_per_acre: 8 }));
  });

  it('quotes a name with a comma so it stays one search term', async () => {
    mocks.limit.mockResolvedValue({ data: [], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2,4-D' } });
    await waitFor(() => expect(mocks.or).toHaveBeenCalled());
    expect(mocks.or).toHaveBeenCalledWith('product_name.ilike."%2,4-D%",sku.ilike."%2,4-D%"');
    expect(await screen.findByText('No matching active products')).toBeInTheDocument();
  });

  it('treats a typed % as a literal character, not a wildcard', async () => {
    mocks.limit.mockResolvedValue({ data: [], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '34%' } });
    await waitFor(() => expect(mocks.or).toHaveBeenCalled());
    expect(mocks.or).toHaveBeenCalledWith('product_name.ilike."%34\\\\%%",sku.ilike."%34\\\\%%"');
  });

  it('keeps showing results when only a trailing space is typed', async () => {
    mocks.limit.mockResolvedValue({ data: [product(7)], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Zoom' } });
    expect(await screen.findByRole('option', { name: /Product 7/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Zoom ' } });
    expect(screen.getByRole('option', { name: /Product 7/ })).toBeInTheDocument();
    expect(screen.queryByText('Searching...')).not.toBeInTheDocument();
  });

  it('shows a failed search as an error, not as no matches', async () => {
    mocks.limit.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Atrazine' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Product search failed');
    expect(screen.queryByText('No matching active products')).not.toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith('error', 'Failed to search Products');
  });

  it('drops the previous search results as soon as the text changes', async () => {
    mocks.limit.mockResolvedValueOnce({ data: [product(1)], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Atrazine' } });
    expect(await screen.findByRole('option', { name: /Product 1/ })).toBeInTheDocument();
    mocks.limit.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.change(input, { target: { value: 'Zoom' } });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('Searching...')).toBeInTheDocument();
  });

  it('says when results stop at the limit instead of hiding the rest', async () => {
    mocks.limit.mockResolvedValue({ data: Array.from({ length: 20 }, (_, i) => product(i)), error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Product' } });
    expect(await screen.findByText(/Showing the first 20 matches/)).toBeInTheDocument();
  });
});
