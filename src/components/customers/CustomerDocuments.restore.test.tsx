import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';

// KI-07: an admin can list removed documents and restore one. The database
// side (only an active admin may clear both removal columns) is
// guard_customer_document_update in 20261222100000.

const toastSpy = vi.fn();
vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
let role = 'admin';
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role } }),
}));

const REMOVED = {
  id: 'doc-1', customer_id: 'customer-1', document_type: 'license',
  storage_path: 'customer-1/doc-1.pdf', filename: 'License.pdf', mime_type: 'application/pdf',
  size_bytes: 1024, effective_date: null, expiration_date: null, notes: null,
  created_at: '2026-09-21T00:00:00Z', deleted_at: '2026-11-01T00:00:00Z',
};

type Recorded = { method: string; args: unknown[] };
const fromCalls: { table: string; recorded: Recorded[] }[] = [];
let updateResult: { data: unknown; error: unknown } = { data: [{ id: 'doc-1' }], error: null };

function makeChain(table: string) {
  const entry = { table, recorded: [] as Recorded[] };
  fromCalls.push(entry);
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'update', 'eq', 'is', 'not', 'order']) {
    chain[method] = (...args: unknown[]) => { entry.recorded.push({ method, args }); return chain; };
  }
  const isUpdate = () => entry.recorded.some((r) => r.method === 'update');
  const isRemovedList = () => entry.recorded.some((r) => r.method === 'not');
  chain.then = (resolve: (v: unknown) => unknown) => resolve(
    isUpdate() ? updateResult : { data: isRemovedList() ? [REMOVED] : [], error: null },
  );
  return chain;
}

vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>();
  return { ...actual, supabase: { from: (table: string) => makeChain(table), rpc: vi.fn() } };
});
const logActivityMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../../lib/activityLogger', () => ({ logActivity: (...args: unknown[]) => logActivityMock(...args) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import CustomerDocuments from './CustomerDocuments';

describe('CustomerDocuments removed documents (admin)', () => {
  beforeEach(() => {
    role = 'admin';
    fromCalls.length = 0;
    updateResult = { data: [{ id: 'doc-1' }], error: null };
    toastSpy.mockClear();
    logActivityMock.mockClear();
  });
  afterEach(cleanup);

  it('is not offered to a sales rep', async () => {
    role = 'sales_rep';
    render(<CustomerDocuments customerId="customer-1" userId="user-1" />);
    await screen.findByText('No documents have been uploaded yet.');
    expect(screen.queryByRole('button', { name: 'Show removed documents' })).toBeNull();
  });

  it('lists removed documents and restores one with a scoped update', async () => {
    render(<CustomerDocuments customerId="customer-1" userId="user-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show removed documents' }));
    expect(await screen.findByText('License.pdf')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove License.pdf')).toBeNull();

    fireEvent.click(screen.getByLabelText('Restore License.pdf'));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', 'Document restored'));

    const update = fromCalls.find((c) => c.recorded.some((r) => r.method === 'update'))!;
    expect(update.table).toBe('customer_documents');
    expect(update.recorded).toEqual(expect.arrayContaining([
      { method: 'update', args: [{ deleted_at: null, deleted_by: null }] },
      { method: 'eq', args: ['id', 'doc-1'] },
      { method: 'eq', args: ['customer_id', 'customer-1'] },
      { method: 'not', args: ['deleted_at', 'is', null] },
    ]));
    expect(logActivityMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'document_restored', entityId: 'doc-1' }));
    expect(screen.queryByText('License.pdf')).not.toBeInTheDocument();
  });

  it('opens another customer on its current documents', async () => {
    const view = render(<CustomerDocuments customerId="customer-1" userId="user-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show removed documents' }));
    expect(await screen.findByText('License.pdf')).toBeInTheDocument();
    view.rerender(<CustomerDocuments customerId="customer-2" userId="user-1" />);
    expect(await screen.findByText('No documents have been uploaded yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show removed documents' })).toBeInTheDocument();
  });

  it('reports a refused restore and logs nothing', async () => {
    updateResult = { data: [], error: null };
    render(<CustomerDocuments customerId="customer-1" userId="user-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show removed documents' }));
    fireEvent.click(await screen.findByLabelText('Restore License.pdf'));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('error', expect.stringContaining('Restore customer document failed')));
    expect(logActivityMock).not.toHaveBeenCalled();
  });
});
