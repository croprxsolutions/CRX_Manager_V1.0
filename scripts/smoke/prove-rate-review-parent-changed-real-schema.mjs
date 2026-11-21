#!/usr/bin/env node
/**
 * Real-schema proof for 20270206100000_rate_review_parent_changed_warning (#1722 item 4).
 * Container setup and replay copied from prove-field-app-refuses-payer-change-real-schema.mjs. Liquid parents at
 * 4 oz/acre ("4 oz/A") are derived into a house draft and a text draft, then the parent is edited and the drafts approved
 * through preview_rate_review / commit_rate_review as an admin:
 *   BEFORE: the approval goes through with no word that the parent moved.
 *   AFTER:  it still goes through (Mason, 2026-11-21: warn but allow); the preview row, the commit receipt and the
 *           'approved' event carry parent_changed {was, now} for the row whose parent value moved, and only that row.
 *           Same value at another scale or padding, and manual rows, never warn. A refused mixed upload saves nothing;
 *           a sales rep is refused; a second apply stops at the preflight.
 *
 * Run: node scripts/smoke/prove-rate-review-parent-changed-real-schema.mjs   (needs Docker)
 * Prints RATE_REVIEW_PARENT_CHANGED_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-rpc-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270206100000_rate_review_parent_changed_warning.sql');
const FOLLOW_UPS = [];
const LATER_READ_ONLY = new Set([]);
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
  // Need live's storage.objects policies, which this database does not have; neither touches units or stock.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate changes or relies on.
const TOUCHED = /(_product_rate_review_approve|_product_rate_review_run|product_rates|product_parents|product_rate_draft_events)/i;
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const LIVE_UNIT_ROWS = "('3f5c3827-8523-4b42-9913-ad479588ff95'::uuid, 'Dry oz', 1, 'dry', '1 dry ounce'), ('5ed18e4b-c4d9-42fc-b85e-22babd3fc098'::uuid, 'Ea', 1, 'both', 'Each / unit'), ('f9e10e66-5027-464e-bb9e-ed9800875256'::uuid, 'fl oz', 1, 'liquid', '1 fluid ounce'), ('4406cacd-a7fe-42db-8c84-694e61bb937b'::uuid, 'g', 0.03527396, 'dry', '1 gram = 0.03527396 dry ounces (1000 mg)'), ('29d05e43-cb40-461b-a969-88ee299faca8'::uuid, 'Gal', 128, 'liquid', '1 gallon = 128 fluid ounces'), ('53997e31-d152-4ab6-b768-d1aa81b657bf'::uuid, 'Lb', 16, 'dry', '1 pound = 16 dry ounces'), ('fc5d349f-b58c-48f1-991d-fa0161fd3d01'::uuid, 'LB', 16, 'dry', '1 pound (capitalized alias)'), ('ddde7daf-8090-492b-aed9-c0b7f8ecfd34'::uuid, 'MG', 0.00003527396, 'dry', '1 milligram = 0.00003527396 dry ounces'), ('438d5f7b-f015-4319-b2b7-4f9a672cb350'::uuid, 'oz', 1, 'liquid', '1 fluid ounce (alias for fl oz)'), ('b69ddac6-68ed-4f1d-8e09-e63a7fa6635a'::uuid, 'Oz', 1, 'liquid', '1 fluid ounce (capitalized alias)'), ('a31f95a0-df80-4025-977f-f1fb4e5c8d53'::uuid, 'Pt', 16, 'liquid', '1 pint = 16 fluid ounces'), ('35532f45-2fd0-4400-87d8-3509a58377c0'::uuid, 'qt', 32, 'liquid', '1 quart lowercase (alias for Qt)'), ('915f25ff-8876-4a49-a375-940047e38313'::uuid, 'Qt', 32, 'liquid', '1 quart = 32 fluid ounces'), ('722e8d86-8e68-47d8-a940-209fad38c70e'::uuid, 'Unit', 1, 'both', 'Each / unit (alias for Ea)')";

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
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
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'], { cwd: ROOT, encoding: 'utf8' });
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, created_at timestamptz DEFAULT now(), UNIQUE (bucket_id, name));
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
    // Other one-shot data migrations rewrite live rows this database does not have: ledger only, as live has them.
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
    // RT-1's preflight pins live's unit factors; give it live's 14 unit rows (read live 2026-11-10).
    if (base === '20261229110000_product_rates_draft.sql') {
      raw(`DELETE FROM public.unit_conversions;
        INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
    }
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    if (base === '20270106110000_invoice_brands_rup.sql') {
      // Live ran REG-1's one-time seed before this file; its preflight refuses without the seed row.
      raw(`INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'units-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
// A rolled-back probe: as postgres with triggers on (uid null) or as a signed-in user. Returns the last row.
function probe(sql, uid = null) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
function okProbe(sql, uid) { const r = probe(sql, uid); assert.equal(r.status, 0, r.output); return r.last; }
function refusedProbe(sql, pattern, uid) {
  const r = probe(sql, uid);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
}


const id = (s) => `a5a5a5a5-1722-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2');
const APPROVE = 'public._product_rate_review_approve(uuid,bigint,uuid)';
const RUN = 'public._product_rate_review_run(jsonb,jsonb,text,uuid)';
const md5Of = (sig) => scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`);
const q = (v) => (v == null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const json = (v) => `${q(JSON.stringify(v))}::jsonb`;
// A committed call as a signed-in user; returns the last row as JSON.
function asUser(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
${sql}
COMMIT;\n` });
  assert.equal(r.status, 0, `${sql}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
}
// Every rate-review table, so a preview or a refused commit can be shown to leave nothing behind.
const snapshot = () => scalar(`SELECT md5(jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.product_rates r),
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.parent_id) FROM public.product_parent_rate_outcomes o),
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.product_rate_draft_events e),
  (SELECT jsonb_agg(to_jsonb(k) ORDER BY k.idempotency_key) FROM public.idempotency_keys k))::text);`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'rpc-admin@example.invalid', '{"full_name":"[PROVER] RPC Admin","role":"admin"}'::jsonb),
    ('${REP}', 'rpc-rep@example.invalid', '{"full_name":"[PROVER] RPC Rep","role":"sales_rep"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';`);
}
// A liquid parent at 4 oz/acre with label text "4 oz/A", derived into a house draft and a text draft.
let n = 0;
function derivedParent(tag) {
  n += 1;
  const pid = id(`b${n}`);
  raw(`INSERT INTO public.product_parents (id, name, product_form, rate_per_acre, rate_unit, suggested_rate, is_active, created_by, updated_by)
    VALUES ('${pid}', '[PROVER] ${tag}', 'liquid', 4, 'oz', '4 oz/A', true, '${ADMIN}', '${ADMIN}');`);
  asUser(ADMIN, `SELECT public.derive_draft_product_rates(ARRAY['${pid}']::uuid[], 'rpc-derive-${n}');`);
  const rows = JSON.parse(scalar(`SELECT jsonb_object_agg(origin, jsonb_build_object('rate_id', id, 'row_version', row_version,
    'basis', basis, 'source', source, 'low', low::text, 'recommended', recommended::text, 'high', high::text, 'unit', unit,
    'is_quoting_default', is_quoting_default, 'over_label_reason', over_label_reason, 'source_text', source_text, 'status', status))
    FROM public.product_rates WHERE parent_id = '${pid}';`));
  assert.ok(rows.derived_house && rows.derived_text, `${tag}: derive made a house row and a text row: ${JSON.stringify(rows)}`);
  assert.equal(rows.derived_house.source_text, '4 oz');
  assert.equal(rows.derived_text.source_text, '4 oz/A');
  return { pid, house: rows.derived_house, text: rows.derived_text };
}
// A parent rate edit by any writer; the approval only reads the parent's columns.
const setParent = (pid, cols) => raw(`UPDATE public.product_parents SET ${cols} WHERE id = '${pid}';`);
const approveRow = (pid, r) => ({ rate_id: r.rate_id, parent_id: pid, expected_row_version: Number(r.row_version), basis: r.basis,
  source: r.source, low: r.low, recommended: r.recommended, high: r.high, unit: r.unit, is_quoting_default: r.is_quoting_default,
  over_label_reason: r.over_label_reason, decision: 'approve', reason: null });
const preview = (rows) => asUser(ADMIN, `SELECT public.preview_rate_review(${json(rows)}, '[]'::jsonb);`);
const commitSql = (rows, key) => `SELECT public.commit_rate_review(${json(rows)}, '[]'::jsonb, ${q(key)});`;
const warnOf = (result, rateId) => result.rates.find((r) => r.rate_id === rateId)?.parent_changed ?? null;
const statusOf = (rateId) => scalar(`SELECT status FROM public.product_rates WHERE id = '${rateId}';`);
const eventWarn = (rateId) => scalar(`SELECT COALESCE(after_values->'parent_changed', 'null'::jsonb)::text FROM public.product_rate_draft_events
  WHERE rate_id = '${rateId}' AND event_type = 'approved' ORDER BY id DESC LIMIT 1;`);

async function main() {
  buildContainer();
  seed();
  assert.equal(md5Of(APPROVE), '1d7154c09d25622387df2981852aa801', 'the replayed approve body is not the one the candidate expects');
  assert.equal(md5Of(RUN), 'dace0490169cb60c416c4703f031558a', 'the replayed run body is not the one the candidate expects');

  // BEFORE: a house draft derived at 4 oz, parent then moved to 6 oz, approves with no word about it.
  const before = derivedParent('Before');
  setParent(before.pid, 'rate_per_acre = 6');
  const beforeReceipt = asUser(ADMIN, commitSql([approveRow(before.pid, before.house)], 'rpc-before'));
  assert.equal(statusOf(before.house.rate_id), 'approved');
  assert.equal(warnOf(beforeReceipt, before.house.rate_id), null);
  console.log('[before] a draft derived at 4 oz approves after the parent moved to 6 oz, with no warning');

  const grantsBefore = [APPROVE, RUN].map((s) => scalar(`SELECT proacl::text FROM pg_proc WHERE oid = '${s}'::regprocedure;`));
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.deepEqual([APPROVE, RUN].map((s) => scalar(`SELECT proacl::text FROM pg_proc WHERE oid = '${s}'::regprocedure;`)), grantsBefore);
  assert.deepEqual(grantsBefore, ['{postgres=X/postgres}', '{postgres=X/postgres}']);
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /RATE_REVIEW_PARENT_CHANGED_PREFLIGHT/);
  console.log('[case] the candidate applies (both functions stay postgres-only); a second apply stops at its preflight');

  // 1. House number changed: preview warns and saves nothing; commit approves, warns, and logs it; text row (unchanged) does not.
  const a = derivedParent('House moved');
  setParent(a.pid, 'rate_per_acre = 6');
  const rowsA = [approveRow(a.pid, a.house), approveRow(a.pid, a.text)];
  const s0 = snapshot();
  const prev = preview(rowsA);
  assert.equal(snapshot(), s0, 'preview leaves rates, events and receipts unchanged');
  assert.deepEqual(warnOf(prev, a.house.rate_id), { was: '4 oz', now: '6 oz' });
  assert.equal(warnOf(prev, a.text.rate_id), null);
  assert.ok(prev.rates.every((r) => r.status === 'change'));
  // The parent moves again between preview and Confirm: the receipt describes the value approved against.
  setParent(a.pid, 'rate_per_acre = 8');
  const receipt = asUser(ADMIN, commitSql(rowsA, 'rpc-a'));
  assert.deepEqual(warnOf(receipt, a.house.rate_id), { was: '4 oz', now: '8 oz' });
  assert.equal(warnOf(receipt, a.text.rate_id), null);
  assert.equal(statusOf(a.house.rate_id), 'approved');
  assert.equal(statusOf(a.text.rate_id), 'approved');
  assert.equal(eventWarn(a.house.rate_id), '{"now": "8 oz", "was": "4 oz"}');
  assert.equal(eventWarn(a.text.rate_id), 'null');
  // A lost-response retry with the same key returns the original receipt, even after the parent moves again.
  setParent(a.pid, 'rate_per_acre = 9');
  assert.deepEqual(asUser(ADMIN, commitSql(rowsA, 'rpc-a')), receipt);
  assert.equal(scalar(`SELECT count(*) FROM public.product_rate_draft_events WHERE rate_id = '${a.house.rate_id}' AND event_type = 'approved';`), '1');
  console.log('[case] 1 house rate 4 -> 8 oz: preview warns and saves nothing; commit approves with {was 4 oz, now 8 oz} on the receipt and the event; retry returns the same receipt');

  // 2. Label text changed: the text row warns, the house row does not.
  const b = derivedParent('Text moved');
  setParent(b.pid, `suggested_rate = '8 oz/A'`);
  const rb = asUser(ADMIN, commitSql([approveRow(b.pid, b.house), approveRow(b.pid, b.text)], 'rpc-b'));
  assert.deepEqual(warnOf(rb, b.text.rate_id), { was: '4 oz/A', now: '8 oz/A' });
  assert.equal(warnOf(rb, b.house.rate_id), null);
  console.log('[case] 2 label text 4 -> 8 oz/A: the text row warns, the house row does not');

  // 3. Unchanged, changed and changed back, same number at another scale, padded text: no warning.
  const c = derivedParent('Same value');
  setParent(c.pid, `rate_per_acre = 7, suggested_rate = 'x'`);
  setParent(c.pid, `rate_per_acre = 4.00, suggested_rate = '  4 oz/A '`);
  const rc = asUser(ADMIN, commitSql([approveRow(c.pid, c.house), approveRow(c.pid, c.text)], 'rpc-c'));
  assert.ok(rc.rates.every((r) => !('parent_changed' in r)), JSON.stringify(rc));
  assert.equal(eventWarn(c.house.rate_id), 'null');
  console.log('[case] 3 changed and changed back (4.00, padded text): no warning on either row');

  // 4. Unit changed, and a cleared rate/text: warns, with now null when the parent has no value.
  const d = derivedParent('Unit and cleared');
  setParent(d.pid, `rate_unit = 'Pt', suggested_rate = NULL`);
  const rd = asUser(ADMIN, commitSql([approveRow(d.pid, d.house), approveRow(d.pid, d.text)], 'rpc-d'));
  assert.deepEqual(warnOf(rd, d.house.rate_id), { was: '4 oz', now: '4 Pt' });
  assert.deepEqual(warnOf(rd, d.text.rate_id), { was: '4 oz/A', now: null });
  const e = derivedParent('Rate cleared');
  setParent(e.pid, 'rate_per_acre = NULL');
  const re = asUser(ADMIN, commitSql([approveRow(e.pid, e.house)], 'rpc-e'));
  assert.deepEqual(warnOf(re, e.house.rate_id), { was: '4 oz', now: null });
  console.log('[case] 4 unit oz -> Pt warns {4 oz -> 4 Pt}; a cleared rate or text warns with now = null');

  // 5. A manual row never warns, whatever the parent does.
  const f = derivedParent('Manual');
  const manual = asUser(ADMIN, `SELECT public.save_draft_product_rate('${f.pid}', NULL, NULL, 'per_100_gal', 'house_standard', NULL, 2, NULL, 'pt', false, NULL, 'rpc-manual');`);
  setParent(f.pid, `rate_per_acre = 12, suggested_rate = 'y'`);
  const mrow = JSON.parse(scalar(`SELECT jsonb_build_object('rate_id', id, 'row_version', row_version, 'basis', basis, 'source', source,
    'low', low::text, 'recommended', recommended::text, 'high', high::text, 'unit', unit, 'is_quoting_default', is_quoting_default,
    'over_label_reason', over_label_reason) FROM public.product_rates WHERE id = '${manual.rate_id}';`));
  const rf = asUser(ADMIN, commitSql([approveRow(f.pid, mrow)], 'rpc-f'));
  assert.equal(warnOf(rf, manual.rate_id), null);
  assert.equal(statusOf(manual.rate_id), 'approved');
  console.log('[case] 5 a manual row never warns');

  // 6. Warn but allow inside an all-or-nothing upload: a warned approval with a refused row saves nothing.
  const g = derivedParent('Mixed');
  setParent(g.pid, 'rate_per_acre = 6');
  const s1 = snapshot();
  const mixed = [approveRow(g.pid, g.house), { ...approveRow(g.pid, g.text), expected_row_version: 999 }];
  const pm = preview(mixed);
  assert.deepEqual(warnOf(pm, g.house.rate_id), { was: '4 oz', now: '6 oz' });
  assert.equal(pm.rates.find((r) => r.rate_id === g.text.rate_id).status, 'stale');
  refusedProbe(commitSql(mixed, 'rpc-g'), /RATE_REVIEW_REFUSED/, ADMIN);
  assert.equal(snapshot(), s1, 'a refused upload leaves no approval and no warning event');
  assert.equal(statusOf(g.house.rate_id), 'draft');
  // A caller cannot send the warning in: it is not an accepted upload field.
  const sent = preview([{ ...approveRow(g.pid, g.house), parent_changed: { was: 'x', now: 'x' } }]);
  assert.equal(sent.rates[0].status, 'invalid');
  assert.match(sent.rates[0].problem, /unexpected field/);
  console.log('[case] 6 a warned approval beside a stale row: preview shows both, commit refuses all of it; a sent parent_changed is refused');

  // 7. Who may: a sales rep and an anonymous caller are refused; the functions stay private.
  refusedProbe(`SELECT public.preview_rate_review(${json([approveRow(g.pid, g.house)])}, '[]'::jsonb);`, /ADMIN_REQUIRED/, REP);
  refusedProbe(commitSql([approveRow(g.pid, g.house)], 'rpc-rep'), /ADMIN_REQUIRED/, REP);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const sig of [APPROVE, RUN]) assert.equal(scalar(`SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE');`), 'f', `${role} ${sig}`);
  }
  for (const sig of ['public.preview_rate_review(jsonb,jsonb)', 'public.commit_rate_review(jsonb,jsonb,text)']) {
    assert.equal(scalar(`SELECT has_function_privilege('anon', '${sig}', 'EXECUTE');`), 'f', `anon ${sig}`);
  }
  console.log('[case] 7 a sales rep is refused (ADMIN_REQUIRED); anon/authenticated/service_role cannot run either private function; anon cannot run the public pair');
  console.log('RATE_REVIEW_PARENT_CHANGED_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
