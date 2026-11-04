/**
 * NewDelivery.unsavedChanges.test.tsx: loading an order (a ?order= link) fills
 * the lines and address, which is not unsaved work; a user edit is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Map<string, 'error' | 'nodata'>(),
  toast: vi.fn(),
  rpc: vi.fn(),
}));

function query(table: string): Record<string, unknown> {
  const reply = (single: boolean) => {
    const mode = H.failing.get(table);
    if (mode === 'error') return { data: null, error: { message: 'connection reset' } };
    if (mode === 'nodata') return { data: null, error: null };
    const rows = H.tables[table] ?? [];
    return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length };
  };
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(reply(false));
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(reply(true));
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return { ...actual, supabase: { from: query, rpc: H.rpc } };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyDriverAssigned: vi.fn() }));
vi.mock('../lib/rupCompliance', () => ({ checkRUPCompliance: () => Promise.resolve({ compliant: true, warnings: [] }) }));
vi.mock('../hooks/useGuardrails', () => ({ useOverloadedDriverCheck: () => ({ warning: null, checkDriverLoad: vi.fn() }) }));
// Records every isDirty value the page hands the unsaved-changes guard.
const dirty = vi.hoisted(() => ({ values: [] as boolean[] }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: (isDirty: boolean) => { dirty.values.push(isDirty); return { state: 'unblocked' }; },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }) }));

import NewDelivery from './NewDelivery';

beforeEach(() => {
  vi.clearAllMocks();
  dirty.values = [];
  H.failing = new Map();
  H.rpc.mockResolvedValue({ data: null, error: null });
  H.tables = {
    orders: [{ id: 'o1', order_number: 'ORD-5', status: 'confirmed', customer_id: 'c1', deleted_at: null, customer: { farm_name: 'Big Farm' } }],
    customers: [{ id: 'c1', farm_name: 'Big Farm' }],
    order_items: [{ id: 'oi-1', order_id: 'o1', product_id: 'p1', product_name: 'Test Chem', quantity_remaining: 3, total_units_needed: 3, quantity_delivered: 0, section_name: 'A' }],
    customer_addresses: [{ id: 'addr-1', customer_id: 'c1', is_default: true, label: 'Home Place', address_line1: '1 Farm Rd' }],
    profile_public_view: [],
    inventory: [],
    deliveries: [],
  };
});
afterEach(cleanup);

describe('New Delivery unsaved changes', () => {
  it('a blank page stays clean after it loads', async () => {
    render(<MemoryRouter initialEntries={['/deliveries/new']}><NewDelivery /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 400));
    expect(dirty.values).not.toContain(true);
  });

  it('an order link fills the lines without marking the page dirty, and a notes edit does', async () => {
    render(<MemoryRouter initialEntries={['/deliveries/new?order=o1']}><NewDelivery /></MemoryRouter>);
    expect(await screen.findByText('Test Chem')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(dirty.values).not.toContain(true);

    fireEvent.change(screen.getByPlaceholderText('Special instructions, gate codes, etc.'), { target: { value: 'gate 4' } });
    expect(dirty.values[dirty.values.length - 1]).toBe(true);
  });
});
