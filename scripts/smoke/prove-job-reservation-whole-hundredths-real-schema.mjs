#!/usr/bin/env node
/**
 * Real-schema proof for KI-100 (20261106170000). Builds the checked-in schema baseline in a
 * network-disabled PostgreSQL container and replays migrations up to the candidate. With invented
 * rows, a spray job on a 10 gal booking that applies 1 fl oz (0.0078125 gal) is synced BEFORE the
 * candidate: its draw is 0.0078125 and the booking is left with 9.9921875 gal, more decimals than
 * the live Partial Order rule (20261106110000) accepts, so the booking can never close. AFTER the
 * candidate the same sync draws 0.01 and leaves 9.99 (whole hundredths, which a Partial Order can
 * take); the job's shed hold is at least that draw (0.01), and a demand under 0.005 gal draws
 * nothing while its full hold is kept. The candidate refuses to apply over a completed job that
 * keeps an unrounded draw.
 *
 * Run: node scripts/smoke/prove-job-reservation-whole-hundredths-real-schema.mjs   (needs local Docker image)
 * Prints JOB_RESERVATION_HUNDREDTHS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-job-draw-hundredths-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261106170000_job_reservation_whole_hundredths.sql');
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
const TOUCHED = /(_sync_quote_job_reservations|job_product_draws)/i;
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


const id = (n) => `6c000000-0000-4000-8000-${n.padStart(12, '0')}`;
const C = id('c1');
const P = id('f1');
const Q = id('e1');
const J = id('11');
const S = id('51');
const U = id('a1');

// Invented rows only, written with triggers and foreign keys off: the proof is about what the sync
// writes, not how a quote or job is saved.
function seed() {
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name) VALUES ('${C}', 'KI-100 Farm');
    INSERT INTO public.products (id, product_name, unit_size, inventory_unit, product_form)
      VALUES ('${P}', 'KI-100 Liquid', 'gal', 'gal', 'liquid');
    INSERT INTO public.inventory (product_id, location)
      VALUES ('${P}', 'Main Warehouse');
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, status, is_planned)
      VALUES ('${Q}', 'KI100-Q', '${C}', '${U}', 'sent', true);
    INSERT INTO public.quote_items (quote_id, section_id, product_id, total_units_needed)
      VALUES ('${Q}', '${S}', '${P}', 10);
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, quote_id, status, created_by)
      VALUES ('${J}', 'KI100-J', '${C}', DATE '2026-11-04', '${Q}', 'scheduled', '${U}');
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, customer_supplied)
      VALUES ('${J}', '${P}', 1, 'fl oz', false);`);
}

const DRAWN = `SELECT quantity_drawn FROM public.job_product_draws WHERE job_id = '${J}' AND product_id = '${P}';`;
const LEFT = `SELECT 10 - COALESCE((SELECT sum(quantity_drawn) FROM public.job_product_draws WHERE quote_id = '${Q}' AND product_id = '${P}'), 0);`;
const HOLD = `SELECT quantity FROM public.inventory_holds WHERE hold_type = 'job' AND source_id = '${J}' AND is_active;`;
// The invented actor has no profile row, so the sync runs with foreign keys off like the seed.
const sync = () => psql(`SET session_replication_role = replica; SELECT public._sync_quote_job_reservations('${Q}', NULL);`);
const scaleOf = (v) => scalar(`SELECT scale(trim_scale((${v})::numeric));`);

function main() {
  buildContainer();
  seed();

  // BEFORE the candidate: the live body strands an unreachable remainder.
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._sync_quote_job_reservations(uuid,uuid)'::regprocedure;`),
    '04ee0476248f3619d20df7a4e5e9a760', 'the replayed sync is not the live body the candidate pins');
  sync();
  assert.equal(Number(scalar(DRAWN)), 0.0078125, 'before: 1 fl oz should draw 0.0078125 gal');
  const leftBefore = scalar(LEFT);
  assert.equal(Number(leftBefore), 9.9921875, 'before: the booking should have 9.9921875 gal left');
  assert.ok(Number(scaleOf(leftBefore)) > 2, 'before: the remainder should need more than 2 decimals');
  console.log(`[prover] BEFORE: job draw ${scalar(DRAWN)} gal, booking left ${leftBefore} gal (no Partial Order can take it)`);

  // A completed job keeps its draw (the sync never rebuilds it), so the candidate refuses to apply
  // over a kept unrounded draw.
  stageText('candidate.sql', lf(CANDIDATE));
  psql(`SET session_replication_role = replica; UPDATE public.jobs SET status = 'completed' WHERE id = '${J}';`);
  const refused = apply('candidate.sql');
  assert.notEqual(refused.status, 0, 'the candidate must refuse a kept draw finer than 0.01');
  assert.match(refused.output, /PREFLIGHT_KEPT_JOB_DRAW_NOT_HUNDREDTHS/);
  psql(`SET session_replication_role = replica; UPDATE public.jobs SET status = 'scheduled' WHERE id = '${J}';`);
  console.log('[prover] a completed job keeping an unrounded draw: the candidate refuses to apply');
  // An active job's unrounded draw is refused too (it would wait for its next sync); reconcile it.
  assert.match(apply('candidate.sql').output, /PREFLIGHT_KEPT_JOB_DRAW_NOT_HUNDREDTHS/, 'an active unrounded draw must be refused');
  psql(`SET session_replication_role = replica; DELETE FROM public.job_product_draws WHERE job_id = '${J}';`);
  console.log('[prover] an active job with an unrounded draw: refused too, until it is reconciled');

  // Apply the candidate as one transaction (its preflight checks that).
  const r = apply('candidate.sql');
  assert.equal(r.status, 0, `candidate failed to apply:\n${r.output}`);

  // AFTER: the same sync draws whole hundredths and leaves a remainder a Partial Order can take.
  sync();
  assert.equal(scalar(DRAWN), '0.01', 'after: 1 fl oz should draw 0.01 gal');
  const leftAfter = scalar(LEFT);
  assert.equal(Number(leftAfter), 9.99, 'after: the booking should have 9.99 gal left');
  assert.ok(Number(scaleOf(leftAfter)) <= 2, 'after: the remainder should be whole hundredths');
  assert.equal(Number(scalar(HOLD)), 0.01, 'after: the shed hold should be at least the draw the booking gave up');
  console.log(`[prover] AFTER: job draw ${scalar(DRAWN)} gal, booking left ${leftAfter} gal, shed hold ${scalar(HOLD)} gal`);

  // A demand under half a hundredth draws nothing (and so writes no draw row); the hold still covers it.
  psql(`SET session_replication_role = replica; UPDATE public.job_chemicals SET quantity = 0.5 WHERE job_id = '${J}';`);
  sync();
  assert.equal(scalar(DRAWN), '', 'after: 0.5 fl oz (0.0039 gal) should draw nothing');
  assert.equal(Number(scalar(HOLD)), 0.00390625, 'after: the hold should still be 0.00390625 gal');
  console.log('[prover] AFTER: a demand under 0.005 gal draws nothing; its hold is kept');

  // Many small jobs completed one after another: the booking's draws track the real total applied,
  // rounded once, instead of adding up one rounding per job (8 x 0.01 = 0.08 for 0.0625 applied).
  psql(`SET session_replication_role = replica; UPDATE public.job_chemicals SET quantity = 1 WHERE job_id = '${J}';`);
  for (let n = 1; n <= 8; n += 1) {
    const jobN = n === 1 ? J : id(`2${n}`);
    if (n > 1) {
      psql(`SET session_replication_role = replica;
        INSERT INTO public.jobs (id, job_number, customer_id, job_date, quote_id, status, created_by)
          VALUES ('${jobN}', 'KI100-J${n}', '${C}', DATE '2026-11-04', '${Q}', 'scheduled', '${U}');
        INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, customer_supplied)
          VALUES ('${jobN}', '${P}', 1, 'fl oz', false);`);
    }
    sync();
    const total = scalar(`SELECT COALESCE(sum(quantity_drawn), 0) FROM public.job_product_draws WHERE quote_id = '${Q}' AND product_id = '${P}';`);
    const expected = Math.round(n * 0.0078125 * 100) / 100;
    assert.equal(Number(total), expected, `after ${n} jobs the booking should have drawn ${expected} gal, not ${total}`);
    assert.ok(Number(scaleOf(scalar(LEFT))) <= 2, `after ${n} jobs the remainder should be whole hundredths`);
    psql(`SET session_replication_role = replica; UPDATE public.jobs SET status = 'completed' WHERE id = '${jobN}';`);
  }
  console.log(`[prover] AFTER: 8 jobs of 1 fl oz completed one by one drew ${scalar(`SELECT sum(quantity_drawn) FROM public.job_product_draws WHERE quote_id = '${Q}';`)} gal for 0.0625 gal applied`);
  console.log('JOB_RESERVATION_HUNDREDTHS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
