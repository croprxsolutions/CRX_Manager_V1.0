import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReceivingLogPanel from '../components/receiving/ReceivingLogPanel';
import CropPrograms from './CropPrograms';

const mocks = vi.hoisted(() => ({
  role: 'admin',
  toast: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: mocks.role, profile: { id: 'fixture-user' } }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  supabase: { from: mocks.from, rpc: mocks.rpc },
}));

const cropProgram = {
  id: 'fixture-program',
  name: 'Invented Corn Program',
  crop_type: 'Corn',
  season: '2026',
  is_active: true,
  items: [{ product_id: 'fixture-product', product_name: 'Invented Product', rate: 1, rate_unit: 'gal' }],
};

describe('role audit controls', () => {
  beforeEach(() => {
    mocks.role = 'admin';
    mocks.from.mockReset();
    mocks.rpc.mockReset();
  });

  it('keeps crop templates readable and clears admin dialogs when access is lost', async () => {
    const result = { data: { setting_value: JSON.stringify([cropProgram]) }, error: null };
    mocks.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => result }), order: async () => ({ data: [], error: null }) }),
    }));
    const view = render(<CropPrograms />);
    await screen.findByRole('heading', { name: cropProgram.name });
    fireEvent.click(screen.getByRole('button', { name: 'Expand program' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    expect(screen.getByRole('dialog', { name: 'Delete Program?' })).toBeInTheDocument();

    mocks.role = 'sales_rep';
    view.rerender(<CropPrograms />);
    expect(screen.getByText('Invented Product')).toBeInTheDocument();
    for (const name of ['New Program', 'Edit', 'Duplicate', 'Delete', 'Deactivate Program']) {
      expect(screen.queryByRole('button', { name, exact: true })).toBeNull();
    }
    expect(screen.queryByRole('dialog')).toBeNull();

    mocks.role = 'admin';
    view.rerender(<CropPrograms />);
    expect(screen.getByRole('button', { name: 'Delete', exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps receiving exports available and clears the admin confirmation when access is lost', async () => {
    mocks.from.mockReturnValue({
      select: () => ({ in: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }),
    });
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === 'get_receiving_log'
        ? [{ id: 'fixture-receipt', po_number: 'PO-FIXTURE', product_name: 'Invented Product', vendor: 'Invented Vendor',
            received_at: '2026-11-25T12:00:00Z', quantity_received: 1, condition: 'good' }]
        : { total_receipts: 1, this_week: 1, this_month: 1, damaged_count: 0 },
      error: null,
    }));
    const panel = () => <MemoryRouter><ReceivingLogPanel /></MemoryRouter>;
    const view = render(panel());
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Invented Product' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    const confirmation = { name: 'Delete 1 receiving record?' };
    expect(screen.getByRole('heading', confirmation)).toBeInTheDocument();

    mocks.role = 'sales_rep';
    view.rerender(panel());
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete', exact: true })).toBeNull();
    expect(screen.queryByRole('heading', confirmation)).toBeNull();

    mocks.role = 'admin';
    view.rerender(panel());
    expect(screen.getByRole('button', { name: 'Delete', exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('heading', confirmation)).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalledWith('reverse_receiving_record', expect.anything());
  });
});
