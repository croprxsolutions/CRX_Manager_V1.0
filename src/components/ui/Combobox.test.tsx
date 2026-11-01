import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import Combobox from './Combobox';

const options = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry'];
const scrollIntoView = vi.fn();

function StatefulCombobox({ initialValue = '' }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  return <Combobox label="Fruit" value={value} onChange={setValue} options={options} />;
}

// jsdom doesn't implement scrollIntoView.
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});

beforeEach(() => {
  scrollIntoView.mockClear();
});

describe('Combobox', () => {
  it('renders with a label', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
    );
    expect(screen.getByLabelText('Fruit')).toBeInTheDocument();
  });

  it('renders without a label', () => {
    render(
      <Combobox value="" onChange={() => {}} options={options} placeholder="Pick one" />
    );
    expect(screen.getByPlaceholderText('Pick one')).toBeInTheDocument();
  });

  it('shows placeholder text', () => {
    render(
      <Combobox value="" onChange={() => {}} options={options} placeholder="Search..." />
    );
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
  });

  it('calls onChange when typing', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="" onChange={onChange} options={options} />
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'App' } });
    expect(onChange).toHaveBeenCalledWith('App');
  });

  it('shows the full list on focus and marks the saved option', () => {
    render(
      <Combobox label="Fruit" value="banana" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);

    const renderedOptions = screen.getAllByRole('option');
    expect(renderedOptions).toHaveLength(5);
    expect(renderedOptions.map((option) => option.textContent?.replace(' ', ''))).toEqual(options);
    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-selected', 'true');
    for (const option of renderedOptions.filter((item) => item.textContent?.startsWith('Banana') === false)) {
      expect(option).toHaveAttribute('aria-selected', 'false');
    }

    const savedOption = screen.getByRole('option', { name: 'Banana' });
    expect(savedOption).toHaveClass('font-medium');
    expect(savedOption.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('filters by typed query while calling onChange for each keystroke', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="Banana" onChange={onChange} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'c' } });
    fireEvent.change(input, { target: { value: 'ch' } });

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Cherry']);
    expect(onChange).toHaveBeenNthCalledWith(1, 'c');
    expect(onChange).toHaveBeenNthCalledWith(2, 'ch');
  });

  it('collapses aria-expanded when there are no matches and expands again when cleared', () => {
    render(<StatefulCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'zz' } });

    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });

    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('selects an option on mouse down', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="" onChange={onChange} options={options} />
    );
    fireEvent.focus(screen.getByRole('combobox'));
    const option = screen.getByText('Cherry');
    const mouseDownEvent = createEvent.mouseDown(option);
    fireEvent(option, mouseDownEvent);
    expect(mouseDownEvent.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledWith('Cherry');
  });

  it('reopens the full list when the input is clicked after a pick', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="Apple" onChange={onChange} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByText('Cherry'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(input);
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  it('keeps aria-selected on the saved value while the active option moves', () => {
    render(
      <Combobox label="Fruit" value="Banana" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(input).toHaveAttribute('aria-activedescendant', 'fruit-option-1');

    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Cherry' })).toHaveAttribute('aria-selected', 'false');
    expect(input).toHaveAttribute('aria-activedescendant', 'fruit-option-2');
  });

  it('does not scroll on hover or wheel, but scrolls after keyboard movement', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    scrollIntoView.mockClear();

    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Banana' }));
    fireEvent.wheel(screen.getByRole('listbox'));
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('wraps keyboard movement through the options', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    for (let index = 0; index < options.length; index += 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    }
    expect(input).toHaveAttribute('aria-activedescendant', 'fruit-option-4');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'fruit-option-0');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', 'fruit-option-4');
  });

  it('opens a closed list with ArrowDown and ArrowUp', () => {
    render(
      <Combobox label="Fruit" value="Banana" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-activedescendant', 'fruit-option-1');

    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-activedescendant', 'fruit-option-1');
  });

  it('navigates options with arrow keys and selects with Enter', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="" onChange={onChange} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Apple');
  });

  it('closes on Enter with no highlight and keeps the typed value', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="" onChange={onChange} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Ch' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('Ch');
  });

  it('Escape restores the value from before typing and closes the list', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="Banana" onChange={onChange} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Cherry' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onChange).toHaveBeenNthCalledWith(1, 'Cherry');
    expect(onChange).toHaveBeenNthCalledWith(2, 'Banana');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape without typing closes without calling onChange', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="" onChange={onChange} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('stops Escape from reaching the document only while the list is open', () => {
    const documentKeyDown = vi.fn();
    document.addEventListener('keydown', documentKeyDown);
    try {
      render(
        <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
      );
      const input = screen.getByRole('combobox');
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(documentKeyDown).not.toHaveBeenCalled();

      fireEvent.keyDown(input, { key: 'Escape' });
      expect(documentKeyDown).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener('keydown', documentKeyDown);
    }
  });

  it('Tab closes without preventing focus movement or reverting typed text', () => {
    render(<StatefulCombobox />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Cherry' } });
    const tabEvent = createEvent.keyDown(input, { key: 'Tab' });
    fireEvent(input, tabEvent);

    expect(tabEvent.defaultPrevented).toBe(false);
    expect(input).toHaveValue('Cherry');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'Date' } });
    const shiftTabEvent = createEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    fireEvent(input, shiftTabEvent);

    expect(shiftTabEvent.defaultPrevented).toBe(false);
    expect(input).toHaveValue('Date');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on outside mouse down, keeps typed text, and resets the next query', () => {
    render(<StatefulCombobox initialValue="Banana" />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Cherry' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Cherry']);

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('Cherry');

    fireEvent.click(input);
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  it('does not close on blur alone', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('does not open when disabled, including on click', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} disabled />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.click(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows error message', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} error="Required" />
    );
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('has correct ARIA attributes and listbox ids without a label', () => {
    render(
      <Combobox value="" onChange={() => {}} options={options} placeholder="Pick one" />
    );
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).not.toHaveAttribute('aria-controls');

    fireEvent.focus(input);
    const listbox = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    for (const option of within(listbox).getAllByRole('option')) {
      expect(option.id).not.toBe('');
    }
  });
});
