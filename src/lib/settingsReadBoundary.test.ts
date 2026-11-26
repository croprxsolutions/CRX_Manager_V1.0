import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const migrations = 'supabase/migrations';
const migration = readdirSync(join(root, migrations)).find((name) => name.endsWith('_scope_app_settings_browser_reads.sql'));
if (!migration) throw new Error('Settings access migration is missing');
const policy = read(join(migrations, migration));
const policyKeys = new Set([...policy.matchAll(/'([a-z][a-z0-9_]+)'/g)].map((match) => match[1]));

describe('staff settings access', () => {
  it('includes the settings read by ordinary browser workflows', () => {
    const paths = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.(test|spec)\./.test(path));
    const sources = paths.map((path) => read(join('src', path))).join('\n');
    const sharedCompany = read('supabase/functions/_shared/pdf/companyInfo.ts');
    const keys = [
      ...[...sources.matchAll(/\.eq\(\s*'setting_key'\s*,\s*'([a-z_]+)'/g)].map((match) => match[1]),
      ...[...sources.matchAll(/readAppSetting\(\s*'([a-z_]+)'/g)].map((match) => match[1]),
      ...[...sources.matchAll(/const (?:LABEL_RATE_GUARDRAIL_MODE|APPLICATOR_PRINT_OPTIONS|SPLIT_BILLING_SETTING)_KEY\s*=\s*'([a-z_]+)'/g)].map((match) => match[1]),
      ...[...sharedCompany.matchAll(/^\s*(company_[a-z_]+): '[a-z]+'/gm)].map((match) => match[1]),
    ];
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(policyKeys, key).toContain(key);
  });

  it('requires active profiles and preserves the three legitimate access groups', () => {
    expect(policy).toMatch(/\(SELECT public\.is_active_profile\(\)\)/);
    expect(policy).toMatch(/\(SELECT public\.is_admin\(\)\)/);
    expect(policy).toMatch(/public\.is_sales_rep\(\).*public\.is_driver\(\).*public\.is_applicator\(\).*\n\s+AND setting_key IN \('company_name', 'company_phone', 'company_email', 'company_address'\)/);
    expect(policy).toMatch(/public\.is_sales_rep\(\).*public\.is_applicator\(\).*\n\s+AND setting_key IN \('label_rate_guardrail_mode'/);
    expect(policy).not.toContain("'entity_recipient'");
  });
});
