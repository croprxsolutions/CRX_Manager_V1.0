#!/usr/bin/env node
/**
 * Real-schema proof for KI-195 (20270225110000_job_proof_kept_epa): the sent proof's data and the printouts' read of
 * job_product_epa give the EPA number a job kept, never the catalog's later one. Builds the baseline plus every
 * migration before the candidate (shared undo-paths harness), then:
 *   FIDELITY: the replayed get_job_proof_data source has the md5 the candidate's preflight pins (live's, 2026-11-23);
 *   BEFORE:   the proof returns the catalog's corrected number (the bug);
 *   APPLY:    the candidate commits (postflight passes); a second apply stops at its preflight;
 *   AFTER (as the office admin, the real caller, with the screen's exact arguments, whole job and per customer):
 *     a corrected catalog number keeps the kept one; a product kept with no number is epa_kept + NULL (prints
 *     "Unknown") although the catalog has one now; a backfilled job is epa_not_recorded (prints "Not recorded");
 *     an unsprayed job still reads the catalog, normalized;
 *   ACCESS: an applicator is refused the proof; one overload; anon has no EXECUTE; the printouts' direct read of
 *     job_product_epa (applyKeptEpa) returns the kept rows to the job's applicator and to a sales rep under RLS, and
 *     the applicator loses the job and its kept rows together once the 7-day window ends.
 * Writes the AFTER proof JSON and the kept rows to KI195_PROOF_OUT (if set) for the rendering test.
 *
 * Run: node scripts/smoke/prove-ki195-kept-epa-real-schema.mjs   (needs Docker)
 * Prints KI195_KEPT_EPA_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-ki195-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, psql, scalar, docker, USERS, id, NAME, ROOT } = await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270225110000_job_proof_kept_epa.sql';
const PINNED_MD5 = 'e4ec151e7306b61962fd16251f47af76';
const CUST = id('e1'); const FIELD = id('e2');
const P_CORR = id('e3'); const P_NONE = id('e4'); const P_OLD = id('e5');
const J_SPRAYED = id('e6'); const J_BACKFILLED = id('e7'); const J_OPEN = id('e8');

const as = (uid, sql) => `BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated; ${sql} COMMIT;`;
const run = (sql) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, allowFailure: true });
const out = (r) => `${r.stdout}${r.stderr}`;
// Exactly what FieldApplicationInvoice sends: { p_job_id } for the preview, { p_job_id, p_customer_id } per recipient.
const proof = (uid, job, customer) => JSON.parse(scalar(as(uid, `SELECT public.get_job_proof_data(p_job_id => '${job}'${
  customer ? `, p_customer_id => '${customer}'` : ''})::text;`)));
const byName = (p) => Object.fromEntries(p.products.map((x) => [x.product_name, x]));
// Exactly what applyKeptEpa reads.
const keptRows = (uid, job) => JSON.parse(scalar(as(uid, `SELECT coalesce(json_agg(json_build_object('product_id', product_id,
  'epa_registration', epa_registration, 'not_recorded', not_recorded) ORDER BY product_id), '[]')::text
  FROM public.job_product_epa WHERE job_id = '${job}';`)));

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();

  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.get_job_proof_data(uuid,uuid)'::regprocedure;`),
    PINNED_MD5, 'the replayed proof function is the body the candidate pins');
  console.log('[KI-195] FIDELITY: replayed get_job_proof_data matches the pinned live body');

  // Seed without triggers, then lock the sprayed job through the real recording function.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] KI195 Farm', true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] KI195 Field', 80);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, is_active) VALUES
      ('${P_CORR}', '[PROVER] Corrected', 'KI195-C', 'liquid', 'Gal', 'Herbicide', '100-1', true),
      ('${P_NONE}', '[PROVER] NoNumber', 'KI195-N', 'liquid', 'Gal', 'Herbicide', NULL, true),
      ('${P_OLD}', '[PROVER] Backfilled', 'KI195-B', 'liquid', 'Gal', 'Herbicide', '300-3', true);
    -- completed_at as the server's completion trigger would stamp it (the applicator's 7-day window reads it).
    INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, created_by, applicator_id, completed_at) VALUES
      ('${J_SPRAYED}', 'KI195-SPRAYED', '${CUST}', 'completed', current_date, '${USERS.admin}', '${USERS.applicator}', now()),
      ('${J_BACKFILLED}', 'KI195-OLD', '${CUST}', 'completed', current_date, '${USERS.admin}', '${USERS.applicator}', now()),
      ('${J_OPEN}', 'KI195-OPEN', '${CUST}', 'scheduled', current_date, '${USERS.admin}', '${USERS.applicator}', NULL);
    INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES
      ('${J_SPRAYED}', '${FIELD}', 80, 0), ('${J_BACKFILLED}', '${FIELD}', 80, 0), ('${J_OPEN}', '${FIELD}', 80, 0);
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, customer_supplied, sort_order) VALUES
      ('${J_SPRAYED}', '${P_CORR}', 10, 'Gal', 0.125, 'Gal', 0, true, 0),
      ('${J_SPRAYED}', '${P_NONE}', 5, 'Gal', 0.0625, 'Gal', 0, true, 1),
      ('${J_BACKFILLED}', '${P_OLD}', 10, 'Gal', 0.125, 'Gal', 0, true, 0),
      ('${J_OPEN}', '${P_CORR}', 10, 'Gal', 0.125, 'Gal', 0, true, 0);
    -- The backfill's own rows for a job sprayed before numbers were kept (20261204120000 section 4).
    INSERT INTO public.job_epa_sprayed (job_id, not_recorded) VALUES ('${J_BACKFILLED}', true);
    INSERT INTO public.job_product_epa (job_id, product_id, epa_registration, not_recorded) VALUES ('${J_BACKFILLED}', '${P_OLD}', NULL, true);
    SET session_replication_role = origin;
    SELECT public._job_epa_freeze('${J_SPRAYED}');
    -- Catalog corrections after the spray: a new number, and a number for a product that had none.
    SET session_replication_role = replica;
    UPDATE public.products SET epa_registration = '100-9' WHERE id = '${P_CORR}';
    UPDATE public.products SET epa_registration = '  200-2 ' WHERE id = '${P_NONE}';
    UPDATE public.products SET epa_registration = '300-9' WHERE id = '${P_OLD}';`);
  assert.deepEqual(keptRows(USERS.admin, J_SPRAYED).map((r) => [r.epa_registration, r.not_recorded]).sort(),
    [['100-1', false], [null, false]].sort(), 'the freeze kept 100-1 and an explicit no-number');

  const before = byName(proof(USERS.admin, J_SPRAYED));
  assert.equal(before['[PROVER] Corrected'].epa_registration, '100-9', 'BEFORE: the proof reads the corrected catalog number (the bug)');
  console.log('[KI-195] BEFORE: proof shows the catalog\'s corrected 100-9 for a job sprayed under 100-1');

  docker(['cp', path.join(ROOT, 'supabase', 'migrations', CANDIDATE), `${NAME}:/tmp/candidate.sql`]);
  const applied = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.equal(applied.status, 0, `the candidate applies: ${out(applied)}`);
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0); assert.match(out(again), /JOB_PROOF_KEPT_EPA_PREFLIGHT/, 'a second apply stops at the preflight');
  console.log('[KI-195] APPLY: commits; a second apply is refused by the preflight');

  const after = proof(USERS.admin, J_SPRAYED);
  const a = byName(after);
  assert.deepEqual([a['[PROVER] Corrected'].epa_registration, a['[PROVER] Corrected'].epa_kept, a['[PROVER] Corrected'].epa_not_recorded],
    ['100-1', true, false], 'a corrected catalog number keeps the kept 100-1');
  assert.deepEqual([a['[PROVER] NoNumber'].epa_registration, a['[PROVER] NoNumber'].epa_kept, a['[PROVER] NoNumber'].epa_not_recorded],
    [null, true, false], 'a product kept with no number stays kept-unknown, never the catalog\'s new 200-2');
  const scoped = byName(proof(USERS.admin, J_SPRAYED, CUST));
  assert.equal(scoped['[PROVER] Corrected'].epa_registration, '100-1', 'the per-recipient call gives the same kept number');
  const old = byName(proof(USERS.admin, J_BACKFILLED))['[PROVER] Backfilled'];
  assert.deepEqual([old.epa_registration, old.epa_kept, old.epa_not_recorded], [null, true, true],
    'a backfilled job is Not recorded, never the catalog\'s 300-9');
  const repView = byName(proof(USERS.rep, J_SPRAYED))['[PROVER] Corrected'];
  assert.equal(repView.epa_registration, '100-1', 'a sales rep gets the same answer');
  console.log('[KI-195] AFTER: kept 100-1; kept no-number; backfilled Not recorded; same per recipient and for a rep');

  // The proof needs a completed job; the open job is read by the printouts only. Its data and lock state:
  assert.deepEqual(keptRows(USERS.admin, J_OPEN), [], 'an unsprayed job has no kept rows, so printouts read the catalog');
  const openProof = byName(proof(USERS.admin, J_OPEN))['[PROVER] Corrected'];
  assert.deepEqual([openProof.epa_registration, openProof.epa_kept], ['100-9', false], 'unlocked: the catalog number');
  psql(`SET session_replication_role = replica; UPDATE public.products SET epa_registration = ' 100-9\t' WHERE id = '${P_CORR}';`);
  assert.equal(byName(proof(USERS.admin, J_OPEN))['[PROVER] Corrected'].epa_registration, '100-9', 'the catalog number is normalized');

  const denied = run(as(USERS.applicator, `SELECT public.get_job_proof_data(p_job_id => '${J_SPRAYED}');`));
  assert.match(out(denied), /INSUFFICIENT_ROLE/, 'an applicator is refused the proof');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'get_job_proof_data';`), '1');
  assert.equal(scalar(`SELECT has_function_privilege('anon', 'public.get_job_proof_data(uuid,uuid)', 'EXECUTE');`), 'f');
  assert.equal(scalar(`SELECT prosecdef FROM pg_proc WHERE proname = 'get_job_proof_data';`), 't');
  for (const who of ['applicator', 'rep']) {
    assert.deepEqual(keptRows(USERS[who], J_SPRAYED).map((r) => r.epa_registration).sort(), ['100-1', null].sort(),
      `the job's ${who} reads the kept rows the printouts use`);
    assert.deepEqual(keptRows(USERS[who], J_BACKFILLED).map((r) => r.not_recorded), [true]);
  }
  // Past the applicator's 7-day window the job and its kept rows vanish together, so applyKeptEpa's job check
  // refuses the print ("can no longer be opened") instead of reading "no kept rows" and printing the catalog.
  psql(`SET session_replication_role = replica; UPDATE public.jobs SET completed_at = now() - interval '8 days' WHERE id = '${J_SPRAYED}';`);
  assert.equal(scalar(as(USERS.applicator, `SELECT count(*) FROM public.jobs WHERE id = '${J_SPRAYED}';`)), '0');
  assert.deepEqual(keptRows(USERS.applicator, J_SPRAYED), [], 'access ends for the job and its kept rows together');
  assert.equal(keptRows(USERS.rep, J_SPRAYED).length, 2, 'the office still reads them');
  console.log('[KI-195] ACCESS: applicator refused the proof; one overload, no anon; printout read works under RLS; ends with the job');

  if (process.env.KI195_PROOF_OUT) {
    writeFileSync(process.env.KI195_PROOF_OUT, JSON.stringify({
      proof: { sprayed: after, backfilled: proof(USERS.admin, J_BACKFILLED), open: proof(USERS.admin, J_OPEN) },
      kept: { sprayed: keptRows(USERS.applicator, J_SPRAYED), backfilled: keptRows(USERS.applicator, J_BACKFILLED), open: [] },
      ids: { P_CORR, P_NONE, P_OLD },
    }, null, 2));
  }
  console.log('KI195_KEPT_EPA_PROOF_PASS');
} finally {
  removeContainer();
}
