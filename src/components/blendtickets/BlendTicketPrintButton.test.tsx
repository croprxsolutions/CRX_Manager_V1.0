import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlendTicketPrintButton } from './BlendTicketPrintButton';
import type { BlendTicketWeights, TicketSnapshot } from '../../lib/blendTicketWeights';
import type { WeightUnitFactors } from '../../types';

const { fetchWeights, downloadPdf, toast } = vi.hoisted(() => ({
  fetchWeights: vi.fn(),
  downloadPdf: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../lib/blendTicketWeights', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/blendTicketWeights')>(),
  fetchBlendTicketWeights: fetchWeights,
}));
vi.mock('../../lib/reportPdf', () => ({ downloadReportPdf: downloadPdf }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));

const units: WeightUnitFactors = { factors: { gal: { kind: 'volume', factor: 1 } }, ambiguous: [] };
const header = { id: 'ticket', ticket_number: 'BT-TEST', ticket_date: '2026-11-24' };
const line = { id: 'line', product_id: 'product', product_name: 'Test product', quantity: 2, unit: 'Gal' };
const pageRead = { header, lines: [line] };
const snapshot: TicketSnapshot = {
  blend_ticket_id: header.id, product_id: line.product_id, captured_name: line.product_name,
  product_form: 'liquid', weight_kind: 'density', value_id: 'approval', value_reviewed_at: null,
  value_reviewed_by: null, lb_per_unit: 8, per_unit: 'Gal', unit_factors: units,
  source: 'sds', value_basis: null, none_reason: null, captured_how: 'at_save', captured_at: '2026-11-24',
};

function ticketWith(weight: TicketSnapshot): BlendTicketWeights {
  return {
    read_at: '2026-11-24', ticket: header, basis_unit_factors: units,
    current_unit_factors: { factors: { gal: { kind: 'volume', factor: 2 } }, ambiguous: [] }, retained: {},
    lines: [{ line_id: line.id, product_id: line.product_id, line, weight }],
  };
}

describe('BlendTicketPrintButton', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([['earlier', 8, '16.00 lb'], ['rechecked', 9, '18.00 lb']])(
    'prints the %s saved density using the ticket’s captured conversion',
    async (_case, density, expected) => {
      fetchWeights.mockResolvedValue(ticketWith({ ...snapshot, lb_per_unit: density }));
      render(<BlendTicketPrintButton ticketId={header.id} pageRead={pageRead} disabled={false} />);
      fireEvent.click(screen.getByRole('button', { name: 'Download ticket PDF' }));
      await waitFor(() => expect(downloadPdf).toHaveBeenCalledWith(expect.objectContaining({
        fileName: 'Blend Ticket BT-TEST',
        data: [{ product: 'Test product', amount: '2 Gal', weight: expect.stringContaining(expected) }],
        totalsRow: ['', '', `Total product weight: ${expected}`],
      })));
    },
  );

  it('prints the saved missing-weight reason and withholds the total', async () => {
    fetchWeights.mockResolvedValue(ticketWith({
      ...snapshot, weight_kind: 'none', none_reason: 'no_approved_weight', value_id: null, lb_per_unit: null,
    }));
    render(<BlendTicketPrintButton ticketId={header.id} pageRead={pageRead} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download ticket PDF' }));
    const reason = 'Test product had no approved weight when this ticket was saved';
    await waitFor(() => expect(downloadPdf).toHaveBeenCalledWith(expect.objectContaining({
      data: [{ product: 'Test product', amount: '2 Gal', weight: reason }],
      totalsRow: ['', '', `Total product weight not shown: ${reason}`],
    })));
  });

  it('prints the captured linked product name when OCR text differs', async () => {
    fetchWeights.mockResolvedValue({
      ...ticketWith({ ...snapshot, captured_name: 'Linked catalog product' }),
      ticket: { ...header, source: 'ocr', review_status: 'approved' },
    });
    render(<BlendTicketPrintButton ticketId={header.id} pageRead={pageRead} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download ticket PDF' }));
    await waitFor(() => expect(downloadPdf).toHaveBeenCalledWith(expect.objectContaining({
      data: [{ product: 'Linked catalog product\nTicket text: Test product', amount: '2 Gal', weight: expect.stringContaining('16.00 lb') }],
    })));
  });

  it('refuses to print an OCR match before the ticket is approved', async () => {
    const unreviewed = { ...header, source: 'ocr', review_status: 'unreviewed' };
    fetchWeights.mockResolvedValue({
      ...ticketWith({ ...snapshot, captured_name: 'Linked catalog product' }),
      ticket: unreviewed,
    });
    render(<BlendTicketPrintButton ticketId={header.id}
      pageRead={{ header: unreviewed, lines: [line] }} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download ticket PDF' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', expect.stringContaining('Approve this OCR ticket')));
    expect(downloadPdf).not.toHaveBeenCalled();
  });

  it('does not download an empty ticket or one whose saved date changed', async () => {
    fetchWeights.mockResolvedValueOnce({ ...ticketWith(snapshot), lines: [] });
    const view = render(<BlendTicketPrintButton ticketId={header.id} pageRead={{ header, lines: [] }} disabled={false} />);
    const button = screen.getByRole('button', { name: 'Download ticket PDF' });
    fireEvent.click(button);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', expect.stringContaining('no saved product lines')));
    expect(downloadPdf).not.toHaveBeenCalled();

    fetchWeights.mockResolvedValueOnce({ ...ticketWith(snapshot), ticket: { ...header, ticket_date: '2026-11-25' } });
    view.rerender(<BlendTicketPrintButton ticketId={header.id} pageRead={pageRead} disabled={false} />);
    fireEvent.click(button);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', expect.stringContaining('Reopen the ticket')));
    expect(downloadPdf).not.toHaveBeenCalled();
  });

  it('cannot print while edits are unsaved and refuses a changed server snapshot', async () => {
    fetchWeights.mockResolvedValue(ticketWith(snapshot));
    const view = render(<BlendTicketPrintButton ticketId={header.id} pageRead={pageRead} disabled />);
    const button = screen.getByRole('button', { name: 'Download ticket PDF' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchWeights).not.toHaveBeenCalled();

    view.rerender(<BlendTicketPrintButton ticketId={header.id}
      pageRead={{ header, lines: [{ ...line, quantity: 3 }] }} disabled={false} />);
    fireEvent.click(button);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', expect.stringContaining('Reopen the ticket')));
    expect(downloadPdf).not.toHaveBeenCalled();
  });
});
