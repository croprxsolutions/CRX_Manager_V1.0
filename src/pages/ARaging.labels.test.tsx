/**
 * ARaging.labels.test.tsx — one set of aging labels (AR_AGING_LABELS) that names get_ar_aging's real
 * day ranges (0–29 / 30–59 / 60–89 / 90–119 / 120+ days past due), on the AR Aging page's table and
 * summary tiles, instead of "30 Days" / "60 Days" next to "90–119 Days".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({ toast: vi.fn() }));

const reply = (rows: unknown[] = []) => {
  const chain: object = new Proxy({}, {
    get: (_target, prop) => (prop === 'then'
      ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject)
      : () => chain),
  });
  return chain;
};

const AGING_ROW = {
  customer_id: 'c1', farm_name: 'Big Farm', current_amount: 10, days_30: 20, days_60: 30, days_90: 40, over_90: 50,
  total_outstanding: 150, prepay_balance_cents: 0, open_credit_cents: 0, unavailable_reason: null,
};

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: () => reply(),
      rpc: (name: string) => reply(name === 'get_ar_aging' ? [AGING_ROW] : []),
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import ARaging from './ARaging';
import { AR_AGING_LABELS } from '../lib/arAging';

afterEach(() => cleanup());

describe('AR aging labels', () => {
  it('names the real day ranges, once, in one shared set', () => {
    expect(AR_AGING_LABELS).toMatchObject({
      current: 'Current',
      days30: '30–59 days',
      days60: '60–89 days',
      days90: '90–119 days',
      over120: '120+ days',
    });
  });

  it('the AR Aging table and summary tiles use that set', async () => {
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    await screen.findAllByRole('button', { name: 'Big Farm' });
    for (const label of ['30–59 days', '60–89 days', '90–119 days', '120+ days', '30–89 days', '90+ days']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    for (const old of ['30 Days', '60 Days', '90–119 Days', '120+ Days', '30-89 Days', '90+ Days', 'Current (<30 days)']) {
      expect(screen.queryByText(old)).toBeNull();
    }
  });
});
