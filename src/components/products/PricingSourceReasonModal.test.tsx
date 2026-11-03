import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PricingSourceReasonModal from './PricingSourceReasonModal';
import { PRICING_SOURCE_CHOICES } from './pricingSource';

function show(onSubmit = vi.fn()) {
  render(<PricingSourceReasonModal open busy={false} productCount={1} onCancel={vi.fn()} onSubmit={onSubmit} />);
  return onSubmit;
}

describe('pricing source and reason', () => {
  it('offers the five settled choices and stores a choice with optional detail', () => {
    const onSubmit = show();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose a source', ...PRICING_SOURCE_CHOICES,
    ]);
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Vendor price list' } });
    fireEvent.change(screen.getByLabelText(/Source detail/), { target: { value: ' Helena, Oct 2026 ' } });
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: ' New vendor price ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(onSubmit).toHaveBeenCalledWith({ source: 'Vendor price list: Helena, Oct 2026', reason: 'New vendor price' });
  });

  it('requires detail for Other and stores just the detail', () => {
    const onSubmit = show();
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Other' } });
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Market correction' } });
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
    expect(screen.getByText('Add a detail for Other.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Source detail/)).toHaveAttribute(
      'aria-describedby', 'pricing-change-source-detail-hint',
    );
    fireEvent.change(screen.getByLabelText(/Source detail/), { target: { value: 'Local bid' } });
    expect(screen.queryByText('Add a detail for Other.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(onSubmit).toHaveBeenCalledWith({ source: 'Local bid', reason: 'Market correction' });
  });

  it('points a typed detail without a choice back to the source picker', () => {
    show();
    fireEvent.change(screen.getByLabelText(/Source detail/), { target: { value: 'Local bid' } });
    expect(screen.getByText('Choose a source.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Source detail/)).toHaveAttribute(
      'aria-describedby', 'pricing-change-source-detail-hint',
    );
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
  });

  it('validates the combined stored source length, including choice and separator', () => {
    show();
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Market adjustment' } });
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Cost change' } });
    fireEvent.change(screen.getByLabelText(/Source detail/), { target: { value: 'x'.repeat(182) } });
    expect(screen.getByText('Source and detail must be 200 characters or less.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Source detail/), { target: { value: 'x'.repeat(181) } });
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeEnabled();
  });
});
