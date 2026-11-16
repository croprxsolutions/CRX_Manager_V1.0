import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Trash2 } from 'lucide-react';
import Modal from './Modal';
import Dropdown from './Dropdown';

describe('Modal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="Test">
        Content
      </Modal>
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders content when open is true', () => {
    render(
      <Modal open={true} onClose={() => {}} title="Test Modal">
        <p>Modal content here</p>
      </Modal>
    );
    expect(screen.getByText('Modal content here')).toBeInTheDocument();
  });

  it('uses a full-height mobile panel with a scrollable body and sticky footer', () => {
    window.innerWidth = 375;
    render(
      <Modal
        open={true}
        onClose={() => {}}
        title="Mobile Modal"
        footer={<button type="button">Save</button>}
      >
        <p>Scrollable content</p>
      </Modal>
    );

    const panel = document.querySelector('[data-modal-panel]');
    const body = document.querySelector('[data-modal-body]');
    const footer = document.querySelector('[data-modal-footer]');

    expect(panel).toHaveClass('h-[100dvh]', 'max-w-full', 'md:h-auto');
    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(footer).toHaveClass('sticky', 'shrink-0', 'pb-[calc(1rem+env(safe-area-inset-bottom))]');
  });

  it('renders the title', () => {
    render(
      <Modal open={true} onClose={() => {}} title="My Title">
        Content
      </Modal>
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('renders the accent text after the title', () => {
    render(
      <Modal open={true} onClose={() => {}} title="My" accent="Title">
        Content
      </Modal>
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">
        Content
      </Modal>
    );

    const closeButton = screen.getByLabelText('Close');
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">
        Content
      </Modal>
    );

    // The backdrop has aria-hidden="true"
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">
        Content
      </Modal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has role="dialog" and aria-modal="true"', () => {
    render(
      <Modal open={true} onClose={() => {}} title="Accessible">
        Content
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('sets body overflow to hidden when open', () => {
    render(
      <Modal open={true} onClose={() => {}} title="Test">
        Content
      </Modal>
    );
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores body overflow when closed', () => {
    const { rerender } = render(
      <Modal open={true} onClose={() => {}} title="Test">
        Content
      </Modal>
    );

    rerender(
      <Modal open={false} onClose={() => {}} title="Test">
        Content
      </Modal>
    );

    expect(document.body.style.overflow).toBe('');
  });

  it('close button uses the strong focus ring', () => {
    render(<Modal open onClose={() => {}} title="T">x</Modal>);
    const cls = screen.getByRole('button', { name: 'Close' }).className;
    expect(cls).toMatch(/focus-visible:ring-crx-green(\s|$)/);
    expect(cls).not.toContain('ring-crx-green/20');
  });

  it('focus trap ignores the hidden select a Dropdown renders', () => {
    render(
      <Modal open onClose={() => {}} title="T">
        <Dropdown aria-label="Pick" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const trigger = screen.getByRole('button', { name: /pick|A/ , hidden: false });
    const close = screen.getByRole('button', { name: 'Close' });
    const last = dialog.querySelector('[aria-haspopup]') as HTMLElement ?? trigger;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });
  it('returns focus to the element that opened it once it closes', async () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">Open dialog</button>
          <Modal open={open} onClose={() => {}} title="T"><input aria-label="Name" /></Modal>
        </>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    trigger.focus();
    rerender(<Harness open />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' })));
    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(trigger);
  });

  describe('alert layout', () => {
    const footer = (
      <>
        <button type="button">Keep quotes</button>
        <button type="button">Delete 3 quotes</button>
      </>
    );

    it('is an alertdialog labelled by its title and described by its message', () => {
      render(
        <Modal open onClose={() => {}} title="Delete 3 quotes?" size="alert" icon={Trash2} iconClassName="bg-red-50 text-red-700" footer={footer}>
          They are removed for everyone.
        </Modal>,
      );
      const dialog = screen.getByRole('alertdialog', { name: 'Delete 3 quotes?' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAccessibleDescription('They are removed for everyone.');
      expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
      expect(document.querySelector('[data-modal-icon]')).toHaveClass('bg-red-50', 'text-red-700');
    });

    it('is a bottom sheet on phone and a centred card from md up', () => {
      render(<Modal open onClose={() => {}} title="T" size="alert" footer={footer}>m</Modal>);
      expect(document.querySelector('[data-modal-panel]')).toHaveClass('rounded-t-2xl', 'w-full', 'md:max-w-md', 'md:rounded-2xl');
      expect(document.querySelector('[data-modal-footer]')).toHaveClass('flex-col-reverse', 'md:flex-row', 'md:justify-end', 'md:bg-cream');
    });

    it('puts initial focus on the first (safe) button', async () => {
      render(<Modal open onClose={() => {}} title="T" size="alert" footer={footer}>m</Modal>);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep quotes' })));
    });

    it('focuses a button marked data-autofocus first', async () => {
      render(
        <Modal open onClose={() => {}} title="T" size="alert" footer={<><button type="button">Discard</button><button type="button" data-autofocus>Keep editing</button></>}>m</Modal>,
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' })));
    });

    it('closes on Escape and backdrop click unless closeDisabled', () => {
      const onClose = vi.fn();
      const { rerender } = render(<Modal open onClose={onClose} title="T" size="alert" footer={footer}>m</Modal>);
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(document.querySelector('[aria-hidden="true"]')!);
      expect(onClose).toHaveBeenCalledTimes(2);
      rerender(<Modal open onClose={onClose} closeDisabled title="T" size="alert" footer={footer}>m</Modal>);
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(document.querySelector('[aria-hidden="true"]')!);
      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });
});
