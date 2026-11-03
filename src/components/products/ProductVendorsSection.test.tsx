import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  listProductVendors: vi.fn(),
  linkProductVendor: vi.fn(),
  unlinkProductVendor: vi.fn(),
  logActivity: vi.fn(),
  allVendors: [] as { id: string; name: string }[],
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: mocks.logActivity }));
vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  const chain = { select: () => chain, is: () => chain, order: () => Promise.resolve({ data: mocks.allVendors, error: null }) };
  return { ...actual, supabase: { from: () => chain } };
});
vi.mock('../../lib/productVendors', async () => {
  const actual = await vi.importActual<typeof import('../../lib/productVendors')>('../../lib/productVendors');
  return {
    ...actual,
    listProductVendors: mocks.listProductVendors,
    linkProductVendor: mocks.linkProductVendor,
    unlinkProductVendor: mocks.unlinkProductVendor,
  };
});

import ProductVendorsSection from './ProductVendorsSection';

const link = (over: Record<string, unknown>) => ({
  link_id: 'l1', vendor_id: 'v1', vendor_name: 'Wells Ag Supply', is_preferred: true, item_details_known: true,
  supplier_sku: 'W-1', supplier_product_name: 'Wells One', supplier_uom: 'case', supplier_pack_description: '2x2.5 gal',
  last_cost_cents: 4250, last_quoted_package_cost_cents: 21250, last_cost_as_of: '2026-10-01', ...over,
});
const preferred = link({});
const spare = link({
  link_id: 'l2', vendor_id: 'v2', vendor_name: 'Spinner Ag', is_preferred: false, item_details_known: false,
  supplier_sku: null, supplier_product_name: null, supplier_uom: null, supplier_pack_description: null,
  last_cost_cents: null, last_quoted_package_cost_cents: null, last_cost_as_of: null,
});

function renderSection(isAdmin: boolean, onPreferredChanged = vi.fn()) {
  render(<ProductVendorsSection productId="p1" productName="Test Product" isAdmin={isAdmin} userId="u1"
    onPreferredChanged={onPreferredChanged} />);
  return onPreferredChanged;
}

describe('ProductVendorsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.allVendors = [{ id: 'v1', name: 'Wells Ag Supply' }, { id: 'v2', name: 'Spinner Ag' }, { id: 'v3', name: 'Crop RX Solutions' }];
    mocks.listProductVendors.mockResolvedValue([preferred, spare]);
    mocks.linkProductVendor.mockResolvedValue(undefined);
    mocks.unlinkProductVendor.mockResolvedValue(undefined);
  });

  it('shows vendors read-only to a non-admin, without cost', async () => {
    renderSection(false);
    expect(await screen.findByText('Wells Ag Supply')).toBeInTheDocument();
    expect(screen.getByText('Preferred')).toBeInTheDocument();
    expect(screen.getByText('Item details not yet known')).toBeInTheDocument();
    expect(screen.queryByText(/Last cost/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make preferred|Remove|Add vendor/ })).not.toBeInTheDocument();
  });

  it('shows an admin the last cost and refuses to remove the preferred vendor', async () => {
    renderSection(true);
    expect(await screen.findByText('Last cost $42.50 per unit (as of 2026-10-01)')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(within(rows[1]).getByRole('button', { name: 'Remove' })).toBeEnabled();
  });

  it('makes another vendor preferred and reports the new name', async () => {
    const onPreferredChanged = renderSection(true);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    mocks.listProductVendors.mockResolvedValue([{ ...spare, is_preferred: true }, { ...preferred, is_preferred: false }]);
    fireEvent.click(button);
    await waitFor(() => expect(onPreferredChanged).toHaveBeenCalledWith('Spinner Ag'));
    expect(mocks.linkProductVendor).toHaveBeenCalledWith('p1', 'v2', true, 'u1', expect.any(String));
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({ event: 'product_preferred_vendor_changed' }));
  });

  it('still reports the new preferred vendor when the re-read fails', async () => {
    const onPreferredChanged = renderSection(true);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    mocks.listProductVendors.mockRejectedValue(new Error('network'));
    fireEvent.click(button);
    await waitFor(() => expect(onPreferredChanged).toHaveBeenCalledWith('Spinner Ag'));
  });

  it('adds only a vendor that is not linked yet, as not preferred', async () => {
    const onPreferredChanged = renderSection(true);
    const picker = await screen.findByLabelText('Add a vendor');
    await waitFor(() => expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toContain('Crop RX Solutions'));
    expect(within(picker).queryByRole('option', { name: 'Spinner Ag' })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'v3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add vendor' }));
    await waitFor(() => expect(mocks.linkProductVendor).toHaveBeenCalledWith('p1', 'v3', false, 'u1', expect.any(String)));
    expect(onPreferredChanged).toHaveBeenCalledWith('Wells Ag Supply');
  });

  it('removes a non-preferred vendor after confirming', async () => {
    renderSection(true);
    const rows = await screen.findAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.unlinkProductVendor).toHaveBeenCalledWith('l2', 'u1', expect.any(String)));
  });

  it('explains a refused removal of the preferred vendor', async () => {
    mocks.unlinkProductVendor.mockRejectedValue({ message: 'PREFERRED_VENDOR_REQUIRED: choose another first' });
    renderSection(true);
    const rows = await screen.findAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error',
      'This is the preferred vendor. Make another vendor preferred first, then remove this one.'));
  });

  it('shows a load failure instead of an empty list', async () => {
    mocks.listProductVendors.mockRejectedValue(new Error('get_product_vendors returned an unexpected result'));
    renderSection(false);
    expect(await screen.findByText(/unexpected result|went wrong|try again/i)).toBeInTheDocument();
    expect(screen.queryByText('No vendors linked yet.')).not.toBeInTheDocument();
  });
});
