import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lanePath = process.platform === 'win32' ? root.toLowerCase() : root;
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(lanePath).digest('hex').slice(0, 8);
const target = await import('./target.mjs');
const { localSql } = await import('./e2e/local-db.ts');

target.assertCleanEnvironment();
const raw = readFileSync(new URL(`./${target.STATE_FOLDER}/local.env`, import.meta.url), 'utf8');
const state = Object.fromEntries(raw.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#')).map(line => {
  const equals = line.indexOf('=');
  return [line.slice(0, equals), line.slice(equals + 1)];
}));
target.assertLocalState(state);

const migrations = new URL('../../supabase/migrations/', import.meta.url);
const filename = readdirSync(migrations).find(name => name.endsWith('_record_standard_delivery_assignment_notice.sql'));
assert(filename, 'Delivery assignment migration missing from this checkout');
const candidate = readFileSync(new URL(filename, migrations), 'utf8');
const previous = readFileSync(new URL('20261110160000_bind_money_inventory_replay_receipts_batch4c.sql', migrations), 'utf8');
const historical = previous.match(/CREATE FUNCTION public\.create_delivery_with_items\([\s\S]+?\$function\$;/)?.[0];
assert(historical, 'Expected delivery wrapper missing from the historical migration');
const restore = `
  DROP TRIGGER IF EXISTS notifications_skip_repeated_delivery_assignment ON public.notifications;
  DROP FUNCTION IF EXISTS public.skip_repeated_delivery_assignment_notice();
  ${historical.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')}
`;

function expectSqlStop(sql, ...signals) {
  assert.throws(() => localSql(`SET ROLE postgres;\n${sql}`), error => {
    const output = String(error.stderr ?? error.message);
    return signals.every(signal => output.includes(signal));
  });
}

expectSqlStop(candidate, 'DELIVERY_ASSIGNMENT_NOTICE_NEEDS_TRANSACTION');
expectSqlStop(`BEGIN;\n${restore.replace('DECLARE', 'DECLARE\n  -- Invented body drift for the local proof.')}\n${candidate}\nROLLBACK;`,
  'DELIVERY_ASSIGNMENT_NOTICE_PREFLIGHT_MISMATCH');
expectSqlStop(`BEGIN;\n${restore}\n${candidate}\nDROP TABLE pg_temp.delivery_assignment_notice_tx;\n${candidate}\nROLLBACK;`,
  'DELIVERY_ASSIGNMENT_NOTICE_PREFLIGHT_MISMATCH');

const roles = ['admin', 'admin', 'driver', 'applicator'];
const profiles = roles.map(role => {
  const id = randomUUID();
  return `('${id}','${id}@fixture.example.test','Invented delivery proof ${role} ${id.slice(0, 8)}','${role}',true)`;
}).join(',');
const smoke = readFileSync(new URL('../smoke/smoke-replay-binding-batch4c.sql', import.meta.url), 'utf8');
expectSqlStop(`
  BEGIN;
  ${restore}
  ${candidate}
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES ${profiles};
  SET LOCAL session_replication_role = origin;
  ${smoke}
  ROLLBACK;
`, 'SMOKE_DELIVERY_ASSIGNMENT_CASES_RAN', 'SMOKE_PASS_ROLLBACK');
console.log('DELIVERY_ASSIGNMENT_MIGRATION_PROOF_PASS');
