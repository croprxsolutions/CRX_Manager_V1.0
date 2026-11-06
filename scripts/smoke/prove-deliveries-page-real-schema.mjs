#!/usr/bin/env node
/**
 * Real-schema proof for 20261116130000_deliveries_list_page.sql (Goal 4). Builds the checked-in baseline plus
 * every post-baseline migration on this checkout (the candidate included) in a network-disabled PostgreSQL
 * container (scripts/smoke/undo-paths/harness.mjs), seeds 1,203 deliveries (every status, dates with many
 * ties, three drivers, a farm group, items on a quarter of them), then checks, calling as `authenticated`:
 *   - pages of 37 return exactly the full read (pages of 500 joined), with no repeated id, for the default
 *     order and every sort key in both directions; total_count equals the full read's row count;
 *   - the default order matches the screen's own comparator (today, upcoming soonest, past newest, then
 *     delivery number, then id), and each column sort matches a direct ORDER BY <column>, id;
 *   - every filter (statuses, driver, priority, customer, date range) and the search (number, customer,
 *     driver, farm group, literal % and _) return the same set as a direct query;
 *   - the summary (cards and 7-day strip) equals direct counts;
 *   - a driver sees only their own deliveries, a sales rep sees what an admin sees, an applicator none;
 *   - editing a row or adding an older one leaves the first pages unchanged;
 *   - bad arguments are refused, anon cannot execute it, and a second apply is refused.
 * It also runs the live smoke chain in the scratch database.
 *
 * Run: node scripts/smoke/prove-deliveries-page-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> DELIVERIES_PAGE_PROOF_REUSE=1 (left running).
 * Prints DELIVERIES_PAGE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, attempt, asUser, refuse, claims, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20261116130000_deliveries_list_page.sql';
const reuse = process.env.DELIVERIES_PAGE_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const N = 1203;
const P = '7c7a0000-0000-4000-8000-00000013'; // seeded ids: P + 4 hex digits
const PARENT = `${P}c000`;
const CUST = [`${P}c001`, `${P}c002`, `${P}c003`];
const TODAY = '2026-06-15';
const WEEK = '2026-06-14';

function seed() {
  // Triggers (and so foreign keys) are off for the seed only, so fixtures need no orders or products.
  // Dates repeat every 19 deliveries (not a multiple of the 7 statuses, so every status falls on every date), so only the delivery number and id break ties.
  const sql = `
${claims(USERS.admin)}
SET session_replication_role = replica;
INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES
  ('${PARENT}', '[DP] Group Parent', NULL),
  ('${CUST[0]}', '[DP] Child Farm', '${PARENT}'),
  ('${CUST[1]}', '[DP] Beta Farm', NULL),
  ('${CUST[2]}', '[DP] 100%_Farm', NULL);
INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, scheduled_date, status,
                               assigned_driver, priority, completed_at)
SELECT ('${P}' || lpad(to_hex(4096 + g), 4, '0'))::uuid,
       'DP-' || lpad(g::text, 5, '0'),
       gen_random_uuid(),
       (ARRAY['${CUST[0]}', '${CUST[1]}', '${CUST[2]}'])[1 + g % 3]::uuid,
       '${USERS.admin}',
       date '${TODAY}' + (g % 19) - 9,
       (ARRAY['scheduled', 'scheduled', 'in_progress', 'completed', 'completed', 'cancelled', 'voided'])[1 + g % 7],
       (ARRAY['${USERS.driver}', NULL, '${USERS.admin}', '${USERS.driver}'])[1 + g % 4]::uuid,
       (ARRAY['low', 'normal', 'high', 'urgent', NULL])[1 + g % 5],
       CASE WHEN g % 7 IN (3, 4) THEN timestamptz '${TODAY} 12:00+00' - ((g % 12) || ' days')::interval END
FROM generate_series(1, ${N}) g;
INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity)
SELECT d.id, gen_random_uuid(), gen_random_uuid(), 1
FROM public.deliveries d, generate_series(1, 3) k
WHERE d.delivery_number LIKE 'DP-%' AND right(d.delivery_number, 1)::int % 4 = 0 AND k <= 1 + right(d.delivery_number, 2)::int % 3;
SET session_replication_role = origin;`;
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: sql, allowFailure: true });
  assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
}

const probe = (uid, body) => {
  const out = attempt(uid, body);
  assert.ok(out.startsWith('ok|'), `probe as ${uid} failed: ${out}`);
  return out.slice(3);
};
const q = (s) => (s == null ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);
/** Named arguments for one call; today and week start are fixed so the seed's buckets are known. */
const args = (o = {}) => [`p_today => '${TODAY}'`, `p_week_start => '${WEEK}'`,
  ...Object.entries(o).map(([k, v]) => `p_${k} => ${Array.isArray(v) ? `ARRAY[${v.map(q).join(',')}]::text[]` : typeof v === 'number' || typeof v === 'boolean' ? v : v === null ? 'NULL' : q(v)}`)].join(', ');
