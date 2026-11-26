import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'supabase', 'migrations');
const names = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
const candidate = names.findIndex((name) => name.endsWith('_rebate_claim_create_transition_rpc_only.sql'));
const read = (file: string) => readFileSync(file, 'utf8').replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ');

describe('rebate claim creation and status changes', () => {
  it('revokes browser writes and rejects later direct write grants', () => {
    expect(candidate).toBeGreaterThanOrEqual(0);
    const migration = read(join(dir, names[candidate]));
    expect(migration).toMatch(/REVOKE INSERT, UPDATE, TRUNCATE ON TABLE public\.rebate_claims FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/DROP POLICY IF EXISTS rebate_claims_insert ON public\.rebate_claims/);
    expect(migration).toMatch(/DROP POLICY IF EXISTS rebate_claims_update ON public\.rebate_claims/);
    expect(migration).toContain("has_any_column_privilege('authenticated', 'public.rebate_claims', 'INSERT, UPDATE')");
    for (const name of names.slice(candidate + 1)) {
      const grants = read(join(dir, name)).match(/\bGRANT\b[^;]+/gi) ?? [];
      for (const grant of grants) {
        const target = grant.match(/\bON\s+(?:TABLE\s+)?(.+?)\s+TO\s+(.+)/i);
        if (!target || !/\brebate_claims\b|^ALL TABLES IN SCHEMA (?:[^;]+,\s*)?public\b/i.test(target[1])
          || /^\s*(service_role|postgres|supabase_admin)(\s*,\s*(service_role|postgres|supabase_admin))*\s*$/i.test(target[2])) continue;
        expect(grant, name).not.toMatch(/^GRANT\b.*\b(INSERT|UPDATE|TRUNCATE|ALL)\b.*\bON\b/i);
      }
    }
  });

  it('keeps browser create and transition actions on guarded operations', () => {
    const page = read(join(process.cwd(), 'src', 'pages', 'Rebates.tsx'));
    expect(page).toMatch(/\.rpc\('create_rebate_claim'/);
    expect(page).toMatch(/\.rpc\('transition_rebate_claim'/);
    expect(page).not.toMatch(/\.from\('rebate_claims'\)\s*\.(?:insert|update|upsert)\(/);
  });
});
