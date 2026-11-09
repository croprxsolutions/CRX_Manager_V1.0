import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import HelpTip from './HelpTip';

describe('HelpTip', () => {
  it('renders the help icon', () => {
    render(<HelpTip text="Test tip" />);
    expect(screen.getByRole('button', { name: 'More info' })).toBeInTheDocument();
  });

  it('shows tip text when clicked', () => {
    render(<HelpTip text="Test tip content" />);
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));
    expect(screen.getByText('Test tip content')).toBeInTheDocument();
  });

  it('opens on Enter, shows the text, Escape closes it', async () => {
    render(<HelpTip text="Hello tip" />);
    const btn = screen.getByRole('button', { name: 'More info' });
    btn.focus();
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.keyUp(btn, { key: 'Enter' });
    expect(await screen.findByText('Hello tip')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Help' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Hello tip')).not.toBeInTheDocument());
  });

  it('uses the strong focus ring, not the 20% one', () => {
    render(<HelpTip text="Tip" />);
    const cls = screen.getByRole('button', { name: 'More info' }).className;
    expect(cls).toMatch(/data-\[focus-visible\]:ring-crx-green(\s|$)/);
    expect(cls).not.toContain('ring-crx-green/20');
  });
});
