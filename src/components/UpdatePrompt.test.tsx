import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { updateServiceWorker, registerOptions } = vi.hoisted(() => ({
  updateServiceWorker: vi.fn(),
  registerOptions: { current: undefined as undefined | { onRegistered?: (r: ServiceWorkerRegistration | undefined) => void } },
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: typeof registerOptions.current) => {
    registerOptions.current = options;
    return {
      needRefresh: [true],
      updateServiceWorker,
    };
  },
}));

import UpdatePrompt from './UpdatePrompt';

describe('UpdatePrompt', () => {
  beforeEach(() => {
    sessionStorage.clear();
    updateServiceWorker.mockClear();
  });

  it('shows a prominent update action above the mobile bottom navigation', async () => {
    window.innerWidth = 375;
    render(<UpdatePrompt />);

    expect(await screen.findByText('A new version of CRX is ready')).toBeInTheDocument();
    const updateButton = await screen.findByRole('button', { name: 'Reload' });
    const prompt = screen.getByTestId('update-prompt');

    expect(updateButton).toHaveClass('min-h-11', 'bg-crx-green');
    expect(prompt).toHaveClass(
      'bottom-[calc(4.5rem+env(safe-area-inset-bottom)+0.75rem)]',
      'md:bottom-4'
    );

    fireEvent.click(updateButton);
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('Later hides it, and it stays hidden after a remount in the same session', async () => {
    const first = render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByTestId('update-prompt')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('crx-update-later')).not.toBeNull();
    expect(updateServiceWorker).not.toHaveBeenCalled();

    first.unmount();
    render(<UpdatePrompt />);
    expect(screen.queryByTestId('update-prompt')).not.toBeInTheDocument();
  });

  it('still shows and still hides on Later when session storage throws', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      render(<UpdatePrompt />);
      fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
      expect(screen.queryByTestId('update-prompt')).not.toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  // Sentry CRX-MANAGER-1G: a rejected hourly update check surfaced as an unhandled rejection.
  it('handles a failed hourly update check instead of leaving an unhandled rejection', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    try {
      render(<UpdatePrompt />);
      const update = vi.fn().mockRejectedValue(new DOMException('invalid state', 'InvalidStateError'));
      registerOptions.current?.onRegistered?.({ update } as unknown as ServiceWorkerRegistration);

      const hourlyCheck = setIntervalSpy.mock.calls.find(([, ms]) => ms === 60 * 60 * 1000)?.[0] as () => unknown;
      await expect(Promise.resolve(hourlyCheck())).resolves.toBeUndefined();
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
