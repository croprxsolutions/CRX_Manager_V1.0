/**
 * InvoicePrintDialog.test.tsx — Tests for invoice print options dialog
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InvoicePrintDialog from './InvoicePrintDialog';

describe('InvoicePrintDialog', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    invoiceType: 'field_application',
    hasShares: true,
    onPrint: vi.fn(),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when open=true', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    expect(screen.getByText('Print Invoice')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<InvoicePrintDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Print Invoice')).not.toBeInTheDocument();
  });

  it('shows EPA checkbox always', () => {
    render(<InvoicePrintDialog {...defaultProps} invoiceType="standard" hasShares={false} />);
    expect(screen.getByText('Show EPA registration numbers')).toBeInTheDocument();
  });

  it('shows grower shares checkbox when hasShares=true', () => {
    render(<InvoicePrintDialog {...defaultProps} hasShares={true} />);
    expect(screen.getByText('Show grower shares')).toBeInTheDocument();
  });

  it('prints a Bill Split invoice with its shares unless someone unticks them', () => {
    const onPrint = vi.fn();
    render(<InvoicePrintDialog {...defaultProps} invoiceType="chemical_sale" hasShares sharesOnByDefault onPrint={onPrint} />);
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(onPrint).toHaveBeenCalledWith(expect.objectContaining({ show_shares: true }));
  });

  it('calls a Bill Split table payer shares, since a landlord payer is not a grower', () => {
    render(<InvoicePrintDialog {...defaultProps} invoiceType="chemical_sale" hasShares sharesOnByDefault />);
    expect(screen.getByText('Show payer shares')).toBeInTheDocument();
    expect(screen.getByText('Display each payer, their share and amount')).toBeInTheDocument();
    expect(screen.queryByText('Show grower shares')).not.toBeInTheDocument();
  });

  it("a payer's misc charge invoice offers the payer table and prints it by default, like the chemical sale", () => {
    const onPrint = vi.fn();
    render(<InvoicePrintDialog {...defaultProps} invoiceType="misc_charge" hasShares sharesOnByDefault onPrint={onPrint} />);
    expect(screen.getByText('Show payer shares')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(onPrint).toHaveBeenCalledWith(expect.objectContaining({ show_shares: true }));
  });

  it('hides grower shares checkbox when hasShares=false', () => {
    render(<InvoicePrintDialog {...defaultProps} hasShares={false} />);
    expect(screen.queryByText('Show grower shares')).not.toBeInTheDocument();
  });

  it('shows price per acre checkbox for field_application type', () => {
    render(<InvoicePrintDialog {...defaultProps} invoiceType="field_application" />);
    expect(screen.getByText('Show price per acre')).toBeInTheDocument();
  });

  it('hides price per acre checkbox for non-field_application type', () => {
    render(<InvoicePrintDialog {...defaultProps} invoiceType="standard" />);
    expect(screen.queryByText('Show price per acre')).not.toBeInTheDocument();
  });

  it('calls onPrint with all options (current format by default) when Download PDF clicked', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(defaultProps.onPrint).toHaveBeenCalledWith({
      show_shares: true,
      show_price_per_acre: true,
      show_epa_registration: true,
      format: 'current',
    });
  });

  it('passes format: legacy when Old Print is selected (#30)', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /old print/i }));
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(defaultProps.onPrint).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'legacy' }),
    );
  });

  it('toggling checkboxes changes the options passed to onPrint', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    // Uncheck EPA checkbox
    const checkboxes = screen.getAllByRole('checkbox');
    const epaCheckbox = checkboxes[checkboxes.length - 1]; // Last one is EPA
    fireEvent.click(epaCheckbox);
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(defaultProps.onPrint).toHaveBeenCalledWith(
      expect.objectContaining({ show_epa_registration: false }),
    );
  });

  it('calls onClose when Cancel clicked', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables Download PDF button when loading', () => {
    render(<InvoicePrintDialog {...defaultProps} loading={true} />);
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeDisabled();
  });
});
