/**
 * Shared disposable database for the undo-path suite (`npm run proof:undo-paths`).
 *
 * Builds the checked-in production baseline in a network-disabled Supabase PostgreSQL 17 container
 * and replays EVERY post-baseline migration on this checkout (skipping the parked set), the same way
 * the scripts/smoke/prove-*-real-schema.mjs proofs do, then seeds one user per role. Area files call
 * `attempt()` for one signed-in, rolled-back probe at a time, so areas never see each other's writes
 * unless they `commit` a fixture of their own.
 *
 * The database itself has no network (--network none); Docker may pull the pinned image once if it is not
 * cached. Nothing here connects to the live project.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const NAME = process.env.UNDO_PATHS_CONTAINER || `crx-undo-paths-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// Data migrations that rewrite live rows this database does not have: recorded in the ledger only.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  // DATA-11 rewrites live product rows only (one preferred vendor link each); this database has none.
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to request.jwt.claims.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';

export function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
export function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
export function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally { unlinkSync(staged); }
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
}
// Live stores this one helper's body with CRLF line endings; a later migration's preflight pins that.
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}
// 20261104150000 pins three live function bodies that the historical LF replay does not reproduce;
// install them exactly as that migration's own prover does, right before that file.
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
      expected, `${signature} is not the pinned live body`);
  }
}
function migrations() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
}

// Set only once `docker run` succeeds, so a failed start never removes someone else's same-named container.
let created = false;
/** `stopBefore`: a migration file name; it and every later file are left for the caller to apply. */
export function buildContainer({ stopBefore } = {}) {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  created = true;
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs', '--with-live-rows'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  psql(LIVE_UID, { user: 'supabase_admin' });
  replay({ stopBefore });
}

const LIVE_UID = `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`;
/** Replays every post-baseline migration not yet in the ledger (so a stopped build can resume). */
export function replay({ stopBefore } = {}) {
  const done = new Set(docker([...psqlArgs(), '-A', '-t'], { input: 'SELECT name FROM supabase_migrations.schema_migrations;' }).stdout.split(/\r?\n/).filter(Boolean));
  let replayed = 0;
  for (const [i, file] of migrations().entries()) {
    const base = path.basename(file);
    if (stopBefore && base >= stopBefore) break;
    if (PARKED.has(base) || done.has(path.basename(file, '.sql'))) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    // The tote-fill preflight needs live's count units; the schema baseline carries no unit rows (live factors, 2026-11-05).
    if (base === '20261117130000_tote_fill_from_bulk.sql') psql("INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Ea', 1, 'both'), ('Unit', 1, 'both') ON CONFLICT DO NOTHING;");
    const name = `m-${i}.sql`; stageText(name, lf(file));
    const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure: true });
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.stdout}\n${r.stderr}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  psql(LIVE_UID, { user: 'supabase_admin' });
  console.log(`[undo-paths] replayed ${replayed} post-baseline migrations into ${NAME}`);
}
export function removeContainer() { if (created) docker(['rm', '-f', NAME], { allowFailure: true }); }

/** Deterministic fixture ids: `id('a1')` → 7c7a0000-…-0000000000a1. */
export const id = (n) => `7c7a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const USERS = { admin: id('a1'), rep: id('a2'), driver: id('a3'), applicator: id('a4') };
export const claims = (uid) => `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;

export function seedUsers() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${USERS.admin}', 'undo-admin@example.invalid', '{"full_name":"[UNDO] Admin","role":"admin"}'::jsonb),
    ('${USERS.rep}', 'undo-rep@example.invalid', '{"full_name":"[UNDO] Rep","role":"sales_rep"}'::jsonb),
    ('${USERS.driver}', 'undo-driver@example.invalid', '{"full_name":"[UNDO] Driver","role":"driver"}'::jsonb),
    ('${USERS.applicator}', 'undo-applicator@example.invalid', '{"full_name":"[UNDO] Applicator","role":"applicator"}'::jsonb);`);
  const roles = scalar(`SELECT string_agg(role, ',' ORDER BY role) FROM public.profiles WHERE id IN ('${Object.values(USERS).join("','")}');`);
  assert.equal(roles, 'admin,applicator,driver,sales_rep', 'seeded users must land with their roles');
}

/**
 * Commits an area's fixtures as postgres, signed in as `uid`, once per database: a reused database
 * (UNDO_PATHS_REUSE=1) keeps the first seed of each `name`.
 */
export function seed(name, sql, uid = USERS.admin) {
  psql('CREATE SCHEMA IF NOT EXISTS undo_paths; CREATE TABLE IF NOT EXISTS undo_paths.seeded (name text PRIMARY KEY); CREATE TABLE IF NOT EXISTS undo_paths.ids (name text PRIMARY KEY, id uuid NOT NULL);');
  if (scalar(`SELECT count(*) FROM undo_paths.seeded WHERE name = '${name}';`) === '1') return;
  psql(`BEGIN;\n${claims(uid)}\n${sql}\nINSERT INTO undo_paths.seeded VALUES ('${name}');\nCOMMIT;`);
}

/** A fixture id an RPC chose, saved by a seed with `INSERT INTO undo_paths.ids VALUES (name, id)`. */
export const ref = (name) => `(SELECT id FROM undo_paths.ids WHERE name = '${name}')`;
/** Switches the probe's signed-in user (auth.uid()) inside a probe body. */
export const signIn = (uid) => `PERFORM set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim.sub', '${uid}', true);`;
/** Runs `stmt` as the `authenticated` role (what the app's browser calls run as), then returns to postgres. */
export const asUser = (stmt) => `SET LOCAL ROLE authenticated; ${stmt} RESET ROLE;`;
/** `stmt` must raise; the message lands in `t` (a call that returns sets t := 'NOT REFUSED'). */
export const refuse = (stmt) => `BEGIN ${asUser(stmt)} t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN t := SQLERRM; END;`;

/**
 * One rolled-back probe (unless `commit`), signed in as `uid`. The body runs as postgres so it can
 * read every row it compares; wrap each app call in asUser() so the call itself runs as
 * `authenticated`. Declared: v text, r/r2/r3 jsonb, t/t2/f0/f1/f2 text, u uuid, n bigint.
 * Returns `ok|<v>` or `<sqlstate>|<message>`.
 */
export function attempt(uid, body, { commit = false } = {}) {
  const sql = `BEGIN;
${claims(uid)}
DO $probe$
DECLARE v text; r jsonb; r2 jsonb; r3 jsonb; t text; t2 text; f0 text; f1 text; f2 text; u uuid; n bigint;
BEGIN
  ${body}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, SQLERRM;
END
$probe$;
${commit ? 'COMMIT' : 'ROLLBACK'};
`;
  const res = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  assert.equal(res.status, 0, `probe failed to run:\n${res.stderr}\n--- SQL ---\n${sql}`);
  const m = /RESULT\|([^\n]*)/.exec(res.stderr);
  assert.ok(m, `probe printed no RESULT:\n${res.stderr}`);
  return m[1].trimEnd();
}

