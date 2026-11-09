import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import DatePicker from './DatePicker';

function Harness({
  initial,
  onChange,
  minValue,
  presets,
}: {
  initial: string | null;
  onChange: (v: string | null) => void;
  minValue?: string;
  presets?: { label: string; value: string }[];
}) {
  const [v, setV] = useState<string | null>(initial);
  return (
    <DatePicker
      label="Expires"
      value={v}
      minValue={minValue}
      presets={presets}
      onChange={(n) => {
        setV(n);
        onChange(n);
      }}
    />
  );
}

const segs = () =>
  ['month', 'day', 'year'].map((t) => screen.getAllByRole('spinbutton').find((s) => s.getAttribute('data-type') === t)!.textContent);

describe('DatePicker', () => {
  it('shows the stored day without shifting (segments 9/30/2027)', () => {
    render(<Harness initial="2027-09-30" onChange={vi.fn()} />);
    expect(segs()).toEqual(['9', '30', '2027']);
  });

  it.each(['2027-09-30T05:00:00Z', 'not a date'])('bad value %j renders an empty field without throwing', (bad) => {
    render(<Harness initial={bad} onChange={vi.fn()} />);
    expect(segs().join('')).not.toMatch(/\d{4}/);
  });

  it('a preset before minValue is disabled and does not fire', () => {
    const onChange = vi.fn();
    render(<Harness initial={null} minValue="2027-01-01" onChange={onChange} presets={[{ label: 'Too early', value: '2026-12-31' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /calendar/i }));
    const chip = screen.getByRole('button', { name: 'Too early' });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a malformed preset is disabled and does not fire', () => {
    const onChange = vi.fn();
    render(<Harness initial={null} minValue="2027-01-01" onChange={onChange} presets={[{ label: 'Bad', value: '2026-12-31T05:00:00Z' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /calendar/i }));
    const chip = screen.getByRole('button', { name: 'Bad' });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('returns the picked day as YYYY-MM-DD', () => {
    const onChange = vi.fn();
    render(<Harness initial="2027-09-30" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /calendar/i }));
    const grid = screen.getByRole('grid');
    fireEvent.click(within(grid).getByText('15'));
    expect(onChange).toHaveBeenLastCalledWith('2027-09-15');
  });

  it('days before minValue are disabled', () => {
    render(<Harness initial="2027-09-30" minValue="2027-09-20" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /calendar/i }));
    const grid = screen.getByRole('grid');
    expect(within(grid).getByText('19').closest('[role="button"]')).toHaveAttribute('aria-disabled', 'true');
    expect(within(grid).getByText('20').closest('[role="button"]')).not.toHaveAttribute('aria-disabled');
  });

  it('a preset chip sets its value and shows its pill', () => {
    const onChange = vi.fn();
    render(<Harness initial="2027-09-30" onChange={onChange} presets={[{ label: 'Season end', value: '2027-10-31' }]} />);
    expect(screen.queryByText('Season end')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /calendar/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Season end' }));
    expect(onChange).toHaveBeenLastCalledWith('2027-10-31');
    expect(screen.getByText('Season end')).toBeInTheDocument();
  });

  it('keyboard: arrow keys move the focused day, Enter picks it', () => {
    const onChange = vi.fn();
    render(<Harness initial="2027-09-30" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /calendar/i }));
    const focused = document.activeElement as HTMLElement;
    expect(focused).toHaveTextContent('30');
    fireEvent.keyDown(focused, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toHaveTextContent('28');
    // RAC presses on keydown + keyup, like a browser.
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    fireEvent.keyUp(document.activeElement!, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('2027-09-28');
  });
});
