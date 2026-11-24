import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./Sidebar', () => ({
  default: ({ mobileOpen }: { mobileOpen: boolean }) => (
    <div data-testid="sidebar" data-mobile-open={mobileOpen}>Sidebar</div>
  ),
}));

vi.mock('./TopBar', () => ({
  default: ({ title }: { title: string }) => (
    <div data-testid="topbar">{title}</div>
  ),
}));

vi.mock('../ui/OfflineBanner', () => ({
  default: () => <div data-testid="offline-banner">OfflineBanner</div>,
}));

vi.mock('../ui/CommandPalette', () => ({
  default: ({ open }: { open: boolean }) => <div data-testid="palette" data-open={open} />,
}));

vi.mock('../../hooks/usePageMeta', () => ({
  usePageMeta: () => ({ title: 'Test Page', accent: 'Accent' }),
}));

import AppLayout from './AppLayout';

function renderLayout() {
  return render(
    <MemoryRouter>
      <AppLayout />
    </MemoryRouter>
  );
}

describe('AppLayout', () => {
  it('renders Sidebar', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('renders TopBar with page title', () => {
    renderLayout();
    expect(screen.getByTestId('topbar')).toHaveTextContent('Test Page');
  });

  it('renders OfflineBanner', () => {
    renderLayout();
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
  });

  it('has skip-to-content link for accessibility', () => {
    renderLayout();
    const skipLink = screen.getByText('Skip to main content');
    expect(skipLink).toBeInTheDocument();
    expect(skipLink).toHaveAttribute('href', '#main-content');
  });

  it('renders main content area with correct id', () => {
    renderLayout();
    const main = document.getElementById('main-content');
    expect(main).toBeTruthy();
    expect(main?.tagName).toBe('MAIN');
  });

  it('sidebar starts with mobileOpen=false', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-mobile-open', 'false');
  });

  it('"/" opens global search when the person is not typing in a field', () => {
    renderLayout();
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'false');
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'true');
  });

  it('"/" types normally in an input, textarea, select or editable text, and while a dialog is open', () => {
    renderLayout();
    const main = document.getElementById('main-content')!;
    main.innerHTML = '<input id="i"/><textarea id="t"></textarea><select id="s"></select><div contenteditable="true"><span id="c">x</span></div>';
    for (const id of ['i', 't', 's', 'c']) {
      fireEvent.keyDown(document.getElementById(id)!, { key: '/' });
      expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'false');
    }
    main.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'false');
  });

  it('Ctrl+K still toggles global search', () => {
    renderLayout();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'true');
  });
});
