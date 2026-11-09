import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Dropdown from './Dropdown';

const options = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'won', label: 'Won', disabled: true },
];

describe('Dropdown', () => {
  it('opens on click and calls onChange with the option value', () => {
    const onChange = vi.fn();
    render(<Dropdown label="Status" value="draft" onChange={onChange} options={options} />);
    fireEvent.click(screen.getByRole('button', { name: /Status/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Sent' }));
    expect(onChange).toHaveBeenCalledWith('sent');
  });

  it('works by keyboard', async () => {
    const onChange = vi.fn();
    render(<Dropdown label="Status" value={null} onChange={onChange} options={options} />);
    const trigger = screen.getByRole('button', { name: /Status/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    // ArrowDown on the trigger opens the list on the first option; the focused option takes the keys.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    fireEvent.keyUp(document.activeElement!, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('sent');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('shows the placeholder when value is null', () => {
    render(<Dropdown label="Status" value={null} onChange={() => {}} options={options} placeholder="Pick a status" />);
    expect(screen.getByRole('button', { name: /Pick a status/ })).toBeInTheDocument();
  });

  it('shows the error text and marks the trigger invalid', () => {
    render(<Dropdown label="Status" value={null} onChange={() => {}} options={options} error="Status is required" />);
    expect(screen.getByText('Status is required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Status/ })).toHaveAttribute('aria-invalid', 'true');
  });

  it('disabled option cannot be chosen', () => {
    const onChange = vi.fn();
    render(<Dropdown label="Status" value="draft" onChange={onChange} options={options} />);
    fireEvent.click(screen.getByRole('button', { name: /Status/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Won' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
