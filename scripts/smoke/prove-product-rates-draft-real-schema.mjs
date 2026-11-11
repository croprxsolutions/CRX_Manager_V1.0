#!/usr/bin/env node
/**
 * Real-schema proof for 20261229110000_product_rates_draft.sql (RT-1; build sheet
 * docs/plans/2026-11-08-product-RT1-BUILD-SHEET.md, section 6, cases R1-R18).
 *
 * Builds the checked-in production baseline plus every post-baseline migration before the candidate in a
 * network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds live's fourteen
 * unit_conversions rows, makes fixture parents and sizes through PAR-1's own RPCs (create_product_with_parent,
 * add_product_size, preview_parent_rates, set_parent_rates) signed in as an admin, adds fixture EPA
 * registrations, and forces two shapes the PAR-1 guards refuse (sizes that disagree, a dry product rated in
 * `oz`) as supabase_admin with triggers off. Then: autocommit refused, apply prints POSTFLIGHT_OK, one batch
 * derivation, and every R-case calling the four RPCs as `authenticated` with an admin's claims. R11 runs two
 * real sessions at once and watches pg_stat_activity for the waiter. R12 compares an md5 of every fixture
 * product's and parent's rate and price columns, product_price_per_acre for every tier, a fixture quote's
 * saved lines and the five untouched function fingerprints before the apply, after it, after derivation and
 * at the end. Re-apply is refused.
 *
 * Run: node scripts/smoke/prove-product-rates-draft-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a kept container: UNDO_PATHS_CONTAINER=<name> RT1_PROOF_REUSE=1 (the candidate's objects are
 * dropped and re-applied; fixtures are kept). Prints PRODUCT_RATES_DRAFT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, replay, removeContainer, seedUsers, scalar, psql, attempt, asUser, refuse, claims, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20261229110000_product_rates_draft.sql';
const PARENT_MIGRATION = '20261217100000_job_access_ends_with_the_job.sql';
const reuse = process.env.RT1_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
// The candidate's own functions, read from its grants list (the reuse reset drops exactly these).
const NEW_FUNCTIONS = `ARRAY[${candidate.slice(candidate.indexOf('CREATE TEMP TABLE product_rates_draft_fns'), candidate.indexOf('DO $grants$'))
  .match(/'public\.[a-z_]+\([^)]*\)'/g).join(', ')}]`;
const ADMIN = USERS.admin;
const REP = USERS.rep;
const QUOTE = id('b1');
const run = (flags) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...flags],
  { input: candidate, allowFailure: true });
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sq = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);
const num = (n) => (n === null || n === undefined ? 'NULL' : `${n}::numeric`);

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

// name, form, stock units, parent rate, rate unit, suggested rate, generic EPA number.
const FIXTURES = [
  ['MSO XL', 'liquid', ['Gal', 'Gal'], 9.6, 'oz', '2 qt/100 Gal', null],
  ['Liquid A', 'liquid', ['Gal'], 1.5, 'Pt', null, '100-1'],
  ['Above', 'liquid', ['Gal'], 1.6, 'Pt', null, '100-1'],
  ['No Max', 'liquid', ['Gal'], 1, 'qt', null, '100-2'],
  ['Spray Max', 'liquid', ['Gal'], 1, 'qt', null, '100-3'],
  ['Dry Kg', 'dry', ['Lb'], 1, 'Lb', null, '100-4'],
  ['No Reg', 'liquid', ['Gal'], 1, 'qt', null, null],
  ['Max Ac', 'liquid', ['Gal'], null, null, null, '100-5'],
  ['Max A', 'liquid', ['Gal'], null, null, null, '100-6'],
  ['Dry A', 'dry', ['Lb'], null, null, null, '100-7'],
  ['Each A', 'each', ['Ea'], 1, null, null, null],
  ['Ilevo', 'liquid', ['Gal'], 1.18, 'oz', '1.18 oz/unit', '100-8'],
  ['Each ST', 'each', ['Ea'], 1.18, null, '1.18 oz/unit', null],
  ['Dry Oz', 'dry', ['Lb'], 2, 'Lb', null, null],          // forced to `oz` below
  ['Per Ton', 'liquid', ['Gal'], 1.5, 'qt', '1.5 qt/ton', null],
  ['Free Text', 'liquid', ['Gal'], 1, 'qt', 'Spray on', null],
  ['Disagree', 'liquid', ['Gal', 'Gal'], 1, 'qt', null, null], // size 2 forced to 2 below
  ['Grouped Each', 'each', ['Ea', 'Ea'], 2, null, null, null],
  ['Mixed Each', 'each', ['Ea', 'Ea'], 1, null, '1 ea/acre', null], // size 2 forced to Unit below
  ['Bad Decimal', 'liquid', ['Gal'], 1, 'qt', '1.1234567 oz/acre', null],
  ['No Rate', 'liquid', ['Gal'], null, null, null, null],
  ['Seed A', 'seed', ['Unit'], null, null, null, null],
  ['Lock Case', 'liquid', ['Gal'], 1, 'qt', null, null],
  ['R11', 'liquid', ['Gal'], 1, 'qt', null, '100-9'],
];
// number, max, max unit (null max = a registration with no label maximum).
const REGISTRATIONS = [
  ['100-1', 24, 'oz/acre'], ['100-2', null, null], ['100-3', 2, 'qt/100 gal'], ['100-4', 1, 'kg/acre'],
  ['100-5', 24, 'oz/ac'], ['100-6', 24, 'oz/a'], ['100-7', 0.035273961, 'oz/acre'], ['100-8', 1.18, 'oz/acre'],
  ['100-9', 24, 'oz/acre'],
];
// Live's unit_conversions rows (read-only, 2026-11-09); the baseline carries only Ea and Unit.
const UNIT_CONVERSIONS = [['fl oz', 1, 'liquid'], ['oz', 1, 'liquid'], ['Oz', 1, 'liquid'], ['Pt', 16, 'liquid'],
  ['qt', 32, 'liquid'], ['Qt', 32, 'liquid'], ['Gal', 128, 'liquid'], ['Dry oz', 1, 'dry'], ['Lb', 16, 'dry'],
  ['LB', 16, 'dry'], ['g', 0.03527396, 'dry'], ['MG', 0.00003527396, 'dry'], ['Ea', 1, 'both'], ['Unit', 1, 'both']];

const MK = `
CREATE SCHEMA IF NOT EXISTS rt1_proof;
CREATE TABLE IF NOT EXISTS rt1_proof.ids (name text PRIMARY KEY, parent uuid NOT NULL, products uuid[] NOT NULL);
CREATE TABLE IF NOT EXISTS rt1_proof.flag (seeded boolean NOT NULL);
CREATE OR REPLACE FUNCTION rt1_proof.mk(p_name text, p_form text, p_units text[], p_rate numeric, p_unit text, p_text text, p_epa text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb; v_parent uuid; v_prev jsonb; i int; v_products uuid[] := '{}';
BEGIN
  r := public.create_product_with_parent(jsonb_build_object('name', '[RT1] ' || p_name, 'product_form', p_form, 'generic_epa_registration', p_epa),
    jsonb_build_object('product_name', '[RT1] ' || p_name || ' 1', 'sku', 'RT1-' || left(md5(p_name), 10) || '-1', 'inventory_unit', p_units[1]), 'rt1-mk-' || p_name);
  v_parent := (r->>'parent_id')::uuid; v_products := v_products || (r->>'product_id')::uuid;
  FOR i IN 2..cardinality(p_units) LOOP
    r := public.add_product_size(v_parent, (SELECT parent_version FROM public.product_parents WHERE id = v_parent),
      jsonb_build_object('product_name', '[RT1] ' || p_name || ' ' || i, 'sku', 'RT1-' || left(md5(p_name), 10) || '-' || i, 'inventory_unit', p_units[i]),
      'rt1-add-' || p_name || '-' || i);
    v_products := v_products || (r->>'product_id')::uuid;
  END LOOP;
  IF p_rate IS NOT NULL OR p_text IS NOT NULL THEN
    v_prev := public.preview_parent_rates(v_parent, p_rate, p_unit, p_text);
    PERFORM public.set_parent_rates(jsonb_build_array(jsonb_build_object('parent_id', v_parent,
      'expected_parent_version', (v_prev->>'parent_version')::bigint, 'rate_per_acre', p_rate::text, 'rate_unit', p_unit,
      'suggested_rate', p_text, 'sizes', v_prev->'sizes')), 'rt1-rates-' || p_name);
  END IF;
  INSERT INTO rt1_proof.ids VALUES (p_name, v_parent, v_products);
  RETURN v_parent;
END $$;`;

function seedFixtures() {
  psql(UNIT_CONVERSIONS.map(([u, f, t]) => `INSERT INTO public.unit_conversions (unit, factor_oz, unit_type)
    SELECT ${sq(u)}, ${f}, ${sq(t)} WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = ${sq(u)});`).join('\n'));
  assert.equal(scalar(`SELECT count(*) FROM public.unit_conversions u JOIN (VALUES ${UNIT_CONVERSIONS.map(([u, f, t]) => `(${sq(u)}, ${f}::numeric, ${sq(t)})`).join(', ')})
    e(unit, factor, kind) ON e.unit = u.unit AND e.factor = u.factor_oz AND e.kind = u.unit_type;`), String(UNIT_CONVERSIONS.length));
  // Live's each/seed stock units (read-only, 2026-11-09); the baseline carries none.
  psql(`INSERT INTO public.product_form_units (product_form, unit) SELECT * FROM (VALUES ('each', 'Ea'), ('each', 'Unit'), ('seed', 'Lb'), ('seed', 'Unit')) v(f, u)
    WHERE NOT EXISTS (SELECT 1 FROM public.product_form_units x WHERE x.product_form = v.f AND x.unit = v.u);`);
  if (scalar(`SELECT count(*) FROM auth.users WHERE id = '${ADMIN}';`) === '0') seedUsers();
  psql(MK);
  for (const [name, form, units, rate, unit, text, epa] of FIXTURES) {
    if (scalar(`SELECT count(*) FROM rt1_proof.ids WHERE name = ${sq(name)};`) === '1') continue;
    const out = attempt(ADMIN, `PERFORM rt1_proof.mk(${sq(name)}, ${sq(form)}, ARRAY[${units.map(sq).join(',')}]::text[], ${num(rate)}, ${sq(unit)}, ${sq(text)}, ${sq(epa)});`, { commit: true });
    assert.equal(out, 'ok|<null>', `fixture ${name}: ${out}`);
  }
}

function seedOnce() {
  if (scalar(`SELECT count(*) FROM public.quotes WHERE id = '${QUOTE}';`) === '1') return;
  psql(`INSERT INTO public.epa_registrations (epa_registration, max_label_rate, max_label_rate_unit, created_by, updated_by) VALUES
    ${REGISTRATIONS.map(([n, m, u]) => `(${sq(n)}, ${num(m)}, ${sq(u)}, '${ADMIN}', '${ADMIN}')`).join(',\n    ')}
    ON CONFLICT DO NOTHING;`);
  // Shapes PAR-1's guards refuse, forced as fixtures only (replica skips triggers): a second size whose rate
  // disagrees, a dry product rated in `oz` (live has two), and an each parent stocked in Ea and Unit
  // (PAR-1 refuses it; the sheet's R14 asks for it). Tier prices make product_price_per_acre real.
  const f = (name) => `(SELECT products FROM rt1_proof.ids WHERE name = ${sq(name)})`;
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE public.products SET rate_per_acre = 2 WHERE id = (${f('Disagree')})[2];
    UPDATE public.products SET rate_unit = 'oz' WHERE id IN (SELECT unnest(products) FROM rt1_proof.ids WHERE name = 'Dry Oz');
    UPDATE public.products SET inventory_unit = 'Unit', rate_unit = 'Unit' WHERE id = (${f('Mixed Each')})[2];
    UPDATE public.product_parents SET rate_unit = 'oz' WHERE id = (SELECT parent FROM rt1_proof.ids WHERE name = 'Dry Oz');
    UPDATE public.products SET tier1_price = 10.25, tier2_price = 11.5, tier3_price = 12.75, unit_size = COALESCE(unit_size, '2.5')
     WHERE id IN (SELECT unnest(products) FROM rt1_proof.ids);
    INSERT INTO public.customers (id, farm_name, is_active, email) VALUES ('${id('b2')}', '[RT1] Farm', true, 'rt1@example.invalid');
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, salesman_id, status, total_price, total_cost, total_profit, total_margin_pct)
      VALUES ('${QUOTE}', 'RT1-Q-1', '${id('b2')}', '${REP}', '${REP}', 'draft', 20.5, 15, 5.5, 26.83);
    INSERT INTO public.quote_sections (id, quote_id, section_name, sort_order) VALUES ('${id('b3')}', '${QUOTE}', 'S1', 0);
    INSERT INTO public.quote_items (id, quote_id, section_id, product_id, price_per_unit, current_cost, total_units_needed, unit_size, total_price, sort_order)
      VALUES ('${id('b4')}', '${QUOTE}', '${id('b3')}', (${f('MSO XL')})[1], 10.25, 7.5, 2, '2.5', 20.5, 0);
    -- Per-acre prices as the recalculation trigger writes them (replica skipped it), so R13 can lock rates.
    UPDATE public.products p SET
      tier1_price_per_acre = public.product_price_per_acre(p.tier1_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size),
      tier2_price_per_acre = public.product_price_per_acre(p.tier2_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size),
      tier3_price_per_acre = public.product_price_per_acre(p.tier3_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size)
     WHERE p.id IN (SELECT unnest(products) FROM rt1_proof.ids)
       AND (p.tier1_price_per_acre, p.tier2_price_per_acre, p.tier3_price_per_acre) IS DISTINCT FROM
           (public.product_price_per_acre(p.tier1_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size),
            public.product_price_per_acre(p.tier2_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size),
            public.product_price_per_acre(p.tier3_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size));
    COMMIT;`, { user: 'supabase_admin' });
}

const P = {};
const SIZES = {};
function loadIds() {
  for (const line of docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-F', '|'],
    { input: 'SELECT name, parent, array_to_string(products, \',\') FROM rt1_proof.ids;' }).stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, parent, products] = line.split('|');
    P[name] = parent; SIZES[name] = products.split(',');
  }
  assert.equal(Object.keys(P).length, FIXTURES.length);
}

// R12: everything a reader shows today, md5'd.
const FIVE = `ARRAY['public.product_price_per_acre(numeric,numeric,text,text,text)', 'public.normalize_rate_unit(text)',
  'public.validate_product_units()', 'public.guard_product_rate_lock()',
  'public._apply_parent_rates(uuid,bigint,numeric,text,text,jsonb,boolean,text)']`;
const readers = () => scalar(`SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
  SELECT row(p.id, p.rate_per_acre, p.rate_unit, p.suggested_rate, p.max_label_rate, p.max_label_rate_unit, p.inventory_unit,
         p.unit_size, p.product_form, p.tier1_price, p.tier2_price, p.tier3_price, p.tier1_price_per_acre, p.tier2_price_per_acre,
         p.tier3_price_per_acre, p.updated_at,
         public.product_price_per_acre(p.tier1_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size),
         public.product_price_per_acre(p.tier2_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size),
         public.product_price_per_acre(p.tier3_price, p.rate_per_acre, p.rate_unit, p.inventory_unit, p.unit_size))::text
    FROM public.products p WHERE p.id IN (SELECT unnest(products) FROM rt1_proof.ids)
  UNION ALL SELECT row(pp.*)::text FROM public.product_parents pp WHERE pp.id IN (SELECT parent FROM rt1_proof.ids)
  UNION ALL SELECT row(q.*)::text FROM public.quotes q WHERE q.id = '${QUOTE}'
  UNION ALL SELECT row(qi.*)::text FROM public.quote_items qi WHERE qi.quote_id = '${QUOTE}'
  UNION ALL SELECT row(l.*)::text FROM public.product_rate_lock l
  UNION ALL SELECT f || md5(row(p.prosrc, p.proconfig, p.prosecdef, p.provolatile, p.proowner, p.proacl, p.proargtypes, p.prorettype)::text)
    FROM unnest(${FIVE}) f JOIN pg_proc p ON p.oid = to_regprocedure(f)) s(x);`);

// ---------------------------------------------------------------------------------------------
// Calls (each as `authenticated`, signed in by the probe)
// ---------------------------------------------------------------------------------------------

const KEY = "'rt1-' || gen_random_uuid()";
// A rate id: a literal uuid, or a parenthesised SQL expression read inside the probe.
const uuidArg = (x) => (x.startsWith('(') ? `${x}::uuid` : `'${x}'`);
const save = (parent, o) => `public.save_draft_product_rate('${parent}', ${o.rate ? uuidArg(o.rate) : 'NULL'}, ${o.ver ?? 'NULL'},
  ${sq(o.basis)}, ${sq(o.source)}, ${num(o.low)}, ${num(o.rec)}, ${num(o.high)}, ${sq(o.unit)}, ${o.def ?? false}, ${sq(o.reason)}, ${o.key ? sq(o.key) : KEY})`;
const del = (rate, ver, reason, key) => `public.delete_draft_product_rate(${uuidArg(rate)}, ${ver}, ${sq(reason)}, ${key ? sq(key) : KEY})`;
const derive = (parents, key) => `public.derive_draft_product_rates(ARRAY[${parents.map((p) => `'${p}'`).join(',')}]::uuid[], ${key ? sq(key) : KEY})`;
const get = (parent) => `public.get_parent_draft_rates('${parent}')`;

function probe(body, who = ADMIN, opts) {
  const out = attempt(who, body, opts);
  assert.ok(out.startsWith('ok|'), `probe failed: ${out}\n--- body ---\n${body}`);
  return out.slice(3);
}
/** One call as authenticated; returns its jsonb. Extra SQL runs first, in the same rolled-back transaction. */
const call = (expr, { before = '', who = ADMIN } = {}) => JSON.parse(probe(`${before} ${asUser(`r := ${expr};`)} v := r::text;`, who));
/** The call must be refused; returns the message. */
const refused = (expr, { before = '', who = ADMIN } = {}) => {
  const msg = probe(`${before} ${refuse(`r := ${expr};`)} v := t;`, who);
  assert.notEqual(msg, 'NOT REFUSED', `expected a refusal from ${expr}`);
  return msg;
};
const expectCode = (msg, code) => assert.ok(msg.startsWith(code), `expected ${code}, got: ${msg}`);
const rates = (parent) => JSON.parse(scalar(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'source', source, 'basis', basis,
  'unit', unit, 'low', low, 'recommended', recommended, 'high', high, 'is_quoting_default', is_quoting_default,
  'basis_confirmed', basis_confirmed, 'origin', origin, 'source_text', source_text, 'over_label_reason', over_label_reason,
  'row_version', row_version, 'status', status) ORDER BY source, basis), '[]') FROM public.product_rates WHERE parent_id = '${parent}';`));
const pick = (rows, source, basis) => rows.find((x) => x.source === source && x.basis === basis);
const noteCodes = (report) => report.notes.map((n) => n.note_code).sort();

// ---------------------------------------------------------------------------------------------
// R11: two real sessions at once
// ---------------------------------------------------------------------------------------------

function session(app, uid, sql) {
  const child = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.end(`SET application_name = '${app}';\nBEGIN;\n${claims(uid)}\n${sql}\nCOMMIT;\n`);
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, out })));
}
function waitUntil(sql, what) {
  for (let i = 0; i < 100; i += 1) {
    if (scalar(sql) === 't') return;
    wait(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function holdThenWait(name, holder, waiter) {
  const a = session('rt1_hold', ADMIN, `${holder}\nSELECT 'HELD';\nSELECT pg_sleep(3);`);
  waitUntil("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'rt1_hold' AND query LIKE '%pg_sleep%' AND state = 'active');", `${name}: holder`);
  const b = session('rt1_wait', ADMIN, waiter);
  waitUntil("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'rt1_wait' AND wait_event_type = 'Lock');", `${name}: waiter blocked on a lock`);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 0, `${name} holder: ${ra.out}`);
  assert.doesNotMatch(ra.out, /ERROR/, `${name} holder: ${ra.out}`);
  assert.doesNotMatch(ra.out + rb.out, /deadlock/i);
  console.log(`R11 ${name}: the second session waited on a lock; no deadlock`);
  return rb;
}
const asAuth = (stmt) => `SET LOCAL ROLE authenticated;\n${stmt}\nRESET ROLE;`;
const setParentRatesSql = (parent, rate, unit) => `SELECT public.set_parent_rates(jsonb_build_array(jsonb_build_object('parent_id', '${parent}',
  'expected_parent_version', (prev->>'parent_version')::bigint, 'rate_per_acre', '${rate}', 'rate_unit', '${unit}', 'suggested_rate', NULL,
  'sizes', prev->'sizes')), 'rt1-spr-' || gen_random_uuid()) FROM (SELECT public.preview_parent_rates('${parent}', ${rate}, '${unit}', NULL) prev) s;`;

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

try {
  if (reuse) {
    // Reuse drops tables and rewrites rows, so it only runs on a harness-built scratch container: the pinned image,
    // no network and a tmpfs data directory (nothing it holds outlives the container).
    const info = docker(['inspect', '--format', '{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{json .HostConfig.Tmpfs}}', NAME]).stdout.trim();
    assert.match(info, /^public\.ecr\.aws\/supabase\/postgres:17\.6\.1\.143\|none\|.*"\/var\/lib\/postgresql\/data"/,
      `RT1_PROOF_REUSE refuses ${NAME}: not a scratch proof container (${info})`);
  }
  if (!reuse) buildContainer({ stopBefore: PARENT_MIGRATION });
  if (scalar("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '20261217100000_job_access_ends_with_the_job';") === '0') {
    // 20261217100000's preflight needs row security on storage.objects, as live has it (the container's stub has it off).
    psql('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;', { user: 'supabase_admin' });
    const parent = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1'],
      { input: readFileSync(path.join(ROOT, 'supabase', 'migrations', PARENT_MIGRATION), 'utf8').replaceAll('\r\n', '\n'), allowFailure: true });
    assert.equal(parent.status, 0, `${PARENT_MIGRATION} failed:\n${parent.stderr}`);
    assert.match(parent.stderr, /POSTFLIGHT_OK/);
    psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
      VALUES ('20261217100000', '20261217100000_job_access_ends_with_the_job', ARRAY[]::text[]) ON CONFLICT DO NOTHING;`);
  }
  // 20261222100000's preflight needs storage.objects.created_at timestamptz, as live has it (the container's stub lacks it).
  psql('ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();', { user: 'supabase_admin' });
  replay({ stopBefore: CANDIDATE });
  if (reuse) {
    // Reuse only: drop the candidate's objects so it can be applied again (fixtures are kept).
    psql(`DROP TABLE IF EXISTS public.product_rate_draft_events, public.product_rates, public.product_rate_units CASCADE;
      DO $d$ DECLARE f text; BEGIN
        FOREACH f IN ARRAY ${NEW_FUNCTIONS} LOOP EXECUTE 'DROP FUNCTION IF EXISTS ' || f; END LOOP; END $d$;
      DROP FUNCTION IF EXISTS public._epa_registrations_seeded();
      DELETE FROM public.idempotency_keys WHERE idempotency_key LIKE 'rt1-derive-%' OR idempotency_key = 'rt1-replay';
      UPDATE public.epa_registrations SET max_label_rate = 24 WHERE epa_registration IN ('100-1', '100-9');`);
  }
  assert.equal(scalar("SELECT to_regclass('public.product_rates') IS NULL AND to_regprocedure('public._epa_registrations_seeded()') IS NULL;"), 't',
    'the container must not have the candidate (or REG-1 step 2)');
  seedFixtures();
  loadIds();
  seedOnce();

  const before = readers();
  // ---- Apply ----
  const auto = run([]);
  assert.notEqual(auto.status, 0, 'an autocommit run must fail');
  assert.match(auto.stderr, /PREFLIGHT_FAIL: run this file as one transaction/);
  assert.equal(scalar("SELECT to_regclass('public.product_rates') IS NULL;"), 't', 'autocommit changed nothing');
  console.log('AUTOCOMMIT: refused by the preflight, nothing changed');
  const applied = run(['-1']);
  assert.equal(applied.status, 0, `apply failed:\n${applied.stderr}`);
  assert.match(applied.stderr, /POSTFLIGHT_OK/);
  console.log('APPLY: POSTFLIGHT_OK');
  assert.equal(readers(), before, 'R12: no reader changed by the apply');
  assert.equal(scalar(`SELECT string_agg(code || ':' || kind || ':' || factor::text, ',' ORDER BY code) FROM public.product_rate_units;`),
    'dry_oz:weight:28349.523125,each:each:1,fl_oz:volume:1,g:weight:1000,gal:volume:128,lb:weight:453592.37,mg:weight:1,pt:volume:16,qt:volume:32');

  // REG-1 step 2 is missing: every house row reads "registrations_not_seeded" (checked on a rolled-back save).
  let res = call(save(P['Liquid A'], { basis: 'per_acre', source: 'house_standard', rec: 1.6, unit: 'pt' }));
  assert.deepEqual(res.label_check, { status: 'not_checked', why: 'registrations_not_seeded' });
  // A stand-in for REG-1's seed check, switchable by the proof.
  psql(`INSERT INTO rt1_proof.flag SELECT true WHERE NOT EXISTS (SELECT 1 FROM rt1_proof.flag);
    UPDATE rt1_proof.flag SET seeded = true;
    CREATE FUNCTION public._epa_registrations_seeded() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT seeded FROM rt1_proof.flag';`);
  console.log('R9: REG-1 seed check missing reads registrations_not_seeded; a 1.6 pt/acre save needed no reason');

  // ---- Derivation: one batch of every fixture except the R11 and R13 parents ----
  const batch = FIXTURES.map(([n]) => n).filter((n) => !['Lock Case', 'R11'].includes(n));
  const derived = JSON.parse(probe(`${asUser(`r := ${derive(batch.map((n) => P[n]), 'rt1-derive-all')};`)} v := r::text;`, ADMIN, { commit: true }));
  const report = Object.fromEntries(derived.parents.map((p) => [Object.keys(P).find((n) => P[n] === p.parent_id), p]));
  assert.equal(derived.totals.parents, batch.length);
  console.log('DERIVE', JSON.stringify(derived.totals));
  assert.equal(readers(), before, 'R12: no reader changed by derivation');

  // R1: MSO XL holds exactly two drafts.
  let rows = rates(P['MSO XL']);
  assert.equal(rows.length, 2);
  assert.deepEqual(pick(rows, 'label', 'per_100_gal'), { ...pick(rows, 'label', 'per_100_gal'), unit: 'qt', recommended: 2, low: null, high: null,
    is_quoting_default: false, origin: 'derived_text', source_text: '2 qt/100 Gal', basis_confirmed: true, status: 'draft' });
  assert.deepEqual(pick(rows, 'house_standard', 'per_acre'), { ...pick(rows, 'house_standard', 'per_acre'), unit: 'fl_oz', recommended: 9.6,
    is_quoting_default: true, origin: 'derived_house', source_text: '9.6 oz', basis_confirmed: true });
  assert.deepEqual(noteCodes(report['MSO XL']), []);
  console.log('R1: MSO XL -> label per_100_gal 2 qt + house per_acre 9.6 fl_oz (the default)');

  // R14 and section 5 shapes.
  rows = rates(P.Ilevo);
  assert.deepEqual([pick(rows, 'label', 'per_seed_unit')].map((x) => [x.unit, x.recommended, x.is_quoting_default]), [['fl_oz', 1.18, false]]);
  const ilevoHouse = pick(rows, 'house_standard', 'per_acre');
  assert.deepEqual([ilevoHouse.unit, ilevoHouse.recommended, ilevoHouse.is_quoting_default, ilevoHouse.basis_confirmed], ['fl_oz', 1.18, false, false]);
  assert.deepEqual(noteCodes(report.Ilevo), ['basis_from_text', 'basis_suspect']);
  let got = call(get(P.Ilevo));
  assert.deepEqual(got.rates.find((x) => x.source === 'house_standard').label_check, { status: 'not_checked', why: 'basis_unconfirmed' });
  res = call(save(P.Ilevo, { rate: ilevoHouse.id, ver: 1, basis: 'per_acre', source: 'house_standard', rec: 1.18, unit: 'fl_oz' }));
  assert.equal(res.label_check.status, 'within', 'a confirmed 1.18 fl oz/acre is within a 1.18 oz/acre maximum');
  assert.equal(probe(`${asUser(`r := ${save(P.Ilevo, { rate: ilevoHouse.id, ver: 1, basis: 'per_acre', source: 'house_standard', rec: 1.18, unit: 'fl_oz' })};`)}
    v := (SELECT basis_confirmed::text FROM public.product_rates WHERE id = '${ilevoHouse.id}');`), 'true');
  console.log('R14: Ilevo -> per_seed_unit label row + unconfirmed house row (no default, basis_suspect); a save confirms it');

  rows = rates(P['Each ST']);
  assert.deepEqual(rows.map((x) => [x.source, x.basis, x.unit, x.recommended, x.is_quoting_default, x.basis_confirmed]),
    [['house_standard', 'per_acre', 'each', 1.18, false, false]]);
  assert.deepEqual(noteCodes(report['Each ST']), ['basis_suspect', 'unit_not_for_form']);
  assert.deepEqual(rates(P['Dry Oz']), []);
  assert.deepEqual(noteCodes(report['Dry Oz']), ['unit_not_for_form']);
  assert.equal(report['Dry Oz'].outcome, 'nothing_to_derive');
  for (const n of ['Per Ton', 'Free Text']) {
    rows = rates(P[n]);
    assert.deepEqual(rows.map((x) => [x.source, x.basis, x.unit, x.is_quoting_default, x.basis_confirmed]), [['house_standard', 'per_acre', 'qt', false, false]], n);
    assert.deepEqual(noteCodes(report[n]), ['basis_suspect', 'text_unparsed'], n);
  }
  assert.equal(report.Disagree.outcome, 'skipped_sizes_disagree');
  assert.deepEqual(rates(P.Disagree), []);
  assert.deepEqual(noteCodes(report.Disagree), ['sizes_disagree']);
  rows = rates(P['Grouped Each']);
  assert.deepEqual(rows.map((x) => [x.source, x.basis, x.unit, x.recommended, x.is_quoting_default, x.source_text]),
    [['house_standard', 'per_acre', 'each', 2, true, '2 Ea']]);
  assert.equal(report['Grouped Each'].outcome, 'derived');
  rows = rates(P['Mixed Each']);
  assert.deepEqual(rows.map((x) => [x.source, x.basis, x.unit, x.recommended, x.is_quoting_default]), [['label', 'per_acre', 'each', 1, false]]);
  assert.deepEqual(noteCodes(report['Mixed Each']), ['stock_units_differ']);
  assert.deepEqual(report['Mixed Each'].notes[0].detail.map((d) => d.inventory_unit).sort(), ['Ea', 'Unit']);
  console.log('R14: each-form seed treatment, dry oz, per ton, free text, disagreeing sizes, grouped each and mixed stock all as section 5');

  // R6 (derivation half): a seventh decimal writes no text row, notes value_invalid, and the batch carried on.
  rows = rates(P['Bad Decimal']);
  assert.deepEqual(rows.map((x) => [x.source, x.unit, x.recommended, x.is_quoting_default]), [['house_standard', 'qt', 1, true]]);
  assert.deepEqual(noteCodes(report['Bad Decimal']), ['value_invalid']);
  assert.deepEqual(noteCodes(report['No Rate']), ['no_rate']);
  assert.equal(report['No Rate'].outcome, 'nothing_to_derive');

  // R9c: a derived house row above a seeded maximum is written with no reason and noted.
  rows = rates(P.Above);
  assert.deepEqual(rows.map((x) => [x.unit, x.recommended, x.over_label_reason, x.is_quoting_default]), [['pt', 1.6, null, true]]);
  assert.deepEqual(noteCodes(report.Above), ['above_label']);
  got = call(get(P.Above));
  assert.equal(got.rates[0].label_check.status, 'above');
  assert.equal(got.rates[0].label_check.reason_missing, true);
  assert.deepEqual(got.notes.map((n) => n.note_code), ['above_label']);
  console.log('R9c: derived 1.6 pt/acre above a 24 oz/acre maximum: written, noted above_label, reads above + reason_missing');

  // R2 / R3: defaults.
  const msoHouse = pick(rates(P['MSO XL']), 'house_standard', 'per_acre');
  expectCode(refused(save(P['MSO XL'], { basis: 'per_acre', source: 'label', rec: 1, unit: 'qt', def: true })), 'PRODUCT_RATE_DEFAULT_EXISTS');
  assert.equal(pick(rates(P['MSO XL']), 'house_standard', 'per_acre').is_quoting_default, true);
  expectCode(refused(save(P['No Rate'], { basis: 'per_100_gal', source: 'label', rec: 2, unit: 'qt', def: true })), 'PRODUCT_RATE_DEFAULT_NOT_PER_ACRE');
  expectCode(refused(save(P['No Rate'], { basis: 'per_acre', source: 'label', low: 1, unit: 'qt', def: true })), 'PRODUCT_RATE_DEFAULT_NEEDS_RECOMMENDED');
  // A label row is never label-checked, so it can never be the quoting default (table CHECK too).
  expectCode(refused(save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 10, unit: 'qt', def: true })), 'PRODUCT_RATE_DEFAULT_NOT_HOUSE');
  const directLabelDefault = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c',
    `INSERT INTO public.product_rates (parent_id, basis, source, recommended, unit, is_quoting_default, origin, created_by, updated_by)
     VALUES ('${P['No Rate']}', 'per_acre', 'label', 1, 'qt', true, 'manual', '${ADMIN}', '${ADMIN}');`], { allowFailure: true });
  assert.notEqual(directLabelDefault.status, 0);
  assert.match(directLabelDefault.stderr, /product_rates_default_house/);
  console.log('R2/R3: a second default, a non-acre default and a default without a recommended rate are refused');

  // R4: units.
  for (const u of ['', '  ', 'quartz', 'Qt', 'oz', null]) {
    expectCode(refused(save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 1, unit: u })), 'PRODUCT_RATE_UNIT_UNKNOWN');
  }
  assert.equal(probe(`${asUser(`r := ${save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 1, unit: ' qt ' })};`)}
    v := (SELECT unit FROM public.product_rates WHERE id = (r->>'rate_id')::uuid);`), 'qt');
  assert.match(probe(`BEGIN INSERT INTO public.product_rates (parent_id, basis, source, recommended, unit, origin, created_by, updated_by)
      VALUES ('${P['No Rate']}', 'per_acre', 'label', 1, 'quartz', 'manual', '${ADMIN}', '${ADMIN}'); v := 'NOT REFUSED';
    EXCEPTION WHEN foreign_key_violation THEN v := 'FK'; END;`), /^FK$/);
  console.log('R4: blank, spaces, unknown, legacy spellings and NULL refused PRODUCT_RATE_UNIT_UNKNOWN; " qt " trimmed and saved; a direct bad unit fails the FK');

  // R5: units outside sheet 3.3.
  for (const [parent, basis, unit] of [['Liquid A', 'per_acre', 'lb'], ['Dry A', 'per_acre', 'fl_oz'], ['Each A', 'per_100_gal', 'each'],
    ['Each A', 'per_seed_unit', 'fl_oz'], ['Seed A', 'per_100_gal', 'each'], ['Seed A', 'per_seed_unit', 'each'], ['Seed A', 'per_acre', 'fl_oz']]) {
    expectCode(refused(save(P[parent], { basis, source: 'label', rec: 1, unit })), 'PRODUCT_RATE_UNIT_NOT_FOR_BASIS');
  }
  for (const [parent, basis, unit] of [['Seed A', 'per_acre', 'each'], ['Seed A', 'per_acre', 'lb'], ['Each A', 'per_seed_unit', 'each'],
    ['Dry A', 'per_cwt_seed', 'g'], ['Liquid A', 'per_unit', 'fl_oz']]) {
    assert.ok(call(save(P[parent], { basis, source: 'label', rec: 1, unit })).rate_id, `${parent} ${basis} ${unit} must save`);
  }
  console.log('R5: lb on liquid, fl_oz on dry, each per 100 gal, fl_oz per seed unit on each (and seed-form refusals) refused; allowed cells save');

  // R6: ranges and values.
  for (const [low, rec, high] of [[2, 1, 3], [3, null, 2], [null, null, null], [-1, null, null], [null, -1, null]]) {
    expectCode(refused(save(P['No Rate'], { basis: 'per_acre', source: 'label', low, rec, high, unit: 'qt' })), 'PRODUCT_RATE_RANGE_INVALID');
  }
  for (const v of ['1.1234567', '1000000000', '-1.1234567']) {
    expectCode(refused(save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: v, unit: 'qt' })), 'PRODUCT_RATE_INVALID');
  }
  res = call(save(P['No Rate'], { basis: 'per_acre', source: 'label', low: 1, rec: 1, high: 1, unit: 'qt' }));
  assert.ok(res.rate_id);
  assert.ok(call(save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: '999999999.999999', unit: 'qt' })).rate_id);
  console.log('R6: inverted, empty and negative ranges refused RANGE_INVALID; 7 decimals and 1e9 refused INVALID; 1/1/1 saved');

  // R7: the sheet 3.3 hand-worked examples.
  const check = (parent, o) => call(save(P[parent], { source: 'house_standard', ...o })).label_check;
  assert.deepEqual(check('Liquid A', { rate: pick(rates(P['Liquid A']), 'house_standard', 'per_acre').id, ver: 1, basis: 'per_acre', rec: 1.5, unit: 'pt', def: true }),
    { status: 'within' });
  assert.equal(check('Liquid A', { rate: pick(rates(P['Liquid A']), 'house_standard', 'per_acre').id, ver: 1, basis: 'per_acre', rec: 1.6, unit: 'pt', reason: 'r7' }).status, 'above');
  assert.equal(check('Dry A', { basis: 'per_acre', rec: 1, unit: 'g', reason: 'r7' }).status, 'above', '1 g is above 0.035273961 dry oz');
  assert.equal(check('Dry A', { basis: 'per_acre', rec: 0.999999, unit: 'g' }).status, 'within');
  // A maximum written "Dry oz" compares (1 lb = 16 dry oz > 1); "fl oz" never compares with a weight.
  const dryOzMax = "UPDATE public.epa_registrations SET max_label_rate = 1, max_label_rate_unit = 'Dry oz/acre' WHERE epa_registration = '100-7';";
  expectCode(refused(save(P['Dry A'], { basis: 'per_acre', source: 'house_standard', rec: 1, unit: 'lb' }), { before: dryOzMax }),
    'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED');
  assert.equal(call(save(P['Dry A'], { basis: 'per_acre', source: 'house_standard', rec: 1, unit: 'dry_oz' }), { before: dryOzMax }).label_check.status, 'within');
  assert.equal(scalar(`SELECT concat_ws(',', public._product_rate_max_unit('Dry oz/acre', 'weight')->>'unit', public._product_rate_max_unit('fl oz/acre', 'volume')->>'unit',
    COALESCE(public._product_rate_max_unit('fl oz/acre', 'weight')->>'unit', '-'), COALESCE(public._product_rate_max_unit('Dry oz', 'volume')->>'unit', '-'));`),
  'dry_oz,fl_oz,-,-');
  // Every fluid-ounce spelling normalize_rate_unit folds into 'oz' keeps its volume kind; only a bare ounce takes the row's kind.
  for (const [spelling, kind, want] of [['fluid ounce/acre', 'weight', '-'], ['Fluid Ounces/acre', 'weight', '-'], ['floz/acre', 'weight', '-'],
    ['fluid ounce/acre', 'volume', 'fl_oz'], ['floz', 'volume', 'fl_oz'], ['ounce/acre', 'weight', 'dry_oz'], ['ounces', 'volume', 'fl_oz'],
    ['dry ounces/acre', 'weight', 'dry_oz'], ['oz', 'weight', 'dry_oz'],
    ['each/acre', 'each', 'each'], ['Ea', 'each', 'each'], ['unit/acre', 'each', 'each'], ['each/acre', 'weight', '-']]) {
    assert.equal(scalar(`SELECT COALESCE(public._product_rate_max_unit(${sq(spelling)}, ${sq(kind)})->>'unit', '-');`), want, `${spelling} on ${kind}`);
  }
  // A count maximum compares with a count rate (Sol round 5): 2 each/acre over 1 each/acre needs a reason.
  const eachMax = `UPDATE public.epa_registrations SET max_label_rate = 1, max_label_rate_unit = 'each/acre' WHERE epa_registration = '100-7';
    UPDATE public.product_parents SET generic_epa_registration = '100-7' WHERE id = '${P['Each A']}';`;
  const eaHouse = pick(rates(P['Each A']), 'house_standard', 'per_acre');
  const eaSave = (rec) => save(P['Each A'], { rate: eaHouse.id, ver: eaHouse.row_version, basis: 'per_acre', source: 'house_standard', rec, unit: 'each', def: eaHouse.is_quoting_default });
  expectCode(refused(eaSave(2), { before: eachMax }), 'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED');
  assert.equal(call(eaSave(1), { before: eachMax }).label_check.status, 'within');
  for (const [text, want] of [['2 each/acre', 'each|2'], ['1-2 ea/acre', 'each|'], ['3 Unit per acre', 'each|3']]) {
    assert.equal(scalar(`SELECT (r->>'unit') || '|' || COALESCE(r->>'recommended', '') FROM (SELECT public._product_rate_parse_text(${sq(text)}, 'each') AS r) s;`), want, text);
  }
  assert.equal(scalar(`SELECT (0.25 * 128 = 32 AND 18 * 1000 = 18000 AND 6 * 1 = 6 AND 2 * 32 = 64
    AND 17 * 453592.37 = 7711070.29 AND 17 * 453592.37 / 28349.523125 = 272
    AND 0.035273961 * 28349.523125 = 999.999973079848125)::text;`), 'true');
  for (const [parent, basis, unit, value] of [['No Rate', 'per_acre', 'gal', 0.25], ['Dry A', 'per_acre', 'mg', 6], ['Each A', 'per_unit', 'each', 1],
    ['MSO XL', 'per_100_gal', 'qt', 2], ['Dry A', 'per_100_gal', 'lb', 17], ['Liquid A', 'per_cwt_seed', 'fl_oz', 1.5], ['Ilevo', 'per_seed_unit', 'fl_oz', 1.18]]) {
    const saved = probe(`${asUser(`r := ${save(P[parent], { basis, source: 'house_standard', rec: value, unit })};`)}
      v := (SELECT recommended::text || ' ' || unit FROM public.product_rates WHERE id = (r->>'rate_id')::uuid);`);
    assert.equal(saved, `${value} ${unit}`, `${parent} ${basis}`);
  }
  console.log('R7: 24 is not above 24; 25.6 > 24; 1 g > 0.035273961 dry oz; every example stores its own number and unit');

  // R8: over label.
  const laHouse = pick(rates(P['Liquid A']), 'house_standard', 'per_acre');
  assert.deepEqual([laHouse.unit, laHouse.recommended, laHouse.is_quoting_default], ['pt', 1.5, true]);
  expectCode(refused(save(P['Liquid A'], { rate: laHouse.id, ver: 1, basis: 'per_acre', source: 'house_standard', rec: 1.6, unit: 'pt', def: true })),
    'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED: 1.6 pt is above the label maximum 24 oz/acre on EPA 100-1');
  expectCode(refused(save(P['Liquid A'], { rate: laHouse.id, ver: 1, basis: 'per_acre', source: 'house_standard', rec: 1.6, unit: 'pt', def: true, reason: '\t\n' })),
    'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED');
  assert.equal(probe(`${asUser(`r := ${save(P['Liquid A'], { rate: laHouse.id, ver: 1, basis: 'per_acre', source: 'house_standard', rec: 1.6, unit: 'pt', def: true, reason: '  Grower trial  ' })};`)}
    v := (r->'label_check'->>'status') || '|' || (SELECT over_label_reason || '|' || row_version FROM public.product_rates WHERE id = '${laHouse.id}');`),
  'above|Grower trial|2');
  console.log('R8: 1.6 pt/acre over a 24 oz/acre maximum refused without a reason; with one it saves, warns above, keeps the trimmed reason');

  // R9: not checked, each saved without a reason.
  const why = (parent, o) => call(save(P[parent], { source: 'house_standard', basis: 'per_acre', ...o })).label_check;
  const nm = (o) => o.not_checked.map((x) => x.why);
  assert.deepEqual(nm(why('No Max', { rate: pick(rates(P['No Max']), 'house_standard', 'per_acre').id, ver: 1, rec: 100, unit: 'qt', def: true })), ['no_label_max']);
  assert.deepEqual(nm(why('Spray Max', { rate: pick(rates(P['Spray Max']), 'house_standard', 'per_acre').id, ver: 1, rec: 100, unit: 'qt', def: true })), ['max_basis_differs']);
  assert.deepEqual(nm(why('Dry Kg', { rate: pick(rates(P['Dry Kg']), 'house_standard', 'per_acre').id, ver: 1, rec: 100, unit: 'lb', def: true })), ['max_unit_not_comparable']);
  assert.deepEqual(why('No Reg', { rate: pick(rates(P['No Reg']), 'house_standard', 'per_acre').id, ver: 1, rec: 100, unit: 'qt', def: true }),
    { status: 'not_checked', why: 'no_registration' });
  assert.deepEqual(call(save(P['Liquid A'], { source: 'house_standard', basis: 'per_acre', rate: laHouse.id, ver: 1, rec: 100, unit: 'pt', def: true }),
    { before: 'UPDATE rt1_proof.flag SET seeded = false;' }).label_check, { status: 'not_checked', why: 'registrations_not_seeded' });
  assert.deepEqual(call(save(P['Liquid A'], { source: 'house_standard', basis: 'per_acre', rate: laHouse.id, ver: 1, rec: 100, unit: 'pt', def: true }),
    { before: 'DROP FUNCTION public._epa_registrations_seeded();' }).label_check, { status: 'not_checked', why: 'registrations_not_seeded' });
  // A seed-check function not owned by postgres is never run by the definer label check.
  assert.deepEqual(call(save(P['Liquid A'], { source: 'house_standard', basis: 'per_acre', rate: laHouse.id, ver: 1, rec: 100, unit: 'pt', def: true }),
    { before: 'GRANT CREATE ON SCHEMA public TO authenticated; ALTER FUNCTION public._epa_registrations_seeded() OWNER TO authenticated;' }).label_check, { status: 'not_checked', why: 'registrations_not_seeded' });
  assert.deepEqual(why('Liquid A', { basis: 'per_unit', rec: 100, unit: 'fl_oz' }), { status: 'not_checked', why: 'basis_has_no_label_max' });
  console.log('R9: no maximum, a per-100-gal maximum, a kg maximum, no registration, REG-1 unseeded or missing, per_unit: all save, not_checked with why');

  // R9b: same-basis maximums and the scale CHECK.
  expectCode(refused(save(P['Spray Max'], { basis: 'per_100_gal', source: 'house_standard', rec: 3, unit: 'qt' })), 'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED');
  assert.deepEqual(why('Spray Max', { basis: 'per_100_gal', rec: 2, unit: 'qt' }), { status: 'within' });
  for (const n of ['Max Ac', 'Max A']) {
    expectCode(refused(save(P[n], { basis: 'per_acre', source: 'house_standard', rec: 1.6, unit: 'pt' })), 'PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED');
    assert.deepEqual(why(n, { rec: 1.5, unit: 'pt' }), { status: 'within' });
  }
  assert.equal(probe(`BEGIN INSERT INTO public.product_rates (parent_id, basis, source, recommended, unit, origin, created_by, updated_by)
      VALUES ('${P['No Rate']}', 'per_acre', 'label', 1.1234567, 'qt', 'manual', '${ADMIN}', '${ADMIN}'); v := 'NOT REFUSED';
    EXCEPTION WHEN check_violation THEN v := 'CHECK'; END;`), 'CHECK');
  console.log('R9b: 3 qt/100 gal over 2 qt/100 gal and 1.6 pt over 24 oz/ac and oz/a need a reason; a direct 7-decimal insert fails the CHECK');

  // R10: a maximum lowered after a within save.
  got = call(get(P['Liquid A']), { before: "UPDATE public.epa_registrations SET max_label_rate = 20 WHERE epa_registration = '100-1';" });
  const lowered = got.rates.find((x) => x.source === 'house_standard' && x.basis === 'per_acre').label_check;
  assert.equal(lowered.status, 'above');
  assert.equal(lowered.reason_missing, true);
  console.log('R10: lowering the maximum after a save reads above + reason_missing');

  // R13: rate lock on.
  const lockProbe = probe(`${asUser(`PERFORM public.set_product_rate_lock(true, 'RT-1 proof', '${ADMIN}', 'rt1-lock-' || gen_random_uuid());`)}
    ${asUser(`r := ${derive([P['Lock Case']])};`)}
    t := (SELECT id::text FROM public.product_rates WHERE parent_id = '${P['Lock Case']}' AND source = 'house_standard');
    ${asUser(`r2 := ${save(P['Lock Case'], { rate: '(t)', ver: 1, basis: 'per_acre', source: 'house_standard', rec: 2, unit: 'qt', def: true })};`)}
    ${asUser(`r3 := ${save(P['Lock Case'], { basis: 'per_100_gal', source: 'label', rec: 2, unit: 'qt' })};`)}
    ${asUser(`r3 := ${del("(r3->>'rate_id')", 1, 'wrong basis')};`)}
    BEGIN ${asUser(`PERFORM public.set_parent_rates(jsonb_build_array(jsonb_build_object('parent_id', '${P['Lock Case']}',
      'expected_parent_version', (SELECT parent_version FROM public.product_parents WHERE id = '${P['Lock Case']}'), 'rate_per_acre', '3',
      'rate_unit', 'qt', 'suggested_rate', NULL, 'sizes', public.preview_parent_rates('${P['Lock Case']}', 3, 'qt', NULL)->'sizes')), 'rt1-spr-' || gen_random_uuid());`)}
      t2 := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN t2 := SQLERRM; END;
    v := (r->'totals'->>'derived') || '|' || (r2->>'row_version') || '|' || (r3->>'deleted') || '|' || t2;`);
  assert.match(lockProbe, /^1\|2\|true\|PRODUCT_RATES_LOCKED/);
  console.log('R13: with the rate lock on, drafts derive, save, edit and delete; a live-rate write is still PRODUCT_RATES_LOCKED');

  // R15: re-derive.
  const versions = scalar(`SELECT string_agg(id::text || row_version, ',' ORDER BY id) FROM public.product_rates;`);
  const again = call(derive([P['MSO XL'], P['No Rate']]));
  assert.deepEqual(again.parents.map((p) => p.outcome).sort(), ['nothing_to_derive', 'skipped_has_rows']);
  assert.equal(scalar(`SELECT string_agg(id::text || row_version, ',' ORDER BY id) FROM public.product_rates;`), versions);
  expectCode(refused(derive([])), 'PRODUCT_RATE_DERIVE_BATCH');
  expectCode(refused(derive([P['MSO XL'], P['MSO XL']])), 'PRODUCT_RATE_DERIVE_BATCH');
  console.log('R15: a re-run skips a derived parent (skipped_has_rows) and changes nothing');

  // R16: grants, reads and replay.
  for (const expr of [save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 1, unit: 'qt' }), del(msoHouse.id, 1, 'x'), derive([P['No Rate']]), get(P['MSO XL'])]) {
    expectCode(refused(expr, { who: REP }), 'ADMIN_REQUIRED');
  }
  assert.equal(scalar(`SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))::text
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE '\\_product\\_rate%' OR p.proname LIKE '%draft_product_rate%'
      OR p.proname = 'get_parent_draft_rates') AND p.proname NOT IN ('_product_rate_unit_ok', '_product_rate_value_ok');`), 'false');
  assert.equal(probe(`${asUser(`v := (SELECT count(*) FROM public.product_rates)::text || '|' || (SELECT count(*) FROM public.product_rate_draft_events)::text
    || '|' || (SELECT count(*) FROM public.product_rate_units)::text;`)}`, REP), '0|0|9');
  assert.match(probe(`${asUser(`v := (SELECT count(*) FROM public.product_rates)::text;`)}`, ADMIN), /^[1-9][0-9]*$/);
  const replayKey = probe(`${asUser(`r := ${save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 1, unit: 'qt', key: 'rt1-replay' })};
    r2 := ${save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 1, unit: 'qt', key: 'rt1-replay' })};`)}
    BEGIN ${asUser(`r3 := ${save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 2, unit: 'qt', key: 'rt1-replay' })};`)} t := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t := SQLERRM; END;
    BEGIN ${asUser(`r3 := ${save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 1, unit: 'qt', key: '  ' })};`)} t2 := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t2 := SQLERRM; END;
    v := (r = r2)::text || '|' || (SELECT count(*) FROM public.product_rates WHERE parent_id = '${P['No Rate']}')::text || '|' || t || '|' || t2;`);
  assert.match(replayKey, /^true\|1\|IDEMPOTENCY_PAYLOAD_MISMATCH.*\|IDEMPOTENCY_KEY_REQUIRED/);
  const deriveReplay = probe(`${asUser(`r := ${derive([P['No Rate']], 'rt1-derive-replay')}; r2 := ${derive([P['No Rate']], 'rt1-derive-replay')};`)}
    v := (r = r2)::text;`);
  assert.equal(deriveReplay, 'true');
  assert.equal(JSON.stringify(call(derive(batch.map((n) => P[n]), 'rt1-derive-all'))), JSON.stringify(derived), 'the batch key replays the committed report');
  console.log('R16: non-admins refused on all four RPCs and read no drafts; anon has no execute; a key replays; a reused key with other values or a blank key is refused');

  // R17: stale and approved.
  expectCode(refused(save(P['MSO XL'], { rate: msoHouse.id, ver: 7, basis: 'per_acre', source: 'house_standard', rec: 9.6, unit: 'fl_oz', def: true })), 'PRODUCT_RATE_STALE');
  expectCode(refused(del(msoHouse.id, 7, 'x')), 'PRODUCT_RATE_STALE');
  const approve = `UPDATE public.product_rates SET status = 'approved', approved_by = '${ADMIN}', approved_at = now() WHERE id = '${msoHouse.id}';`;
  expectCode(refused(save(P['MSO XL'], { rate: msoHouse.id, ver: 1, basis: 'per_acre', source: 'house_standard', rec: 9.6, unit: 'fl_oz', def: true }), { before: approve }), 'PRODUCT_RATE_APPROVED');
  expectCode(refused(del(msoHouse.id, 1, 'x'), { before: approve }), 'PRODUCT_RATE_APPROVED');
  assert.match(probe(`${approve} BEGIN UPDATE public.product_rates SET recommended = 1 WHERE id = '${msoHouse.id}'; v := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN v := SQLERRM; END;`), /^PRODUCT_RATE_APPROVED/);
  expectCode(refused(del(msoHouse.id, 1, '   ')), 'PRODUCT_RATE_REASON_REQUIRED');
  expectCode(refused(del(msoHouse.id, 1, ' \t\r\n  ')), 'PRODUCT_RATE_REASON_REQUIRED');
  console.log('R17: a stale version and an approved row are refused for edit and delete');

  // R18: events.
  assert.equal(scalar(`SELECT count(*) FILTER (WHERE event_type = 'derive_note') || '|' || count(*) FILTER (WHERE event_type = 'derived')
    || '|' || count(*) FROM public.product_rate_draft_events;`), `${derived.totals.notes}|${derived.totals.rows}|${derived.totals.notes + derived.totals.rows}`);
  assert.equal(scalar(`SELECT count(*) FROM public.product_rate_draft_events e JOIN public.product_rates r ON r.id = e.rate_id WHERE e.event_type = 'derived';`),
    String(derived.totals.rows));
  const events = probe(`n := (SELECT max(id) FROM public.product_rate_draft_events);
    ${asUser(`r := ${save(P['No Rate'], { basis: 'per_acre', source: 'label', rec: 1, unit: 'qt' })};`)}
    ${asUser(`r2 := ${save(P['No Rate'], { rate: "(r->>'rate_id')", ver: 1, basis: 'per_acre', source: 'label', rec: 2, unit: 'qt' })};`)}
    ${asUser(`r3 := ${del("(r->>'rate_id')", 2, '  derived wrong  ')};`)}
    v := (SELECT string_agg(event_type || ':' || COALESCE(before_values->>'recommended', '-') || ':' || COALESCE(after_values->>'recommended', '-')
           || ':' || COALESCE(reason, '-') || ':' || (changed_by = '${ADMIN}')::text, ',' ORDER BY id)
          FROM public.product_rate_draft_events WHERE id > n);
    BEGIN UPDATE public.product_rate_draft_events SET reason = 'x' WHERE id = (SELECT max(id) FROM public.product_rate_draft_events); t := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t := SQLERRM; END;
    BEGIN DELETE FROM public.product_rate_draft_events; t2 := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN t2 := SQLERRM; END;
    v := v || '|' || t || '|' || t2;
    BEGIN TRUNCATE public.product_rate_draft_events; t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN t := SQLERRM; END;
    v := v || '|' || t;`);
  assert.match(events, /^saved:-:1:-:true,saved:1:2:-:true,deleted:2:-:derived wrong:true\|PRODUCT_RATE_EVENTS_APPEND_ONLY.*\|PRODUCT_RATE_EVENTS_APPEND_ONLY.*\|PRODUCT_RATE_EVENTS_APPEND_ONLY/);
  console.log('R18: every derived row, note, save, edit and delete has one event; history cannot be changed, deleted or truncated');

  // R11: two sessions at once on one parent, three orders. Each commits.
  const r11 = P.R11;
  // (a) a draft save holds the parent; set_parent_rates (same values) waits, then finishes.
  let waiter = await holdThenWait('save holds, set_parent_rates waits',
    asAuth(`SELECT ${save(r11, { basis: 'per_acre', source: 'label', rec: 1, unit: 'qt' })};`),
    asAuth(setParentRatesSql(r11, 1, 'qt')));
  assert.equal(waiter.status, 0, waiter.out);
  assert.doesNotMatch(waiter.out, /ERROR/, waiter.out);
  // (b) a REG-1 writer (exclusive advisory pair) lowers the maximum; a save waits, then sees the new maximum.
  waiter = await holdThenWait('REG-1 writer holds, save waits',
    `SELECT pg_advisory_xact_lock(20261210, hashtext('crx_epa_registration'));
     UPDATE public.epa_registrations SET max_label_rate = 20, registration_version = registration_version + 1 WHERE epa_registration = '100-9';`,
    asAuth(`SELECT ${save(r11, { basis: 'per_acre', source: 'house_standard', rec: 1.5, unit: 'pt' })};`));
  assert.notEqual(waiter.status, 0, 'the save must be refused');
  assert.match(waiter.out, /PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED: 1\.5 pt is above the label maximum 20 oz\/acre on EPA 100-9/);
  // (c) set_parent_rates holds the parent; a draft save waits, then finishes.
  waiter = await holdThenWait('set_parent_rates holds, save waits',
    asAuth(setParentRatesSql(r11, 1, 'qt')),
    asAuth(`SELECT ${save(r11, { basis: 'per_100_gal', source: 'label', rec: 2, unit: 'qt' })};`));
  assert.equal(waiter.status, 0, waiter.out);
  assert.doesNotMatch(waiter.out, /ERROR/, waiter.out);
  assert.deepEqual(rates(r11).map((x) => `${x.source}/${x.basis}`), ['label/per_100_gal', 'label/per_acre']);

  // R12 at the end: R11's set_parent_rates rewrote the same values, so nothing a reader shows changed.
  assert.equal(readers(), before, 'R12: no reader changed by any R-case');
  console.log('R12: every fixture product, parent, price per acre, the quote and the five functions are unchanged after apply, derive and every case');

  const reapply = run(['-1']);
  assert.notEqual(reapply.status, 0);
  assert.match(reapply.stderr, /already exist \(already applied\?\)/);
  console.log('RE-APPLY: refused by the preflight');
  console.log('\nPRODUCT_RATES_DRAFT_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
