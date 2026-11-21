import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    title: 'Delete Item',
    message: 'Are you sure you want to delete this?',
  };

  it('renders nothing when open is false', () => {
    const { container } = render(
      <ConfirmModal {...defaultProps} open={false} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the title and message when open', () => {
    render(<ConfirmModal {...defaultProps} />);
    expect(screen.getByText('Delete Item')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete this?')).toBeInTheDocument();
  });

  it('renders Cancel and Confirm buttons', () => {
    render(<ConfirmModal {...defaultProps} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(document.querySelector('[data-modal-footer]')).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<ConfirmModal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when Confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('uses custom confirmLabel', () => {
    render(<ConfirmModal {...defaultProps} confirmLabel="Yes, Delete" />);
    expect(screen.getByText('Yes, Delete')).toBeInTheDocument();
  });

  it('uses a custom reachable secondary label without changing existing callers', () => {
    render(<ConfirmModal {...defaultProps} cancelLabel="Keep editing" />);
    expect(screen.getByText('Keep editing')).toBeInTheDocument();
    expect(screen.getByText('Keep editing').closest('button')?.className).toContain('min-h-12');
  });

  const icon = () => document.querySelector('[data-modal-icon]');
  const confirmButton = () => screen.getByRole('button', { name: 'Confirm' });

  it('applies danger variant styles by default, with a red main button', () => {
    render(<ConfirmModal {...defaultProps} />);
    expect(icon()).toHaveClass('bg-red-50', 'text-red-700');
    expect(confirmButton().className).toContain('bg-red-600');
  });

  it('applies warning variant styles with a red main button', () => {
    render(<ConfirmModal {...defaultProps} variant="warning" />);
    expect(icon()).toHaveClass('bg-amber-50', 'text-amber-700');
    expect(confirmButton().className).toContain('bg-red-600');
  });

  it('applies info variant styles', () => {
    render(<ConfirmModal {...defaultProps} variant="info" />);
    expect(icon()).toHaveClass('bg-crx-green-light', 'text-crx-green');
    expect(confirmButton().className).toContain('bg-crx-green');
  });

  it('is an alertdialog named by the title and described by the message', () => {
    render(<ConfirmModal {...defaultProps} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Item' });
    expect(dialog).toHaveAccessibleDescription('Are you sure you want to delete this?');
  });

  it('puts initial focus on the cancel button', async () => {
    render(<ConfirmModal {...defaultProps} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })));
  });

  it('keeps the safe button first in the DOM and the main button last', () => {
    render(<ConfirmModal {...defaultProps} />);
    const buttons = Array.from(document.querySelectorAll('[data-modal-footer] button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Cancel', 'Confirm']);
  });

  it('blocks every close path and spins the main button while loading', () => {
    const onClose = vi.fn();
    render(<ConfirmModal {...defaultProps} onClose={onClose} loading />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
    expect(confirmButton().querySelector('.animate-spin')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('[aria-hidden="true"]')!);
    expect(onClose).not.toHaveBeenCalled();
  });
});
