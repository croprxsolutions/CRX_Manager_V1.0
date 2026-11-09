#!/usr/bin/env node
/**
 * Real-schema proof for 20261210100000_epa_registrations (REG-1 PR 1, storage only): the registration
 * tables (RLS, read-only to active users, append-only events, a private draft-target table), the
 * label-draft create functions writing each draft's target row (and otherwise unchanged), the read RPC,
 * and the admin registration tools refusing EPA_REGISTRATION_NOT_SEEDED after their admin and key checks.
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays every
 * migration before the candidate, seeds invented rows and checks each case.
 *
 * Run: node scripts/smoke/prove-epa-registrations-real-schema.mjs   (needs local Docker image)
 * Prints EPA_REGISTRATIONS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-epareg-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261210100000_epa_registrations.sql');
const FOLLOW_UPS = [];
// Later files that only READ what this proof covers and redefine none of it.
const LATER_READ_ONLY = new Set();
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  // DATA-11 rewrites live rows only (every product gets one preferred link); the proof seeds that state.
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(label_draft|epa_registration_events|epa_registrations|get_epa_registrations|set_epa_registration|assign_epa_registration|_product_label_fingerprint)/i;
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
  // Others' migrations may sort between the candidate and a follow-up (live applied them in between);
  // they are not replayed, so each must leave alone what this proof covers.
  let last = at;
  for (const file of FOLLOW_UPS) {
    const i = all.indexOf(file);
    assert.ok(i > last, `${path.basename(file)} must sort after the candidate and earlier follow-ups`);
    last = i;
  }
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f) && !LATER_READ_ONLY.has(path.basename(f)))) {
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
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
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


const id = (n) => `7a7e4000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2'), GONE = id('a3');
const P1 = id('f1'), P2 = id('f2');
const EPA1 = '524-475';

function asOwner(sql) { psql(sql, { user: 'supabase_admin' }); }
function txIn(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
function ownerRefused(sql, pattern) {
  const r = psql(sql, { allowFailure: true });
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(`${r.stdout}\n${r.stderr}`, pattern);
}
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const counts = () => scalar("SELECT (SELECT count(*) FROM public.idempotency_keys) || '|' || (SELECT count(*) FROM public.epa_registration_events);");

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'er-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'er-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${GONE}', 'er-gone@example.invalid', '{"full_name":"[PROVER] Gone","role":"admin"}'::jsonb);`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'admin', is_active = false WHERE id = '${GONE}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT 'Gal', 128, 'liquid' WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'Gal');
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, signal_word, rei_hours, current_cost, tier1_price, is_active) VALUES
      ('${P1}', '[PROVER] Gly 2.5', 'ER-1', 'liquid', 'Gal', 'Herbicide', '${EPA1}', 'Caution', 4, 10.00, 15.00, true),
      ('${P2}', '[PROVER] No number', 'ER-2', 'liquid', 'Gal', 'Herbicide', NULL, NULL, NULL, 10.00, 15.00, true);
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  console.log('[prover] seeded an admin, a rep, an inactive admin, a product with an EPA number and one without');
}

const DEFS = {
  'public._epa_label_adjuvants_valid(jsonb)': { secdef: false, grant: [] },
  'public.refuse_epa_registration_event_mutation()': { secdef: false, grant: [] },
  'public._product_label_fingerprint(uuid)': { secdef: true, grant: [] },
  'public._record_label_draft_target(uuid)': { secdef: true, grant: [] },
  'public._epa_registration_target_table(text)': { secdef: false, grant: [] },
  'public._create_label_draft_replay_impl_20261015(uuid,text,integer,integer,text,numeric,text,text,text,text,text)': { secdef: true, grant: [] },
  'public._bulk_create_label_drafts_replay_impl_20261015(jsonb,text)': { secdef: true, grant: [] },
  'public.get_epa_registrations(text[])': { secdef: true, grant: ['authenticated'] },
  'public.set_epa_registration(text,bigint,jsonb,text,uuid,text)': { secdef: true, grant: ['authenticated'] },
  'public.preview_epa_assignment(text,uuid,text)': { secdef: true, grant: ['authenticated'] },
  'public.assign_epa_registration(text,uuid,text,jsonb,text,bigint,text,uuid,text)': { secdef: true, grant: ['authenticated'] },
};
const SET_SQL = (key) => `SELECT public.set_epa_registration('${EPA1}', NULL, '{}'::jsonb, 'label checked', NULL, ${key});`;
const PREVIEW_SQL = (table) => `SELECT public.preview_epa_assignment(${table}, '${P1}', '100-1');`;
const ASSIGN_SQL = (table, key) => `SELECT public.assign_epa_registration(${table}, '${P1}', '100-1', NULL, 'fp', NULL, 'typo', NULL, ${key});`;
const CREATE_SQL = (key, pid = P1) => `SELECT public.create_label_draft('${pid}', 'Warning', 12, 7, ' 524-476 ', 2.5, 'qt/A', 'label pdf', 'high', 'accepted', '${key}');`;
const REG = (cols, vals) => `INSERT INTO public.epa_registrations (epa_registration, created_by, updated_by${cols}) VALUES (${vals});`;

async function main() {
  buildContainer();
  seed();
  stageText('cand.sql', lf(CANDIDATE));

  // 1. One transaction only, once only.
  let r = docker([...psqlArgs(), '-f', '/tmp/cand.sql'], { allowFailure: true });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /EPA_REGISTRATIONS_NOT_IN_TRANSACTION/);
  assert.equal(scalar("SELECT count(*) FROM pg_class WHERE relname = 'epa_registrations';"), '0');
  r = apply('cand.sql');
  assert.equal(r.status, 0, r.output);
  r = apply('cand.sql');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /EPA_REGISTRATIONS_PREFLIGHT: this file was already applied/);
  console.log('[prover] case 1: the file applies once, as one transaction');

  // 2. Every new or re-issued function: SECURITY DEFINER as listed, search_path pinned, EXECUTE only as listed.
  for (const [sig, want] of Object.entries(DEFS)) {
    const row = scalar(`SELECT p.prosecdef || '|' || array_to_string(p.proconfig, ',') || '|' || pg_get_userbyid(p.proowner) || '|' ||
        COALESCE((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, ',' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
          FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), '')
      FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`);
    const [secdef, config, owner, grants] = row.split('|');
    assert.equal(secdef, String(want.secdef), `${sig} prosecdef`);
    assert.equal(config, 'search_path=public, pg_temp', `${sig} search_path`);
    assert.equal(owner, 'postgres', `${sig} owner`);
    assert.equal(grants, want.grant.join(','), `${sig} EXECUTE grants`);
  }
  // The public wrappers are unchanged.
  assert.equal(scalar(`SELECT string_agg(DISTINCT a.grantee::regrole::text, ',' ORDER BY a.grantee::regrole::text) FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.proname IN ('create_label_draft', 'bulk_create_label_drafts') AND p.pronamespace = 'public'::regnamespace
      AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner;`), 'authenticated,service_role');
  console.log('[prover] case 2: every new or re-issued function is owned by postgres, pins search_path, and is executable only as listed');

  // 3. Tables: RLS on, read-only to active users, the target table private, events append-only.
  assert.equal(scalar(`SELECT string_agg(relname || ':' || relrowsecurity, ',' ORDER BY relname) FROM pg_class
    WHERE relname IN ('epa_registrations', 'epa_registration_events', 'label_draft_targets') AND relnamespace = 'public'::regnamespace;`),
  'epa_registration_events:true,epa_registrations:true,label_draft_targets:true');
  asOwner(`INSERT INTO public.epa_registrations (epa_registration, signal_word, rup_status, label_adjuvants, created_by, updated_by)
      VALUES ('100-1070', 'Caution', 'no', '[{"kind":"required","adjuvant_type":"NIS","note":null}]', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.epa_registration_events (epa_registration, event_type, changed_by) VALUES ('100-1070', 'created', '${ADMIN}');`);
  assert.equal(ok(REP, 'SELECT count(*) FROM public.epa_registrations;'), '1');
  assert.equal(ok(REP, 'SELECT count(*) FROM public.epa_registration_events;'), '1');
  assert.equal(ok(GONE, 'SELECT count(*) FROM public.epa_registrations;'), '0');
  refused(null, 'SELECT count(*) FROM public.epa_registrations;', /permission denied/);
  refused(ADMIN, `INSERT INTO public.epa_registrations (epa_registration, created_by, updated_by) VALUES ('7-7', '${ADMIN}', '${ADMIN}');`, /permission denied/);
  refused(ADMIN, "UPDATE public.epa_registrations SET rup_status = 'yes';", /permission denied/);
  refused(ADMIN, 'DELETE FROM public.epa_registrations;', /permission denied/);
  refused(ADMIN, `INSERT INTO public.epa_registration_events (epa_registration, event_type, changed_by) VALUES ('100-1070', 'updated', '${ADMIN}');`, /permission denied/);
  refused(ADMIN, 'SELECT count(*) FROM public.label_draft_targets;', /permission denied/);
  ownerRefused("UPDATE public.epa_registration_events SET reason = 'x';", /EPA_REGISTRATION_EVENTS_ARE_APPEND_ONLY/);
  ownerRefused('DELETE FROM public.epa_registration_events;', /EPA_REGISTRATION_EVENTS_ARE_APPEND_ONLY/);
  ownerRefused('TRUNCATE public.epa_registration_events;', /EPA_REGISTRATION_EVENTS_ARE_APPEND_ONLY/);
  console.log('[prover] case 3: tables have RLS, active users read registrations and events, nobody signed in writes them or reads draft targets, events are append-only');

  // 4. Constraints: strict number, cancelled needs a date, RUP tri-state, adjuvant shape.
  for (const [cols, vals, why] of [
    ['', `'524-0475', '${ADMIN}', '${ADMIN}'`, /epa_registration_check/],
    ['', `'abc', '${ADMIN}', '${ADMIN}'`, /epa_registration_check/],
    [', registration_status', `'1-1', '${ADMIN}', '${ADMIN}', 'cancelled'`, /check/],
    [', cancelled_on', `'1-1', '${ADMIN}', '${ADMIN}', current_date`, /check/],
    [', rup_status', `'1-1', '${ADMIN}', '${ADMIN}', 'maybe'`, /rup_status_check/],
    [', label_url', `'1-1', '${ADMIN}', '${ADMIN}', 'http://example.invalid/x.pdf'`, /label_url_check/],
    [', label_adjuvants', `'1-1', '${ADMIN}', '${ADMIN}', '{"kind":"required"}'`, /label_adjuvants_check/],
    [', label_adjuvants', `'1-1', '${ADMIN}', '${ADMIN}', '[{"kind":"maybe","adjuvant_type":"NIS"}]'`, /label_adjuvants_check/],
    [', label_adjuvants', `'1-1', '${ADMIN}', '${ADMIN}', '[{"kind":"required","adjuvant_type":" "}]'`, /label_adjuvants_check/],
    [', label_adjuvants', `'1-1', '${ADMIN}', '${ADMIN}', '[{"kind":"required","adjuvant_type":"NIS","extra":1}]'`, /label_adjuvants_check/],
    [', rei_hours', `'1-1', '${ADMIN}', '${ADMIN}', -1`, /rei_hours_check/],
    [', max_label_rate, max_label_rate_unit', `'1-1', '${ADMIN}', '${ADMIN}', 'NaN', 'pt/A'`, /max_label_rate_check/],
    [', max_label_rate, max_label_rate_unit', `'1-1', '${ADMIN}', '${ADMIN}', 'Infinity', 'pt/A'`, /max_label_rate_check/],
    [', max_label_rate', `'1-1', '${ADMIN}', '${ADMIN}', 2.5`, /epa_registrations_rate_unit_pair/],
    [', max_label_rate_unit', `'1-1', '${ADMIN}', '${ADMIN}', 'pt/A'`, /epa_registrations_rate_unit_pair/],
  ]) ownerRefused(REG(cols, vals), why);
  psql(`BEGIN; ${REG(', registration_status, cancelled_on, label_adjuvants', `'1-1', '${ADMIN}', '${ADMIN}', 'cancelled', current_date, '[]'`)} ROLLBACK;`);
  assert.equal(scalar("SELECT rup_status || '|' || registration_status || '|' || registration_version || '|' || (label_adjuvants IS NULL) FROM public.epa_registrations WHERE epa_registration = '100-1070';"), 'no|unknown|1|false');
  console.log('[prover] case 4: bad numbers, a cancelled status without a date (and the reverse), a fourth RUP value, a non-https link, malformed adjuvants, a non-finite rate and a rate without its unit (or the reverse) are refused; [] is reviewed-none');

  // 5. The read RPC: active users only, normalized lookup, all when NULL.
  assert.deepEqual(JSON.parse(ok(REP, "SELECT public.get_epa_registrations(ARRAY[' 100-1070 ', '9-9']);")).map((x) => x.epa_registration), ['100-1070']);
  assert.equal(JSON.parse(ok(REP, 'SELECT public.get_epa_registrations();')).length, 1);
  assert.deepEqual(JSON.parse(ok(REP, "SELECT public.get_epa_registrations(ARRAY['9-9']);")), []);
  refused(GONE, 'SELECT public.get_epa_registrations();', /ACTIVE_USER_REQUIRED/);
  refused(null, 'SELECT public.get_epa_registrations();', /permission denied/);
  console.log('[prover] case 5: get_epa_registrations returns registrations to active users only, matching numbers after normalizing');

  // 6. Admin tools: refused for anon, non-admins and inactive admins before anything else; a missing key or
  //    a target table off the list refused; otherwise EPA_REGISTRATION_NOT_SEEDED; nothing written.
  const before = counts();
  for (const sql of [SET_SQL("'k1'"), PREVIEW_SQL("'products'"), ASSIGN_SQL("'products'", "'k2'")]) {
    refused(null, sql, /permission denied/);
    refused(REP, sql, /ADMIN_REQUIRED/);
    refused(GONE, sql, /ADMIN_REQUIRED/);
    refused(ADMIN, sql, /EPA_REGISTRATION_NOT_SEEDED/);
  }
  refused(REP, ASSIGN_SQL("'pg_authid'", 'NULL'), /ADMIN_REQUIRED/);
  for (const table of ["'pg_authid'", "'invoices'", 'NULL']) {
    refused(ADMIN, PREVIEW_SQL(table), /EPA_REGISTRATION_TARGET_TABLE/);
    refused(ADMIN, ASSIGN_SQL(table, "'k3'"), /EPA_REGISTRATION_TARGET_TABLE/);
  }
  refused(ADMIN, SET_SQL('NULL'), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(ADMIN, SET_SQL("' '"), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(ADMIN, ASSIGN_SQL("'products'", 'NULL'), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(ADMIN, SET_SQL("'k1'"), /EPA_REGISTRATION_NOT_SEEDED/);  // same key twice: same refusal, nothing kept
  assert.equal(counts(), before);
  console.log('[prover] case 6: set, preview and assign refuse anon, non-admins and inactive admins first, then a missing key or an unlisted table, then EPA_REGISTRATION_NOT_SEEDED, writing nothing');

  // 7. create_label_draft: the draft is stored exactly as before, plus its private target row.
  refused(REP, CREATE_SQL('d-rep'), /PERMISSION_DENIED/);
  const draft = ok(ADMIN, CREATE_SQL('d1'));
  assert.equal(scalar(`SELECT signal_word || '|' || rei_hours || '|' || phi_days || '|' || epa_registration || '|' || max_label_rate || '|' || max_label_rate_unit || '|' || status || '|' || created_by
    FROM public.product_label_drafts WHERE id = '${draft}';`), `Warning|12|7| 524-476 |2.5|qt/A|pending|${ADMIN}`);
  const fp = scalar(`SELECT md5(jsonb_build_object('epa_registration', '${EPA1}', 'signal_word', 'Caution', 'is_rup', false, 'rei_hours', 4,
    'phi_days', NULL, 'max_label_rate', NULL, 'max_label_rate_unit', NULL)::text);`);
  const target = JSON.parse(scalar(`SELECT to_jsonb(t) - 'updated_at' FROM public.label_draft_targets t WHERE draft_id = '${draft}';`));
  assert.deepEqual(target, {
    draft_id: draft, epa_registration: '524-476', product_epa_registration: EPA1, product_id: P1,
    product_label_fingerprint: fp, registration_version: null,
    proposed_values: { signal_word: 'Warning', rei_hours: 12, phi_days: 7, epa_registration: ' 524-476 ', max_label_rate: 2.5, max_label_rate_unit: 'qt/A' },
  });
  // A retry with the same key returns the same draft and writes no second target; another request under it is refused.
  assert.equal(ok(ADMIN, CREATE_SQL('d1')), draft);
  assert.equal(scalar('SELECT count(*) FROM public.label_draft_targets;'), '1');
  refused(ADMIN, CREATE_SQL('d1', P2), /IDEMPOTENCY|mismatch/i);
  // A product with no number: the target holds no numbers.
  const d2 = ok(ADMIN, `SELECT public.create_label_draft('${P2}', NULL, NULL, NULL, NULL, NULL, NULL, '', 'low', 'pending', 'd2');`);
  assert.equal(scalar(`SELECT COALESCE(epa_registration, '-') || '|' || COALESCE(product_epa_registration, '-') FROM public.label_draft_targets WHERE draft_id = '${d2}';`), '-|-');
  // A registration that exists for the product's number is recorded by version.
  asOwner(`INSERT INTO public.epa_registrations (epa_registration, registration_version, created_by, updated_by) VALUES ('${EPA1}', 3, '${ADMIN}', '${ADMIN}');`);
  const d3 = ok(ADMIN, CREATE_SQL('d3'));
  assert.equal(scalar(`SELECT registration_version FROM public.label_draft_targets WHERE draft_id = '${d3}';`), '3');
  console.log('[prover] case 7: create_label_draft stores the draft as before plus its target (numbers, product fingerprint, registration version, proposed values); a retry writes once; a reused key with another request is refused');

  // 8. bulk_create_label_drafts: one target per draft; a retry writes nothing more.
  const bulk = J([{ product_id: P1, signal_word: 'Danger', epa_registration: EPA1 }, { product_id: P2, rei_hours: 24 }]);
  const res = JSON.parse(ok(ADMIN, `SELECT public.bulk_create_label_drafts(${bulk}, 'b1');`));
  assert.equal(res.count, 2);
  assert.equal(scalar(`SELECT count(*) FROM public.label_draft_targets WHERE draft_id = ANY('{${res.draft_ids.join(',')}}'::uuid[]);`), '2');
  assert.equal(scalar(`SELECT proposed_values->>'signal_word' FROM public.label_draft_targets WHERE draft_id = '${res.draft_ids[0]}';`), 'Danger');
  assert.deepEqual(JSON.parse(ok(ADMIN, `SELECT public.bulk_create_label_drafts(${bulk}, 'b1');`)), res);
  assert.equal(scalar('SELECT count(*) FROM public.label_draft_targets;'), '5');
  refused(ADMIN, `SELECT public.bulk_create_label_drafts(${J([{ product_id: P1, rei_hours: -1 }])}, 'b2');`, /INVALID_LABEL_VALUE/);
  assert.equal(scalar('SELECT count(*) FROM public.label_draft_targets;'), '5');
  console.log('[prover] case 8: bulk_create_label_drafts writes one target per draft; a retry writes nothing more; a refused batch leaves none');

  // 9. A client removing a draft (its table grant is kept) removes its target too; clients cannot edit targets.
  ok(ADMIN, `DELETE FROM public.product_label_drafts WHERE id = '${d2}';`);
  assert.equal(scalar(`SELECT count(*) FROM public.label_draft_targets WHERE draft_id = '${d2}';`), '0');
  refused(ADMIN, `UPDATE public.label_draft_targets SET proposed_values = '{}' WHERE draft_id = '${draft}';`, /permission denied/);
  console.log('[prover] case 9: removing a draft removes its target; nobody signed in can edit a target');

  // 10. Products are untouched.
  assert.equal(scalar(`SELECT signal_word || '|' || epa_registration FROM public.products WHERE id = '${P1}';`), `Caution|${EPA1}`);
  console.log('EPA_REGISTRATIONS_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
