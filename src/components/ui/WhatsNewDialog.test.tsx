import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import WhatsNewDialog, { seenKey } from './WhatsNewDialog';

const NOTES = { version: '0.2.0', date: '2026-11-19', items: ['Quotes show the booked price.', 'Bill Split has a payer table.'] };

describe('WhatsNewDialog', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows the release items once per version per user', () => {
    render(<WhatsNewDialog userId="u1" notes={NOTES} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Quotes show the booked price.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(seenKey('u1'))).toBe('0.2.0');
  });

  it('stays closed when this user already saw this version', () => {
    localStorage.setItem(seenKey('u1'), '0.2.0');
    render(<WhatsNewDialog userId="u1" notes={NOTES} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows again for a newer version and for another user', () => {
    localStorage.setItem(seenKey('u1'), '0.1.0');
    const { unmount } = render(<WhatsNewDialog userId="u1" notes={NOTES} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    unmount();
    localStorage.setItem(seenKey('u1'), '0.2.0');
    render(<WhatsNewDialog userId="u2" notes={NOTES} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows again when another user signs in on the same page', () => {
    const { rerender } = render(<WhatsNewDialog userId="u1" notes={NOTES} />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    rerender(<WhatsNewDialog userId="u2" notes={NOTES} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows nothing without items or without a signed-in user', () => {
    const { unmount } = render(<WhatsNewDialog userId="u1" notes={{ ...NOTES, items: [] }} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();
    render(<WhatsNewDialog userId={null} notes={NOTES} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('still closes when storage is unavailable (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    render(<WhatsNewDialog userId="u1" notes={NOTES} />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
