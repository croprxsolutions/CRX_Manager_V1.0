import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import VehicleDetail from './VehicleDetail';

const { toast, save } = vi.hoisted(() => ({ toast: vi.fn(), save: vi.fn() }));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => ({ state: 'unblocked' }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin' }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../lib/db', () => ({
  checkMutationResult: vi.fn(),
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { vehicle_name: 'Sprayer', vehicle_type: 'ground', status: 'active' } }),
        }),
      }),
      update: () => ({ eq: () => ({ select: () => ({ single: save }) }) }),
    }),
  },
}));

it('locks edits during an existing vehicle save and restores them after it settles', async () => {
  let finishSave!: (result: unknown) => void;
  save.mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
  const router = createMemoryRouter([{ path: '/vehicles/:id', element: <VehicleDetail /> }], {
    initialEntries: ['/vehicles/vehicle-1'],
  });
  render(<RouterProvider router={router} />);

  const notes = await screen.findByPlaceholderText(/maintenance schedule/i);
  fireEvent.change(notes, { target: { value: 'New inspection notes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

  expect(notes).toBeDisabled();
  await act(async () => finishSave({ data: { id: 'vehicle-1' }, error: null }));
  expect(notes).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'Notes' })).toBe(notes);
  expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('ground');
  expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('gallons');
  expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('active');
});
