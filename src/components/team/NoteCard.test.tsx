import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExtendedTeamNote } from '../../types';
import NoteCard from './NoteCard';

afterEach(cleanup);

it('lets keyboard events on the completion button reach the button without opening the note', () => {
  const open = vi.fn();
  const complete = vi.fn();
  const note = { id: 'test', title: 'Check label', priority: 'medium', is_completed: false } as ExtendedTeamNote;
  render(<NoteCard note={note} showCheckbox canEdit={false} onClick={open} onToggleComplete={complete}
    onTogglePin={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />);
  const toggle = screen.getByRole('button', { name: 'Complete Check label', exact: true });
  expect(fireEvent.keyDown(toggle, { key: ' ' })).toBe(true);
  expect(fireEvent.keyDown(toggle, { key: 'Enter' })).toBe(true);
  fireEvent.click(toggle);
  expect(complete).toHaveBeenCalledWith(note);
  expect(open).not.toHaveBeenCalled();
});
