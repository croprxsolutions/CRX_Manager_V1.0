import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  listProductVendors: vi.fn(),
  linkProductVendor: vi.fn(),
  unlinkProductVendor: vi.fn(),
  logActivity: vi.fn(),
  allVendors: [] as { id: string; name: string }[],
  pickerFailures: 0,
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: mocks.logActivity }));
vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  // The picker reads page by page (fetchAllRows), so the mock answers each requested range.
  const chain = {
    select: () => chain, is: () => chain, order: () => chain,
    range: (from: number, to: number) => {
      if (mocks.pickerFailures > 0) {
        mocks.pickerFailures -= 1;
        return Promise.resolve({ data: null, error: { message: 'vendors down' }, count: null });
      }
      return Promise.resolve({ data: mocks.allVendors.slice(from, to + 1), error: null, count: mocks.allVendors.length });
    },
  };
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

const onPreferredUnknown = vi.fn();
function renderSection(isAdmin: boolean, onPreferredChanged = vi.fn()) {
  render(<ProductVendorsSection productId="p1" productName="Test Product" isAdmin={isAdmin} userId="u1"
    onPreferredChanged={onPreferredChanged} onPreferredUnknown={onPreferredUnknown} />);
  return onPreferredChanged;
}

describe('ProductVendorsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pickerFailures = 0;
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

  it('KI-170: a failed re-read guesses no preferred vendor until a re-read succeeds', async () => {
    const onPreferredChanged = renderSection(true);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    mocks.listProductVendors.mockRejectedValue(new Error('network'));
    fireEvent.click(button);
    await waitFor(() => expect(onPreferredUnknown).toHaveBeenCalledWith(true));
    expect(onPreferredChanged).not.toHaveBeenCalled();
    expect(screen.getByText(/Could not refresh the vendors/)).toBeInTheDocument();
    // Another admin made Wells preferred meanwhile: the re-read, not this click, decides what is mirrored.
    mocks.listProductVendors.mockResolvedValue([preferred, spare]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onPreferredUnknown).toHaveBeenLastCalledWith(false));
    expect(onPreferredChanged).toHaveBeenCalledTimes(1);
    expect(onPreferredChanged).toHaveBeenCalledWith('Wells Ag Supply');
  });

  it('KI-170: a failed re-read after the first vendor is linked guesses nothing either', async () => {
    mocks.listProductVendors.mockResolvedValue([]);
    const onPreferredChanged = renderSection(true);
    const picker = await screen.findByLabelText('Add a vendor');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Crop RX Solutions' })).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: 'v3' } });
    mocks.listProductVendors.mockRejectedValue(new Error('network'));
    fireEvent.click(screen.getByRole('button', { name: 'Add vendor' }));
    await waitFor(() => expect(onPreferredUnknown).toHaveBeenCalledWith(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onPreferredChanged).not.toHaveBeenCalled();
    expect(onPreferredUnknown).not.toHaveBeenCalledWith(false);
  });

  it('KI-170: an unknown preferred vendor is never settled from another product list', async () => {
    const onPreferredChanged = vi.fn();
    const props = { productName: 'Test Product', userId: 'u1', onPreferredChanged, onPreferredUnknown, isAdmin: true };
    const view = render(<ProductVendorsSection {...props} productId="p1" />);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    mocks.listProductVendors.mockRejectedValue(new Error('network'));
    fireEvent.click(button);
    await waitFor(() => expect(onPreferredUnknown).toHaveBeenCalledWith(true));
    mocks.listProductVendors.mockResolvedValue([spare, { ...preferred, link_id: 'p2l', vendor_name: 'Other Preferred' }]);
    view.rerender(<ProductVendorsSection {...props} productId="p2" />);
    await screen.findByText('Other Preferred');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onPreferredChanged).not.toHaveBeenCalled();
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
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.unlinkProductVendor).toHaveBeenCalledWith('l2', 'u1', expect.any(String)));
  });

  it('explains a refused removal of the preferred vendor', async () => {
    mocks.unlinkProductVendor.mockRejectedValue({ message: 'PREFERRED_VENDOR_REQUIRED: choose another first' });
    renderSection(true);
    const rows = await screen.findAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error',
      'This is the preferred vendor. Make another vendor preferred first, then remove this one.'));
  });

  it('shows a load failure instead of an empty list', async () => {
    mocks.listProductVendors.mockRejectedValue(new Error('get_product_vendors returned an unexpected result'));
    renderSection(false);
    expect(await screen.findByRole('alert')).toHaveTextContent(/unexpected result|went wrong/i);
    expect(screen.queryByText('No vendors linked yet.')).not.toBeInTheDocument();
    mocks.listProductVendors.mockResolvedValue([preferred]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Wells Ag Supply')).toBeInTheDocument();
  });

  it('marks the list out of date when the re-read after a change fails', async () => {
    renderSection(true);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    mocks.listProductVendors.mockRejectedValue(new Error('network'));
    fireEvent.click(button);
    expect(await screen.findByText('Could not refresh the vendors. This list may be out of date.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Make preferred' })).toBeDisabled();
    expect(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'Remove' })).toBeDisabled();
    mocks.listProductVendors.mockResolvedValue([preferred, spare]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument());
  });

  it('offers every vendor past the first 1,000', async () => {
    mocks.allVendors = Array.from({ length: 1001 }, (_, i) => ({ id: `x${i}`, name: `Vendor ${String(i).padStart(4, '0')}` }));
    renderSection(true);
    const picker = await screen.findByLabelText('Add a vendor');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Vendor 1000' })).toBeInTheDocument());
  });

  it('a failed vendor list keeps the linked vendors and only blocks adding', async () => {
    mocks.pickerFailures = 1;
    renderSection(true);
    expect(await screen.findByText('Could not load the vendor list.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Make preferred' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add vendor' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const picker = await screen.findByLabelText('Add a vendor');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Crop RX Solutions' })).toBeInTheDocument());
    expect(screen.queryByText('Could not load the vendor list.')).not.toBeInTheDocument();
  });

  it('drops a pick that is no longer offered', async () => {
    renderSection(true);
    const picker = await screen.findByLabelText('Add a vendor');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Crop RX Solutions' })).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: 'v3' } });
    expect(screen.getByRole('button', { name: 'Add vendor' })).toBeEnabled();
    // Another admin linked v3 meanwhile; removing a vendor re-reads the list (and, unlike adding, keeps the pick).
    const v3 = link({ link_id: 'l3', vendor_id: 'v3', vendor_name: 'Crop RX Solutions', is_preferred: false });
    mocks.listProductVendors.mockResolvedValue([preferred, v3]);
    fireEvent.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByText('Crop RX Solutions', { selector: 'span' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add vendor' })).toBeDisabled();
  });

  it('a change whose re-read is overtaken mirrors only the newer read, never the overtaken answer', async () => {
    const onPreferredChanged = vi.fn();
    const props = { productId: 'p1', productName: 'Test Product', userId: 'u1', onPreferredChanged, onPreferredUnknown };
    const view = render(<ProductVendorsSection {...props} isAdmin />);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    let release!: (rows: unknown) => void;
    mocks.listProductVendors.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.listProductVendors).toHaveBeenCalledTimes(2));
    view.rerender(<ProductVendorsSection {...props} isAdmin={false} />);
    await screen.findByText('Wells Ag Supply');
    await act(async () => { release([{ ...spare, is_preferred: true }]); });
    expect(onPreferredChanged).not.toHaveBeenCalledWith('Spinner Ag');
    // Save waited (unknown) until the newer read settled who is preferred.
    expect(onPreferredUnknown).toHaveBeenCalledWith(true);
    await waitFor(() => expect(onPreferredUnknown).toHaveBeenLastCalledWith(false));
    expect(onPreferredChanged).toHaveBeenCalledWith('Wells Ag Supply');
  });

  it('KI-170: a read begun before the change, answering late with the old vendor, never settles it', async () => {
    const onPreferredChanged = vi.fn();
    const props = { productId: 'p1', productName: 'Test Product', userId: 'u1', onPreferredChanged, onPreferredUnknown };
    const view = render(<ProductVendorsSection {...props} isAdmin />);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    let finishLink!: () => void;
    mocks.linkProductVendor.mockReturnValueOnce(new Promise<void>((resolve) => { finishLink = resolve; }));
    let answerOld!: (rows: unknown) => void;
    mocks.listProductVendors.mockReturnValueOnce(new Promise((resolve) => { answerOld = resolve; }));
    fireEvent.click(button);
    // A role change starts a list read while the change is still saving.
    view.rerender(<ProductVendorsSection {...props} isAdmin={false} />);
    await waitFor(() => expect(mocks.listProductVendors).toHaveBeenCalledTimes(2));
    mocks.listProductVendors.mockRejectedValueOnce(new Error('network'));
    await act(async () => { finishLink(); });
    await waitFor(() => expect(onPreferredUnknown).toHaveBeenCalledWith(true));
    await act(async () => { answerOld([preferred, spare]); });
    expect(onPreferredChanged).not.toHaveBeenCalled();
    expect(onPreferredUnknown).not.toHaveBeenCalledWith(false);
  });

  it('KI-170: a section shown again while the page still waits settles it from its own fresh read', async () => {
    const onPreferredChanged = vi.fn();
    render(<ProductVendorsSection productId="p1" productName="Test Product" isAdmin userId="u1"
      onPreferredChanged={onPreferredChanged} onPreferredUnknown={onPreferredUnknown} preferredUnknown />);
    await waitFor(() => expect(onPreferredUnknown).toHaveBeenLastCalledWith(false));
    expect(onPreferredChanged).toHaveBeenCalledWith('Wells Ag Supply');
  });

  it('closes an open removal when the user is no longer an admin', async () => {
    const props = { productId: 'p1', productName: 'Test Product', userId: 'u1', onPreferredChanged: vi.fn(), onPreferredUnknown };
    const view = render(<ProductVendorsSection {...props} isAdmin />);
    const rows = await screen.findAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    view.rerender(<ProductVendorsSection {...props} isAdmin={false} />);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
  it('closes an open removal when the screen moves to another product', async () => {
    const props = { productName: 'Test Product', userId: 'u1', onPreferredChanged: vi.fn(), onPreferredUnknown, isAdmin: true };
    const view = render(<ProductVendorsSection {...props} productId="p1" />);
    const rows = await screen.findAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    mocks.listProductVendors.mockResolvedValue([link({ link_id: 'other', vendor_id: 'v2', vendor_name: 'Spinner Ag', is_preferred: false })]);
    view.rerender(<ProductVendorsSection {...props} productId="p2" />);
    await screen.findByText('Spinner Ag');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a link that finishes after the screen moved to another product reports nothing', async () => {
    const onPreferredChanged = vi.fn();
    const props = { productName: 'Test Product', userId: 'u1', onPreferredChanged, onPreferredUnknown, isAdmin: true };
    const view = render(<ProductVendorsSection {...props} productId="p1" />);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    let finish!: () => void;
    mocks.linkProductVendor.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(button);
    mocks.listProductVendors.mockRejectedValue(new Error('network'));
    view.rerender(<ProductVendorsSection {...props} productId="p2" />);
    await act(async () => { finish(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onPreferredChanged).not.toHaveBeenCalled();
  });

  it('a pick does not carry over to another product', async () => {
    const props = { productName: 'Test Product', userId: 'u1', onPreferredChanged: vi.fn(), onPreferredUnknown, isAdmin: true };
    const view = render(<ProductVendorsSection {...props} productId="p1" />);
    const picker = await screen.findByLabelText('Add a vendor');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Crop RX Solutions' })).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: 'v3' } });
    expect(screen.getByRole('button', { name: 'Add vendor' })).toBeEnabled();
    view.rerender(<ProductVendorsSection {...props} productId="p2" />);
    await screen.findByText('Wells Ag Supply');
    expect(screen.getByRole('button', { name: 'Add vendor' })).toBeDisabled();
  });

  it('the vendor picker is locked while a change is saving', async () => {
    renderSection(true);
    const picker = await screen.findByLabelText('Add a vendor');
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Crop RX Solutions' })).toBeInTheDocument());
    mocks.linkProductVendor.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Make preferred' }));
    await waitFor(() => expect(screen.getByLabelText('Add a vendor')).toBeDisabled());
  });
  it('a save still running for another product does not lock this one', async () => {
    const props = { productName: 'Test Product', userId: 'u1', onPreferredChanged: vi.fn(), onPreferredUnknown, isAdmin: true };
    const view = render(<ProductVendorsSection {...props} productId="p1" />);
    const button = await screen.findByRole('button', { name: 'Make preferred' });
    mocks.linkProductVendor.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make preferred' })).toBeDisabled());
    view.rerender(<ProductVendorsSection {...props} productId="p2" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make preferred' })).toBeEnabled());
  });

  it('a removal closed by a product switch does not reopen on switching back', async () => {
    const props = { productName: 'Test Product', userId: 'u1', onPreferredChanged: vi.fn(), onPreferredUnknown, isAdmin: true };
    const view = render(<ProductVendorsSection {...props} productId="p1" />);
    const rows = await screen.findAllByRole('listitem');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    view.rerender(<ProductVendorsSection {...props} productId="p2" />);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    view.rerender(<ProductVendorsSection {...props} productId="p1" />);
    await screen.findAllByRole('listitem');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
