#!/usr/bin/env node
/**
 * Real-schema proof for 20270307120000_booking_close_guard_applied_and_short.sql (release #1990 known issues:
 * Sol r54 HIGH 2 and #2065).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Fixture: rep A's planned, sent booking with a
 * scheduled spray job, and rep A's booking with no job.
 *   1. BEFORE: the gaps are real, as signed-in users under the row policies: rep A closes the booking as applied with
 *      its job scheduled, and rep B closes rep A's booking short or as applied. smoke-booking-close-guard.sql fails
 *      at C1.
 *   2. The candidate: an autocommit apply is refused; an apply over a booking already closed as applied with a live
 *      job is refused by the postflight; the apply succeeds; a second apply is refused by the preflight.
 *   3. AFTER: the same calls are refused (BOOKING_HAS_JOB, BOOKING_NOT_YOURS); a direct close as applied at
 *      REPEATABLE READ is refused (BOOKING_NEEDS_READ_COMMITTED) and at READ COMMITTED goes through;
 *      smoke-booking-close-guard.sql and smoke-booking-guard-rep-and-delete.sql pass; two older chains that stop on this
 *      fixture (live-job guard, replay binding batch 2) end exactly as before.
 *   4. ROLLBACK: booking-close-guard-reverse.sql restores the 20270129150000 body and both gaps come back.
 *
 * Run: node scripts/smoke/prove-booking-close-guard-real-schema.mjs   (needs Docker; never touches live)
 * Prints BOOKING_CLOSE_GUARD_PROOF_PASS on success. KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, psql, scalar, claims, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270307120000_booking_close_guard_applied_and_short.sql';
const OLD_MD5 = '9beb84454834da47d80e2c2a05a8a25d';
const NEW_MD5 = 'c95e156c09d9b8258ce4b5d92520abb3';
const text = (file) => readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n');
const candidate = text(`supabase/migrations/${CANDIDATE}`);
const reverse = text('scripts/smoke/booking-close-guard-reverse.sql');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, flags = []) => { const r = docker([...PSQL, ...flags], { input: sql, allowFailure: true }); return { status: r.status, out: `${r.stdout}\n${r.stderr}` }; };
const bodyMd5 = () => scalar("SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._enforce_booking_live_job_rules()'::regprocedure;");
const smoke = (file) => run(text(`scripts/smoke/${file}`)).out;

const REP_A = USERS.rep;
const REP_B = id('a5');
const ADMIN_2 = id('a6'); // smoke-stock-replay-binding-batch2.sql needs two active admins
const ADMIN = USERS.admin;
const CUSTOMER = id('b1');
const Q_JOB = id('c1'); // rep A's planned booking with a scheduled job
const Q_FREE = id('c2'); // rep A's booking with no job
const S_JOB = id('d1');
const JOB = id('e1');
let key = 0;
const closeApplied = (q, uid) => refuse(`r := public.close_quote_as_applied('${q}', '${uid}', 'bcg-prover-${(key += 1)}');`);
const closeShort = (q, uid) => refuse(`r := public.close_quote_as_short('${q}', '${uid}', 'bcg-prover-${(key += 1)}');`);
const probe = (uid, call) => attempt(uid, `${call} v := t;`);
/** A direct close as applied by rep A at the given isolation level; returns the error text, or 'ok'. */
const directApplied = (level) => {
  const r = run(`BEGIN ISOLATION LEVEL ${level};
${claims(REP_A)}
SET LOCAL ROLE authenticated;
UPDATE public.quotes SET status = 'closed_by_application' WHERE id = '${Q_FREE}';
ROLLBACK;`);
  return r.status === 0 ? 'ok' : r.out.trim();
};

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${REP_B}', 'bcg-repb@example.invalid', '{"full_name":"[PROVER] Rep B","role":"sales_rep"}'::jsonb),
      ('${ADMIN_2}', 'bcg-admin2@example.invalid', '{"full_name":"[PROVER] Admin 2","role":"admin"}'::jsonb);
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id IN ('${REP_A}', '${REP_B}');
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id IN ('${ADMIN}', '${ADMIN_2}');
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUSTOMER}', '[PROVER] BCG Farm');
    INSERT INTO public.quotes (id, quote_number, customer_id, status, tier, created_by, is_planned) VALUES
      ('${Q_JOB}', '[PROVER] BCG-JOB', '${CUSTOMER}', 'draft', 1, '${REP_A}', true),
      ('${Q_FREE}', '[PROVER] BCG-FREE', '${CUSTOMER}', 'draft', 1, '${REP_A}', true);
    INSERT INTO public.quote_sections (id, quote_id, section_name, sort_order) VALUES ('${S_JOB}', '${Q_JOB}', 'North', 0);
    INSERT INTO public.quote_versions (quote_id, sent_by, snapshot_data) VALUES ('${Q_JOB}', '${ADMIN}', '{}'), ('${Q_FREE}', '${ADMIN}', '{}');
    UPDATE public.quotes SET status = 'sent' WHERE id IN ('${Q_JOB}', '${Q_FREE}');
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, quote_id, quote_section_id)
      VALUES ('${JOB}', 'PRV-BCG-1', '${CUSTOMER}', (now() AT TIME ZONE 'America/Chicago')::date + 7, '${Q_JOB}', '${S_JOB}');`);
  assert.equal(scalar(`SELECT string_agg(status, ',' ORDER BY quote_number) FROM public.quotes WHERE id IN ('${Q_JOB}', '${Q_FREE}');`), 'sent,sent');
  assert.equal(scalar(`SELECT status FROM public.jobs WHERE id = '${JOB}';`), 'scheduled');
  assert.equal(bodyMd5(), OLD_MD5, 'the replayed guard is not the 20270129150000 body');

  // 1. BEFORE: both gaps are real.
  const gaps = (label) => {
    assert.equal(probe(REP_A, closeApplied(Q_JOB, REP_A)), 'ok|NOT REFUSED', `${label}: rep A closes as applied with a scheduled job`);
    assert.equal(probe(REP_B, closeShort(Q_FREE, REP_B)), 'ok|NOT REFUSED', `${label}: rep B closes rep A's booking short`);
    assert.equal(probe(REP_B, closeApplied(Q_FREE, REP_B)), 'ok|NOT REFUSED', `${label}: rep B closes rep A's booking as applied`);
    assert.match(smoke('smoke-booking-close-guard.sql'), /SMOKE_FAIL: \(C1\)/, `${label}: the new chain must fail at C1`);
    assert.equal(directApplied('REPEATABLE READ'), 'ok', `${label}: a close as applied at REPEATABLE READ goes through`);
  };
  gaps('before');
  // Two older chains do not pass on this fixture: smoke-booking-live-job-guard.sql stops at its draw_down_quote call
  // (QUOTE_STALE_WRITE: the chain predates draw_down's version check), and smoke-stock-replay-binding-batch2.sql needs
  // its own prover's priced products. Each must end exactly the same way after the candidate.
  const SAME = ['smoke-booking-live-job-guard.sql', 'smoke-stock-replay-binding-batch2.sql'];
  const before = Object.fromEntries(SAME.map((chain) => [chain, smoke(chain)]));
  console.log('[before] rep A closed a booking as applied with its job scheduled; rep B closed rep A\'s booking short and as applied; the new chain fails at C1');

  // 2. The candidate.
  let r = run(candidate);
  assert.notEqual(r.status, 0, 'an autocommit apply must be refused');
  assert.match(r.out, /LOCK TABLE can only be used in transaction blocks/);
  assert.equal(bodyMd5(), OLD_MD5, 'the refused autocommit apply changed the guard');
  r = run(`BEGIN;
UPDATE public.quotes SET status = 'closed_by_application' WHERE id = '${Q_JOB}';
${candidate}
ROLLBACK;`);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /POSTFLIGHT_APPLIED_BOOKING_LIVE_JOB/, 'a booking already closed as applied with a live job must stop the apply');
  r = run(candidate, ['-1']);
  assert.equal(r.status, 0, `the candidate must apply:\n${r.out}`);
  assert.equal(bodyMd5(), NEW_MD5);
  r = run(candidate, ['-1']);
  assert.match(r.out, /PREFLIGHT_BOOKING_CLOSE_GUARD_DRIFT/, 'a second apply must be refused');
  assert.equal(bodyMd5(), NEW_MD5);
  console.log('[apply] autocommit refused; postflight refused an applied booking with a live job; applied once; re-apply refused');

  // 3. AFTER.
  assert.match(probe(REP_A, closeApplied(Q_JOB, REP_A)),
    /^ok\|BOOKING_HAS_JOB: spray job PRV-BCG-1 was made from this booking, so the booking cannot be closed as applied\. Cancel or complete the job first\.$/);
  assert.match(probe(ADMIN, closeApplied(Q_JOB, ADMIN)), /^ok\|BOOKING_HAS_JOB: spray job PRV-BCG-1 /, 'an admin too');
  assert.equal(probe(REP_B, closeShort(Q_FREE, REP_B)),
    "ok|BOOKING_NOT_YOURS: booking [PROVER] BCG-FREE is another rep's, so only that rep or an admin can close it short.");
  assert.equal(probe(REP_B, closeApplied(Q_FREE, REP_B)),
    "ok|BOOKING_NOT_YOURS: booking [PROVER] BCG-FREE is another rep's, so only that rep or an admin can close it as applied.");
  assert.equal(probe(REP_A, closeShort(Q_FREE, REP_A)), 'ok|NOT REFUSED', 'rep A closes their own booking short');
  assert.equal(probe(ADMIN, closeShort(Q_FREE, ADMIN)), 'ok|NOT REFUSED', 'an admin closes it short');
  assert.equal(probe(REP_A, closeApplied(Q_FREE, REP_A)), 'ok|NOT REFUSED', 'a booking with no job closes as applied');
  assert.match(directApplied('REPEATABLE READ'), /BOOKING_NEEDS_READ_COMMITTED/);
  assert.match(directApplied('SERIALIZABLE'), /BOOKING_NEEDS_READ_COMMITTED/);
  assert.equal(directApplied('READ COMMITTED'), 'ok');
  assert.equal(scalar(`SELECT string_agg(status, ',' ORDER BY quote_number) FROM public.quotes WHERE id IN ('${Q_JOB}', '${Q_FREE}');`), 'sent,sent', 'every probe rolled back');
  const chains = ['smoke-booking-close-guard.sql', 'smoke-booking-guard-rep-and-delete.sql'];
  for (const chain of chains) assert.match(smoke(chain), /SMOKE_PASS_ROLLBACK/, `${chain} must pass after the candidate`);
  for (const chain of SAME) assert.equal(smoke(chain), before[chain], `${chain} must end exactly as before`);
  console.log('[after] close as applied refused with a live job (rep and admin); rep B refused closing short and as applied; owner/admin/no-job closes go through; REPEATABLE READ and SERIALIZABLE refused');
  console.log(`[after] ${chains.join(', ')} pass; ${SAME.map((c) => `${c} ends exactly as before (${(/ERROR:\s+([A-Z_]+)/.exec(before[c]) ?? ['', 'pass'])[1]})`).join('; ')}`);

  // 4. ROLLBACK text: both gaps come back.
  r = run(reverse, ['-1']);
  assert.equal(r.status, 0, `the rollback text must apply:\n${r.out}`);
  assert.equal(bodyMd5(), OLD_MD5);
  gaps('rollback');
  console.log('[rollback] the 20270129150000 body is back and both gaps reproduce');

  console.log('\nBOOKING_CLOSE_GUARD_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
