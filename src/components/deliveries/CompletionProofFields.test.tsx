import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CompletionProofFields, { ProofOption } from './CompletionProofFields';

vi.mock('../ui/SignatureCanvas', () => ({
  default: ({ label }: { label: string }) => <div data-testid="signature-box">{label}</div>,
}));

function setup(overrides: Partial<Parameters<typeof CompletionProofFields>[0]> = {}) {
  const props = {
    idPrefix: 't',
    signedBy: '',
    onSignedByChange: vi.fn(),
    usePaperTicket: false,
    onUsePaperTicketChange: vi.fn(),
    paperTicket: {
      hasPhoto: false, deliveredOn: '2026-11-24', onDeliveredOnChange: vi.fn(), onTakePhoto: vi.fn(),
      takePhotoDisabled: false, uploading: false,
    },
    onSignatureChange: vi.fn(),
    ...overrides,
  };
  render(<CompletionProofFields {...props} />);
  return props;
}

describe('CompletionProofFields', () => {
  it('asks who signed and shows the signature box by default', () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText('Signed by (name)'), { target: { value: 'Pat Farmer' } });
    expect(props.onSignedByChange).toHaveBeenCalledWith('Pat Farmer');
    expect(screen.getByTestId('signature-box')).toHaveTextContent('Customer signature');
    expect(screen.queryByLabelText(/Email delivery receipt/)).not.toBeInTheDocument();
  });

  it('switching to a paper ticket drops the drawn signature', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('Customer signed a paper ticket'));
    expect(props.onUsePaperTicketChange).toHaveBeenCalledWith(true);
    expect(props.onSignatureChange).toHaveBeenCalledWith(null);
  });

  it('shows the ticket photo and date in place of the signature for a paper ticket', () => {
    const props = setup({ usePaperTicket: true });
    expect(screen.queryByTestId('signature-box')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Delivered on (date on the ticket)'), { target: { value: '2026-11-20' } });
    expect(props.paperTicket.onDeliveredOnChange).toHaveBeenCalledWith('2026-11-20');
    fireEvent.click(screen.getByRole('button', { name: /Take Photo of Signed Ticket/ }));
    expect(props.paperTicket.onTakePhoto).toHaveBeenCalled();
  });

  it('offers the contact on file as a one-tap name, and not once it is filled in', () => {
    const props = setup({ contactName: 'J. Hollow' });
    fireEvent.click(screen.getByRole('button', { name: 'Use J. Hollow' }));
    expect(props.onSignedByChange).toHaveBeenCalledWith('J. Hollow');
  });

  it('uses another proof path from the screen in place of the signature, with the name locked', () => {
    const onExtra = vi.fn();
    setup({
      signerLocked: true,
      contactName: 'J. Hollow',
      showPaperTicketOption: false,
      extraOptions: <ProofOption checked onChange={onExtra}>No one present — left at site</ProofOption>,
      alternateProof: <p>Drop-location photo</p>,
    });
    expect(screen.getByLabelText('Signed by (name)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Use J. Hollow' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Customer signed a paper ticket')).not.toBeInTheDocument();
    expect(screen.queryByTestId('signature-box')).not.toBeInTheDocument();
    expect(screen.getByText('Drop-location photo')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('No one present — left at site'));
    expect(onExtra).toHaveBeenCalledWith(false);
  });

  it('shows the receipt box when the screen asks it here', () => {
    const onChange = vi.fn();
    setup({ receipt: { checked: true, onChange } });
    const box = screen.getByLabelText('Email delivery receipt to customer');
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('shows no issue picker unless the screen asks for one', () => {
    setup();
    expect(screen.queryByLabelText(/Report an issue/)).not.toBeInTheDocument();
  });

  it('reports an issue in the same step: notes appear once a type is chosen', () => {
    const issue = { type: 'none' as const, notes: '', onTypeChange: vi.fn(), onNotesChange: vi.fn() };
    setup({ issue });
    const picker = screen.getByLabelText(/Report an issue/);
    expect(picker).toHaveValue('none');
    expect(picker).toHaveClass('h-12');
    expect(screen.queryByLabelText('Describe the issue')).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'other' } });
    expect(issue.onTypeChange).toHaveBeenCalledWith('other');
  });

  it('passes the typed notes back unchanged', () => {
    const issue = { type: 'other' as const, notes: '', onTypeChange: vi.fn(), onNotesChange: vi.fn() };
    setup({ issue });
    fireEvent.change(screen.getByLabelText('Describe the issue'), { target: { value: 'cap broken' } });
    expect(issue.onNotesChange).toHaveBeenCalledWith('cap broken');
  });
});
