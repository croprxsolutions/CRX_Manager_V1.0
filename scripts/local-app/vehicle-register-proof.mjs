
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(process.cwd().toLowerCase()).digest('hex').slice(0, 8);
const target = await import('./target.mjs');
const raw = readFileSync(new URL('./.state/screen-walk/local.env', import.meta.url), 'utf8');
const state = Object.fromEntries(raw.trim().split(/\r?\n/).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
target.assertCleanEnvironment();
target.assertLocalState(state);
assert(await target.portIsOpen(target.APP_PORT), 'The owned local walkthrough is stopped');
await target.assertFrontendIsOurs(state.LOCAL_ANON_KEY);

const docker = (args, input) => {
  const result = spawnSync('docker', args, { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
target.assertLocalDockerEndpoint(docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
const container = target.PROJECT + '-db-1';
assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]), target.PROJECT);

const accounts = [['admin', true], ['sales_rep', true], ['driver', true], ['applicator', true], ['entity_recipient', true], ['admin', false]]
  .map(([role, active], i) => ({ role, active, id: randomUUID(), name: 'Invented vehicle proof ' + (i + 1) }));
const owned = [randomUUID(), randomUUID()];
const profiles = accounts.map(user => `INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES ('${user.id}','${user.id}@fixture.example.test','${user.name}','${user.role}',${user.active});`).join('\n');
const checks = accounts.map(({ role, active, id }) => `
  SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);
  SELECT set_config('request.jwt.claim.sub', '${id}', true);
  SET LOCAL ROLE authenticated;
  DO $proof$ BEGIN
    IF (SELECT count(*) FROM public.admin_vehicle_register WHERE id IN ('${owned.join("','")}')
      AND registration = 'INVENTED' AND notes = 'Invented private note') <> ${role === 'admin' && active ? 2 : 0}
    THEN RAISE EXCEPTION 'Admin register scope mismatch'; END IF;
    IF has_table_privilege(current_user, 'public.admin_vehicle_register', 'INSERT, UPDATE, DELETE')
    THEN RAISE EXCEPTION 'Admin register permits browser writes'; END IF;
    BEGIN
      UPDATE public.admin_vehicle_register SET notes = 'Invented attempted edit' WHERE id = '${owned[0]}';
      RAISE EXCEPTION 'A browser role could edit the register view';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END $proof$;
  RESET ROLE;
`).join('\n');
docker(['exec', '-i', container, 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'], `
  BEGIN;
  SET LOCAL session_replication_role = replica;
  ${profiles}
  INSERT INTO public.vehicles (id, vehicle_name, vehicle_type, status, registration, notes) VALUES
    ('${owned[0]}','Invented Active Vehicle','ground','active','INVENTED','Invented private note'),
    ('${owned[1]}','Invented Retired Vehicle','air','inactive','INVENTED','Invented private note');
  SET LOCAL session_replication_role = origin;
  ${checks}
  SET LOCAL ROLE anon;
  DO $anon$ BEGIN
    BEGIN
      PERFORM id FROM public.admin_vehicle_register;
      RAISE EXCEPTION 'The anonymous role could read the admin register';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END $anon$;
  RESET ROLE;
  ROLLBACK;
`);
console.log('VEHICLE_ADMIN_REGISTER_ROLE_PROOF_PASS');

