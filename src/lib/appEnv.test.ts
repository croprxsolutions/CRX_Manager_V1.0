import { describe, it, expect } from 'vitest';
import { appEnv, envTitlePrefix, isStagingDatabase } from './appEnv';

const LIVE = 'https://rhyzpcqhnizqbxphqdkr.supabase.co';
const STAGING = 'https://fsnjredpmakbmhwowjjt.supabase.co';

describe('appEnv', () => {
  it('reads staging and local from VITE_APP_ENV', () => {
    expect(appEnv('staging', false, LIVE)).toBe('staging');
    expect(appEnv('local', false, LIVE)).toBe('local');
    expect(appEnv('Staging ', false, LIVE)).toBe('staging');
  });

  it('treats the Vite dev server as local unless told otherwise', () => {
    expect(appEnv(undefined, true, LIVE)).toBe('local');
    expect(appEnv('staging', true, LIVE)).toBe('staging');
  });

  it('is production only when unset or "production" and not on the staging database', () => {
    expect(appEnv(undefined, false, LIVE)).toBe('production');
    expect(appEnv('', false, LIVE)).toBe('production');
    expect(appEnv('production', false, LIVE)).toBe('production');
    expect(appEnv(undefined, false, undefined)).toBe('production');
  });

  it('fails loud: a misspelt value or a build on the staging database shows the staging banner', () => {
    expect(appEnv('stagin', false, LIVE)).toBe('staging');
    expect(appEnv(undefined, false, STAGING)).toBe('staging');
    expect(appEnv('production', false, STAGING)).toBe('staging');
    expect(appEnv(undefined, false, 'http://127.0.0.1:54321')).toBe('local');
    expect(appEnv('production', false, 'http://localhost:54321')).toBe('local');
  });
});

describe('isStagingDatabase', () => {
  it('is true only for the staging project, by exact host', () => {
    expect(isStagingDatabase(STAGING)).toBe(true);
    expect(isStagingDatabase('http://127.0.0.1:56321')).toBe(false);
    expect(isStagingDatabase('http://localhost:54321')).toBe(false);
    expect(isStagingDatabase(LIVE)).toBe(false);
    expect(isStagingDatabase('https://fsnjredpmakbmhwowjjt.supabase.co.evil.example')).toBe(false);
    expect(isStagingDatabase(undefined)).toBe(false);
    expect(isStagingDatabase('not a url')).toBe(false);
  });
});

describe('envTitlePrefix', () => {
  it('prefixes staging and local tabs only', () => {
    expect(envTitlePrefix('staging')).toBe('STAGING · ');
    expect(envTitlePrefix('local')).toBe('LOCAL · ');
    expect(envTitlePrefix('production')).toBe('');
  });
});