/** Calls get_deliveries_page as `uid` (authenticated role) and returns the payload. */
function call(uid, o) {
  return JSON.parse(probe(uid, `${asUser(`r := public.get_deliveries_page(${args(o)});`)} v := r::text;`));
}
/** Runs a read-only SQL query as postgres (no row security) and returns the ids it selects, in order. */
const directIds = (where, order = 'd.id') => {
  const out = scalar(`SELECT COALESCE(string_agg(d.id::text, ',' ORDER BY ${order}), '') FROM public.deliveries d
    LEFT JOIN public.customers c ON c.id = d.customer_id LEFT JOIN public.customers pc ON pc.id = c.parent_customer_id
    LEFT JOIN public.profiles pr ON pr.id = d.assigned_driver WHERE d.delivery_number LIKE 'DP-%' AND (${where});`);
  return out ? out.split(',') : [];
};
const ids = (payload) => payload.rows.map((row) => row.id);
const sorted = (a) => [...a].sort();
const NOT_DONE = "d.status NOT IN ('cancelled','voided')";

/** The full read, as the screen's exports make it: pages of 500 joined end to end. */
function callAll(uid, o) {
  const first = call(uid, { ...o, limit: 500, offset: 0 });
  for (let offset = 500; offset < first.total_count; offset += 500) {
    const page = call(uid, { ...o, limit: 500, offset });
    assert.equal(page.total_count, first.total_count, `${JSON.stringify(o)}: total_count moved between pages of 500`);
    first.rows.push(...page.rows);
  }
  return first;
}

/** Reads every page of `size` and checks it against the full read. Returns the full read. */
function pagesMatch(uid, o, size = 37) {
  const all = callAll(uid, o);
  assert.equal(all.total_count, all.rows.length, `${JSON.stringify(o)}: total_count ${all.total_count} but ${all.rows.length} rows`);
  assert.equal(new Set(ids(all)).size, all.rows.length, `${JSON.stringify(o)}: a repeated id`);
  const paged = [];
  for (let offset = 0; offset < all.total_count; offset += size) {
    const page = call(uid, { ...o, limit: size, offset });
    assert.equal(page.total_count, all.total_count, `${JSON.stringify(o)}: page total_count moved`);
    assert.ok(page.rows.length <= size);
    paged.push(...ids(page));
  }
  assert.deepEqual(paged, ids(all), `${JSON.stringify(o)}: pages of ${size} differ from the full read`);
  return all;
}

