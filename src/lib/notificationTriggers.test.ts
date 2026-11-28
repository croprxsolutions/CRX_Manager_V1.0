import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted — cannot reference variables declared outside.
// Use inline return values instead.

vi.mock('./db', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockResolvedValue({ data: [] }),
      gte: vi.fn().mockResolvedValue({ data: [] }),
      in: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

// Mock activityLogger since notificationTriggers imports it
vi.mock('./activityLogger', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  notifyAdmins: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import {
  notifyOrderStatusChange,
  notifyLargeOrder,
} from './notificationTriggers';
import { notifyAdmins } from './activityLogger';

const mockNotifyAdmins = vi.mocked(notifyAdmins);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifyOrderStatusChange', () => {
  it('notifies admins with order status info', async () => {
    await notifyOrderStatusChange('ord-1', 'ORD-001', 'Smith Farms', 'shipped');

    expect(mockNotifyAdmins).toHaveBeenCalledWith(
      expect.stringContaining('shipped'),
      expect.stringContaining('ORD-001'),
      'order_status',
      'order',
      'ord-1'
    );
  });

  it('replaces first underscore with space in status', async () => {
    // Note: source uses .replace('_', ' ') which only replaces the FIRST underscore
    await notifyOrderStatusChange('ord-1', 'ORD-001', 'Farm', 'ready_to_ship');

    const title = mockNotifyAdmins.mock.calls[0][0];
    expect(title).toContain('ready to');
  });

  it('does not throw on failure', async () => {
    mockNotifyAdmins.mockRejectedValueOnce(new Error('fail'));
    await expect(
      notifyOrderStatusChange('o', 'O-1', 'C', 'shipped')
    ).resolves.toBeUndefined();
  });
});

describe('notifyLargeOrder', () => {
  it('notifies admins when total exceeds threshold', async () => {
    await notifyLargeOrder('ord-1', 'ORD-001', 'Big Farm', 75000);

    expect(mockNotifyAdmins).toHaveBeenCalledWith(
      'Large Order Created',
      expect.stringContaining('$75,000'),
      'large_order',
      'order',
      'ord-1'
    );
  });

  it('uses custom threshold when provided', async () => {
    await notifyLargeOrder('ord-1', 'ORD-001', 'Farm', 30000, 25000);
    expect(mockNotifyAdmins).toHaveBeenCalled();
  });

  it('does NOT notify when below threshold', async () => {
    await notifyLargeOrder('ord-1', 'ORD-001', 'Farm', 10000);
    expect(mockNotifyAdmins).not.toHaveBeenCalled();
  });

  it('notifies when exactly at threshold (uses strict less-than)', async () => {
    // Source: if (totalPrice < threshold) return;
    // 50000 < 50000 is false → does NOT return early → DOES notify
    await notifyLargeOrder('ord-1', 'ORD-001', 'Farm', 50000);
    expect(mockNotifyAdmins).toHaveBeenCalled();
  });

  it('does not throw on failure', async () => {
    mockNotifyAdmins.mockRejectedValueOnce(new Error('fail'));
    await expect(
      notifyLargeOrder('o', 'O-1', 'C', 99999)
    ).resolves.toBeUndefined();
  });
});
