#!/usr/bin/env node
/**
 * Real-schema proof for 20261207113000_parent_epa_correction: new invoice lines get the
 * product's EPA number (none when it has none), the readers are unchanged (they move to the copies with the screens PR),
 * and the parent EPA correction (switched off by the file, switched on here for the test) writes the
 * parent and every size, so jobs not sprayed yet show the new number while sprayed and finished jobs
 * keep the number 20261204120000 locked for them; it refuses
 * while an invoice line has no copy and its size's number would change, and leaves sprayed and finished jobs and invoices as they were.
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays every
 * migration before the candidate, seeds invented rows and checks each case.
 *
 * Run: node scripts/smoke/prove-parent-epa-correction-real-schema.mjs   (needs local Docker image)
 * Prints PARENT_EPA_CORRECTION_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-parentepa-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261207113000_parent_epa_correction.sql');
const FOLLOW_UPS = [];
// Later files that only READ what this proof covers and redefine none of it (none since the
// restamp to 20261207113000 put 20261207100000 product weights before this file).
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
const TOUCHED = /(job_chemicals|_product_parent_identity_after|correct_product_parent_identity|_copy_parent_to_size|_product_parent_epa_correction_enabled|_fill_invoice_line_epa|job_product_epa|job_epa_sprayed|_job_epa_freeze|_epa_norm)/i;
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


const id = (n) => `7a7e3000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
const CUST = id('c1');
const PARENT = id('f0'), S1 = id('f1'), S2 = id('f2'), OTHER = id('f9');
const JOPEN = id('10'), JPROG = id('11'), JDONE = id('12'), JDEL = id('13'), JINV = id('14'), JSPRAY = id('15');
const IPOST = id('20'), IDRAFT = id('21'), IBLANK = id('22');
const FIELD = id('30');
const OLD = '524-475', NEW = '524-476', OTHER_EPA = '100-1070';

function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
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
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const version = () => scalar(`SELECT parent_version FROM public.product_parents WHERE id = '${PARENT}';`);
const correctSql = (changes, key, ver = version()) =>
  `SELECT public.correct_product_parent_identity('${PARENT}', ${ver}, ${J(changes)}, 'typo on the label entry', 'EPA label PDF, page 1', '${key}');`;
// The number a job shows for a product (20261204120000 item 4): the job's kept number, else the product's.
const lineEpa = (job, pid) => scalar(`SELECT CASE WHEN k.job_id IS NOT NULL THEN COALESCE(k.epa_registration, '<null>')
    ELSE COALESCE(public._epa_norm(p.epa_registration), '<null>') END
  FROM public.products p LEFT JOIN public.job_product_epa k ON k.job_id = '${job}' AND k.product_id = p.id
  WHERE p.id = '${pid}';`);
const productEpa = (pid) => scalar(`SELECT COALESCE(epa_registration, '<null>') FROM public.products WHERE id = '${pid}';`);
const invoiceEpas = () => scalar(`SELECT string_agg(i.invoice_number || ':' || COALESCE(ii.epa_registration, '<null>'), ',' ORDER BY i.invoice_number, ii.description)
  FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id;`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'pe-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'pe-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  const p = (pid, name, epa) => `('${pid}', '[PROVER] ${name}', '${name}', 'liquid', 'Gal', 'Herbicide', '${epa}', 10.00, 15.00, true)`;
  const line = (job, pid, n) => `('${job}', '${pid}', 5, 'gal', 1500, ${n})`;
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT 'Gal', 128, 'liquid' WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = 'Gal');
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUST}', '[PROVER] Farm');
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] Field', 100);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, current_cost, tier1_price, is_active) VALUES
      ${p(S1, 'Gly 2.5 Gal', OLD)}, ${p(S2, 'Gly Bulk', OLD)}, ${p(OTHER, 'Other Chem', OTHER_EPA)};
    INSERT INTO public.product_parents (id, name, product_form, category, generic_epa_registration, created_by, updated_by) VALUES
      ('${PARENT}', '[PROVER] Gly', 'liquid', 'Herbicide', '${OLD}', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES
      ('${S1}', '${PARENT}', 'package', '${ADMIN}'), ('${S2}', '${PARENT}', 'bulk', '${ADMIN}');
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by, deleted_at) VALUES
      ('${JOPEN}', 'PE-OPEN', '${CUST}', 'scheduled', current_date, '${ADMIN}', NULL),
      ('${JPROG}', 'PE-PROG', '${CUST}', 'in_progress', current_date, '${ADMIN}', NULL),
      ('${JDONE}', 'PE-DONE', '${CUST}', 'completed', current_date, '${ADMIN}', NULL),
      ('${JINV}', 'PE-INV', '${CUST}', 'invoiced', current_date, '${ADMIN}', NULL),
      ('${JDEL}', 'PE-DEL', '${CUST}', 'scheduled', current_date, '${ADMIN}', now()),
      ('${JSPRAY}', 'PE-SPRAYED', '${CUST}', 'in_progress', current_date, '${ADMIN}', NULL);
    INSERT INTO public.job_applied_records (job_id, application_date, applied_acres) VALUES ('${JSPRAY}', current_date, 40);
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, sort_order) VALUES
      ${[JOPEN, JPROG, JDONE, JINV, JDEL, JSPRAY].flatMap((j) => [line(j, S1, 1), line(j, OTHER, 2)]).join(', ')};
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, created_by, posted_by, posted_at, total_amount_cents, season) VALUES
      ('${IPOST}', 'PE-INV-POSTED', '${CUST}', 'field_application', 'posted', '${ADMIN}', '${ADMIN}', now(), 3000, 2026),
      ('${IDRAFT}', 'PE-INV-DRAFT', '${CUST}', 'field_application', 'draft', '${ADMIN}', NULL, NULL, 0, 2026);
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, epa_registration) VALUES
      ('${IPOST}', '${S1}', '[PROVER] a gly line', 2, 1500, 3000, 1000, '${OLD}');`);
  psql(`SELECT public._job_epa_freeze(j) FROM unnest(ARRAY['${JSPRAY}', '${JDONE}', '${JINV}']::uuid[]) j;`);
  assert.equal(scalar('SELECT count(*) FROM public.job_product_epa WHERE NOT not_recorded;'), '6');
  console.log('[prover] seeded an admin, a rep, a parent with two sizes, an unrelated product, six jobs (sprayed, completed and invoiced ones with their numbers kept) and a posted invoice');
}

async function main() {
  buildContainer();
  seed();
  stageText('cand.sql', lf(CANDIDATE));

  // One transaction only, once only.
  let r = docker([...psqlArgs(), '-f', '/tmp/cand.sql'], { allowFailure: true });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}\n${r.stderr}`, /PARENT_EPA_CORRECTION_NOT_IN_TRANSACTION/);
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname = '_fill_invoice_line_epa';"), '0');
  r = apply('cand.sql');
  assert.equal(r.status, 0, r.output);
  r = apply('cand.sql');
  assert.notEqual(r.status, 0);
  assert.match(r.output, /PARENT_EPA_CORRECTION_PREFLIGHT: this file was already applied/);
  console.log('[prover] the file applies once, as one transaction');

  refused(null, 'SELECT public._product_parent_epa_correction_enabled();', /permission denied/);
  refused(ADMIN, 'SELECT public._product_parent_epa_correction_enabled();', /permission denied/);
  console.log('[prover] no one signed in can call the switch');

  // Invoice lines: a blank one (spaces, tabs and line breaks count as blank) gets the product's number; a given one is kept.
  psql(`INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES
      ('${IDRAFT}', '${S2}', '[PROVER] blank given', 1, 1500, 1500, 1000);
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, epa_registration) VALUES
      ('${IDRAFT}', '${OTHER}', '[PROVER] number given', 1, 1500, 1500, 1000, '7-7'),
      ('${IDRAFT}', '${OTHER}', '[PROVER] spaces given', 1, 1500, 1500, 1000, E' \\t\\n');`);
  assert.equal(invoiceEpas(), `PE-INV-DRAFT:${OLD},PE-INV-DRAFT:7-7,PE-INV-DRAFT:${OTHER_EPA},PE-INV-POSTED:${OLD}`);
  const blankLine = `invoice_id = '${IDRAFT}' AND description = '[PROVER] blank given'`;
  const draftLineEpa = () => scalar(`SELECT epa_registration FROM public.invoice_items WHERE ${blankLine};`);
  psql(`UPDATE public.invoice_items SET description = description WHERE ${blankLine};`);
  assert.equal(draftLineEpa(), OLD);
  // A line made before this file with no copy gets one on a later edit of a draft invoice. A posted
  // invoice's blank line is never filled by the cost-only edits its lock still allows (filling it would
  // make the lock refuse those edits).
  const postedLine = `invoice_id = '${IPOST}' AND description = '[PROVER] a gly line'`;
  const asFixture = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`);
  asFixture(`UPDATE public.invoice_items SET epa_registration = NULL WHERE ${blankLine} OR ${postedLine};`);
  psql(`UPDATE public.invoice_items SET description = description WHERE ${blankLine};`);
  assert.equal(draftLineEpa(), OLD);
  psql(`UPDATE public.invoice_items SET cost_cents = cost_cents + 1 WHERE ${postedLine};`);
  assert.equal(scalar(`SELECT COALESCE(epa_registration, '<null>') FROM public.invoice_items WHERE ${postedLine};`), '<null>');
  asFixture(`UPDATE public.invoice_items SET epa_registration = '${OLD}', cost_cents = cost_cents - 1 WHERE ${postedLine};`);
  psql(`UPDATE public.invoice_items SET product_id = '${OTHER}' WHERE ${blankLine};`);
  assert.equal(draftLineEpa(), OTHER_EPA);
  psql(`UPDATE public.invoice_items SET product_id = '${S2}', epa_registration = '9-9' WHERE ${blankLine};`);
  assert.equal(draftLineEpa(), '9-9');
  psql(`UPDATE public.invoice_items SET product_id = '${S2}' WHERE ${blankLine};`);
  assert.equal(draftLineEpa(), '9-9');
  psql(`UPDATE public.invoice_items SET product_id = '${OTHER}' WHERE ${blankLine};
    UPDATE public.invoice_items SET product_id = '${S2}' WHERE ${blankLine};`);
  assert.equal(draftLineEpa(), OLD);
  psql(`UPDATE public.invoice_items SET epa_registration = '' WHERE ${blankLine};`);
  assert.equal(draftLineEpa(), OLD);
  console.log("[prover] an invoice line written without an EPA number gets its product's; a given number is kept; a line moved to another product takes that product's number unless one is sent");

  // Switched off: the EPA change is refused; other identity corrections still work.
  refused(ADMIN, correctSql({ generic_epa_registration: NEW }, 'k-off'), /PRODUCT_PARENT_EPA_CORRECTION_OFF/);
  let receipt = JSON.parse(ok(ADMIN, correctSql({ safener: 'cloquintocet' }, 'k-safener')));
  assert.deepEqual(receipt.sizes, []);
  assert.equal(receipt.open_job_lines, 0);
  assert.equal(scalar(`SELECT safener FROM public.product_parents WHERE id = '${PARENT}';`), 'cloquintocet');
  // The same number written differently is not a change.
  refused(ADMIN, correctSql({ generic_epa_registration: ' 524-475 ' }, 'k-same'), /PRODUCT_PARENT_NO_CHANGE/);
  console.log('[prover] switched off, an EPA change is refused and a safener correction still works');

  // Switch on for the rest of the proof (the screens PR's migration does this live).
  psql('CREATE OR REPLACE FUNCTION public._product_parent_epa_correction_enabled() RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $f$ SELECT true $f$;');

  refused(REP, correctSql({ generic_epa_registration: NEW }, 'k-rep'), /ADMIN_REQUIRED/);
  refused(ADMIN, correctSql({ generic_epa_registration: 'ABC' }, 'k-bad'), /PRODUCT_PARENT_INVALID/);
  refused(ADMIN, correctSql({ generic_epa_registration: '0524-475' }, 'k-bad2'), /PRODUCT_PARENT_INVALID/);
  refused(ADMIN, correctSql({ generic_epa_registration: 524 }, 'k-bad3'), /PRODUCT_PARENT_INVALID/);
  refused(ADMIN, `SELECT public.correct_product_parent_identity('${PARENT}', ${version()}, ${J({ generic_epa_registration: NEW })}, 'typo', NULL, 'k-noevidence');`, /evidence/i);

  // An invoice line with no copy of its own blocks the change and is named.
  asOwner(`INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, created_by, posted_by, posted_at, total_amount_cents, season) VALUES
      ('${IBLANK}', 'PE-INV-BLANK', '${CUST}', 'field_application', 'posted', '${ADMIN}', '${ADMIN}', now(), 1500, 2026);
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, epa_registration) VALUES
      ('${IBLANK}', '${S2}', '[PROVER] old blank line', 1, 1500, 1500, 1000, E'\\t');`);
  r = as(ADMIN, correctSql({ generic_epa_registration: NEW }, 'k-blocked'));
  assert.notEqual(r.status, 0);
  assert.match(r.output, /PRODUCT_PARENT_EPA_RECORD_UNSAVED: invoice PE-INV-BLANK \(posted\)/);
  // A blank line for a size with no number showed none: it does not block (a missing number stays correctable).
  asFixture(`UPDATE public.products SET epa_registration = NULL WHERE id = '${S2}';`);
  assert.equal(scalar(`SELECT public._product_parent_identity_after(p, '{"generic_epa_registration": "${NEW}"}')->>'generic_epa_registration'
    FROM public.product_parents p WHERE id = '${PARENT}';`), NEW);
  // Nor does one whose size already carries the corrected number: the line keeps showing it (Luna 2026-11-07).
  asFixture(`UPDATE public.products SET epa_registration = '${NEW}' WHERE id = '${S2}';`);
  assert.equal(scalar(`SELECT public._product_parent_identity_after(p, '{"generic_epa_registration": "${NEW}"}')->>'generic_epa_registration'
    FROM public.product_parents p WHERE id = '${PARENT}';`), NEW);
  asFixture(`UPDATE public.products SET epa_registration = '${OLD}' WHERE id = '${S2}';`);
  assert.equal(productEpa(S2), OLD);
  // A deleted invoice does not block, nor does a blank line for a product outside this parent.
  asOwner(`UPDATE public.invoices SET deleted_at = now() WHERE id = '${IBLANK}';
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES
      ('${IPOST}', '${OTHER}', '[PROVER] other blank', 1, 1500, 1500, 1000);`);
  console.log('[prover] refused for a rep, an invalid number, no evidence, and while a live invoice line for a size has no EPA copy (named)');

  // The correction.
  const before = { invoices: invoiceEpas(), events: scalar('SELECT count(*) FROM public.product_parent_events;') };
  const ver = version();
  receipt = JSON.parse(ok(ADMIN, correctSql({ generic_epa_registration: ' 524-476 ' }, 'k-fix')));
  assert.equal(scalar(`SELECT generic_epa_registration FROM public.product_parents WHERE id = '${PARENT}';`), NEW);
  assert.equal(version(), String(Number(ver) + 1));
  assert.equal(productEpa(S1), NEW);
  assert.equal(productEpa(S2), NEW);
  assert.equal(productEpa(OTHER), OTHER_EPA);
  assert.deepEqual(receipt.sizes.map((s) => [s.product_id, s.before.epa_registration ?? null, s.after.epa_registration ?? null]).sort(),
    [[S1, OLD, NEW], [S2, OLD, NEW]].sort());
  // Open jobs (scheduled, in progress) show the new number; the deleted one is not counted.
  assert.equal(receipt.open_job_lines, 2);
  assert.equal(lineEpa(JOPEN, S1), NEW);
  assert.equal(lineEpa(JPROG, S1), NEW);
  // Sprayed, finished and invoiced jobs keep the number they had; other products are untouched.
  assert.equal(lineEpa(JSPRAY, S1), OLD);
  assert.equal(lineEpa(JDONE, S1), OLD);
  assert.equal(lineEpa(JINV, S1), OLD);
  assert.equal(scalar(`SELECT count(*) FROM public.job_product_epa WHERE product_id = '${S1}' AND epa_registration = '${OLD}';`), '3');
  for (const j of [JOPEN, JPROG, JDONE, JINV, JSPRAY]) assert.equal(lineEpa(j, OTHER), OTHER_EPA);
  assert.equal(invoiceEpas(), before.invoices, 'an invoice line changed');
  assert.equal(scalar('SELECT count(*) FROM public.product_parent_events;'), String(Number(before.events) + 1));
  assert.equal(scalar(`SELECT event_type || ':' || jsonb_array_length(affected) || ':' || (after_values->>'generic_epa_registration')
    FROM public.product_parent_events WHERE id = ${receipt.event_id};`), `identity_corrected:2:${NEW}`);
  console.log('[prover] the correction wrote the parent, both sizes and jobs not sprayed yet show the new number, in one logged event; sprayed, finished and invoiced jobs and every invoice line kept their number');

  // A sprayed job saved again from the job screen (save_job deletes and re-writes its lines) keeps
  // the number it was sprayed under, after the correction.
  const sent = scalar(`SELECT string_agg(id::text || '/' || product_id::text || '/' || sort_order, ',' ORDER BY sort_order)
    FROM public.job_chemicals WHERE job_id = '${JSPRAY}';`).split(',').map((x) => x.split('/'));
  ok(ADMIN, `SELECT public.save_job('${JSPRAY}', jsonb_build_object('customer_id', '${CUST}', 'job_date', current_date::text),
    ${J([{ field_id: FIELD, acres_to_treat: 10, sort_order: 0 }])}, ${J(sent.map(([lid, pid, n]) => ({ id: lid, product_id: pid, quantity: 0,
      unit: 'Gal', rate_per_acre: null, rate_unit: null, cost_per_unit_cents: 0, price_per_unit_cents: 0, customer_supplied: true, sort_order: Number(n) })))},
    auth.uid(), 'k-resave-sprayed');`);
  assert.equal(lineEpa(JSPRAY, S1), OLD);
  console.log('[prover] a sprayed job saved again from the job screen after the correction keeps the number it was sprayed under');

  // Replay, a reused key, a stale version.
  const again = JSON.parse(ok(ADMIN, correctSql({ generic_epa_registration: ' 524-476 ' }, 'k-fix', ver)));
  assert.deepEqual(again, receipt);
  assert.equal(scalar('SELECT count(*) FROM public.product_parent_events;'), String(Number(before.events) + 1));
  refused(ADMIN, correctSql({ generic_epa_registration: '524-477' }, 'k-fix', ver), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(ADMIN, correctSql({ generic_epa_registration: '524-477' }, 'k-stale', ver), /STALE|version/i);
  console.log('[prover] a retried correction returns the same receipt and writes nothing; a reused key or a stale version is refused');

  // A product outside any parent, its EPA number edited directly: jobs not sprayed yet follow, the rest keep theirs.
  psql(`UPDATE public.products SET epa_registration = '300-3' WHERE id = '${OTHER}';`);
  for (const j of [JOPEN, JPROG]) assert.equal(lineEpa(j, OTHER), '300-3');
  for (const j of [JDONE, JSPRAY, JINV]) assert.equal(lineEpa(j, OTHER), OTHER_EPA);
  psql(`UPDATE public.products SET epa_registration = '${OTHER_EPA}' WHERE id = '${OTHER}';`);
  for (const j of [JOPEN, JPROG]) assert.equal(lineEpa(j, OTHER), OTHER_EPA);
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_sync_job_holds_upd';"), 'O');
  console.log("[prover] a product's EPA number edited directly reaches jobs not sprayed yet only; the holds trigger is on");

  // A line added to an open job after the correction shows the new number.
  psql(`INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, sort_order) VALUES ('${JPROG}', '${S2}', 1, 'gal', 1500, 4);`);
  assert.equal(lineEpa(JPROG, S2), NEW);

  // The readers are unchanged here: the sent proof still shows the product's number.
  const proof = JSON.parse(ok(ADMIN, `SELECT public.get_job_proof_data('${JDONE}');`));
  assert.ok(proof.products.some((x) => x.epa_registration === NEW));
  console.log('[prover] the sent-proof reader is unchanged (it moves to the copies with the screens PR)');

  // Correcting back is a new event; finished jobs still keep theirs.
  ok(ADMIN, correctSql({ generic_epa_registration: OLD }, 'k-back'));
  assert.equal(productEpa(S1), OLD);
  assert.equal(lineEpa(JDONE, S1), OLD);
  assert.equal(lineEpa(JPROG, S2), OLD);
  console.log('PARENT_EPA_CORRECTION_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
