import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SectionJumpBar from './SectionJumpBar';

const sections = [
  { id: 'a', label: 'Users', count: 4 },
  { id: 'b', label: 'Billing' },
];

describe('SectionJumpBar', () => {
  it('links each pill to its section and marks the first active', () => {
    render(<SectionJumpBar sections={sections} />);
    const users = screen.getByRole('link', { name: /Users/ });
    expect(users).toHaveAttribute('href', '#a');
    expect(users).toHaveAttribute('aria-current', 'location');
    expect(users).toHaveClass('bg-crx-green');
    expect(screen.getByText('4')).toHaveClass('bg-white');
    expect(screen.getByRole('link', { name: 'Billing' })).not.toHaveAttribute('aria-current');
  });

  it('moves the active pill on click', () => {
    render(<SectionJumpBar sections={sections} />);
    fireEvent.click(screen.getByRole('link', { name: 'Billing' }));
    expect(screen.getByRole('link', { name: 'Billing' })).toHaveAttribute('aria-current', 'location');
  });
});

describe('SectionJumpBar with a replaced list', () => {
  it('falls back to the first section when the active one is gone', () => {
    const { rerender } = render(<SectionJumpBar sections={sections} />);
    rerender(<SectionJumpBar sections={[{ id: 'c', label: 'Field jobs' }, { id: 'd', label: 'Company' }]} />);
    expect(screen.getByRole('link', { name: 'Field jobs' })).toHaveAttribute('aria-current', 'location');
  });
});
