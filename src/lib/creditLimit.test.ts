import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCaptureException, mockNotifyCreditLimitExceeded, mockRpc } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  mockNotifyCreditLimitExceeded: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('./sentry', () => ({
  Sentry: { captureException: mockCaptureException },
}));

vi.mock('./db', () => ({
  supabase: { rpc: mockRpc },
  assertRpcResult: (data: unknown, rpcName: string) => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data`);
    }
    return data;
  },
}));

vi.mock('./notificationTriggers', () => ({
  notifyCreditLimitExceeded: mockNotifyCreditLimitExceeded,
}));

import { warnIfOverCreditLimit } from './creditLimit';

describe('warnIfOverCreditLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyCreditLimitExceeded.mockResolvedValue(undefined);
  });

  it('warns and notifies when the credit limit is exceeded', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        exceeded: true,
        farm_name: 'Sample Farm',
        outstanding_ar: 125000,
        credit_limit: 100000,
      },
      error: null,
    });
    const toast = vi.fn();

    await warnIfOverCreditLimit('customer-1', toast);

    expect(mockRpc).toHaveBeenCalledWith('check_customer_credit_limit', {
      p_customer_id: 'customer-1',
    });
    expect(toast).toHaveBeenCalledWith(
      'warning',
      'Credit limit warning: Sample Farm outstanding AR $125,000 exceeds limit $100,000'
    );
    expect(mockNotifyCreditLimitExceeded).toHaveBeenCalledWith(
      'Sample Farm',
      125000,
      100000,
      'customer-1'
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('stays silent when the credit limit is not exceeded', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        exceeded: false,
        farm_name: 'Sample Farm',
        outstanding_ar: 50000,
        credit_limit: 100000,
      },
      error: null,
    });
    const toast = vi.fn();

    await warnIfOverCreditLimit('customer-1', toast);

    expect(toast).not.toHaveBeenCalled();
    expect(mockNotifyCreditLimitExceeded).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('warns that it could not check when the RPC returns an error', async () => {
    const rpcError = { message: 'permission denied', code: '42501' };
    mockRpc.mockResolvedValueOnce({ data: null, error: rpcError });
    const toast = vi.fn();

    await expect(warnIfOverCreditLimit('customer-1', toast)).resolves.toBeUndefined();

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('warning', expect.stringContaining("Couldn't check"));
    expect(mockCaptureException).toHaveBeenCalledWith(rpcError, expect.anything());
    expect(mockNotifyCreditLimitExceeded).not.toHaveBeenCalled();
  });

  it('warns that it could not check when the RPC call rejects, without throwing', async () => {
    mockRpc.mockRejectedValueOnce(new Error('RPC unavailable'));
    const toast = vi.fn();

    await expect(warnIfOverCreditLimit('customer-1', toast)).resolves.toBeUndefined();

    expect(toast).toHaveBeenCalledWith('warning', expect.stringContaining("Couldn't check"));
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockNotifyCreditLimitExceeded).not.toHaveBeenCalled();
  });

  it('returns immediately for an empty customer id', async () => {
    await expect(warnIfOverCreditLimit('', vi.fn())).resolves.toBeUndefined();

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockNotifyCreditLimitExceeded).not.toHaveBeenCalled();
  });
});
