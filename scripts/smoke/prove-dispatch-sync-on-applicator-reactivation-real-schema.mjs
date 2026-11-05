#!/usr/bin/env node
/**
 * Real-schema proof for KI-28 (20261107160000). Builds the checked-in schema baseline in a network-disabled
 * PostgreSQL container and replays migrations up to the candidate. With invented rows, BEFORE the candidate: a job
 * assigned to an inactive applicator gets no dispatch rows, and re-activating that person (admin_update_profile,
 * the admin screen's call) still adds none. AFTER the candidate (a second apply refuses; applying writes no rows):
 * activating the person puts each missing location of their open job on the board exactly once; a wizard split to
 * another applicator, a completed job and a deleted job are untouched; a retry with the same key, a second save,
 * and off/on again add nothing; an applicator whose only license expired is skipped; a driver made applicator is
 * synced; the detection sweep ends at zero rows. The new function is SECURITY DEFINER, search_path pinned,
 * EXECUTE postgres-only.
 *
 * Run: node scripts/smoke/prove-dispatch-sync-on-applicator-reactivation-real-schema.mjs   (needs local Docker image)
 * Prints KI28_DISPATCH_SYNC_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-ki28-dispatch-sync-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);  // a kept container still before the candidate
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261107160000_dispatch_sync_on_applicator_reactivation.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations and DATA-11 rewrite live rows this disposable database does not have
// (DATA-11 also needs a live admin approver); they are recorded in the ledger (as live has them)
// instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(_sync_job_location_dispatch_on_|trg_sync_job_location_dispatch_|FUNCTION\s+(public\.)?"?admin_update_profile\b|ON (public\.)?profiles\b)/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove ${staged}: ${e.message}`); }
  }
}
function apply(name) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
function ledger(stem) {
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    SELECT '${stem.slice(0, 14)}', '${stem}', ARRAY[]::text[]
     WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${stem}')
    ON CONFLICT (version) DO NOTHING;`);
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`), '1', `${stem} is not in the ledger`);
}
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}
// 20261104150000 (WP-PM-9, live) pins three live function bodies that the historical LF replay
// does not reproduce; install them exactly as PM-9's own prover does, right before that file.
const FORMS_SEED_EACH = '20261104150000_product_forms_seed_each.sql';
const LIVE_BODY_MD5 = {
  'public.field_app_priced_quantity(numeric,text,text,text)': 'bc91a52577840973f18f1710e47edf2b',
  'public.convert_to_gl_lb(numeric,text,text)': 'ce9265521821c09b0cf74de45afb375b',
  'public.validate_product_units()': '83a51c58c83cd83bea760bd117410a38',
};

function bodyFrom(file, expression) {
  const match = expression.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  assert.ok(match, `${file} no longer contains its pinned function body`);
  return match[1];
}
function restoreLiveBodies() {
  // Historical replay uses LF staging; validate_product_units had CRLF in live prosrc.
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)
    .replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');  // same bytes on an LF or CRLF checkout
  const field = bodyFrom('20260630180000_field_app_pricing_unit_fix.sql',
    /CREATE OR REPLACE FUNCTION public.field_app_priced_quantity\([\s\S]*?AS \$fapq\$([\s\S]*?)\$fapq\$;/);
  const seededConvert = bodyFrom(FORMS_SEED_EACH,
    /CREATE OR REPLACE FUNCTION public.convert_to_gl_lb\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/).replaceAll('\r\n', '\n');
  const seedArm = "  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN QUERY SELECT NULL::numeric, NULL::text; RETURN; END IF;\n";
  assert.equal(seededConvert.split(seedArm).length - 1, 1);
  const convert = seededConvert.replace(seedArm, '');
  psql(`CREATE OR REPLACE FUNCTION public.validate_product_units() RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp AS $live_validate$${validate}$live_validate$;`);
  psql(`CREATE OR REPLACE FUNCTION public.field_app_priced_quantity(
      p_applied_qty numeric, p_rate_unit text, p_inventory_unit text, p_product_form text)
    RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp
    AS $live_field$${field}$live_field$;`);
  psql(`CREATE OR REPLACE FUNCTION public.convert_to_gl_lb(
      p_total_applied numeric, p_rate_unit text, p_product_form text)
    RETURNS TABLE(converted_value numeric, converted_unit text) LANGUAGE plpgsql IMMUTABLE
    SET search_path = public AS $live_convert$${convert}$live_convert$;`);
  for (const [signature, expected] of Object.entries(LIVE_BODY_MD5)) {
    assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${signature}'::regprocedure;`),
      expected, `${signature} is not the pinned live body before the candidate`);
  }
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it relies on; re-think this proof`);
  }
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  // storage.objects carries metadata and a (bucket_id, name) key, and postgres may read it, as live
  // has them: 20261022075000 (replayed before the candidate) checks that shape in its preflight.
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const SWEEP = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'dispatch-sync-nonqualifying-profile.sql');
const FN = 'public._sync_job_location_dispatch_on_applicator_qualify()';

// Each phase (before / after the candidate) seeds its own rows.
let PHASE = Number(process.env.KI28_PHASE || 1);  // a reused container needs fresh rows
const id = (n) => `28000000-000${PHASE}-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = () => id('a1');
const CUSTOMER = () => id('c1');
const FIELD = (n) => id(`f${n}`);
// People: A = inactive applicator (the KI-28 case), B = active applicator (a wizard split),
// X = inactive applicator whose only tracked license has expired, D = active driver later made applicator.
const PERSON = { A: 'b1', B: 'b2', X: 'b3', D: 'b4' };
const P = (k) => id(PERSON[k]);
const JOB = { open: 'd1', done: 'd2', deleted: 'd3', expired: 'd4', role: 'd5' };
const J = (k) => id(JOB[k]);
const JF = (k, n) => id(`e${JOB[k].slice(1)}${n}`);

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function asAdmin(sql, options = {}) {
  return docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${claims(ADMIN())}\nSET LOCAL ROLE authenticated;\n${sql}\nCOMMIT;`, allowFailure: options.allowFailure });
}
function updateProfile(person, args, key) {
  const r = asAdmin(`SELECT public.admin_update_profile(target_user_id => '${P(person)}', ${args}, p_idempotency_key => ${key ? `'${key}'` : 'NULL'})::text;`);
  const out = r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  // A replayed key returns the cached jsonb, which prints with different spacing.
  assert.deepEqual(JSON.parse(out ?? 'null'), { success: true }, `admin_update_profile ${person} ${args}: ${r.stdout}${r.stderr}`);
}

function seed() {
  const user = (uid, tag, role) => `('${uid}', 'ki28-${tag}-${PHASE}@example.invalid', '{"full_name":"[PROVER] KI28 ${tag} ${PHASE}","role":"${role}"}'::jsonb)`;
  // Live's auth schema has these and _sync_auth_access_on_profile_active writes them; the image's does not
  // (as prove-blend-tickets-application-records-only seeds them).
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  // The profile role lock lets only an admin change is_active, so the seed deactivates A and X as the admin.
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${user(ADMIN(), 'admin', 'admin')}, ${user(P('A'), 'a', 'applicator')}, ${user(P('B'), 'b', 'applicator')},
      ${user(P('X'), 'x', 'applicator')}, ${user(P('D'), 'd', 'driver')};
    ${claims(ADMIN())}
    UPDATE public.profiles SET is_active = false WHERE id IN ('${P('A')}', '${P('X')}');
    COMMIT;
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUSTOMER()}', '[PROVER] KI28 Farm ${PHASE}');
    INSERT INTO public.fields (id, customer_id, field_name)
      SELECT ('28000000-000${PHASE}-4000-8000-' || lpad('f' || n, 12, '0'))::uuid, '${CUSTOMER()}', '[PROVER] KI28 field ' || n
        FROM generate_series(1, 9) n;`);
  const job = (k, applicator, status, fields, extra = '') => `
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id, created_by)
      VALUES ('${J(k)}', 'PROVER-KI28-${PHASE}-${k}', '${CUSTOMER()}', current_date, '${status}', '${P(applicator)}', '${ADMIN()}');
    ${fields.map((f, n) => `INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${JF(k, n + 1)}', '${J(k)}', '${FIELD(f)}');`).join('\n    ')}
    ${extra}`;
  psql(`${job('open', 'A', 'scheduled', [1, 2, 3])}
    ${job('done', 'A', 'completed', [4])}
    ${job('deleted', 'A', 'scheduled', [5])}
    ${job('expired', 'X', 'scheduled', [6])}
    ${job('role', 'D', 'in_progress', [7, 8])}`);
  // X's only license expired after the job was assigned (the assignment-time license gate passed).
  // The wizard split location 3 of the open job to active applicator B (stays exactly as it is).
  psql(`INSERT INTO public.applicator_licenses (profile_id, holder_name, license_number, expiry_date, is_active)
      VALUES ('${P('X')}', '[PROVER] KI28 x', 'KI28-X-${PHASE}', current_date - 30, true);
    INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, dispatch_status, dispatched_by, dispatched_at)
      VALUES ('${JF('open', 3)}', '${J('open')}', '${P('B')}', 'dispatched', '${ADMIN()}', '2026-01-02 03:04:05+00');
    UPDATE public.jobs SET deleted_at = now() WHERE id = '${J('deleted')}';`);
}

// "<job>: <field n>=<applicator letter>/<status>/<dispatched_by letter> ..." for every location of a job.
function board(k) {
  const letter = (col) => `CASE ${col} WHEN '${P('A')}' THEN 'A' WHEN '${P('B')}' THEN 'B' WHEN '${P('X')}' THEN 'X' WHEN '${P('D')}' THEN 'D'
    WHEN '${ADMIN()}' THEN 'admin' ELSE coalesce(${col}::text, '-') END`;
  return scalar(`SELECT coalesce(string_agg(
      right(jf.id::text, 1) || '=' || coalesce((${letter('d.applicator_id')}) || '/' || d.dispatch_status || '/'
        || (${letter('d.dispatched_by')}), 'none'), ' ' ORDER BY jf.id), '')
    FROM public.job_fields jf LEFT JOIN public.job_location_dispatches d ON d.job_field_id = jf.id
   WHERE jf.job_id = '${J(k)}';`);
}
function boards() { return Object.fromEntries(Object.keys(JOB).map((k) => [k, board(k)])); }
function dispatchRows() { return scalar(`SELECT count(*) FROM public.job_location_dispatches WHERE job_id::text LIKE '28000000-000${PHASE}-%';`); }
function sweepRows() {
  const sql = readFileSync(SWEEP, 'utf8').replace(/;\s*$/, '');
  return scalar(`SELECT count(*) FROM (${sql}) s WHERE s.job_id::text LIKE '28000000-000${PHASE}-%';`);
}
const SPLIT_ROW = () => scalar(`SELECT applicator_id || ' ' || dispatch_status || ' ' || dispatched_at::text
  FROM public.job_location_dispatches WHERE job_field_id = '${JF('open', 3)}';`);

function main() {
  if (REUSE) {
    // Only this proof's own throwaway container, checked before any write: its name, pinned image, no network.
    assert.match(NAME, /^crx-ki28-dispatch-sync-\d+-[a-z0-9]+$/, 'CRX_PROVER_REUSE_CONTAINER must name a container this proof created');
    assert.equal(docker(['inspect', '--format', '{{.Config.Image}} {{.HostConfig.NetworkMode}}', NAME]).stdout.trim(),
      `${IMAGE} none`, 'the reused container is not a network-disabled prover container');
    // A container kept after a full run already has the candidate and fixtures; only a pre-candidate one is reusable.
    assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = '_sync_job_location_dispatch_on_applicator_qualify';`)
      + scalar(`SELECT count(*) FROM public.jobs;`), '00', 'reuse needs a container kept before the candidate and seed; start fresh');
  } else buildContainer();

  // BEFORE: KI-28 reproduces. A job assigned to an inactive applicator gets no dispatch rows, and
  // re-activating that applicator still adds none.
  seed();
  const seeded = { open: '1=none 2=none 3=B/dispatched/admin', done: '1=none', deleted: '1=none', expired: '1=none', role: '1=none 2=none' };
  assert.deepEqual(boards(), seeded, 'seeded: no automatic dispatch rows for inactive/non-applicator assignees');
  // The sweep flags open-job locations whose assignee does not qualify now: A open 1-2, A deleted 1, X 1, D 1-2.
  assert.equal(sweepRows(), '6', 'the sweep sees every seeded KI-28 shape');
  updateProfile('A', 'new_is_active => true', `ki28-before-${PHASE}`);
  assert.deepEqual(boards(), seeded, 'BEFORE: re-activating A leaves its open job off the board (KI-28)');
  console.log('[prover] BEFORE: a job assigned to an inactive applicator stays off the board after re-activation (KI-28 reproduces)');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_DISPATCH_SYNC_QUALIFY_EXISTS/);
  assert.equal(scalar(`SELECT prosecdef::text || ' ' || array_to_string(proconfig, ',') || ' ' || proowner::regrole::text
    FROM pg_proc WHERE oid = '${FN}'::regprocedure;`), 'true search_path=public, pg_temp postgres');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', '${FN}', 'EXECUTE');`), 'f', `${role} must not execute the trigger function`);
  }
  // Applying the file wrote nothing: the earlier phase's re-activated A still has no rows (no backfill).
  assert.equal(board('open'), seeded.open, 'the migration itself writes no rows');
  console.log('[prover] candidate applied once (no rows written); a second apply refuses; definer, search_path, postgres-only EXECUTE');

  // AFTER: fresh rows.
  PHASE += 1;
  seed();
  assert.deepEqual(boards(), seeded, 'AFTER seed: same starting state');
  assert.equal(sweepRows(), '6');
  const splitBefore = SPLIT_ROW();

  // Activate A (the admin screen's real call): its open job's two missing locations appear, once each.
  updateProfile('A', 'new_is_active => true', `ki28-activate-${PHASE}`);
  const activated = { ...seeded, open: '1=A/dispatched/admin 2=A/dispatched/admin 3=B/dispatched/admin' };
  assert.deepEqual(boards(), activated, 'AFTER: A\'s open job is on the board; completed/deleted jobs are not; the split is untouched');
  assert.equal(SPLIT_ROW(), splitBefore, 'the wizard split row is byte-for-byte unchanged');
  assert.equal(dispatchRows(), '3', 'exactly one row per open location (2 new + the split)');
  assert.equal(sweepRows(), '3', 'A leaves the sweep; X (inactive) and D (a driver) remain');
  console.log('[prover] AFTER: activating A puts its open job\'s 2 missing locations on the board exactly once; split, completed and deleted jobs untouched');

  // Retries: the same idempotency key replays; a second save while already active; deactivate + re-activate.
  updateProfile('A', 'new_is_active => true', `ki28-activate-${PHASE}`);
  updateProfile('A', "new_is_active => true, new_full_name => '[PROVER] KI28 a renamed'", `ki28-again-${PHASE}`);
  assert.deepEqual(boards(), activated, 'a retry or a second save adds nothing');
  updateProfile('A', 'new_is_active => false', `ki28-off-${PHASE}`);
  updateProfile('A', 'new_is_active => true', `ki28-on-${PHASE}`);
  assert.deepEqual(boards(), activated, 'deactivate then re-activate: still exactly one row per location, unchanged');
  assert.equal(dispatchRows(), '3');
  console.log('[prover] retry (same key), a second save, and off/on again add nothing: still one row per location');

  // Expired license: X's re-activation does not auto-dispatch (same rule as dispatch_job_locations).
  updateProfile('X', 'new_is_active => true', `ki28-expired-${PHASE}`);
  assert.equal(board('expired'), '1=none', 'an applicator with only expired licenses is not auto-dispatched');
  // Role change: active driver D becomes an applicator; its in-progress job's locations appear.
  updateProfile('D', "new_role => 'applicator'", `ki28-role-${PHASE}`);
  assert.equal(board('role'), '1=D/dispatched/admin 2=D/dispatched/admin', 'becoming an applicator syncs that person\'s open jobs');
  // An active applicator saved again (B) is not a transition: nothing is written.
  const rowsBeforeB = dispatchRows();
  updateProfile('B', 'new_is_active => true', `ki28-b-${PHASE}`);
  assert.equal(dispatchRows(), rowsBeforeB);
  assert.equal(sweepRows(), '0', 'every assignee qualifies now, so the sweep is clean');
  console.log('[prover] expired-license applicator skipped; driver->applicator role change syncs; an unchanged active applicator writes nothing');
  console.log('KI28_DISPATCH_SYNC_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
