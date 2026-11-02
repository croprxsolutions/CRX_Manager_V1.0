import { describe, it, expect } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
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

describe('SectionJumpBar while scrolling', () => {
  it('lights the last section scrolled past, both down and back up', () => {
    render(
      <>
        <SectionJumpBar sections={[...sections, { id: 'c', label: 'Field jobs' }]} />
        <div id="a" />
        <div id="b" />
        <div id="c" />
      </>,
    );
    const scrollTo = (tops: Record<string, number>) =>
      act(() => {
        for (const [id, top] of Object.entries(tops)) {
          document.getElementById(id)!.getBoundingClientRect = () => ({ top }) as DOMRect;
        }
        fireEvent.scroll(window);
      });
    const active = () => screen.getByRole('link', { current: 'location' }).textContent;
    // A fast jump to the bottom, past every section, lights the last one.
    scrollTo({ a: -3000, b: -2000, c: -500 });
    expect(active()).toBe('Field jobs');
    // Back up onto an untagged card between Users and Billing: Users is the one scrolled past.
    scrollTo({ a: -400, b: 600, c: 1500 });
    expect(active()).toBe('Users4');
    // At the top nothing has passed the bars yet, so the first section stays lit.
    scrollTo({ a: 200, b: 900, c: 1800 });
    expect(active()).toBe('Users4');
    scrollTo({ a: -900, b: 100, c: 900 });
    expect(active()).toBe('Billing');
  });
});
