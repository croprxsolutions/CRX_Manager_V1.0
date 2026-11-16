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

  it('inline mode puts the label inside the trigger and drops the helper line', () => {
    const onChange = vi.fn();
    const { container } = render(<Dropdown inline label="Status" value="draft" onChange={onChange} options={options} helper="Never shown" />);
    const trigger = screen.getByRole('button', { name: /Status/ });
    expect(trigger).toHaveTextContent('StatusDraft');
    expect(trigger).toHaveClass('rounded-full', 'md:rounded-lg'); // a pill on phones, like the filter chips
    expect(screen.queryByText('Never shown')).not.toBeInTheDocument();
    expect(container.querySelector('.min-h-5')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Sent' }));
    expect(onChange).toHaveBeenCalledWith('sent');
  });

  it('active inline filter is green-tinted; inactive is plain', () => {
    const { rerender } = render(<Dropdown inline label="Status" value="draft" onChange={() => {}} options={options} />);
    expect(screen.getByRole('button', { name: /Status/ })).toHaveClass('bg-white', 'border-gray-300');
    rerender(<Dropdown inline active label="Status" value="sent" onChange={() => {}} options={options} />);
    const trigger = screen.getByRole('button', { name: /Status/ });
    expect(trigger).toHaveClass('bg-crx-green-light', 'border-crx-green');
    expect(trigger).not.toHaveClass('bg-white');
  });

  it('icon and valueLabel change only what the trigger shows', () => {
    const onChange = vi.fn();
    render(<Dropdown inline aria-label="Sort things" icon={<span data-testid="lead-icon" />} valueLabel="Sort" value="draft" onChange={onChange} options={options} />);
    const trigger = screen.getByRole('button', { name: /Sort/ });
    expect(trigger).toHaveTextContent(/^Sort$/);
    expect(screen.getByTestId('lead-icon')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'Draft' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('option', { name: 'Sent' }));
    expect(onChange).toHaveBeenCalledWith('sent');
  });

  it('the option list gets the thin scrollbar and scroll shadows', () => {
    render(<Dropdown label="Status" value="draft" onChange={vi.fn()} options={options} />);
    fireEvent.click(screen.getByRole('button', { name: /Status/ }));
    expect(screen.getByRole('listbox')).toHaveClass('scroll-thin', 'scroll-shadows');
  });

  it('disabled option cannot be chosen', () => {
    const onChange = vi.fn();
    render(<Dropdown label="Status" value="draft" onChange={onChange} options={options} />);
    fireEvent.click(screen.getByRole('button', { name: /Status/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Won' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
