import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import Vehicles from './Vehicles';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin' }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../lib/db', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: async () => ({
          error: null,
          data: [
            { id: 'v1', vehicle_name: 'Sprayer', vehicle_type: 'ground', status: 'active', registration: 'ABC' },
            { id: 'v2', vehicle_name: 'Tender', vehicle_type: 'ground', status: 'active', registration: 'DEF' },
          ],
        }),
      }),
    }),
  },
}));

it('limits Select All to the vehicles shown by the registration search', async () => {
  render(<MemoryRouter><Vehicles /></MemoryRouter>);
  await screen.findByRole('button', { name: 'Tender' });

  fireEvent.change(screen.getByRole('textbox', { name: /search vehicles/i }), { target: { value: 'abc' } });
  expect(screen.queryByRole('button', { name: 'Tender' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Select All' }));

  expect(screen.getByText('1 selected')).toBeInTheDocument();
  expect(screen.getByRole('checkbox')).toBeChecked();
});

