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
    invoiceNumbers: ['CS-1001'],
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
    expect(screen.getByText('Print CS-1001')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<InvoicePrintDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Print CS-1001')).not.toBeInTheDocument();
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
    expect(screen.getByText('Show who pays')).toBeInTheDocument();
    expect(screen.getByText('Each payer, their share and amount')).toBeInTheDocument();
    expect(screen.queryByText('Show grower shares')).not.toBeInTheDocument();
  });

  it("a payer's misc charge invoice offers the payer table and prints it by default, like the chemical sale", () => {
    const onPrint = vi.fn();
    render(<InvoicePrintDialog {...defaultProps} invoiceType="misc_charge" hasShares sharesOnByDefault onPrint={onPrint} />);
    expect(screen.getByText('Show who pays')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('radio', { name: /old print/i }));
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

  it('names the layouts as two radio cards in one radio group, Current first and selected', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    expect(screen.getByRole('radiogroup', { name: 'Layout' })).toBeInTheDocument();
    const current = screen.getByRole('radio', { name: /current/i });
    expect(current).toBeChecked();
    expect(screen.getByText('The CRX invoice, same style as quotes')).toBeInTheDocument();
    expect(screen.getByText('Plain black and white, for growers who expect it')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /old print/i })).not.toBeChecked();
  });

  it('says a single print downloads a PDF', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    expect(screen.getByText('Downloads a PDF you can print or send.')).toBeInTheDocument();
    expect(screen.queryByText(/you will get/i)).not.toBeInTheDocument();
  });

  describe('batch', () => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => `CS-${i + 1}`);

    it('titles the dialog with the count and puts the count on the button', () => {
      render(<InvoicePrintDialog {...defaultProps} invoiceNumbers={batch(3)} />);
      expect(screen.getByText('Print 3 invoices')).toBeInTheDocument();
      expect(screen.getByText('Downloads one PDF for each invoice.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download 3 PDFs' })).toBeInTheDocument();
    });

    it('lists both file names for two invoices', () => {
      render(<InvoicePrintDialog {...defaultProps} invoiceNumbers={batch(2)} />);
      expect(screen.getByText('You will get 2 files: CS-1.pdf and CS-2.pdf.')).toBeInTheDocument();
    });

    it('lists the first two and counts the rest for more than two', () => {
      render(<InvoicePrintDialog {...defaultProps} invoiceNumbers={batch(5)} />);
      expect(screen.getByText('You will get 5 files: CS-1.pdf, CS-2.pdf and 3 more.')).toBeInTheDocument();
    });

    it('passes the same option values as a single print', () => {
      const onPrint = vi.fn();
      render(<InvoicePrintDialog {...defaultProps} invoiceNumbers={batch(3)} onPrint={onPrint} />);
      fireEvent.click(screen.getByRole('button', { name: 'Download 3 PDFs' }));
      expect(onPrint).toHaveBeenCalledWith({
        show_shares: true,
        show_price_per_acre: true,
        show_epa_registration: true,
        format: 'current',
      });
    });
  });
});
