import { describe, expect, it, vi } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('./db', () => ({ supabaseUntyped: { from: mockFrom } }));

import {
  APPLICATION_SERVICE_BILLING_DB_READY,
  loadApplicationServiceBilling,
} from './jobServiceBillingSummary';

function resultChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const method = () => chain;
  for (const name of ['select', 'eq', 'maybeSingle']) chain[name] = method;
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  return chain;
}

describe('application service billing details', () => {
  it('keeps the feature hidden until the database lane is ready', () => {
    expect(APPLICATION_SERVICE_BILLING_DB_READY).toBe(false);
  });

  it('fails soft when the new billing columns are missing', async () => {
    mockFrom.mockReturnValue(resultChain({ data: null, error: { message: 'column bills_customer does not exist' } }));
    await expect(loadApplicationServiceBilling('service-1')).resolves.toEqual({ available: false, billing: null });
  });

  it('reads the selected service billing and outside company details', async () => {
    mockFrom.mockReturnValue(resultChain({
      data: { bills_customer: true, outside_vendor_id: 'vendor-1', outside_vendor: { name: 'Spray Partner' } },
      error: null,
    }));
    await expect(loadApplicationServiceBilling('service-1')).resolves.toEqual({
      available: true,
      billing: { billsCustomer: true, outsideCompanyName: 'Spray Partner' },
    });
  });
});
