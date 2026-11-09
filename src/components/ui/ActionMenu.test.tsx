import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ActionMenu, { type ActionMenuItem } from './ActionMenu';

const make = (over: Partial<Record<string, Partial<ActionMenuItem>>> = {}): ActionMenuItem[] => [
  { id: 'delete', label: 'Delete quote', danger: true, onAction: vi.fn(), ...over.delete },
  { id: 'pdf', label: 'Download PDF', onAction: vi.fn(), ...over.pdf },
  { id: 'dup', label: 'Duplicate', onAction: vi.fn(), ...over.dup },
];

describe('ActionMenu', () => {
  it('opens and runs an item', () => {
    const items = make();
    render(<ActionMenu label="More actions" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download PDF' }));
    expect(items[1].onAction).toHaveBeenCalledTimes(1);
  });

  it('danger items come last', () => {
    render(<ActionMenu label="More actions" items={make()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const names = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(names).toEqual(['Download PDF', 'Duplicate', 'Delete quote']);
  });

  it('groups items under a header', () => {
    const items = make({ pdf: { group: 'Export' } });
    render(<ActionMenu label="More actions" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('group', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Duplicate',
      'Download PDF',
      'Delete quote',
    ]);
  });

  it('disabled item shows its reason and does not run', () => {
    const items = make({ dup: { disabled: true, disabledReason: 'Save the quote first' } });
    render(<ActionMenu label="More actions" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: 'Duplicate' });
    expect(screen.getByText('Save the quote first')).toBeInTheDocument();
    expect(item).toHaveAccessibleDescription('Save the quote first');
    fireEvent.click(item);
    expect(items[2].onAction).not.toHaveBeenCalled();
  });

  it('works by keyboard and returns focus to the trigger', async () => {
    const items = make();
    render(<ActionMenu label="More actions" items={items} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyUp(trigger, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    fireEvent.keyUp(document.activeElement!, { key: 'Enter' });
    // Enter opens on the first item (Download PDF); ArrowDown moves to the second (Duplicate).
    expect(items[2].onAction).toHaveBeenCalledTimes(1);
    expect(items[1].onAction).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('renders a text trigger', () => {
    render(<ActionMenu label="Create order" items={make()} trigger={{ text: 'Create order', variant: 'primary' }} />);
    expect(screen.getByRole('button', { name: 'Create order' })).toBeInTheDocument();
  });
});
