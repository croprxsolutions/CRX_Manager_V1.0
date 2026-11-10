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
  default: ({ onSelect, ariaLabel, disabled }: { onSelect: (c: { id: string; farm_name: string }) => void; ariaLabel: string; disabled?: boolean }) => (
    <button aria-label={ariaLabel} disabled={disabled} onClick={() => onSelect({ id: 'c9', farm_name: 'Landlord' })}>pick</button>
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
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    expect(screen.getAllByText('Billed to Farmer')).toHaveLength(2);
  });

  it('keeps the list closed until someone asks for it or a line has its own shares', () => {
    const { rerender } = render(<LineBillSplit {...props} />);
    expect(screen.queryByText('Glyphosate')).not.toBeInTheDocument();
    rerender(<LineBillSplit {...props} canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Split by line' })).not.toBeInTheDocument();
    rerender(<LineBillSplit {...props} lineShares={[{ id: 's1', order_item_id: 'l1', customer_id: 'c1', split_percentage: 60, customer: { farm_name: 'Farmer' } }]} />);
    expect(screen.getByText('Glyphosate')).toBeInTheDocument();
  });

  it('rounds what is left on a line, so database decimals stay readable', () => {
    render(<LineBillSplit {...props} lineShares={[{ id: 's1', order_item_id: 'l1', customer_id: 'c1', split_percentage: 33.333333, customer: { farm_name: 'Farmer' } }, { id: 's2', order_item_id: 'l1', customer_id: 'c2', split_percentage: 0.1, customer: { farm_name: 'Other' } }]} />);
    expect(screen.getByText(/Other 66\.57% stays with Farmer/)).toBeInTheDocument();
  });

  it('refuses a share with more than two decimals before saving', () => {
    render(<LineBillSplit {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '33.333' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('two decimals'));
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('saves a line share', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{}], error: null });
    const insert = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ insert });
    render(<LineBillSplit {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(mocks.from).toHaveBeenCalledWith('order_item_shares');
    expect(insert).toHaveBeenCalledWith({ order_item_id: 'l1', customer_id: 'c9', split_percentage: 100 });
  });

  it('locks the picker and percent while a share saves, so the reply cannot clear newer edits', async () => {
    let finish: (v: { data: unknown[]; error: null }) => void = () => {};
    const select = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    mocks.from.mockReturnValue({ insert: vi.fn(() => ({ select })) });
    render(<LineBillSplit {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByLabelText('Line split percent')).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Line split customer' })).toBeDisabled();
    finish({ data: [{}], error: null });
    await waitFor(() => expect(screen.getByLabelText('Line split percent')).not.toBeDisabled());
  });

  it('refreshes the shares even when a save fails, since the insert may have committed', async () => {
    const select = vi.fn().mockResolvedValue({ data: null, error: new Error('network') });
    mocks.from.mockReturnValue({ insert: vi.fn(() => ({ select })) });
    render(<LineBillSplit {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  });

  it('stays locked until the refreshed shares arrive, so a second add checks the new list', async () => {
    let refreshed: () => void = () => {};
    const onChanged = vi.fn(() => new Promise<void>((resolve) => { refreshed = resolve; }));
    mocks.from.mockReturnValue({ insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [{}], error: null }) })) });
    render(<LineBillSplit {...props} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByLabelText('Line split percent')).toBeDisabled();
    refreshed();
    await waitFor(() => expect(screen.getByLabelText('Line split percent')).not.toBeDisabled());
  });

  it('stays locked when the order could not be reloaded after a save, so nothing is added against a stale list', async () => {
    const onChanged = vi.fn(() => Promise.resolve(false));
    mocks.from.mockReturnValue({ insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [{}], error: null }) })) });
    render(<LineBillSplit {...props} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByLabelText('Line split percent')).toBeDisabled();
  });

  it("can't switch lines while a share is saving, so the reply can't clear the other line's entry", async () => {
    let finish: (v: { data: unknown[]; error: null }) => void = () => {};
    mocks.from.mockReturnValue({ insert: vi.fn(() => ({ select: vi.fn(() => new Promise((resolve) => { finish = resolve; })) })) });
    render(<LineBillSplit {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change split for Adjuvant' })).toBeDisabled());
    finish({ data: [{}], error: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change split for Adjuvant' })).not.toBeDisabled());
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

  it('shows the database refusal when a save fails, and keeps what was typed', async () => {
    mocks.from.mockReturnValue({ insert: () => ({ select: () => Promise.resolve({ data: null, error: new Error('BILL_SPLIT_FROZEN') }) }) });
    render(<LineBillSplit {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split by line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change split for Glyphosate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line split customer' }));
    fireEvent.change(screen.getByLabelText('Line split percent'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('BILL_SPLIT_FROZEN')));
    expect(screen.getByLabelText('Line split percent')).toHaveValue(100);
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
