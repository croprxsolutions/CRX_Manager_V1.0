#!/usr/bin/env node
/**
 * Real-schema proof for 20270309040000_job_draw_bumps_booking_version (audit 2026-11-26 on #2318 / KI-190).
 * Builds the production baseline plus every replayable migration before the candidate (Docker; the image may be
 * pulled once; no network), then runs each case before the candidate, after it, and after the rollback text
 * (scripts/smoke/job-draw-bumps-booking-version-reverse.sql). Every case uses the real RPCs on separate
 * connections: a rep with Partial Order open on a booking of 100 (Field A 60 + Field B 40, booked at $10.00,
 * today's price $12.00), and an admin scheduling or cancelling a spray job meanwhile.
 *   schedule  the admin's create_job_from_quote_section for Field A (60) is in flight, holding the booking; the
 *             rep's Partial Order for 150, extra at today's price, at the version the screen loaded, waits on it.
 *             Before: it goes through as 40 booked + 110 at today's price (the rep saw 100 + 50). After: refused
 *             QUOTE_STALE_WRITE, nothing ordered.
 *   cancel    the Field A job (60) is scheduled; the rep opens Partial Order (40 left) and asks for 50 with the
 *             extra at today's price (40 + 10); the admin cancels the job (edit_jobs). Before: 50 booked, no
 *             extra. After: refused.
 *   reload    after the refusal, the rep's reloaded screen orders the same 150: 40 booked + 110 extra (what it
 *             now shows), so the refusal only asks for a reload.
 *   no-op     a job sync that rebuilds the same draws (a job chemical saved unchanged) does not move the version.
 *
 * Run: node scripts/smoke/prove-job-draw-bumps-booking-version-real-schema.mjs   (needs Docker)
 * Prints JOB_DRAW_BOOKING_VERSION_PROOF_PASS on success. CRX_PROVER_REUSE=1 with UNDO_PATHS_CONTAINER=<a kept
 * container built without the candidate> skips the build (and keeps the container).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const REUSE = process.env.CRX_PROVER_REUSE === '1';
process.env.UNDO_PATHS_CONTAINER ||= `crx-jdv-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, claims, USERS, NAME, docker, ROOT } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270309040000_job_draw_bumps_booking_version.sql';
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'job-draw-bumps-booking-version-reverse.sql');
const OLD_SYNC_MD5 = '2e62bad29abc2ba33cb0e2f06a2d4a64';
const { admin: ADMIN, rep: REP } = USERS;
const STALE = /QUOTE_STALE_WRITE: this booking changed since you opened it/;
const RUN = Date.now().toString(36);  // unique names when a kept container is reused
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const syncMd5 = () => scalar(`SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc
  WHERE oid = 'public._sync_quote_job_reservations(uuid,uuid)'::regprocedure;`);

function applyFile(file) {
  docker(['cp', file, `${NAME}:/tmp/jdv-apply-${RUN}.sql`]);
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-1', '-f', `/tmp/jdv-apply-${RUN}.sql`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

/** One connection kept open: statements run as they are sent; ON_ERROR_STOP ends it on the first error. */
function session(app) {
  const child = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t',
    '-v', 'ON_ERROR_STOP=1'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.stdin.on('error', () => {});
  app = `${app}-${RUN}`;
  const s = { app, closed: false, marks: 0, output: () => out };
  const done = new Promise((resolve) => child.on('close', (status) => { s.closed = true; resolve({ status, out }); }));
  child.stdin.write(`SET application_name = '${app}';\n`);
  return Object.assign(s, {
    // Each batch ends with a marker row, so "its statements ran" is read from the output, not from timing.
    send(sql) { s.marks += 1; child.stdin.write(`${sql}\nSELECT 'JDVMARK${s.marks}';\n`); },
    end(sql = '') { child.stdin.end(`${sql}\n`); return done; },
    done,
  });
}
/** 'idle' (its statements ran; the transaction stays open), 'lock' (waiting on a lock), or 'gone' (ended). */
async function settle(s) {
  for (let i = 0; i < 300; i += 1) {
    if (s.output().includes(`JDVMARK${s.marks}`)) return 'idle';
    if (s.closed) return 'gone';
    const wait = scalar(`SELECT COALESCE(wait_event_type, '') FROM pg_stat_activity
      WHERE application_name = '${s.app}' UNION ALL SELECT '' LIMIT 1;`);
    if (wait === 'Lock') return 'lock';
    await pause(100);
  }
  throw new Error(`${s.app} neither finished nor waited`);
}
// Signed in through PostgREST's role, as the screens call these RPCs.
const as = (uid) => `BEGIN; ${claims(uid)} SET LOCAL ROLE authenticated;`;

