import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UnsavedChangesModal from './UnsavedChangesModal';

describe('UnsavedChangesModal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <UnsavedChangesModal open={false} onStay={() => {}} onLeave={() => {}} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders modal content when open', () => {
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Leave without saving?' });
    expect(dialog).toHaveAccessibleDescription('The changes you made on this page will be lost.');
  });

  it('renders through a hidden wrapper directly under document.body', () => {
    const { container } = render(
      <div className="hidden md:block">
        <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
      </div>
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('has role="alertdialog" and aria-modal="true"', () => {
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('shows Discard changes and Keep editing buttons, Discard changes then Keep editing in the DOM', () => {
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
    );
    const buttons = Array.from(document.querySelectorAll('[data-modal-footer] button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Discard changes', 'Keep editing']);
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('focuses Keep editing first', async () => {
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' })));
  });

  it('disables Leave while a save is in progress', () => {
    render(
      <UnsavedChangesModal open={true} disableLeave onStay={() => {}} onLeave={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();
  });

  it('is a bottom sheet on phone with the main action stacked on top', () => {
    window.innerWidth = 375;
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
    );

    const dialog = screen.getByRole('alertdialog');
    const panel = dialog.querySelector('[data-modal-panel]');
    const actionBar = screen.getByRole('button', { name: 'Keep editing' }).parentElement;

    expect(panel).toHaveClass('rounded-t-2xl', 'max-w-full', 'md:max-w-md');
    expect(actionBar).toHaveClass('flex-col-reverse', 'shrink-0', 'pb-[calc(1.25rem+env(safe-area-inset-bottom))]');
  });

  it('calls onLeave when Discard changes is clicked', () => {
    const onLeave = vi.fn();
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={onLeave} />
    );
    fireEvent.click(screen.getByText('Discard changes'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('calls onStay when Keep editing is clicked', () => {
    const onStay = vi.fn();
    render(
      <UnsavedChangesModal open={true} onStay={onStay} onLeave={() => {}} />
    );
    fireEvent.click(screen.getByText('Keep editing'));
    expect(onStay).toHaveBeenCalledTimes(1);
  });

  it('calls onStay when Escape key is pressed', () => {
    const onStay = vi.fn();
    render(
      <UnsavedChangesModal open={true} onStay={onStay} onLeave={() => {}} />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onStay).toHaveBeenCalledTimes(1);
  });

  it('calls onStay when backdrop is clicked', () => {
    const onStay = vi.fn();
    render(
      <UnsavedChangesModal open={true} onStay={onStay} onLeave={() => {}} />
    );
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onStay).toHaveBeenCalledTimes(1);
  });
});
