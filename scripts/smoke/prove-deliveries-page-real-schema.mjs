#!/usr/bin/env node
/**
 * Real-schema proof for 20261130100000_deliveries_list_page.sql (Goal 4). Builds the checked-in baseline plus
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
 *   - bad arguments are refused, anon cannot execute it, and a second apply is refused;
 *   - at 60,000 deliveries (rolled back) a rep's first page, a page by id and an export page stay under 8 s
 *     and under 3x a rep's plain read of the same deliveries.
 * It also runs the live smoke chain in the scratch database.
 *
 * 20261202100000_deliveries_list_keyset_page.sql (Goal 4 follow-up): get_deliveries_page now calls
 * get_deliveries_keyset_page, so every check above also covers it with no bookmark. Section 11 adds:
 *   - following next_cursor lists exactly the full read for the default order, every sort key both ways,
 *     filters with search, and a driver; the last page has no next_cursor;
 *   - a delivery cancelled before the bookmark, and the bookmarked delivery itself, make offset paging skip
 *     rows while bookmark paging returns the same next page (default order and five sorts);
 *   - stale (other sort, direction or day) and malformed bookmarks are refused, as are a bookmark with an
 *     offset or an id cursor; anon cannot execute; a second apply is refused; its smoke chain passes;
 *   - at 60,000 deliveries a rep's bookmarked page stays under 8 s and 3x a plain read.
 *
 * Run: node scripts/smoke/prove-deliveries-page-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> DELIVERIES_PAGE_PROOF_REUSE=1 (left running).
 * Prints DELIVERIES_PAGE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, asUser, refuse, claims, signIn, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20261130100000_deliveries_list_page.sql';
const KEYSET = '20261202100000_deliveries_list_keyset_page.sql';
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

const NIL = '00000000-0000-0000-0000-000000000000';
/** The whole-list read the screen makes: pages of 500 in delivery id order, each after the last id. */
function callById(uid, o) {
  const rows = [];
  for (let after = NIL; ;) {
    const page = call(uid, { ...o, limit: 500, after_id: after });
    rows.push(...page.rows);
    if (page.rows.length < 500) return { ...page, rows };
    after = page.rows.at(-1).id;
  }
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
  const byId = callById(uid, o);
  assert.deepEqual(ids(byId), sorted(ids(all)), `${JSON.stringify(o)}: the read by id is not the same rows in id order`);
  assert.deepEqual(ids({ rows: [...byId.rows].sort((a, b) => a.sort_position - b.sort_position) }), ids(all),
    `${JSON.stringify(o)}: the read by id sorted by sort_position is not the full read's order`);
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

  // 6b. A read by id that sees edits between its pages (Sol, 2026-11-06): after page 1, a page-1 delivery is
  // cancelled and two cancelled ones come back, one on each side of the cursor. Every delivery visible before
  // and after must appear exactly once, and nothing that was never visible may appear.
  const drift = probe(USERS.admin, `
    CREATE TEMP TABLE kb (id uuid); CREATE TEMP TABLE km (id uuid); CREATE TEMP TABLE ka (id uuid);
    u := '${NIL}';
    LOOP ${asUser(`r := public.get_deliveries_page(p_today => '${TODAY}', p_week_start => '${WEEK}', p_limit => 500, p_after_id => u);`)}
      INSERT INTO kb SELECT (e->>'id')::uuid FROM jsonb_array_elements(r->'rows') e;
      EXIT WHEN jsonb_array_length(r->'rows') < 500; u := (r->'rows'->-1->>'id')::uuid;
    END LOOP;
    u := '${NIL}';
    ${asUser(`r := public.get_deliveries_page(p_today => '${TODAY}', p_week_start => '${WEEK}', p_limit => 500, p_after_id => u);`)}
    INSERT INTO km SELECT (e->>'id')::uuid FROM jsonb_array_elements(r->'rows') e;
    u := (r->'rows'->-1->>'id')::uuid;
    SET LOCAL session_replication_role = replica;
    UPDATE public.deliveries SET status = 'cancelled' WHERE id = (r->'rows'->0->>'id')::uuid;
    UPDATE public.deliveries SET status = 'scheduled' WHERE id IN (
      (SELECT id FROM public.deliveries WHERE delivery_number LIKE 'DP-%' AND status = 'cancelled' AND id < u ORDER BY id DESC LIMIT 1),
      (SELECT id FROM public.deliveries WHERE delivery_number LIKE 'DP-%' AND status = 'cancelled' AND id > u ORDER BY id DESC LIMIT 1));
    SET LOCAL session_replication_role = origin;
    LOOP ${asUser(`r := public.get_deliveries_page(p_today => '${TODAY}', p_week_start => '${WEEK}', p_limit => 500, p_after_id => u);`)}
      INSERT INTO km SELECT (e->>'id')::uuid FROM jsonb_array_elements(r->'rows') e;
      EXIT WHEN jsonb_array_length(r->'rows') < 500; u := (r->'rows'->-1->>'id')::uuid;
    END LOOP;
    u := '${NIL}';
    LOOP ${asUser(`r := public.get_deliveries_page(p_today => '${TODAY}', p_week_start => '${WEEK}', p_limit => 500, p_after_id => u);`)}
      INSERT INTO ka SELECT (e->>'id')::uuid FROM jsonb_array_elements(r->'rows') e;
      EXIT WHEN jsonb_array_length(r->'rows') < 500; u := (r->'rows'->-1->>'id')::uuid;
    END LOOP;
    v := concat_ws('|', (SELECT count(*) FROM kb), (SELECT count(*) FROM ka),
      (SELECT count(*) - count(DISTINCT id) FROM km),
      (SELECT count(*) FROM ((SELECT id FROM kb INTERSECT SELECT id FROM ka) EXCEPT SELECT id FROM km) missing),
      (SELECT count(*) FROM (SELECT id FROM km EXCEPT (SELECT id FROM kb UNION SELECT id FROM ka)) stray));`);
  const [before, after, repeated, missing, stray] = drift.split('|').map(Number);
  assert.equal(after, before + 1, `the edits should leave one more visible delivery (${before} -> ${after})`);
  assert.deepEqual({ repeated, missing, stray }, { repeated: 0, missing: 0, stray: 0 }, 'a read by id skipped or repeated a delivery across edits');
  console.log(`[deliveries-page] read by id across a cancel and two reactivations: ${before} -> ${after}, none skipped or repeated`);

  // 6c. No delivery can have the nil id, so the nil start cursor skips nothing (Sol, 2026-11-06).
  const nilTry = psql(`UPDATE public.deliveries SET id = '${NIL}' WHERE id = (SELECT id FROM public.deliveries WHERE delivery_number LIKE 'DP-%' LIMIT 1);`, { allowFailure: true });
  assert.match(`${nilTry.stderr ?? ''}${nilTry.stdout ?? ''}${nilTry}`, /deliveries_id_not_nil/, 'a delivery with the nil id must be refused');
  console.log('[deliveries-page] a delivery with the nil id is refused (deliveries_id_not_nil)');

  // 7. Bad arguments refused; anon cannot execute.
  for (const bad of ["p_today => NULL, p_week_start => '2026-06-14'", `${args()}, p_limit => 0`, `${args()}, p_limit => 501`, `${args()}, p_limit => NULL`,
    `${args()}, p_offset => -1`, `${args()}, p_after_id => '${NIL}', p_offset => 1`, `${args()}, p_sort_key => 'id'`, `${args()}, p_sort_desc => NULL`, `${args()}, p_search => repeat('a', 201)`]) {
    const refused = attempt(USERS.admin, `${refuse(`PERFORM public.get_deliveries_page(${bad});`)} v := t;`);
    assert.match(refused, /DELIVERIES_PAGE_BAD_ARGS/, `not refused: ${bad}`);
  }
  assert.equal(scalar("SELECT has_function_privilege('anon', 'public.get_deliveries_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid)', 'EXECUTE');"), 'f');
  assert.equal(scalar("SELECT prosecdef FROM pg_proc WHERE proname = 'get_deliveries_page';"), 'f');
  console.log('[deliveries-page] 9 bad argument sets refused; anon cannot execute; SECURITY INVOKER');

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
  console.log('[deliveries-page] second apply refused');

  // 11. Bookmark (keyset) paging: get_deliveries_keyset_page (20261202100000).
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(KEYSET, '.sql')}';`), '1',
    'the keyset candidate must have replayed (its preflight and postflight passed)');
  const callK = (uid, o, after) => JSON.parse(probe(uid,
    `${asUser(`r := public.get_deliveries_keyset_page(${args(o)}${after ? `, p_after => ${q(JSON.stringify(after))}::jsonb` : ''});`)} v := r::text;`));
  /** Follows next_cursor in pages of `size`; the rows must be exactly the full read, in order. */
  function keysetMatch(uid, o, size) {
    const all = callAll(uid, o);
    const first = callK(uid, { ...o, limit: size });
    assert.deepEqual(first, call(uid, { ...o, limit: size }), `${JSON.stringify(o)}: get_deliveries_page and the keyset page differ on page one`);
    const got = [];
    for (let page = first, n = 0; ; n++) {
      assert.equal(page.total_count, all.total_count, `${JSON.stringify(o)}: total_count moved`);
      assert.ok(page.rows.length <= size);
      got.push(...ids(page));
      if (!page.next_cursor) break;
      assert.ok(n < 1000, 'next_cursor never ended');
      page = callK(uid, { ...o, limit: size }, page.next_cursor);
    }
    assert.deepEqual(got, ids(all), `${JSON.stringify(o)}: bookmark pages of ${size} differ from the full read`);
  }
  keysetMatch(USERS.admin, {}, 37);
  for (const key of ['delivery_number', 'customer_name', 'driver_name', 'scheduled_date', 'priority', 'status', 'item_count']) {
    for (const desc of [false, true]) keysetMatch(USERS.admin, { sort_key: key, sort_desc: desc }, 50);
  }
  keysetMatch(USERS.admin, { search: 'beta', statuses: ['completed', 'scheduled'] }, 23);
  keysetMatch(USERS.admin, { statuses: ['cancelled'], sort_key: 'priority', sort_desc: true }, 11);
  keysetMatch(USERS.driver, {}, 37);
  console.log('[deliveries-page] bookmark paging equals the full read: default, 7 sorts x 2, filters + search, a driver');

  // A delivery on page one is cancelled, and so is the bookmarked (last) one: offset paging skips two rows,
  // bookmark paging returns the same page two.
  for (const o of [{}, { sort_key: 'priority' }, { sort_key: 'priority', sort_desc: true }, { sort_key: 'status' },
    { sort_key: 'item_count', sort_desc: true }, { sort_key: 'customer_name' }]) {
    const keyset = (extra) => `public.get_deliveries_keyset_page(${args({ ...o, limit: 50 })}${extra})`;
    const out = probe(USERS.admin, `
      ${asUser(`r := ${keyset('')}; r2 := ${keyset(", p_after => r->'next_cursor'")};`)}
      SET LOCAL session_replication_role = replica;
      UPDATE public.deliveries SET status = 'cancelled' WHERE id IN ((r->'rows'->9->>'id')::uuid, (r->'rows'->49->>'id')::uuid);
      SET LOCAL session_replication_role = origin;
      ${asUser(`r3 := ${keyset(", p_after => r->'next_cursor'")};`)}
      t := (SELECT string_agg(e->>'id', ',' ORDER BY i) FROM jsonb_array_elements(r2->'rows') WITH ORDINALITY x(e, i));
      t2 := (SELECT string_agg(e->>'id', ',' ORDER BY i) FROM jsonb_array_elements(r3->'rows') WITH ORDINALITY x(e, i));
      ${asUser(`r3 := public.get_deliveries_page(${args({ ...o, limit: 50, offset: 50 })});`)}
      v := concat_ws('|', jsonb_array_length(r2->'rows'), t = t2, r3->'rows'->0->>'id' = r2->'rows'->2->>'id');`);
    assert.equal(out, '50|t|t', `${JSON.stringify(o)}: expected a full page two, unchanged by bookmark, and offset paging to skip two (got ${out})`);
  }
  console.log('[deliveries-page] two deliveries removed before the bookmark (one the bookmark itself): offset skips 2, bookmark skips none, 6 orders');

  // Refused bookmarks.
  const page1 = callK(USERS.admin, { sort_key: 'priority', limit: 50 });
  const cur = page1.next_cursor;
  assert.deepEqual(Object.keys(cur).sort(), ['dir', 'id', 'k', 'n', 's', 'today', 'v']);
  const kRefuse = (o, after, extra = '') => attempt(USERS.admin,
    `${refuse(`PERFORM public.get_deliveries_keyset_page(${args(o)}, p_after => ${q(JSON.stringify(after))}::jsonb${extra});`)} v := t;`);
  for (const [o, after] of [[{ sort_key: 'status' }, cur], [{}, cur], [{ sort_key: 'priority', sort_desc: true }, cur],
    [{ sort_key: 'priority' }, { ...cur, today: '2026-06-16' }]]) {
    assert.match(kRefuse(o, after), /DELIVERIES_PAGE_STALE_CURSOR/, `stale bookmark not refused: ${JSON.stringify(o)} ${JSON.stringify(after)}`);
  }
  const { v: _v, ...noV } = cur;
  for (const after of [[1], { ...cur, id: 'nope' }, { ...cur, id: 7 }, noV, { ...cur, s: 'not-a-date' }, { ...cur, s: 3 }]) {
    assert.match(kRefuse({ sort_key: 'priority' }, after), /DELIVERIES_PAGE_BAD_CURSOR/, `malformed bookmark not refused: ${JSON.stringify(after)}`);
  }
  const countCur = callK(USERS.admin, { sort_key: 'item_count', limit: 50 }).next_cursor;
  assert.match(kRefuse({ sort_key: 'item_count' }, { ...countCur, v: 'x' }), /DELIVERIES_PAGE_BAD_CURSOR/);
  const defCur = callK(USERS.admin, { limit: 50 }).next_cursor;
  assert.match(kRefuse({}, { ...defCur, v: 'x' }), /DELIVERIES_PAGE_BAD_CURSOR/, 'a value in v with no sort column must be refused');
  assert.match(kRefuse({ sort_key: 'priority' }, cur, ', p_offset => 50'), /DELIVERIES_PAGE_BAD_ARGS/);
  assert.match(kRefuse({ sort_key: 'priority' }, cur, `, p_after_id => '${NIL}'`), /DELIVERIES_PAGE_BAD_ARGS/);
  assert.equal(scalar("SELECT has_function_privilege('anon', 'public.get_deliveries_keyset_page(date,date,text,text[],uuid,text,uuid,date,date,text,boolean,integer,integer,uuid,jsonb)', 'EXECUTE');"), 'f');
  assert.equal(scalar("SELECT prosecdef FROM pg_proc WHERE proname = 'get_deliveries_keyset_page';"), 'f');
  console.log('[deliveries-page] stale and malformed bookmarks refused; anon cannot execute; SECURITY INVOKER');

  const kChain = readFileSync(path.join(ROOT, 'scripts', 'smoke', 'smoke-goal4-deliveries-keyset-page.sql'), 'utf8');
  const kSmoked = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1'], { input: kChain, allowFailure: true });
  assert.match(kSmoked.stderr, /SMOKE_PASS_ROLLBACK/, `smoke-goal4-deliveries-keyset-page.sql did not pass:\n${kSmoked.stderr}`);
  console.log('[deliveries-page] smoke-goal4-deliveries-keyset-page.sql: PASS (rolled back)');

  const keysetSql = readFileSync(path.join(ROOT, 'supabase', 'migrations', KEYSET), 'utf8').replaceAll('\r\n', '\n');
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/dp-keyset.sql'], { input: keysetSql });
  const againK = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/dp-keyset.sql'], { allowFailure: true });
  assert.notEqual(againK.status, 0, 'a second apply of the keyset migration must be refused');
  assert.match(againK.stderr, /DELIVERIES_KEYSET_PAGE_ALREADY_EXISTS/);
  console.log('[deliveries-page] keyset migration: second apply refused');

  // 10. Speed at 60,000 deliveries (Sol + Taha, 2026-11-06: a rep's first page took ~9 s on live hardware when
  // every page counted items for every match). Seeded in one rolled-back transaction. Each call is compared with a
  // rep's plain read of the same deliveries (the same row level security cost), so the check holds on any PC:
  // before the fix a rep's first page was ~4x that read, after it ~1.6x.
  const ms = (label, stmt) => `f0 := clock_timestamp(); ${asUser(stmt)} t := concat_ws(',', t, '${label}=' || round(extract(epoch FROM clock_timestamp() - f0::timestamptz) * 1000));`;
  const page = (o) => `r := public.get_deliveries_page(${args(o)});`;
  const timed = probe(USERS.rep, `
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name) SELECT ('7c7a0000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, '[DPV] Farm ' || g FROM generate_series(1, 400) g;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, scheduled_date, status, assigned_driver, priority, completed_at)
    SELECT 'DPV-' || lpad(g::text, 6, '0'), gen_random_uuid(), ('7c7a0000-0000-4000-9000-' || lpad(to_hex(1 + g % 400), 12, '0'))::uuid,
           '${USERS.admin}', date '${TODAY}' - (g % 1500) + 30,
           (ARRAY['scheduled','scheduled','in_progress','completed','completed','completed','completed','cancelled','voided'])[1 + g % 9],
           (ARRAY['${USERS.driver}'::uuid, NULL, '${USERS.admin}'::uuid])[1 + g % 3], (ARRAY['low','normal','high','urgent',NULL])[1 + g % 5],
           CASE WHEN g % 9 BETWEEN 3 AND 6 THEN timestamptz '${TODAY} 12:00+00' - ((g % 1500) || ' days')::interval END
    FROM generate_series(1, 60000) g;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity)
    SELECT d.id, gen_random_uuid(), gen_random_uuid(), 1 FROM public.deliveries d, generate_series(1, 4) k
     WHERE d.delivery_number LIKE 'DPV-%' AND k <= 1 + right(d.delivery_number, 1)::int % 4;
    SET LOCAL session_replication_role = origin;
    ANALYZE public.deliveries; ANALYZE public.delivery_items; ANALYZE public.customers;
    ${ms('warm', 'n := (SELECT count(*) FROM public.deliveries);')}
    ${ms('base', 'n := (SELECT count(*) FROM public.deliveries);')}
    ${ms('rep_cold', page({ limit: 50 }))}
    ${ms('rep_first', page({ limit: 50 }))}
    ${ms('rep_by_id', page({ limit: 500, after_id: NIL }))}
    ${ms('rep_export', page({ limit: 500, offset: 30000 }))}
    ${ms('rep_items_sort', page({ limit: 50, sort_key: 'item_count' }))}
    ${signIn(USERS.admin)}
    ${ms('admin_first', page({ limit: 50 }))}
    ${signIn(USERS.rep)}
    ${asUser(page({ limit: 50 }))}
    ${ms('rep_keyset', `r2 := public.get_deliveries_keyset_page(${args({ limit: 50 })}, p_after => r->'next_cursor');`)}
    v := t;`);
  const times = Object.fromEntries(timed.split(',').map((kv) => kv.split('=')).map(([k, n]) => [k, Number(n)]));
  console.log(`[deliveries-page] 60,000 deliveries, ms: ${JSON.stringify(times)}`);
  for (const k of ['rep_first', 'rep_by_id', 'rep_export', 'admin_first', 'rep_keyset']) {
    assert.ok(times[k] < 8000, `${k} took ${times[k]} ms at 60,000 deliveries (authenticated statement_timeout is 8 s)`);
    assert.ok(times[k] < 3 * Math.max(times.base, 100), `${k} took ${times[k]} ms, over 3x a rep's plain read (${times.base} ms): the per-page cost regressed`);
  }
  // The very first call also plans get_deliveries_page and the keyset function it wraps (one-time; 0.2-0.6 s here, more on a busy PC);
  // it is held only to the timeout, and rep_first measures the per-page cost.
  assert.ok(times.rep_cold < 8000, `rep_cold took ${times.rep_cold} ms at 60,000 deliveries`);
  // Sorting by item count still counts every match (known limit, in the migration record and KNOWN_ISSUES); it must
  // at least stay under the timeout here.
  assert.ok(times.rep_items_sort < 8000, `rep_items_sort took ${times.rep_items_sort} ms at 60,000 deliveries`);
  console.log('\nDELIVERIES_PAGE_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