let product;
function seedProduct() {
  product = randomUUID();
  // Pricing writes go through a governed change set; this disposable container seeds one product directly.
  psql(`BEGIN; ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, inventory_unit, product_form)
      VALUES ('${product}', '[JDV] Herbicide', 'gal', 3.00, 12.00, 'Gal', 'liquid');
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing; COMMIT;`);
}

/** A sent crop-plan booking the rep made: Field A 60 + Field B 40 gal at $10.00. */
function booking(tag) {
  const ids = { q: randomUUID(), c: randomUUID(), a: randomUUID(), b: randomUUID() };
  psql(`BEGIN; ${claims(ADMIN)}
    INSERT INTO public.customers (id, farm_name) VALUES ('${ids.c}', '[JDV ${tag}] Farm');
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, salesman_id, status, is_planned, commission_split, expires_at)
      VALUES ('${ids.q}', 'QJDV-${tag}', '${ids.c}', '${REP}', '${REP}', 'sent', true, '{"splits": []}'::jsonb, CURRENT_DATE + 60);
    INSERT INTO public.quote_versions (quote_id, sent_by, snapshot_data) VALUES ('${ids.q}', '${REP}', '{}'::jsonb);
    INSERT INTO public.quote_sections (id, quote_id, section_name, sort_order) VALUES
      ('${ids.a}', '${ids.q}', 'Field A', 0), ('${ids.b}', '${ids.q}', 'Field B', 1);
    INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, current_cost, total_units_needed, unit_size)
      VALUES ('${ids.q}', '${ids.a}', '${product}', 0, 10.00, 3.00, 60, 'gal'),
             ('${ids.q}', '${ids.b}', '${product}', 0, 10.00, 3.00, 40, 'gal');
    COMMIT;`);
  return ids;
}
const version = (q) => scalar(`SELECT row_version FROM public.quotes WHERE id = '${q}';`);
const schedule = (ids, key) => `SELECT public.create_job_from_quote_section('${ids.q}', '${ids.a}', '${ADMIN}', '${key}');`;
const partialOrder = (ids, qty, v, key) => `SELECT public.draw_down_quote('${ids.q}',
  '[{"product_id": "${product}", "quantity": ${qty}, "extra_price": "today"}]'::jsonb, '${REP}', '${key}', NULL, ${v});`;
/** What the rep's order became: booked units drawn and extra units at today's price, or the refusal. */
function outcome(ids, out, status = 0) {
  if (STALE.test(out)) return { result: 'QUOTE_STALE_WRITE', orders: scalar(`SELECT count(*) FROM public.orders WHERE quote_id = '${ids.q}';`) };
  const json = JSON.parse(out.split(/\r?\n/).find((l) => l.startsWith('{')) ?? 'null');
  assert.ok(json, `the Partial Order neither went through nor was refused:\n${out}`);
  assert.equal(status, 0, `the Partial Order's transaction did not commit:\n${out}`);
  assert.ok(Number(scalar(`SELECT count(*) FROM public.orders WHERE id = '${json.order_id}';`)) === 1, 'its order was not committed');
  return {
    result: 'ordered',
    booked: Number(json.lines?.[0]?.drawn ?? 0),
    extra: Number(json.extra_lines?.[0]?.quantity ?? 0),
    extraPrice: json.extra_lines?.[0]?.price_per_unit ?? null,
  };
}

