import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Page = { data: unknown[] | null; error: { message: string } | null; count: number | null };

const mocks = vi.hoisted(() => ({
  // table name → the next answer for one page read of that table
  page: vi.fn<(table: string) => Promise<Page>>(),
  groupingOpen: vi.fn<() => Promise<boolean>>(),
  captureException: vi.fn(),
}));

function from(table: string) {
  const builder = {
    select: () => builder,
    order: () => builder,
    range: () => mocks.page(table),
  };
  return builder;
}

vi.mock('../../lib/db', () => ({ supabase: { from }, supabaseUntyped: { from } }));
vi.mock('../../lib/productParentProposals', () => ({ loadGroupingOpen: mocks.groupingOpen }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));

import NameBrandCheckSection from './NameBrandCheckSection';

const ok = (data: unknown[]): Page => ({ data, error: null, count: data.length });
const product = (id: string, product_name: string) => ({ id, product_name, is_active: true });

function answer(products: unknown[], brandsPage: Page = ok([])) {
  mocks.page.mockImplementation(async (table) => {
    if (table === 'products') return ok(products);
    if (table === 'product_brands') return brandsPage;
    return ok([]);
  });
}

function renderSection() {
  return render(<MemoryRouter><NameBrandCheckSection /></MemoryRouter>);
}

describe('NameBrandCheckSection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.groupingOpen.mockResolvedValue(false);
  });

  it('lists a product whose name has brands but no brand list, linked to its page', async () => {
    answer([product('p1', 'Gen Alpha: (Brandon, Zest) - 1 Gal'), product('p2', 'Plain - 1 Gal')]);
    renderSection();
    const link = await screen.findByRole('link', { name: 'Gen Alpha: (Brandon, Zest) - 1 Gal' });
    expect(link).toHaveAttribute('href', '/products/p1');
    expect(screen.getByText('Brandon')).toBeInTheDocument();
    expect(screen.getByText(/1 have no brands in the name or the list/)).toBeInTheDocument();
  });

  it('shows one error and no rows when any read fails', async () => {
    answer([product('p1', 'Gen Alpha: (Brandon) - 1 Gal')], { data: null, error: { message: 'boom' }, count: null });
    renderSection();
    expect(await screen.findByText(/This check could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Gen Alpha/ })).not.toBeInTheDocument();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('keeps Reload disabled while a load runs, and drops a load that ends after the page closed', async () => {
    let release: (value: boolean) => void = () => {};
    mocks.groupingOpen.mockReturnValueOnce(new Promise<boolean>((resolve) => { release = resolve; }));
    answer([product('p1', 'Slow: (Slowbrand)')]);
    const { unmount } = renderSection();
    await waitFor(() => expect(mocks.page).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /reload/i })).toBeDisabled();
    unmount();
    release(false);
    await Promise.resolve();
    expect(screen.queryByRole('link', { name: 'Slow: (Slowbrand)' })).not.toBeInTheDocument();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('Reload reads again and shows the new result', async () => {
    answer([product('p1', 'First: (Firstbrand)')]);
    renderSection();
    await screen.findByRole('link', { name: 'First: (Firstbrand)' });
    answer([product('p2', 'Second: (Secondbrand)')]);
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(await screen.findByRole('link', { name: 'Second: (Secondbrand)' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'First: (Firstbrand)' })).not.toBeInTheDocument();
  });
});
