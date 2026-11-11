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

  describe('beforeSend with a Supabase error object', () => {
    async function beforeSend() {
      import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
      const { initSentry } = await import('./sentry');
      initSentry();
      return mockInit.mock.calls[0][0].beforeSend;
    }
    const synthetic = () => ({
      exception: { values: [{ type: 'Error', value: 'Object captured as exception with keys: code, details, hint, message' }] },
    });

    it('drops a network blip the ignore list cannot see', async () => {
      const send = await beforeSend();
      const original = { code: '', details: 'TypeError: Failed to fetch', hint: '', message: 'TypeError: Failed to fetch (x.supabase.co)' };
      expect(send(synthetic(), { originalException: original })).toBeNull();
    });

    it('titles the event with the database message', async () => {
      const send = await beforeSend();
      const original = { code: '22P02', details: null, hint: null, message: 'invalid input syntax for type uuid: "group"' };
      expect(send(synthetic(), { originalException: original }).exception.values[0].value)
        .toBe('invalid input syntax for type uuid: "group"');
    });

    it.each([
      'Failed to fetch (x.supabase.co)',
      'TypeError: NetworkError when attempting to fetch resource. (x.supabase.co)',
      'TypeError: Load failed',
    ])('drops the network failure %s', async (message) => {
      const send = await beforeSend();
      expect(send(synthetic(), { originalException: { code: '', details: '', hint: '', message } })).toBeNull();
    });

    it('keeps a database error that only mentions fetching', async () => {
      const send = await beforeSend();
      const original = { code: 'P0001', details: null, hint: null, message: 'Failed to fetch the current inventory row' };
      expect(send(synthetic(), { originalException: original }).exception.values[0].value)
        .toBe('Failed to fetch the current inventory row');
    });

    it('keeps a real Error title', async () => {
      const send = await beforeSend();
      const event = { exception: { values: [{ type: 'Error', value: 'boom' }] } };
      expect(send(event, { originalException: new Error('Failed to fetch') }).exception.values[0].value).toBe('boom');
    });
  });

  describe('only known-safe fields reach Sentry (Mason, 2026-11-10, option B)', () => {
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
    const PROBES = [JWT, 'r3fr35h', 'pkce_123', 'c00kie', 'h3ader', 'xtra', 'ctx_secret', 'crumbdata', 'crumbmsg', '1,250.75'];
    async function hooks() {
      import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
      const { initSentry } = await import('./sentry');
      initSentry();
      return mockInit.mock.calls[0][0];
    }
    const frame = { filename: 'https://croprxsolutions.app/assets/index-abc.js?v=pkce_123', function: 'pay', lineno: 10, colno: 4, in_app: true, vars: { t: JWT }, context_line: 'xtra' };
    const loaded = () => ({
      event_id: 'e1', timestamp: 1, platform: 'javascript', level: 'error', release: 'r1', environment: 'production',
      sdk: { name: 'sentry.javascript.react', version: '10' }, fingerprint: ['f'], tags: { mechanism: 'unhandledrejection' },
      user: { id: 'u1', email: 'h3ader@example.com', ip_address: '1.2.3.4' },
      transaction: '/reset-password#access_token=' + JWT,
      message: `Allocation of 1,250.75 failed, refresh_token=r3fr35h ${JWT}`,
      exception: { values: [{ type: 'Error', value: `Payment of 1,250.75 failed Bearer ${JWT}`, mechanism: { type: 'generic', handled: true, data: { t: JWT } }, stacktrace: { frames: [frame] } }] },
      extra: { __serialized__: { details: `Bearer ${JWT}` }, note: 'xtra' },
      contexts: { trace: { trace_id: 't1', span_id: 's1', data: { url: '?code=pkce_123' } }, supabase: { headers: { authorization: 'ctx_secret' } } },
      breadcrumbs: [
        { category: 'navigation', timestamp: 2, data: { to: '/reset-password#refresh_token=r3fr35h' } },
        { category: 'supabase', timestamp: 3, message: 'crumbmsg', data: { q: 'crumbdata' } },
      ],
      request: { url: 'https://croprxsolutions.app/auth/confirm?token_hash=pkce_123', headers: { Cookie: 'c00kie', Referer: 'h3ader' }, cookies: { sb: 'c00kie' }, query_string: 'pkce_123' },
      spans: [{ span_id: 's2', trace_id: 't1', start_timestamp: 1, op: 'http.client', description: 'GET https://x.supabase.co/rest/v1/payments?amount=eq.1,250.75&token=pkce_123', data: { 'http.url': JWT } }],
    });

    it.each(['beforeSend', 'beforeSendTransaction'])('%s lets no probe value through', async (hook) => {
      const result = (await hooks())[hook](loaded(), { originalException: new Error('x') });
      const text = JSON.stringify(result);
      for (const probe of PROBES) expect(text).not.toContain(probe);
    });

    it('keeps what Sentry needs to group and locate the error', async () => {
      const result = (await hooks()).beforeSend(loaded(), { originalException: new Error('x') });
      expect(result.exception.values[0]).toEqual({
        type: 'Error',
        value: 'Payment of # failed [REDACTED]',
        mechanism: { type: 'generic', handled: true },
        stacktrace: { frames: [{ filename: 'https://croprxsolutions.app/assets/index-abc.js', function: 'pay', lineno: 10, colno: 4, in_app: true }] },
      });
      expect(result.tags).toEqual({ mechanism: 'unhandledrejection' });
      expect(result.user).toEqual({ id: 'u1' });
      expect(result.breadcrumbs).toEqual([{ category: 'navigation', timestamp: 2 }, { category: 'supabase', timestamp: 3 }]);
      expect(result.contexts).toEqual({ trace: { trace_id: 't1', span_id: 's1' } });
      expect(result.request).toEqual({ url: 'https://croprxsolutions.app/auth/confirm' });
      expect(result.transaction).toBe('/reset-password');
      expect(result.spans[0].description).toBe('GET https://x.supabase.co/rest/v1/payments');
      expect(result.extra).toBeUndefined();
    });

    it('blanks figures in a plain database error used as the title', async () => {
      const event = { exception: { values: [{ type: 'Error', value: 'Object captured as exception with keys: code, message' }] }, extra: { __serialized__: { message: 'x' } } };
      const original = { code: 'P0001', message: 'Allocation of 1,250.75 exceeds balance 980.10' };
      const result = (await hooks()).beforeSend(event, { originalException: original });
      expect(result.exception.values[0].value).toBe('Allocation of # exceeds balance #');
      expect(result.extra).toBeUndefined();
    });

    it('keeps the trace header path-only and leaves live SDK objects alone', async () => {
      class Scope { label = 'kept'; }
      const scope = new Scope();
      const event = { sdkProcessingMetadata: { capturedSpanScope: scope, dynamicSamplingContext: { trace_id: 't1', transaction: '/x?token=pkce_123' } } };
      const result = (await hooks()).beforeSendTransaction(event);
      expect(result.sdkProcessingMetadata.dynamicSamplingContext).toEqual({ trace_id: 't1', transaction: '/x' });
      expect(result.sdkProcessingMetadata.capturedSpanScope).toBe(scope);
    });
  });
});
