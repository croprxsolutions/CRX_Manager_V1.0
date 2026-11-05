import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LineBillSplit from './LineBillSplit';

const mocks = vi.hoisted(() => ({ from: vi.fn(), toast: vi.fn(), captureException: vi.fn() }));
vi.mock('../../lib/db', () => ({
  supabase: { from: mocks.from },
  checkMutationResult: (r: { error: unknown }) => { if (r.error) throw r.error; },
  sanitizeError: (e: unknown) => String((e as Error).message),
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../customers/CustomerSearchPicker', () => ({
  default: ({ onSelect, ariaLabel }: { onSelect: (c: { id: string; farm_name: string }) => void; ariaLabel: string }) => (
    <button aria-label={ariaLabel} onClick={() => onSelect({ id: 'c9', farm_name: 'Landlord' })}>pick</button>
  ),
}));

const items = [
  { id: 'l1', product_name: 'Glyphosate' },
  { id: 'l2', product_name: 'Adjuvant' },
];
const props = { items, lineShares: [], hasCard: true, mainCustomerName: 'Farmer', canEdit: true, locked: false, onChanged: vi.fn() };

beforeEach(() => vi.clearAllMocks());

describe('LineBillSplit', () => {
  it('says a line follows the card until it has its own shares', () => {
    render(<LineBillSplit {...props} lineShares={[{ id: 's1', order_item_id: 'l2', customer_id: 'c1', split_percentage: 60, customer: { farm_name: 'Farmer' } }]} />);
    expect(screen.getByText('Follows the Bill Split')).toBeInTheDocument();
    expect(screen.getByText(/Farmer 60%/)).toBeInTheDocument();
    expect(screen.getByText(/Other 40% stays with Farmer/)).toBeInTheDocument();
  });

  it('with no card, a line with no shares bills the main customer', () => {
    render(<LineBillSplit {...props} hasCard={false} />);
    expect(screen.getAllByText('Billed to Farmer')).toHaveLength(2);
  });

  it('saves a line share', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{}], error: null });
    const insert = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ insert });
    render(<LineBillSplit {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(mocks.from).toHaveBeenCalledWith('order_item_shares');
    expect(insert).toHaveBeenCalledWith({ order_item_id: 'l1', customer_id: 'c9', split_percentage: 100 });
  });

  it('refuses a line total over 100% before saving', () => {
    render(<LineBillSplit {...props} lineShares={[{ id: 's1', order_item_id: 'l1', customer_id: 'c1', split_percentage: 60, customer: { farm_name: 'Farmer' } }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('more than 100%'));
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('shows the database refusal when a save fails, and stays unchanged', async () => {
    mocks.from.mockReturnValue({ insert: () => ({ select: () => Promise.resolve({ data: null, error: new Error('BILL_SPLIT_FROZEN') }) }) });
    render(<LineBillSplit {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('BILL_SPLIT_FROZEN')));
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('removes a line share', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{}], error: null });
    const eq = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ delete: () => ({ eq }) });
    render(<LineBillSplit {...props} lineShares={[{ id: 's1', order_item_id: 'l1', customer_id: 'c1', split_percentage: 60, customer: { farm_name: 'Farmer' } }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Farmer' }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(eq).toHaveBeenCalledWith('id', 's1');
  });

  it('offers no change while the split is locked, or to someone who cannot edit', () => {
    const { rerender } = render(<LineBillSplit {...props} locked />);
    expect(screen.queryByRole('button', { name: 'Change split for Glyphosate' })).not.toBeInTheDocument();
    rerender(<LineBillSplit {...props} canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Change split for Glyphosate' })).not.toBeInTheDocument();
  });
});
