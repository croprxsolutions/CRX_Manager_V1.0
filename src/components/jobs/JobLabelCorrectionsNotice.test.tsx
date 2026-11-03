import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), toast: vi.fn(), captureException: vi.fn() }));
vi.mock('../../lib/db', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

import JobLabelCorrectionsNotice from './JobLabelCorrectionsNotice';

const row = { product_id: 'product-1', product_name: 'Atrazine 4L', rei_hours: '12', phi_days: '30', quantity: '8' };

function returnLabels(rei_hours: number, error: { message: string } | null = null) {
  const query = { select: vi.fn(), in: vi.fn() };
  query.select.mockReturnValue(query);
  query.in.mockResolvedValue({
    data: error ? null : [{ id: 'product-1', rei_hours, phi_days: 30 }],
    error,
  });
  mocks.from.mockReturnValue(query);
  return query;
}

describe('JobLabelCorrectionsNotice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the old and new REI with an update button', async () => {
    const query = returnLabels(24);
    render(<JobLabelCorrectionsNotice rows={[row]} canEdit onApply={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: "Some lines differ from the product's current label" })).toBeInTheDocument();
    expect(screen.getByText('Atrazine 4L — REI: 12 hr → 24 hr')).toBeInTheDocument();
    expect(screen.getByText("Only this open job's lines change, and only after you save. Invoices and restricted-use sale records are never changed.")).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update to current label' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep job values' })).toBeInTheDocument();
    expect(mocks.from).toHaveBeenCalledWith('products');
    expect(query.select).toHaveBeenCalledWith('id, rei_hours, phi_days');
    expect(query.in).toHaveBeenCalledWith('id', ['product-1']);
  });

  it('updates only the form row and asks the user to save', async () => {
    returnLabels(24);
    const onApply = vi.fn();
    render(<JobLabelCorrectionsNotice rows={[row]} canEdit onApply={onApply} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update to current label' }));
    expect(onApply).toHaveBeenCalledWith([{ ...row, rei_hours: '24' }]);
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Label values updated — save the job to keep them.');
  });

  it('Keep job values hides the notice until the correction signature changes', async () => {
    returnLabels(24);
    const onApply = vi.fn();
    const view = render(<JobLabelCorrectionsNotice rows={[row]} canEdit onApply={onApply} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep job values' }));
    expect(screen.queryByRole('heading', { name: "Some lines differ from the product's current label" })).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    view.rerender(<JobLabelCorrectionsNotice rows={[{ ...row, rei_hours: '10' }]} canEdit onApply={onApply} />);
    expect(screen.getByText('Atrazine 4L — REI: 10 hr → 24 hr')).toBeInTheDocument();
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it('blank job value shows nothing', async () => {
    returnLabels(12);
    const view = render(<JobLabelCorrectionsNotice rows={[{ ...row, phi_days: ' ' }]} canEdit onApply={vi.fn()} />);
    await waitFor(() => expect(mocks.from).toHaveBeenCalledOnce());
    expect(view.container).toBeEmptyDOMElement();
  });

  it('shows Product when the job line has no product name', async () => {
    returnLabels(24);
    render(<JobLabelCorrectionsNotice rows={[{ ...row, product_name: '' }]} canEdit onApply={vi.fn()} />);
    expect(await screen.findByText('Product — REI: 12 hr → 24 hr')).toBeInTheDocument();
  });

  it('refetches when product IDs change, not when a line value changes', async () => {
    const query = returnLabels(24);
    const onApply = vi.fn();
    const view = render(<JobLabelCorrectionsNotice rows={[row]} canEdit onApply={onApply} />);
    await screen.findByRole('heading', { name: "Some lines differ from the product's current label" });

    view.rerender(<JobLabelCorrectionsNotice rows={[{ ...row, rei_hours: '10' }]} canEdit onApply={onApply} />);
    expect(mocks.from).toHaveBeenCalledTimes(1);

    view.rerender(<JobLabelCorrectionsNotice rows={[{ ...row, product_id: 'product-2' }]} canEdit onApply={onApply} />);
    await waitFor(() => expect(query.in).toHaveBeenCalledWith('id', ['product-2']));
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });

  it('does not query or render when the job cannot be edited', () => {
    const view = render(<JobLabelCorrectionsNotice rows={[row]} canEdit={false} onApply={vi.fn()} />);
    expect(view.container).toBeEmptyDOMElement();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('renders nothing when label values match', async () => {
    const query = returnLabels(12);
    const view = render(<JobLabelCorrectionsNotice rows={[row]} canEdit onApply={vi.fn()} />);
    await waitFor(() => expect(query.in).toHaveBeenCalledOnce());
    expect(view.container).toBeEmptyDOMElement();
  });

  it('shows a muted note and reports a lookup error', async () => {
    const error = { message: 'lookup failed' };
    returnLabels(24, error);
    render(<JobLabelCorrectionsNotice rows={[row]} canEdit onApply={vi.fn()} />);
    expect(await screen.findByText("Could not check this job's lines against the product label.")).toHaveClass('text-secondary');
    expect(mocks.captureException).toHaveBeenCalledWith(error, { extra: { context: 'job_label_corrections_lookup' } });
    expect(screen.queryByRole('heading', { name: "Some lines differ from the product's current label" })).not.toBeInTheDocument();
  });
});
