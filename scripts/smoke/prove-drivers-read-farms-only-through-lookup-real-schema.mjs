#!/usr/bin/env node
/**
 * Real-schema proof for 20270217100000_drivers_read_farms_only_through_lookup.sql (#2162, #2018 step 2).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), records the before state, applies the candidate
 * (autocommit refused, POSTFLIGHT_OK, re-apply refused), then as the signed-in user (role authenticated) checks:
 *   1. a driver reads NO customers row through a delivery, not even the farm on today's delivery assigned to them
 *      (before the candidate: the whole row); a driver on a dispatched field crew keeps field-crew access (Mason, 2026-11-22);
 *   2. admin and sales rep still read every customer with every column; an applicator still reads the farm of
 *      their job and the farm of a job location dispatched to them, and no other;
 *   3. get_deliveries_keyset_page: a driver's list still shows the customer name and TOP farm group of each of their
 *      deliveries (now also an old one), searches by farm group, shows no delivery that is not theirs and never a
 *      secret; admin and sales rep get exactly the same full response as before the candidate (every sort key both
 *      ways, searches, a status filter, a short page);
 *   4. _delivery_list_customer_labels: three keys only; a driver gets labels only for farms on deliveries assigned
 *      to them, an admin and a sales rep for every farm on a delivery, an applicator holding a delivery assignment
 *      and an inactive driver nothing; anon has no execute;
 *   5. get_driver_customers still answers a driver;
 *   6. no function a signed-in user may run (definer or invoker) returns the seeded credit limit, prepay balance,
 *      payment terms or notes to a driver (the same sweep as an admin finds them, so the sweep can see a leak).
 *
 * Run: node scripts/smoke/prove-drivers-read-farms-only-through-lookup-real-schema.mjs   (needs Docker; never touches live)
 * Prints DRIVERS_READ_FARMS_ONLY_THROUGH_LOOKUP_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, attempt, asUser, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270217100000_drivers_read_farms_only_through_lookup.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });

// A > B > C is a farm group; D is on the driver's deliveries only; E is on other people's; F is on a job only;
// G's job is dispatched to a crew the driver is on; H's job location is dispatched to the applicator.
const [A, B, C, D, E, F, G, H] = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map(id);
const [JOB_G, JOB_H, FIELD_G, FIELD_H, JF_G, JF_H, CREW] = ['e1', 'e2', 'f1', 'f2', 'b1', 'b2', 'd1'].map(id);
const DRIVER2 = id('a6');
const OFF_DRIVER = id('a7');
const DENIED_REP = id('a8');
const SECRETS = ['987654321', '123456789', 'ZZTERMS2162', 'ZZNOTE2162'];
// Every sort key both ways, two searches, a status filter and a short page: the office before/after comparison.
const VARIANTS = ['NULL', "'delivery_number'", "'customer_name'", "'driver_name'", "'scheduled_date'", "'priority'", "'status'", "'item_count'"]
  .flatMap((k) => [`, p_sort_key => ${k}`, `, p_sort_key => ${k}, p_sort_desc => true`])
  .concat([", p_search => 'alpha'", ", p_search => 'echo'", ", p_statuses => ARRAY['completed']", ', p_limit => 2']);
const page = (extra = '') => `public.get_deliveries_keyset_page(CURRENT_DATE, CURRENT_DATE - 6${extra})`;
const readAll = (who) => attempt(who, asUser(`v := (SELECT string_agg(farm_name, ',' ORDER BY farm_name) FROM public.customers);`));
const readCol = (who, col, farm) => attempt(who, asUser(`v := (SELECT ${col}::text FROM public.customers WHERE id = '${farm}');`));
const officeList = (who) => attempt(who, asUser(`v := (SELECT string_agg(r0::text, '#' ORDER BY o) FROM unnest(ARRAY[${VARIANTS.map((x) => page(x)).join(', ')}]) WITH ORDINALITY AS u(r0, o));`));
const labels = (who) => attempt(who, asUser(`v := (SELECT string_agg(farm_name || '/' || COALESCE(farm_group_name, '-'), ',' ORDER BY farm_name) FROM public._delivery_list_customer_labels());`));
const driverList = (extra = '') => attempt(USERS.driver, `${asUser(`r := ${page(extra)};`)}
  v := (SELECT string_agg((x->>'delivery_number') || '=' || (x->>'customer_name') || '/' || COALESCE(x->>'farm_group_name', '-'), ',' ORDER BY x->>'delivery_number')
          FROM jsonb_array_elements(r->'rows') x);`);
// Calls every function authenticated may run (definer and invoker; every uuid argument = u, uuid[] = {u}, the rest
// NULL), each as the signed-in user in its own step, and lists the ones whose result shows a secret. A backstop only:
// a call that errors on a NULL argument is skipped; the read rule itself is proved directly in step 1.
const sweep = (u) => `SET LOCAL statement_timeout = '5s';
  n := 0; v := '';
  FOR f0, f1 IN
    SELECT format('public.%I', p.proname),
           COALESCE((SELECT string_agg(CASE t.oid WHEN 'uuid'::regtype THEN quote_literal('${u}') || '::uuid'
                                                WHEN 'uuid[]'::regtype THEN 'ARRAY[' || quote_literal('${u}') || ']::uuid[]'
                                                ELSE 'NULL::' || format_type(t.oid, NULL) END, ', ' ORDER BY a.ord)
                     FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(typ, ord) JOIN pg_type t ON t.oid = a.typ), '')
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ORDER BY 1, 2
  LOOP
    BEGIN
      SET LOCAL ROLE authenticated;
      EXECUTE format('SELECT string_agg(x::text, %L) FROM %s(%s) AS x', '|', f0, f1) INTO t;
      RESET ROLE;
      n := n + 1;
      IF t ~ '${SECRETS.join('|')}' THEN v := v || f0 || ' '; END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  v := n::text || ':' || btrim(v);`;

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  docker(PSQL, { input: `SET session_replication_role = replica;
    INSERT INTO public.profiles (id, email, full_name, role, is_active, denied_pages) VALUES
      ('${DRIVER2}', 'd2@example.invalid', 'Driver Two', 'driver', true, ARRAY['deliveries']),
      ('${OFF_DRIVER}', 'd3@example.invalid', 'Driver Off', 'driver', false, '{}'),
      ('${DENIED_REP}', 'r2@example.invalid', 'Rep Denied', 'sales_rep', true, ARRAY['deliveries']);
    INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES
      ('${A}', 'Alpha Top Farms', NULL), ('${B}', 'Bravo Farms', '${A}'), ('${C}', 'Charlie Farms', '${B}'),
      ('${D}', 'Delta Farms', NULL), ('${E}', 'Echo Farms', NULL), ('${F}', 'Foxtrot Farms', NULL),
      ('${G}', 'Golf Farms', NULL), ('${H}', 'Hotel Farms', NULL);
    UPDATE public.customers SET credit_limit_cents = 987654321, prepay_balance_cents = 123456789,
      payment_terms = 'ZZTERMS2162', notes = 'ZZNOTE2162' WHERE id IN ('${C}', '${D}');
    UPDATE public.customers SET notes = 'CREWNOTE2162' WHERE id = '${G}';
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, scheduled_date, status, assigned_driver) VALUES
      ('FR-01', gen_random_uuid(), '${D}', '${USERS.admin}', CURRENT_DATE, 'scheduled', '${USERS.driver}'),
      ('FR-02', gen_random_uuid(), '${C}', '${USERS.admin}', CURRENT_DATE + 1, 'in_progress', '${USERS.driver}'),
      ('FR-03', gen_random_uuid(), '${B}', '${USERS.admin}', CURRENT_DATE - 30, 'completed', '${USERS.driver}'),
      ('FR-04', gen_random_uuid(), '${E}', '${USERS.admin}', CURRENT_DATE, 'scheduled', '${DRIVER2}'),
      ('FR-05', gen_random_uuid(), '${E}', '${USERS.admin}', CURRENT_DATE, 'scheduled', NULL),
      ('FR-06', gen_random_uuid(), '${D}', '${USERS.admin}', CURRENT_DATE, 'scheduled', '${OFF_DRIVER}'),
      ('FR-07', gen_random_uuid(), '${E}', '${USERS.admin}', CURRENT_DATE, 'scheduled', '${USERS.applicator}');
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id) VALUES
      (gen_random_uuid(), 'FR-J1', '${F}', CURRENT_DATE, 'scheduled', '${USERS.applicator}'),
      ('${JOB_G}', 'FR-J2', '${G}', CURRENT_DATE, 'scheduled', NULL),
      ('${JOB_H}', 'FR-J3', '${H}', CURRENT_DATE, 'scheduled', NULL);
    INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${FIELD_G}', '${G}', 'Golf North'), ('${FIELD_H}', '${H}', 'Hotel South');
    INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${JF_G}', '${JOB_G}', '${FIELD_G}'), ('${JF_H}', '${JOB_H}', '${FIELD_H}');
    INSERT INTO public.ground_crews (id, name, is_active) VALUES ('${CREW}', 'Crew One', true);
    INSERT INTO public.ground_crew_members (crew_id, name, profile_id, is_active) VALUES ('${CREW}', 'Driver on crew', '${USERS.driver}', true),
      ('${CREW}', 'Inactive driver on crew', '${OFF_DRIVER}', true);
    INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, crew_id, dispatch_status) VALUES
      ('${JF_G}', '${JOB_G}', NULL, '${CREW}', 'dispatched'),
      ('${JF_H}', '${JOB_H}', '${USERS.applicator}', NULL, 'dispatched');
    SET session_replication_role = origin;` });

  // Before the candidate: the holes this closes, and the office results to compare with.
  assert.equal(readCol(USERS.driver, 'credit_limit_cents', D), 'ok|987654321', 'before: a driver reads the whole row of the farm on their delivery');
  assert.equal(readCol(USERS.driver, 'notes', G), 'ok|CREWNOTE2162', 'before: a crew dispatch gives a driver the whole row');
  assert.equal(readAll(USERS.driver), 'ok|Charlie Farms,Delta Farms,Golf Farms', 'before: a driver reads their delivery farms and the crew-dispatched farm');
  assert.equal(readAll(USERS.applicator), 'ok|Foxtrot Farms,Hotel Farms', 'before: an applicator reads their job farm and dispatched farm');
  // Before: the driver could not read the parent farms, so their list showed no farm group.
  assert.equal(driverList(), 'ok|FR-01=Delta Farms/-,FR-02=Charlie Farms/-,FR-03=Unknown/-', 'before: driver list');
  const before = { admin: officeList(USERS.admin), rep: officeList(USERS.rep) };
  assert.match(before.admin, /^ok\|.*Echo Farms/, 'the office list carries other drivers\' farms');
  assert.match(before.rep, /^ok\|.*Alpha Top Farms/, 'the office list carries the top farm group');

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /DRIVER_FARM_READ_BASELINE_DRIFT/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  // 1-2. Direct reads.
  assert.equal(readAll(USERS.driver), 'ok|Golf Farms', 'a driver reads no delivery farm row, only the crew-dispatched farm');
  assert.equal(readCol(USERS.driver, 'credit_limit_cents', D), 'ok|<null>', 'a driver no longer reads the farm on their own delivery');
  // _is_dispatched_to_me() requires an active profile, so an inactive driver on a dispatched crew reads nothing.
  // For an inactive driver is_driver() is false, so NOT is_driver() admits them; _is_dispatched_to_me() requires an active profile.
  assert.equal(readAll(OFF_DRIVER), 'ok|<null>', 'an inactive driver on a dispatched crew reads no customers row');
  const everyone = 'ok|Alpha Top Farms,Bravo Farms,Charlie Farms,Delta Farms,Echo Farms,Foxtrot Farms,Golf Farms,Hotel Farms';
  assert.equal(readAll(USERS.admin), everyone, 'admin reads every customer');
  assert.equal(readAll(USERS.rep), everyone, 'sales rep reads every customer');
  assert.equal(readCol(USERS.admin, 'credit_limit_cents', D), 'ok|987654321', 'admin reads every column');
  assert.equal(readCol(USERS.rep, 'credit_limit_cents', D), 'ok|987654321', 'sales rep reads every column');
  assert.equal(readAll(USERS.applicator), 'ok|Foxtrot Farms,Hotel Farms', 'an applicator still reads their job farm and dispatched farm only');
  console.log('[read] a driver reads no delivery farm row (crew dispatch kept); admin, sales rep and applicator unchanged');

  // 3. The Deliveries list.
  assert.equal(driverList(), 'ok|FR-01=Delta Farms/-,FR-02=Charlie Farms/Alpha Top Farms,FR-03=Bravo Farms/Alpha Top Farms',
    'a driver\'s list keeps names and the top farm group, the old delivery included');
  assert.equal(driverList(", p_search => 'alpha top'"), 'ok|FR-02=Charlie Farms/Alpha Top Farms,FR-03=Bravo Farms/Alpha Top Farms', 'a driver searches by farm group');
  const driverText = attempt(USERS.driver, `${asUser(`r := ${page()};`)} v := r::text;`);
  for (const secret of SECRETS) assert.ok(!driverText.includes(secret), `the list must not return ${secret}`);
  for (const other of ['FR-04', 'FR-05', 'FR-06', 'FR-07']) assert.ok(!driverText.includes(other), `a driver must not see ${other}`);
  assert.equal(officeList(USERS.admin), before.admin, 'admin list identical to before');
  assert.equal(officeList(USERS.rep), before.rep, 'sales rep list identical to before');
  console.log(`[list] driver list keeps farm names and groups; admin and sales rep responses identical across ${VARIANTS.length} variants`);

  // 4. The label helper.
  assert.equal(attempt(USERS.driver, `${asUser(`r := (SELECT to_jsonb(x) FROM public._delivery_list_customer_labels() x LIMIT 1);`)} v := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r) k);`),
    'ok|farm_group_name,farm_name,id', 'only three columns');
  assert.equal(labels(USERS.driver), 'ok|Bravo Farms/Alpha Top Farms,Charlie Farms/Alpha Top Farms,Delta Farms/-', 'a driver: labels for their deliveries\' farms only');
  assert.equal(labels(USERS.admin), 'ok|Bravo Farms/Alpha Top Farms,Charlie Farms/Alpha Top Farms,Delta Farms/-,Echo Farms/-', 'admin: every farm on a delivery');
  assert.equal(labels(USERS.rep), 'ok|Bravo Farms/Alpha Top Farms,Charlie Farms/Alpha Top Farms,Delta Farms/-,Echo Farms/-', 'sales rep: every farm on a delivery');
  assert.equal(labels(USERS.applicator), 'ok|<null>', 'an applicator holding a delivery assignment: nothing');
  assert.equal(labels(OFF_DRIVER), 'ok|<null>', 'an inactive driver: nothing');
  assert.equal(labels(DRIVER2), 'ok|<null>', 'a driver denied the Deliveries page: nothing, though FR-04 is assigned to them');
  assert.equal(labels(DENIED_REP), 'ok|<null>', 'a sales rep denied the Deliveries page: nothing');
  assert.match(attempt(USERS.driver, `SET LOCAL ROLE anon; BEGIN PERFORM public._delivery_list_customer_labels(); v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /permission denied/, 'anon cannot run the helper');
  console.log('[labels] names only, for a driver\'s own deliveries; office all; others nothing; anon refused');

  // 5. The driver's farm lookup is untouched.
  assert.equal(attempt(USERS.driver, `${asUser(`r := public.get_driver_customers(ARRAY['${D}']::uuid[]);`)} v := r->'rows'->0->>'farm_name';`),
    'ok|Delta Farms', 'get_driver_customers still answers a driver');
  assert.equal(scalar(`SELECT count(*) FROM pg_policies WHERE tablename = 'customers' AND policyname = 'customers_select' AND qual ~ 'is_driver';`), '0');
  console.log('[lookup] get_driver_customers unchanged');

  // 6. No function a signed-in user may run hands a driver the secret farm fields; as an admin the sweep finds them.
  // Every uuid argument is tried as a delivery farm (D), the crew-dispatched farm (G), its job and its job field.
  let driverSweep;
  for (const u of [D, G, JOB_G, JF_G]) {
    driverSweep = attempt(USERS.driver, sweep(u));
    assert.match(driverSweep, /^ok\|\d+:$/, `functions showing a driver secret farm fields (uuid ${u}): ${driverSweep}`);
  }
  const adminSweep = attempt(USERS.admin, sweep(D));
  assert.match(adminSweep, /^ok\|\d+:\S/, `the sweep must see the secrets as an admin: ${adminSweep}`);
  console.log(`[sweep] driver: ${driverSweep.split('|')[1].split(':')[0]} functions answered, none showed a secret; admin sees them in: ${adminSweep.split(':')[1]}`);

  console.log('\nDRIVERS_READ_FARMS_ONLY_THROUGH_LOOKUP_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
