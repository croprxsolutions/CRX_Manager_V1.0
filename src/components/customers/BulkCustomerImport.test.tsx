/**
 * BulkCustomerImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Fully chainable Supabase query-builder mock
function chainable(resolveWith: unknown = { data: [], error: null }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','like','ilike','is','in','or','not','match',
    'order','limit','range','single','maybeSingle',
    'csv','explain',
  ];
  for (const m of methods) builder[m] = vi.fn(self);
  // Make it thenable so `await supabase.from(...)...` resolves
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc: vi.fn(() => chainable()) },
}));

vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: vi.fn(),
  isCSVFile: vi.fn(() => true),
  isOCRSupported: vi.fn(() => false),
}));

const authValue = vi.hoisted(() => ({ profile: { id: 'admin-1', role: 'admin' } as { id: string; role: string } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authValue }));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import BulkCustomerImport from './BulkCustomerImport';

describe('BulkCustomerImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => vi.clearAllMocks());

  it('renders when open', () => {
    render(<BulkCustomerImport {...defaultProps} />);
    expect(screen.getByText(/bulk customer/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkCustomerImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/bulk customer/i)).not.toBeInTheDocument();
  });

  // Price tiers are admin-only (Mason 2026-11-01): a rep's import puts every row on the
  // Settings Default Tier (1 here: no setting), whatever tier the file says.
  async function parseTierThreeFile() {
    const { container } = render(<BulkCustomerImport {...defaultProps} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['farm_name,tier\nTier Three Farm,3\n'], 'c.csv', { type: 'text/csv' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Parse File' }));
    await screen.findByText('Tier Three Farm');
  }

  it('keeps the tier from the file for an admin', async () => {
    authValue.profile = { id: 'admin-1', role: 'admin' };
    await parseTierThreeFile();
    expect(screen.getByText('Tier: 3')).toBeInTheDocument();
  });

  it('puts a sales rep\'s rows on the default tier and says why', async () => {
    authValue.profile = { id: 'rep-1', role: 'sales_rep' };
    try {
      await parseTierThreeFile();
      expect(screen.getByText('Tier: 1')).toBeInTheDocument();
      expect(screen.getAllByText(/only an admin can set a customer.s tier/i).length).toBeGreaterThan(0);
    } finally {
      authValue.profile = { id: 'admin-1', role: 'admin' };
    }
  });

  it('shows file upload area', () => {
    render(<BulkCustomerImport {...defaultProps} />);
    expect(screen.getByText(/csv/i)).toBeInTheDocument();
  });
});