async function scheduleRace(phase) {
  const ids = booking(`${phase}-${RUN}-s`);
  const seen = version(ids.q);  // the rep's Partial Order dialog loads the booking: 100 left
  const job = session(`jdv-job-${phase}`);
  job.send(`${as(ADMIN)} ${schedule(ids, `jdv-${phase}-${RUN}-job`)}`);
  assert.equal(await settle(job), 'idle', `${phase}: scheduling the job did not run:\n${job.output()}`);
  const rep = session(`jdv-rep-${phase}`);
  rep.send(`${as(REP)} ${partialOrder(ids, 150, seen, `jdv-${phase}-${RUN}-draw`)}`);
  const waited = await settle(rep);
  const blockedByJob = scalar(`SELECT count(*) FROM pg_stat_activity r JOIN pg_stat_activity j ON j.pid = ANY (pg_blocking_pids(r.pid))
    WHERE r.application_name = '${rep.app}' AND j.application_name = '${job.app}';`) === '1';
  await job.end('COMMIT;');
  const done = await rep.end('COMMIT;');
  return { waited, blockedByJob, seen, ...outcome(ids, done.out, done.status), ids,
    jobDrawn: scalar(`SELECT COALESCE(sum(quantity_drawn), 0) FROM public.job_product_draws WHERE quote_id = '${ids.q}';`) };
}
async function cancelGap(phase) {
  const ids = booking(`${phase}-${RUN}-c`);
  const made = psql(`${as(ADMIN)} ${schedule(ids, `jdv-${phase}-${RUN}-cjob`)} COMMIT;`);
  assert.equal(made.status, 0, made.stderr);
  const jobId = scalar(`SELECT id FROM public.jobs WHERE quote_id = '${ids.q}';`);
  const seen = version(ids.q);  // Partial Order opens: 40 left
  const cancel = session(`jdv-cancel-${phase}`);
  cancel.send(`${as(ADMIN)} SELECT public.edit_jobs(ARRAY['${jobId}']::uuid[], NULL, 'cancel', '${ADMIN}', 'jdv-${phase}-${RUN}-cancel');`);
  assert.equal(await settle(cancel), 'idle', `${phase}: cancelling the job did not run:\n${cancel.output()}`);
  await cancel.end('COMMIT;');
  const rep = session(`jdv-crep-${phase}`);
  rep.send(`${as(REP)} ${partialOrder(ids, 50, seen, `jdv-${phase}-${RUN}-cdraw`)}`);
  await settle(rep);
  const done = await rep.end('COMMIT;');
  return { seen, ...outcome(ids, done.out, done.status),
    jobStatus: scalar(`SELECT status FROM public.jobs WHERE id = '${jobId}';`) };
}
/** A sync that rebuilds the same draws: a job chemical saved with the same quantity (the job_chemicals trigger re-syncs). */
function noOpSync(phase) {
  const ids = booking(`${phase}-${RUN}-n`);
  const made = psql(`${as(ADMIN)} ${schedule(ids, `jdv-${phase}-${RUN}-njob`)} COMMIT;`);
  assert.equal(made.status, 0, made.stderr);
  const v0 = version(ids.q);
  const hold = () => scalar(`SELECT string_agg(h.id::text, ',') FROM public.inventory_holds h JOIN public.jobs j ON j.id = h.source_id
    WHERE j.quote_id = '${ids.q}' AND h.hold_type = 'job';`);
  const hold0 = hold();
  const touched = psql(`BEGIN; ${claims(ADMIN)} UPDATE public.job_chemicals SET quantity = quantity
    WHERE job_id = (SELECT id FROM public.jobs WHERE quote_id = '${ids.q}'); COMMIT;`);
  assert.equal(touched.status, 0, touched.stderr);
  return { moved: version(ids.q) !== v0, resynced: hold0 !== '' && hold() !== hold0,
    jobDrawn: scalar(`SELECT COALESCE(sum(quantity_drawn), 0) FROM public.job_product_draws WHERE quote_id = '${ids.q}';`) };
}

async function runAll(phase) {
  return { schedule: await scheduleRace(phase), cancel: await cancelGap(phase), noop: noOpSync(phase) };
}
function assertBroken(r, when) {
  // The rep saw 100 left and asked for 150 (100 booked + 50 at today's price); a 60 job took 60 meanwhile.
  assert.deepEqual([r.schedule.waited, r.schedule.blockedByJob], ['lock', true], `${when}: the Partial Order should wait for the job being scheduled`);
  assert.equal(r.schedule.jobDrawn, '60.00');
  assert.deepEqual([r.schedule.result, r.schedule.booked, r.schedule.extra], ['ordered', 40, 110],
    `${when}: the stale split should reproduce (40 booked + 110 at today's price)`);
  assert.equal(Number(r.schedule.extraPrice), 12, `${when}: the extra should be at today's price`);
  // The rep saw 40 left and asked for 50 (40 + 10 extra); the job was cancelled meanwhile.
  assert.equal(r.cancel.jobStatus, 'cancelled');
  assert.deepEqual([r.cancel.result, r.cancel.booked, r.cancel.extra], ['ordered', 50, 0],
    `${when}: the cancel direction should reproduce (50 booked, no extra)`);
}

