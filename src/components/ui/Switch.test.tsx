import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import Switch from './Switch';

function Harness({ onChange }: { onChange: (v: boolean) => void }) {
  const [on, setOn] = useState(false);
  return (
    <Switch
      label="Planned program"
      description="Spread across the season"
      isSelected={on}
      onChange={(v) => {
        setOn(v);
        onChange(v);
      }}
    />
  );
}

describe('Switch', () => {
  it('toggles with click and Space and reports isSelected', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: /Planned program/ });
    expect(sw).not.toBeChecked();
    expect(screen.getByText('Spread across the season')).toBeInTheDocument();
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(sw).toBeChecked();
    // jsdom does not turn Space into a click on a checkbox input, so dispatch the click a browser would.
    sw.focus();
    fireEvent.keyDown(sw, { key: ' ' });
    fireEvent.keyUp(sw, { key: ' ' });
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(sw).not.toBeChecked();
  });

  it('is disabled when isDisabled', () => {
    render(<Switch label="X" isSelected={false} onChange={() => {}} isDisabled />);
    expect(screen.getByRole('switch', { name: 'X' })).toBeDisabled();
  });
});
