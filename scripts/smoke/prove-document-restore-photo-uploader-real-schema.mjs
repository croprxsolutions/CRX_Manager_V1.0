#!/usr/bin/env node
/**
 * Real-schema proof for 20261222100000 (KI-07, KI-77/KI-26). Builds the checked-in schema baseline in a
 * network-disabled PostgreSQL container, replays migrations up to the candidate, shows the old guard refuses an
 * admin restore, applies the candidate (a second apply refuses), then, as real signed-in roles on invented rows:
 *   documents: an active admin restores a removed document (both removal columns cleared, nothing else);
 *     a sales rep, an inactive admin, a signed-out service-role update, a half restore and a restore that also
 *     edits a field are refused; the old rules (identity immutable, attributable soft delete, rep RPC remove) hold;
 *   photos: a driver records a photo of a file they uploaded (uploaded_at = server clock); naming another
 *     uploader, another person's file, a missing file or another bucket's file is refused; uploader, time, file
 *     and delivery never change afterwards; a caption edit still works; a service-role insert is unchecked;
 *     a paper-ticket completion still accepts a guarded photo.
 *
 * Run: node scripts/smoke/prove-document-restore-photo-uploader-real-schema.mjs   (needs local Docker image)
 * Prints DOCUMENT_RESTORE_PHOTO_UPLOADER_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-doc-restore-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
if (REUSE && !/^crx-doc-restore-\d+-[0-9a-z]+$/.test(NAME)) {
  console.error(`CRX_PROVER_REUSE_CONTAINER must name a container this prover created (crx-doc-restore-<pid>-<id>), not "${NAME}"`);
  process.exit(1);
}
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261222100000_document_restore_and_photo_uploader.sql');
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
  '20261105170000_data11_preferred_vendor_links.sql',
  // KI-01 part C (#1650) changes job and storage access only; its preflight needs live's storage.objects policies,
  // which this database does not have (the staff photo storage files are parked above). Its own proof is
  // prove-job-access-ends-with-the-job-real-schema.mjs; same approach as prove-close-delivery-receipt-real-schema.mjs.
  '20261217100000_job_access_ends_with_the_job.sql',
  // Its KI-73 follow-up (applicator spray-record fields) needs part C applied; same reason.
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(guard_customer_document_update|_guard_delivery_photo_uploader|delivery_photos_uploader_guard)/i;
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
  docker(['run', '-d', '--name', NAME, '--label', 'crx-prover=doc-restore', '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
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
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    // BLK-1a's preflight needs the count units live already has.
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql("INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Ea', 1, 'both'), ('Unit', 1, 'both') ON CONFLICT DO NOTHING;");
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const id = (n) => `07150000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const ADMIN2 = id('a2');      // deactivated later
const REP = id('a3');
const DRIVER = id('a4');
const CUST = id('c1');
const DOC = id('d1');
const DOC_PATH = `${CUST}/${id('d2')}-License.pdf`;
const P = id('f1'); const O = id('e1'); const OI = id('e2'); const D = id('b1'); const DI = id('b2');
const TICKET = 'Signed paper delivery ticket';
const FILE_TIME = '2026-01-02 03:04:05+00';
const restoreLog = () => scalar(`SELECT count(*) || '|' || coalesce(string_agg(removed_by::text || '>' || restored_by::text, ',' ORDER BY restored_at, id), '-') FROM public.customer_document_restores WHERE document_id = '${DOC}';`);

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function q(sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  return { status: r.status, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr };
}
// One statement as a signed-in user (RLS, policies and triggers all apply).
const as = (uid, sql) => q(`BEGIN;\n${claims(uid)}\nSET LOCAL ROLE authenticated;\n${sql};\nCOMMIT;`);
const service = (sql) => q(`BEGIN; SET LOCAL ROLE service_role; ${sql}; COMMIT;`);
function refused(r, pattern, label) {
  assert.notEqual(r.status, 0, `${label}: expected a refusal`);
  assert.match(r.err, pattern, `${label}: wrong refusal`);
}
const docState = () => scalar(`SELECT coalesce(deleted_at::text, 'live') || '|' || coalesce(deleted_by::text, '-') || '|' || coalesce(notes, '-') FROM public.customer_documents WHERE id = '${DOC}';`);
const removeDoc = (by) => psql(`SET session_replication_role = replica;
  UPDATE public.customer_documents SET deleted_at = now(), deleted_by = '${by}' WHERE id = '${DOC}';`);
// Prints how many rows the restore changed (the screen's update, scoped the same way).
const RESTORE = `WITH r AS (UPDATE public.customer_documents SET deleted_at = NULL, deleted_by = NULL
  WHERE id = '${DOC}' AND customer_id = '${CUST}' AND deleted_at IS NOT NULL RETURNING id) SELECT count(*) FROM r`;
const REMOVED_BY_REP = new RegExp(`\\|${REP}\\|-$`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'dr-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${ADMIN2}', 'dr-admin2@example.invalid', '{"full_name":"[PROVER] Admin 2","role":"admin"}'::jsonb),
    ('${REP}', 'dr-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${DRIVER}', 'dr-driver@example.invalid', '{"full_name":"[PROVER] Driver","role":"driver"}'::jsonb);`);
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id IN ('${ADMIN}', '${ADMIN2}');
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${DRIVER}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Restore Farm', true);
    INSERT INTO public.customer_documents (id, customer_id, document_type, storage_path, filename, mime_type, size_bytes, uploaded_by, source)
      VALUES ('${DOC}', '${CUST}', 'license', '${DOC_PATH}', 'License.pdf', 'application/pdf', 1024, '${REP}', 'rep');
    INSERT INTO public.products (id, product_name, sku, unit_size, current_cost, tier1_price, is_active)
      VALUES ('${P}', '[PROVER] product', 'DR-1', 'GL', 6.00, 10.00, true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${P}', 'Main Warehouse', 100, 10, 'GL');
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${O}', 'PROVER-DR-1', '${CUST}', current_date, 'confirmed', false, '${ADMIN}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
      VALUES ('${OI}', '${O}', '${P}', '[PROVER] product', 10, 6, 10, 100, 40, 40, 0, 10);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver)
      VALUES ('${D}', 'PROVER-DR-D1', '${O}', '${CUST}', '${ADMIN}', 'in_progress', current_date, '${DRIVER}');
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${DI}', '${D}', '${OI}', '${P}', 10, 'GL');
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata, created_at) VALUES
      ('delivery-photos', 'delivery-photos/${D}/driver.jpg', '${DRIVER}', '{"mimetype":"image/jpeg","size":"5000"}'::jsonb, '${FILE_TIME}'),
      ('delivery-photos', 'delivery-photos/${D}/admin.jpg', '${ADMIN}', '{"mimetype":"image/jpeg","size":"5000"}'::jsonb, now()),
      ('receiving-photos', 'delivery-photos/${D}/other-bucket.jpg', '${DRIVER}', '{"mimetype":"image/jpeg","size":"5000"}'::jsonb, now());`);
}
const photoInsert = (uploader, file, uploadedAt) => `INSERT INTO public.delivery_photos (delivery_id, storage_path, image_url, caption, uploaded_by${uploadedAt ? ', uploaded_at' : ''})
  VALUES ('${D}', 'delivery-photos/${D}/${file}', 'x', '${TICKET}', '${uploader}'${uploadedAt ? `, ${uploadedAt}` : ''}) RETURNING id`;

function main() {
  if (!REUSE) buildContainer();
  else {
    const seen = docker(['inspect', '-f', '{{index .Config.Labels "crx-prover"}} {{.HostConfig.NetworkMode}}', NAME]).stdout.trim();
    if (seen !== 'doc-restore none') throw new Error(`refusing to reuse ${NAME}: not a container this prover built (${seen})`);
  }
  seed();

  // BEFORE: the old guard refuses even an admin's restore.
  removeDoc(REP);
  refused(as(ADMIN, RESTORE), /soft-deleted customer documents cannot be modified/, 'before: admin restore');
  console.log('[prover] before the candidate an admin cannot restore a removed document');

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  // The replaced guard body no longer matches the pinned 20260717013415 fingerprint, so that check refuses first.
  assert.match(again.output, /DOC_RESTORE_PREFLIGHT: guard_customer_document_update is not the expected/);
  console.log('[prover] candidate applied once; a second apply refuses at the preflight');

  // ---- Documents ----
  // A rep can neither see nor restore a removed row (0 rows, still removed).
  assert.equal(as(REP, `SELECT count(*) FROM public.customer_documents WHERE id = '${DOC}'`).out, '0');
  const repTry = as(REP, RESTORE);
  assert.equal(repTry.status, 0, repTry.err);
  assert.equal(repTry.out, '0', 'a rep reaches no removed row');
  assert.match(docState(), REMOVED_BY_REP);
  // A signed-out service role bypasses row security, but the guard still refuses.
  refused(service(RESTORE), /soft-deleted customer documents cannot be modified/, 'service role restore');
  // An admin must clear both columns and change nothing else.
  refused(as(ADMIN, `UPDATE public.customer_documents SET deleted_at = NULL WHERE id = '${DOC}'`), /cannot be modified/, 'half restore');
  refused(as(ADMIN, `UPDATE public.customer_documents SET deleted_at = NULL, deleted_by = NULL, notes = 'edited' WHERE id = '${DOC}'`), /cannot be modified/, 'restore plus edit');
  refused(as(ADMIN, `UPDATE public.customer_documents SET notes = 'edited' WHERE id = '${DOC}'`), /cannot be modified/, 'edit a removed row');
  // A deactivated admin is not an admin.
  // Test setup only: skip the profile role-lock trigger to deactivate the second admin.
  psql(`SET session_replication_role = replica; UPDATE public.profiles SET is_active = false WHERE id = '${ADMIN2}';`);
  const inactive = as(ADMIN2, RESTORE);
  assert.equal(inactive.out, '0', 'an inactive admin reaches no row');
  assert.match(docState(), REMOVED_BY_REP);
  // The real restore.
  const restored = as(ADMIN, RESTORE);
  assert.equal(restored.status, 0, restored.err);
  assert.equal(restored.out, '1', 'the admin restore changed one row');
  assert.equal(docState(), 'live|-|-');
  assert.equal(restoreLog(), `1|${REP}>${ADMIN}`, 'the restore is recorded with who removed and who restored');
  assert.equal(as(ADMIN, 'SELECT count(*) FROM public.customer_document_restores').out, '1', 'an admin reads the restore record');
  assert.equal(as(REP, 'SELECT count(*) FROM public.customer_document_restores').out, '0', 'a rep reads no restore record');
  refused(as(ADMIN, `INSERT INTO public.customer_document_restores (document_id, customer_id, removed_at, restored_by) VALUES ('${DOC}', '${CUST}', now(), '${ADMIN}')`), /permission denied/, 'admin writes a restore record');
  refused(as(ADMIN, 'DELETE FROM public.customer_document_restores'), /permission denied/, 'admin deletes a restore record');
  assert.equal(as(REP, `SELECT count(*) FROM public.customer_documents WHERE id = '${DOC}'`).out, '1', 'a rep sees the restored document');
  console.log('[prover] only an active admin restores, by clearing both removal columns and nothing else');

  // The old rules still hold on a live document.
  refused(as(ADMIN, `UPDATE public.customer_documents SET filename = 'x.pdf' WHERE id = '${DOC}'`), /identity and provenance are immutable/, 'identity');
  refused(as(ADMIN, `UPDATE public.customer_documents SET deleted_at = now(), deleted_by = '${REP}' WHERE id = '${DOC}'`), /attribution must match/, 'attribution');
  const repRemove = as(REP, `SELECT public.soft_delete_customer_document('${DOC}', '${CUST}', 'doc-restore-rep-remove')::text`);
  assert.equal(repRemove.status, 0, repRemove.err);
  assert.match(docState(), REMOVED_BY_REP);
  assert.equal(as(ADMIN, RESTORE).status, 0, 'a document can be restored again after a second removal');
  assert.equal(docState(), 'live|-|-');
  assert.equal(restoreLog(), `2|${REP}>${ADMIN},${REP}>${ADMIN}`, 'each restore is recorded');
  // A retry of the rep's removal (same key) after the restore must not report "removed".
  refused(as(REP, `SELECT public.soft_delete_customer_document('${DOC}', '${CUST}', 'doc-restore-rep-remove')::text`),
    /CUSTOMER_DOCUMENT_RESTORED/, 'replayed removal after a restore');
  assert.equal(docState(), 'live|-|-');
  // A new removal with a new key still works.
  assert.equal(as(REP, `SELECT public.soft_delete_customer_document('${DOC}', '${CUST}', 'doc-restore-rep-remove-2')::text`).status, 0);
  assert.match(docState(), REMOVED_BY_REP);
  assert.equal(as(ADMIN, RESTORE).out, '1');
  console.log('[prover] identity, attributable removal and the rep remove RPC are unchanged');

  // ---- Photos ----
  refused(as(DRIVER, photoInsert(ADMIN, 'driver.jpg')), /DELIVERY_PHOTO_UPLOADER_MISMATCH/, 'another uploader');
  refused(as(DRIVER, photoInsert(DRIVER, 'admin.jpg')), /DELIVERY_PHOTO_FILE_NOT_YOURS/, "someone else's file");
  refused(as(DRIVER, photoInsert(DRIVER, 'missing.jpg')), /DELIVERY_PHOTO_FILE_NOT_YOURS/, 'missing file');
  refused(as(DRIVER, photoInsert(DRIVER, 'other-bucket.jpg')), /DELIVERY_PHOTO_FILE_NOT_YOURS/, 'other bucket');
  refused(as(ADMIN, photoInsert(DRIVER, 'driver.jpg')), /DELIVERY_PHOTO_UPLOADER_MISMATCH/, 'admin naming the driver');
  const ok = as(DRIVER, photoInsert(DRIVER, 'driver.jpg', "'2020-01-01'"));
  assert.equal(ok.status, 0, ok.err);
  const photo = scalar(`SELECT id FROM public.delivery_photos WHERE storage_path = 'delivery-photos/${D}/driver.jpg';`);
  assert.equal(scalar(`SELECT uploaded_by::text || '|' || (uploaded_at = '${FILE_TIME}'::timestamptz)::text FROM public.delivery_photos WHERE id = '${photo}';`),
    `${DRIVER}|true`, "uploader recorded, upload time is the file's own");
  console.log('[prover] a photo row must name its uploader and a file that uploader owns');

  for (const [col, value] of [['uploaded_by', `'${ADMIN}'`], ['uploaded_at', "'2020-01-01'"], ['storage_path', `'delivery-photos/${D}/admin.jpg'`], ['delivery_id', `'${id('b9')}'`]]) {
    refused(as(ADMIN, `UPDATE public.delivery_photos SET ${col} = ${value} WHERE id = '${photo}'`), /DELIVERY_PHOTO_PROVENANCE_LOCKED/, `change ${col}`);
    refused(service(`UPDATE public.delivery_photos SET ${col} = ${value} WHERE id = '${photo}'`), /DELIVERY_PHOTO_PROVENANCE_LOCKED/, `service change ${col}`);
  }
  assert.equal(as(ADMIN, `UPDATE public.delivery_photos SET sort_order = 3 WHERE id = '${photo}'`).status, 0, 'other columns stay editable');
  assert.equal(service(photoInsert(ADMIN, 'missing-but-service.jpg')).status, 0, 'a service-role insert is not checked (KI-77 accepted limit)');
  console.log('[prover] uploader, time, file and delivery never change; service-role inserts are unchecked');

  const done = as(DRIVER, `SELECT public.complete_delivery(p_delivery_id => '${D}', p_signed_by => '[PROVER] Signer',
    p_performed_by => '${DRIVER}', p_quantities => jsonb_build_object('${DI}', 10), p_idempotency_key => 'doc-restore-ticket',
    p_evidence => 'paper_ticket', p_evidence_ref => '${photo}')::text`);
  assert.equal(done.status, 0, done.err);
  assert.equal(scalar(`SELECT status || '|' || completion_evidence || '|' || completion_evidence_ref FROM public.deliveries WHERE id = '${D}';`),
    `completed|paper_ticket|${photo}`);
  console.log('[prover] a paper-ticket completion accepts the guarded photo');

  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public._guard_delivery_photo_uploader()', 'EXECUTE')::text;"), 'false');
  console.log('DOCUMENT_RESTORE_PHOTO_UPLOADER_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }

