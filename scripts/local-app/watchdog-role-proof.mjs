import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Run against a started walkthrough from this checkout. All fixtures roll back.
const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
process.env.CRX_LOCAL_APP_LANE = createHash('sha256')
  .update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 8);
const target = await import('./target.mjs');
const state = Object.fromEntries(readFileSync(new URL('./.state/screen-walk/local.env', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
target.assertCleanEnvironment();
target.assertLocalState(state);
assert(await target.portIsOpen(target.APP_PORT), 'Start this checkout’s local walkthrough first');
await target.assertFrontendIsOurs(state.LOCAL_ANON_KEY);

const docker = (args, input) => {
  const run = spawnSync('docker', args, { input, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  return run.stdout.trim();
};
target.assertLocalDockerEndpoint(docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
const container = target.PROJECT + '-db-1';
assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]), target.PROJECT);

const accounts = ['admin', 'sales_rep', 'driver', 'applicator'].map(role => ({ role, user: randomUUID(), flag: randomUUID() }));
const fixtures = accounts.map(({ user, role, flag }) => `
  INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${user}', '${user}@watchdog-proof.example.test', '{"full_name":"Invented Watchdog user","role":"${role}"}');
  INSERT INTO public.profiles (id, email, full_name, role, is_active)
    VALUES ('${user}', '${user}@watchdog-proof.example.test', 'Invented Watchdog ${role}', '${role}', true);
  INSERT INTO public.watchdog_flags (id, flag_type, entity_type, entity_id, message)
    VALUES ('${flag}', 'acre_divergence', 'job', '${flag}', 'Invented Watchdog flag');
`).join('\n');

const checks = accounts.map(({ role, user, flag }) => {
  const read = `SELECT count(*) INTO seen FROM public.get_watchdog_flags() f WHERE f.id = '${flag}';`;
  const dismiss = `first_result := public.dismiss_watchdog_flag('${flag}', 'looks_fine', NULL, NULL, '${flag}');`;
  const office = ['admin', 'sales_rep'].includes(role);
  const refused = sql => `BEGIN
    ${sql}
    RAISE EXCEPTION 'USING_WRONG_ROLE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'WATCHDOG_ACCESS_DENIED:%' THEN RAISE; END IF;
  END;`;
  return `
SELECT set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${user}', true);
SET LOCAL ROLE authenticated;
DO $prove$
DECLARE seen integer; first_result jsonb;
BEGIN
  ${office ? `${read}
  IF seen <> 1 THEN RAISE EXCEPTION 'An office user could not see a seeded Watchdog flag'; END IF;
  ${dismiss}
  IF first_result IS DISTINCT FROM public.dismiss_watchdog_flag('${flag}', 'looks_fine', NULL, NULL, '${flag}')
    OR NOT EXISTS (SELECT 1 FROM public.get_watchdog_flags(p_include_dismissed => true) f
      WHERE f.id = '${flag}' AND f.dismissed_by = '${user}' AND f.is_dismissed)
  THEN RAISE EXCEPTION 'Watchdog dismissal replay or actor mismatch'; END IF;
  PERFORM public.refresh_watchdog_flags(p_job_id => '${flag}');` :
    [read, dismiss, 'PERFORM public.refresh_watchdog_flags();'].map(refused).join('\n')}
END
$prove$;
RESET ROLE;`;
}).join('\n');
docker(['exec', '-i', container, 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'], `
BEGIN;
SET LOCAL session_replication_role = replica;
${fixtures}
SET LOCAL session_replication_role = origin;
DO $grants$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES ('anon'), ('authenticated')) r(role_name)
    CROSS JOIN (VALUES ('public.watchdog_flags'), ('public.watchdog_flag_dismissals')) t(relation_name)
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('TRIGGER')) p(privilege)
    WHERE has_table_privilege(r.role_name, t.relation_name, p.privilege)
  ) OR EXISTS (
    SELECT 1 FROM (VALUES ('anon'), ('authenticated')) r(role_name)
    CROSS JOIN (VALUES ('public.watchdog_flags'), ('public.watchdog_flag_dismissals')) t(relation_name)
    WHERE has_any_column_privilege(r.role_name, t.relation_name, 'INSERT, UPDATE')
  ) THEN RAISE EXCEPTION 'Direct browser Watchdog write privilege remains'; END IF;
  IF NOT has_table_privilege('service_role', 'public.watchdog_flags', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.watchdog_flag_dismissals', 'INSERT') THEN
    RAISE EXCEPTION 'The Watchdog service role lost existing write access';
  END IF;
END
$grants$;
${checks}
ROLLBACK;`);
console.log('WATCHDOG_ROLE_PROOF_PASS');
