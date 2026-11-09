import { describe, it, expect } from 'vitest';
import { appEnv, envTitlePrefix } from './appEnv';

describe('appEnv', () => {
  it('reads staging and local from VITE_APP_ENV', () => {
    expect(appEnv('staging', false)).toBe('staging');
    expect(appEnv('local', false)).toBe('local');
    expect(appEnv('Staging ', false)).toBe('staging');
  });

  it('treats the Vite dev server as local unless told otherwise', () => {
    expect(appEnv(undefined, true)).toBe('local');
    expect(appEnv('staging', true)).toBe('staging');
  });

  it('falls back to production for unset or unknown values', () => {
    expect(appEnv(undefined, false)).toBe('production');
    expect(appEnv('', false)).toBe('production');
    expect(appEnv('prod', false)).toBe('production');
  });
});

describe('envTitlePrefix', () => {
  it('prefixes staging and local tabs only', () => {
    expect(envTitlePrefix('staging')).toBe('STAGING · ');
    expect(envTitlePrefix('local')).toBe('LOCAL · ');
    expect(envTitlePrefix('production')).toBe('');
  });
});
