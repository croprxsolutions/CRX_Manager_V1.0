import { describe, expect, it } from 'vitest';
import { billingM4Enabled } from './billingFeatures';
import { appEnv } from './appEnv';

describe('billingM4Enabled', () => {
  it('is on for staging and local, off for production', () => {
    expect(billingM4Enabled('staging')).toBe(true);
    expect(billingM4Enabled('local')).toBe(true);
    expect(billingM4Enabled('production')).toBe(false);
  });

  it('is off for a live build: no VITE_APP_ENV, not dev, the live database', () => {
    expect(billingM4Enabled(appEnv(undefined, false, 'https://live-project.supabase.co'))).toBe(false);
    expect(billingM4Enabled(appEnv('production', false, 'https://live-project.supabase.co'))).toBe(false);
  });

  it('is on for the staging build', () => {
    expect(billingM4Enabled(appEnv('staging', false, 'https://live-project.supabase.co'))).toBe(true);
  });
});
