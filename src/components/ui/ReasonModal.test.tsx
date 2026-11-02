import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReasonModal from './ReasonModal';

const props = { onClose: () => undefined, title: 'Force hold', message: 'Blocked', confirmLabel: 'Force' };

function reasonBox() {
  return screen.getByLabelText(/reason/i);
}

describe('ReasonModal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('clears an abandoned reason when it opens again', () => {
    const view = render(<ReasonModal {...props} open onConfirm={vi.fn()} />);
    fireEvent.change(reasonBox(), { target: { value: 'abandoned reason' } });
    view.rerender(<ReasonModal {...props} open={false} onConfirm={vi.fn()} />);
    view.rerender(<ReasonModal {...props} open onConfirm={vi.fn()} />);
    expect(reasonBox()).toHaveValue('');
  });

  it('keeps a reason entered the instant the dialog appears', async () => {
    // Without act, React commits the dialog and runs effects later, as in a real
    // browser. A reset in an effect lands in that gap and wipes the reason.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    const onConfirm = vi.fn();
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    flushSync(() => root.render(<ReasonModal {...props} open={false} onConfirm={onConfirm} />));
    const appeared = new Promise<void>((resolve) => {
      new MutationObserver((_records, observer) => {
        if (!document.getElementById('reason-modal-textarea')) return;
        observer.disconnect();
        resolve();
      }).observe(document.body, { childList: true, subtree: true });
    });
    root.render(<ReasonModal {...props} open onConfirm={onConfirm} />);
    await appeared;

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fireEvent.change(reasonBox(), { target: { value: 'physical stock confirmed' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Force' }));
    expect(onConfirm).toHaveBeenCalledWith('physical stock confirmed');
    act(() => root.unmount());
  });
});