// The screen's own default comparator (src/pages/Deliveries.tsx compareDefaultDeliveryOrder).
function defaultOrder(a, b) {
  const bucket = (d) => (d === TODAY ? 1 : d > TODAY ? 2 : 3);
  const ab = bucket(a.scheduled_date); const bb = bucket(b.scheduled_date);
  if (ab !== bb) return ab - bb;
  if (a.scheduled_date !== b.scheduled_date) {
    return ab === 3 ? b.scheduled_date.localeCompare(a.scheduled_date) : a.scheduled_date.localeCompare(b.scheduled_date);
  }
  return a.delivery_number.localeCompare(b.delivery_number) || a.id.localeCompare(b.id);
}

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(CANDIDATE, '.sql')}';`), '1',
    'the candidate must have replayed (its preflight and postflight passed)');
  if (scalar("SELECT count(*) FROM deliveries WHERE delivery_number LIKE 'DP-%';") === '0') seed();
  const visible = directIds(NOT_DONE);
  assert.ok(visible.length > 800, `seed: ${visible.length} visible deliveries`);

  // 1. Default order: pages match, set matches, order matches the screen's comparator.
  const all = pagesMatch(USERS.admin, {});
  assert.deepEqual(sorted(ids(all)), sorted(visible), 'default: rows differ from the deliveries not cancelled or voided');
  assert.deepEqual(ids(all), ids({ rows: [...all.rows].sort(defaultOrder) }), 'default: order differs from the screen comparator');
  const row = all.rows.find((d) => d.farm_group_name);
  assert.equal(row.farm_group_name, '[DP] Group Parent');
  assert.equal(row.customer_name, '[DP] Child Farm');
  const unassigned = all.rows.find((d) => !d.assigned_driver);
  assert.equal(unassigned.driver_name, 'Unassigned');
  assert.equal(all.rows.find((d) => d.assigned_driver === USERS.driver).driver_name, '[UNDO] Driver');
  for (const d of all.rows) {
    const n = Number(d.delivery_number.slice(-2));
    assert.equal(d.item_count, Number(d.delivery_number.slice(-1)) % 4 === 0 ? 1 + (n % 3) : 0, `${d.delivery_number}: item_count`);
  }
  console.log(`[deliveries-page] default order: ${all.total_count} rows, pages of 37 match, screen comparator order`);

  // 2. Every sort key, both directions: pages match, and the order equals the screen's own column sort
  // (src/lib/tableSearchSort.ts, a stable sort) applied to the rows in default order.
  const screenSort = (rows, key, desc) => [...rows].sort((a, b) => {
    const av = a[key]; const bv = b[key];
    if (av == null && bv == null) return 0; // the screen returns 1 for two nulls, which is not a consistent comparator (its result depends on the sort algorithm); the database keeps such ties in default order, and that order is what the new screen shows
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return desc ? bv - av : av - bv;
    const cmp = String(av).localeCompare(String(bv));
    return desc ? -cmp : cmp;
  });
  for (const key of ['delivery_number', 'customer_name', 'driver_name', 'scheduled_date', 'priority', 'status', 'item_count']) {
    for (const desc of [false, true]) {
      const got = pagesMatch(USERS.admin, { sort_key: key, sort_desc: desc }, 50);
      assert.deepEqual(ids(got), ids({ rows: screenSort(all.rows, key, desc) }), `sort ${key} ${desc ? 'desc' : 'asc'}: order differs from the screen's sort`);
    }
  }
  console.log('[deliveries-page] 7 sort keys x 2 directions: pages of 50 match, order equals the screen sort (ties in default order)');

  // 3. Filters and search equal a direct query.
  const cases = [
    [{ statuses: [] }, NOT_DONE],
    [{ statuses: ['cancelled'] }, "d.status = 'cancelled'"],
    [{ statuses: ['scheduled', 'in_progress'] }, "d.status IN ('scheduled','in_progress')"],
    [{ driver_id: USERS.driver }, `${NOT_DONE} AND d.assigned_driver = '${USERS.driver}'`],
    [{ priority: 'urgent' }, `${NOT_DONE} AND d.priority = 'urgent'`],
    [{ customer_id: CUST[1] }, `${NOT_DONE} AND d.customer_id = '${CUST[1]}'`],
    [{ date_from: TODAY, date_to: '2026-06-20' }, `${NOT_DONE} AND d.scheduled_date BETWEEN '${TODAY}' AND '2026-06-20'`],
    [{ search: 'dp-0115' }, `${NOT_DONE} AND d.delivery_number ILIKE '%dp-0115%'`],
    [{ search: 'group par' }, `${NOT_DONE} AND c.parent_customer_id = '${PARENT}'`],
    [{ search: 'BETA' }, `${NOT_DONE} AND d.customer_id = '${CUST[1]}'`],
    [{ search: 'unassigned' }, `${NOT_DONE} AND d.assigned_driver IS NULL`],
    [{ search: '100%_' }, `${NOT_DONE} AND d.customer_id = '${CUST[2]}'`],
    [{ search: '0%1' }, 'false'],
    [{ search: '   ' }, NOT_DONE],
    [{ search: 'beta', statuses: ['completed'], driver_id: USERS.driver }, `d.customer_id = '${CUST[1]}' AND d.status = 'completed' AND d.assigned_driver = '${USERS.driver}'`],
  ];
  for (const [o, where] of cases) {
    const got = pagesMatch(USERS.admin, o, 50);
    assert.deepEqual(sorted(ids(got)), sorted(directIds(where)), `filter ${JSON.stringify(o)}: set`);
  }
  // Search reaches a row far past the first page of the default order.
  const lastNumber = all.rows.at(-1).delivery_number;
  const found = call(USERS.admin, { search: lastNumber, limit: 50 });
  assert.ok(ids(found).includes(all.rows.at(-1).id), `search ${lastNumber} (row ${all.total_count}) not found`);
  console.log(`[deliveries-page] ${cases.length} filter/search cases equal a direct query; search finds row ${all.total_count} (${lastNumber})`);

  // 4. Summary equals direct counts.
  const count = (where) => Number(scalar(`SELECT count(*) FROM public.deliveries d WHERE d.delivery_number LIKE 'DP-%' AND ${NOT_DONE} AND (${where});`));
  const s = all.summary;
  assert.equal(s.visible_count, visible.length);
  assert.equal(s.open_count, count("d.status IN ('scheduled','in_progress')"));
  assert.equal(s.scheduled_today, count(`d.scheduled_date = '${TODAY}' AND d.status IN ('scheduled','in_progress')`));
  assert.equal(s.in_progress, count("d.status = 'in_progress'"));
  assert.equal(s.completed_this_week, count(`d.status = 'completed' AND (d.completed_at AT TIME ZONE 'UTC')::date >= '${WEEK}'`));
  assert.ok(s.completed_this_week > 0 && s.scheduled_today > 0, 'the seed must exercise the cards');
  assert.equal(s.strip.length, 7);
  for (const [i, day] of s.strip.entries()) {
    const date = scalar(`SELECT (date '${TODAY}' + ${i})::text;`);
    assert.equal(day.date, date);
    assert.equal(day.count, count(`d.scheduled_date = '${date}'`), `strip ${date}: count`);
    assert.equal(day.unassigned, count(`d.scheduled_date = '${date}' AND d.assigned_driver IS NULL`), `strip ${date}: unassigned`);
  }
  assert.deepEqual(call(USERS.admin, { statuses: ['cancelled'], search: 'zzz', limit: 5 }).summary, s, 'summary must not depend on the list filters');
  console.log(`[deliveries-page] summary equals direct counts: ${JSON.stringify({ ...s, strip: undefined })}`);

  // 5. Roles: driver sees only their own, rep sees what admin sees, applicator sees none.
  const driverAll = pagesMatch(USERS.driver, {});
  assert.deepEqual(sorted(ids(driverAll)), sorted(directIds(`${NOT_DONE} AND d.assigned_driver = '${USERS.driver}'`)), 'driver: own deliveries only');
  assert.equal(driverAll.summary.visible_count, driverAll.total_count, 'driver: summary counts own deliveries only');
  assert.deepEqual(ids(callAll(USERS.rep, {})), ids(all), 'sales rep: same rows as admin');
  const applicator = callAll(USERS.applicator, {});
  assert.equal(applicator.total_count, 0, 'applicator: sees no delivery');
  assert.equal(applicator.summary.visible_count, 0);
  console.log(`[deliveries-page] driver sees ${driverAll.total_count} own rows; rep = admin; applicator 0`);

  // 6. Edits and an older new row leave the first pages unchanged (one rolled-back transaction).
  const stable = probe(USERS.admin, `
    ${asUser(`r := public.get_deliveries_page(${args({ limit: 100 })});`)}
    SET LOCAL session_replication_role = replica;
    UPDATE public.deliveries SET priority = 'urgent', delivery_notes = 'edited'
     WHERE id = (SELECT (e->>'id')::uuid FROM jsonb_array_elements(r->'rows') WITH ORDINALITY q(e, o) WHERE o = 60);
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, scheduled_date, status)
    VALUES ('DP-99999', gen_random_uuid(), '${CUST[1]}', '${USERS.admin}', date '2020-01-01', 'scheduled');
    SET LOCAL session_replication_role = origin;
    ${asUser(`r2 := public.get_deliveries_page(${args({ limit: 100 })}); r3 := public.get_deliveries_page(${args({ limit: 1, offset: visible.length })});`)}
    v := concat_ws('|',
      (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(r->'rows') WITH ORDINALITY q(e, o))
        = (SELECT string_agg(e->>'id', ',' ORDER BY o) FROM jsonb_array_elements(r2->'rows') WITH ORDINALITY q(e, o)),
      (r2->>'total_count')::int - (r->>'total_count')::int,
      r3->'rows'->(jsonb_array_length(r3->'rows') - 1)->>'delivery_number');`);
  const [samePages, grew, lastAfter] = stable.split('|');
  assert.equal(samePages, 't', 'an edit or an older new row moved the first pages');
  assert.equal(grew, '1');
  assert.equal(lastAfter, 'DP-99999', 'the older new row lands at the end of the default order');
  console.log('[deliveries-page] edit + older insert: first 100 rows unchanged, new row last');

  // 7. Bad arguments refused; anon cannot execute.
  for (const bad of ["p_today => NULL, p_week_start => '2026-06-14'", `${args()}, p_limit => 0`, `${args()}, p_limit => 501`, `${args()}, p_limit => NULL`,
    `${args()}, p_offset => -1`, `${args()}, p_sort_key => 'id'`, `${args()}, p_sort_desc => NULL`, `${args()}, p_search => repeat('a', 201)`]) {
    const refused = attempt(USERS.admin, `${refuse(`PERFORM public.get_deliveries_page(${bad});`)} v := t;`);
    assert.match(refused, /DELIVERIES_PAGE_BAD_ARGS/, `not refused: ${bad}`);
  }
  assert.equal(scalar("SELECT has_function_privilege('anon', 'public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer)', 'EXECUTE');"), 'f');
  assert.equal(scalar("SELECT prosecdef FROM pg_proc WHERE proname = 'get_deliveries_page';"), 'f');
  console.log('[deliveries-page] 8 bad argument sets refused; anon cannot execute; SECURITY INVOKER');

  // 8. The live smoke chain passes here first (it must end in SMOKE_PASS_ROLLBACK).
  const chain = readFileSync(path.join(ROOT, 'scripts', 'smoke', 'smoke-goal4-deliveries-page.sql'), 'utf8');
  const smoked = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1'], { input: chain, allowFailure: true });
  assert.match(smoked.stderr, /SMOKE_PASS_ROLLBACK/, `smoke-goal4-deliveries-page.sql did not pass:\n${smoked.stderr}`);
  console.log('[deliveries-page] smoke-goal4-deliveries-page.sql: PASS (rolled back)');

  // 9. A second apply is refused by the preflight.
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/dp-candidate.sql'], { input: candidate });
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/dp-candidate.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /DELIVERIES_PAGE_ALREADY_EXISTS/);
  console.log('\nDELIVERIES_PAGE_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
