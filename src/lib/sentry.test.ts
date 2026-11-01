/**
 * sentry.test.ts — Tests for Sentry initialization + config
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock @sentry/react ───────────────────────────────────────────────────

const mockInit = vi.fn();

vi.mock('@sentry/react', () => ({
  init: mockInit,
}));

// ── Tests ────────────────────────────────────────────────────────────────

describe('initSentry', () => {
  const originalEnv = { ...import.meta.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env
    Object.assign(import.meta.env, originalEnv);
  });

  it('does nothing when VITE_SENTRY_DSN is not set', async () => {
    import.meta.env.VITE_SENTRY_DSN = '';
    const { initSentry } = await import('./sentry');
    initSentry();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('calls Sentry.init when DSN is provided', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('passes correct DSN and sample rates', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();
    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://abc@o123.ingest.sentry.io/456',
        sampleRate: 1.0,
        tracesSampleRate: 0.1,
      }),
    );
  });

  it('includes ignoreErrors list', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();
    const config = mockInit.mock.calls[0][0];
    expect(config.ignoreErrors).toContain('ResizeObserver loop');
    expect(config.ignoreErrors).toContain('Failed to fetch');
    expect(config.ignoreErrors).toContain('NetworkError');
  });

  it('beforeSend redacts JWT tokens from messages', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();

    const config = mockInit.mock.calls[0][0];
    const event = {
      message: 'Error with token eyJhbGciOiJIUzI1NiJ9.payload.signature',
    };
    const result = config.beforeSend(event);
    expect(result.message).toContain('[JWT_REDACTED]');
    expect(result.message).not.toContain('eyJ');
  });

  it('beforeSend passes through events without messages', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();

    const config = mockInit.mock.calls[0][0];
    const event = { exception: { values: [] } };
    const result = config.beforeSend(event);
    expect(result).toEqual(event);
  });

  describe('beforeBreadcrumb', () => {
    const FILTERED_PATH = '/rest/v1/allocation_sets?customer_id=eq.11111111-2222-3333-4444-555555555555'
      + '&total_payment_cents=eq.123456';

    async function scrubber() {
      import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
      const { initSentry } = await import('./sentry');
      initSentry();
      return mockInit.mock.calls[0][0].beforeBreadcrumb;
    }

    it.each(['fetch', 'xhr'])('removes filter values from %s urls and keeps method and status', async (category) => {
      const beforeBreadcrumb = await scrubber();
      const result = beforeBreadcrumb({
        category,
        type: 'http',
        data: { method: 'GET', status_code: 200, url: `https://x.supabase.co${FILTERED_PATH}` },
      });
      expect(result.data).toEqual({
        method: 'GET',
        status_code: 200,
        url: 'https://x.supabase.co/rest/v1/allocation_sets?[REDACTED]',
      });
    });

    it('removes filter values from the crumb db.ts writes', async () => {
      const beforeBreadcrumb = await scrubber();
      const result = beforeBreadcrumb({
        category: 'supabase',
        message: `GET ${FILTERED_PATH}`,
        data: { requestId: 'req-1' },
      });
      expect(result.message).toBe('GET /rest/v1/allocation_sets?[REDACTED]');
      expect(result.data).toEqual({ requestId: 'req-1' });
    });

    it('removes a fragment and everything after a line break', async () => {
      const beforeBreadcrumb = await scrubber();
      expect(beforeBreadcrumb({ category: 'supabase', message: 'GET /auth/v1/verify#token=abc\nsecond line' }).message)
        .toBe('GET /auth/v1/verify?[REDACTED]');
    });

    it('leaves a url without a query alone and passes other crumbs through', async () => {
      const beforeBreadcrumb = await scrubber();
      const rpc = { category: 'fetch', data: { method: 'POST', url: 'https://x.supabase.co/rest/v1/rpc/allocate_payment' } };
      expect(beforeBreadcrumb(rpc)).toEqual(rpc);
      const click = { category: 'ui.click', message: 'button?not-a-url' };
      expect(beforeBreadcrumb(click)).toEqual(click);
    });
  });
});