try {
  if (!REUSE) { buildContainer({ stopBefore: CANDIDATE }); seedUsers(); }
  assert.equal(syncMd5(), OLD_SYNC_MD5, 'the database must start without the candidate');
  seedProduct();

  const before = await runAll('before');
  assertBroken(before, 'BEFORE');
  console.log(`[jdv] BEFORE schedule: rep saw v${before.schedule.seen}, 100 left, asked 150 with extra at today's price; a 60 job was scheduled meanwhile; the order went through as ${before.schedule.booked} booked + ${before.schedule.extra} at $${before.schedule.extraPrice}`);
  console.log(`[jdv] BEFORE cancel: rep saw 40 left, asked 50 (40 + 10 extra); the job was cancelled meanwhile; the order went through as ${before.cancel.booked} booked + ${before.cancel.extra} extra`);
  console.log(`[jdv] BEFORE no-op sync: version moved = ${before.noop.moved}`);
  assert.deepEqual([before.noop.moved, before.noop.resynced], [false, true]);

  const applied = applyFile(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
  assert.equal(applied.status, 0, applied.output);
  const again = applyFile(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
  assert.notEqual(again.status, 0);
  assert.match(again.output, /JOB_DRAW_VERSION_PREFLIGHT/);
  console.log('[jdv] candidate applied; a second apply is refused by its preflight');

  const after = await runAll('after');
  assert.deepEqual([after.schedule.waited, after.schedule.blockedByJob], ['lock', true], 'AFTER: the Partial Order should still wait for the job being scheduled');
  assert.equal(after.schedule.jobDrawn, '60.00');
  assert.deepEqual([after.schedule.result, after.schedule.orders], ['QUOTE_STALE_WRITE', '0'],
    'AFTER schedule: the stale Partial Order must be refused with nothing ordered');
  assert.deepEqual([after.cancel.result, after.cancel.orders, after.cancel.jobStatus], ['QUOTE_STALE_WRITE', '0', 'cancelled'],
    'AFTER cancel: the stale Partial Order must be refused with nothing ordered');
  assert.deepEqual([after.noop.moved, after.noop.resynced], [false, true], 'AFTER: a sync that rebuilds the same draws must not move the version');
  assert.equal(after.noop.jobDrawn, '60.00');
  console.log('[jdv] AFTER schedule: the Partial Order waited for the job, then was refused QUOTE_STALE_WRITE; no order');
  console.log('[jdv] AFTER cancel: refused QUOTE_STALE_WRITE; no order');
  console.log('[jdv] AFTER no-op sync: the version did not move');
  // The reload: the screen reads the booking again (60 drawn by the job, 40 left) and the same request now
  // orders what it shows.
  const ids = after.schedule.ids;
  const reload = psql(`${as(REP)} ${partialOrder(ids, 150, version(ids.q), `jdv-after-${RUN}-reload`)} COMMIT;`, { allowFailure: true });
  assert.equal(reload.status, 0, reload.stderr);
  const reloaded = outcome(ids, reload.stdout);
  assert.deepEqual([reloaded.result, reloaded.booked, reloaded.extra, Number(reloaded.extraPrice)], ['ordered', 40, 110, 12]);
  console.log(`[jdv] AFTER reload: the same 150 from the reloaded screen orders ${reloaded.booked} booked + ${reloaded.extra} at $${reloaded.extraPrice}`);

  const reversed = applyFile(REVERSE);
  assert.equal(reversed.status, 0, reversed.output);
  assert.equal(syncMd5(), OLD_SYNC_MD5);
  assert.equal(scalar(`SELECT array_to_string(proacl, ',') FROM pg_proc WHERE oid = 'public._sync_quote_job_reservations(uuid,uuid)'::regprocedure;`),
    'postgres=X/postgres,service_role=X/postgres');
  assertBroken(await runAll('rollback'), 'ROLLBACK');
  console.log('[jdv] ROLLBACK: the 20261107070000 body and grants are back; both stale splits reproduce again');
  console.log('JOB_DRAW_BOOKING_VERSION_PROOF_PASS');
} finally {
  // A failed run must not leave its sessions holding locks in a kept container.
  try { psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE 'jdv-%-${RUN}';`, { allowFailure: true }); } catch { /* container gone */ }
  if (!REUSE) removeContainer();
}
