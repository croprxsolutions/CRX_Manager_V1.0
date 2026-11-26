import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_SERVICE_BILLING_DB_READY,
  readApplicationServiceBilling,
  readApplicationServiceBillingIfReady,
  saveApplicationService,
} from './applicationServiceBilling';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    supabase: { from: mocks.from },
    supabaseUntyped: { from: mocks.from, rpc: mocks.rpc },
  };
});

function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'in', 'is', 'order']) builder[method] = () => builder;
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset();
});

describe('application service billing contract', () => {
  it('omits billing fields when the caller has no known billing values', async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: true, service_id: 'service-1', created: false },
      error: null,
    });

    expect(APPLICATION_SERVICE_BILLING_DB_READY).toBe(false);
    await saveApplicationService({
      p_name: 'Y-Drop Nitrogen',
      p_default_rate_per_acre_cents: 1200,
      p_is_active: true,
      p_sort_order: 4,
      p_vehicle_id: null,
      p_cost_per_acre_cents: null,
      p_service_id: 'service-1',
    }, null, 'retry-key-1');

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('admin_save_application_service', {
      p_name: 'Y-Drop Nitrogen',
      p_default_rate_per_acre_cents: 1200,
      p_is_active: true,
      p_sort_order: 4,
      p_vehicle_id: null,
      p_cost_per_acre_cents: null,
      p_service_id: 'service-1',
      p_idempotency_key: 'retry-key-1',
    });
  });

  it('refuses a vendor ID paired with clear=true before calling the RPC', async () => {
    await expect(saveApplicationService({
      p_name: 'Y-Drop Nitrogen',
      p_default_rate_per_acre_cents: 1200,
      p_is_active: true,
      p_sort_order: 4,
      p_vehicle_id: null,
      p_cost_per_acre_cents: null,
      p_service_id: 'service-1',
    }, {
      billsCustomer: false,
      outsideVendorId: 'vendor-1',
      clearOutsideVendor: true,
    }, 'retry-key-1')).rejects.toThrow('Cannot set an outside vendor and clear it in the same save.');

    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('returns unavailable when the proposed columns are missing', async () => {
    mocks.from.mockReturnValue(query({
      data: null,
      error: { code: '42703', message: 'column application_services.bills_customer does not exist' },
    }));

    await expect(readApplicationServiceBilling(['service-1'])).resolves.toEqual({
      available: false,
      byServiceId: new Map(),
    });
  });

  it('does not query the proposed columns until the database lane is ready', async () => {
    await expect(readApplicationServiceBillingIfReady(['service-1'], false)).resolves.toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
