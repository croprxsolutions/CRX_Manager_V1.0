/**
 * KI-38: Edge Functions must say loudly when the Sentry key is missing,
 * without ever blocking their real work (sending email, creating users).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FUNCTIONS_DIR = join(ROOT, 'supabase', 'functions');
// Variable specifier so tsc (src config, no Deno types) does not follow into the Deno file.
const SENTRY_MODULE = '../../supabase/functions/_shared/sentry.ts';
type SentryModule = { warnIfSentryMisconfigured: (fn: string) => void };
const loadSentry = () => import(/* @vite-ignore */ SENTRY_MODULE) as Promise<SentryModule>;

function stubDsn(value: string | undefined) {
  vi.stubGlobal('Deno', { env: { get: (k: string) => (k === 'SENTRY_DSN' ? value : undefined) } });
}

describe('warnIfSentryMisconfigured', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('logs an error, and does not throw, when the key is missing', async () => {
    stubDsn(undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { warnIfSentryMisconfigured } = await loadSentry();
    expect(() => warnIfSentryMisconfigured('send-email')).not.toThrow();
    expect(err).toHaveBeenCalledOnce();
    expect(String(err.mock.calls[0][0])).toContain('[SENTRY_MISCONFIG] function=send-email');
  });

  it('logs an error without echoing the key when it is malformed', async () => {
    stubDsn('https://secretkeyvalue@not-a-valid-dsn');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { warnIfSentryMisconfigured } = await loadSentry();
    expect(() => warnIfSentryMisconfigured('create-user')).not.toThrow();
    expect(err).toHaveBeenCalledOnce();
    expect(String(err.mock.calls[0][0])).toContain('malformed');
    expect(String(err.mock.calls[0][0])).not.toContain('secretkeyvalue');
  });

  it('stays quiet when the key is well-formed', async () => {
    stubDsn('https://abc123@o1.ingest.sentry.io/42');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { warnIfSentryMisconfigured } = await loadSentry();
    warnIfSentryMisconfigured('epa-lookup');
    expect(err).not.toHaveBeenCalled();
  });
});

describe('every Edge Function runs the Sentry boot check', () => {
  const fns = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .filter((name) => existsSync(join(FUNCTIONS_DIR, name, 'index.ts')));

  it('finds the functions', () => {
    expect(fns.length).toBeGreaterThanOrEqual(8);
  });

  for (const name of fns) {
    it(`${name} calls warnIfSentryMisconfigured("${name}") at module top`, () => {
      const src = readFileSync(join(FUNCTIONS_DIR, name, 'index.ts'), 'utf8');
      const call = `warnIfSentryMisconfigured("${name}");`;
      expect(src.split(/\r?\n/)).toContain(call);
      expect(src.indexOf(call)).toBeLessThan(src.indexOf('Deno.serve('));
    });
  }
});
