#!/usr/bin/env node
/**
 * Real-schema proof for the KI-25 receipt screens (W2-06) on TODAY's chain: the baseline plus every migration.
 * It calls close_delivery_receipt with the exact named arguments src/lib/receiptsToCheck.ts sends, as an office
 * user, and reads "Customer receipts to check" with the screen's own filter under RLS. Shown:
 *  - Mark handled: a needs_check receipt leaves the list and the server worker never claims it;
 *  - Email Confirmation: 'manual_send' pauses an owed receipt (it stays listed, the worker skips it), then 'handled'
 *    takes it off the list once the hand send went out;
 *  - a sent receipt answers 'sent' with sent_at, so the screen asks before a second copy;
 *  - every key the screen reads is in the answer; a driver is refused;
 *  - #2251 (20270223120000): a close that names the receipt it saw (p_expected_queued_at) acts on no other: a receipt
 *    re-queued by _enqueue_delivery_receipt (before the close, or while the close waits on its row lock) is refused
 *    with DELIVERY_RECEIPT_CHANGED and left owed; a row that is not replaced keeps its generation; the expected value
 *    is matched to the microsecond whatever offset it is written in; a key saved without it still replays.
 *
 * Run: node scripts/smoke/prove-ki25-receipt-screens-real-schema.mjs   (needs Docker)
 * Prints KI25_RECEIPT_SCREENS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';

process.env.UNDO_PATHS_CONTAINER ||= `crx-ki25-screens-${process.pid}-${Date.now().toString(36)}`;
import { readFileSync } from 'node:fs';
const { buildContainer, removeContainer, seedUsers, psql, scalar, USERS, id, NAME, docker } = await import('./undo-paths/harness.mjs');

const CUST = id('c1'); const ORDER = id('c2');
const D = (n) => id(`d${n}`);
const HOUR_AGO = "now() - interval '2 hours'";

// The screen's filter (receiptsToCheckFilter) in SQL: needs_check, or owed/sending for over an hour.
const LISTED = `(status = 'needs_check' OR (status IN ('pending','sending') AND created_at < now() - interval '1 hour'))`;
const asOffice = (uid, sql) => `BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated; ${sql} COMMIT;`;
// Exactly what closeDeliveryReceipt() sends.
const close = (uid, delivery, reason, key) => scalar(asOffice(uid,
  `SELECT public.close_delivery_receipt(p_delivery_id => '${delivery}', p_reason => '${reason}', p_idempotency_key => '${key}')::text;`));
// What closeDeliveryReceipt() sends with the receipt the screen saw (#2251).
const closeAt = (uid, delivery, reason, key, queuedAt) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: asOffice(uid,
  `SELECT public.close_delivery_receipt(p_delivery_id => '${delivery}', p_reason => '${reason}', p_idempotency_key => '${key}', p_expected_queued_at => '${queuedAt}')::text;`),
  allowFailure: true });
const out = (r) => `${r.stdout}${r.stderr}`;
// created_at exactly as PostgREST hands it to the screen (JSON text, microseconds).
const queuedAt = (delivery) => scalar(`SELECT to_json(created_at) #>> '{}' FROM public.delivery_receipt_queue WHERE delivery_id = '${delivery}';`);
const listed = (uid) => scalar(asOffice(uid,
  `SELECT coalesce(string_agg(delivery_id::text, ',' ORDER BY delivery_id), 'none') FROM public.delivery_receipt_queue WHERE ${LISTED};`));
const status = (delivery) => scalar(`SELECT status FROM public.delivery_receipt_queue WHERE delivery_id = '${delivery}';`);
// The server worker's claim (service_role), as send-delivery-receipts calls it.
const runWorkerClaim = () => psql(`BEGIN; SET LOCAL ROLE service_role;
  SELECT public.claim_delivery_receipts(50, 'ki25-screens-claim-' || gen_random_uuid()); COMMIT;`);

try {
  buildContainer();
  seedUsers();
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active, email, contact_name)
      VALUES ('${CUST}', '[PROVER] KI25 Screens Farm', true, 'ki25-screens@example.invalid', 'Pat Prover');
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${ORDER}', 'PROVER-KI25S', '${CUST}', current_date, 'fulfilled', false, '${USERS.admin}');
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, completed_at, signed_by) VALUES
      ('${D(1)}', 'PROVER-KI25S-1', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat'),
      ('${D(2)}', 'PROVER-KI25S-2', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat'),
      ('${D(3)}', 'PROVER-KI25S-3', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat'),
      ('${D(4)}', 'PROVER-KI25S-4', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat');
    INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, requested_by, status, last_error, receipt, created_at, next_attempt_at, sent_at, sent_to) VALUES
      ('${D(1)}', '${CUST}', '${USERS.admin}', 'needs_check', 'provider said no', '{"lines":[]}', ${HOUR_AGO}, now(), NULL, NULL),
      ('${D(2)}', '${CUST}', '${USERS.admin}', 'pending', NULL, '{"lines":[]}', ${HOUR_AGO}, now(), NULL, NULL),
      ('${D(3)}', '${CUST}', '${USERS.admin}', 'sent', NULL, '{"lines":[]}', ${HOUR_AGO}, now(), now(), 'ki25-screens@example.invalid'),
      ('${D(4)}', '${CUST}', '${USERS.admin}', 'pending', NULL, '{"lines":[]}', now(), now(), NULL, NULL);`);

  assert.equal(listed(USERS.rep), [D(1), D(2)].sort().join(','), 'the sales rep sees the needs_check and the over-an-hour owed receipt');

  // A driver cannot close a receipt.
  const driver = psql(asOffice(USERS.driver, `SELECT public.close_delivery_receipt(p_delivery_id => '${D(1)}', p_reason => 'handled', p_idempotency_key => 'ki25s-drv');`), { allowFailure: true });
  assert.match(`${driver.stdout}${driver.stderr}`, /INSUFFICIENT_ROLE/, 'a driver is refused');
  assert.equal(status(D(1)), 'needs_check');

  // Mark handled is admin-only (Mason, 2026-11-23): a sales rep is refused on a listed receipt and on one the server
  // has not tried to send yet, and nothing changes or is saved.
  const savedKey = (key) => scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = '${key}';`);
  for (const [d, was] of [[D(1), 'needs_check'], [D(2), 'pending'], [D(4), 'pending']]) {
    const refused = psql(asOffice(USERS.rep, `SELECT public.close_delivery_receipt(p_delivery_id => '${d}', p_reason => 'handled', p_idempotency_key => 'ki25s-rep-${d}');`), { allowFailure: true });
    assert.match(`${refused.stdout}${refused.stderr}`, /RECEIPT_HANDLED_ADMIN_ONLY/, `a sales rep cannot mark a ${was} receipt handled`);
    assert.equal(status(d), was, 'the refused receipt is unchanged');
    assert.equal(savedKey(`ki25s-rep-${d}`), '0', 'a refused call saves nothing');
  }
  console.log('[admin-only] a sales rep is refused Mark handled (needs_check and never-tried receipts), nothing changed');

  // Mark handled (ReceiptsToCheck) by an admin: off the list, and the worker never claims it.
  const handled = JSON.parse(close(USERS.admin, D(1), 'handled', 'ki25s-handled-1'));
  for (const key of ['delivery_id', 'outcome', 'previous_status', 'sent_at', 'send_authorized_at']) assert.ok(key in handled, `answer has ${key}`);
  assert.equal(handled.outcome, 'closed');
  assert.equal(status(D(1)), 'cancelled');
  assert.equal(listed(USERS.rep), D(2), 'a handled receipt leaves the list');
  console.log('[KI-25] Mark handled: closed, off the list');

  // Email Confirmation (DeliveryDetail) by a sales rep: pause first; the worker then skips it and it stays listed
  // until handled. The hand send is unchanged: the same rep closes the receipt they paused.
  const paused = JSON.parse(close(USERS.rep, D(2), 'manual_send', 'ki25s-pause-2'));
  assert.equal(paused.outcome, 'paused');
  assert.equal(paused.sent_at, null); assert.equal(paused.send_authorized_at, null); // the screen goes straight to the send
  assert.equal(status(D(2)), 'needs_check');
  runWorkerClaim();
  assert.equal(status(D(4)), 'sending', 'control: the worker does claim an ordinary owed receipt');
  assert.equal(status(D(1)), 'cancelled', 'the worker never claims a handled receipt');
  assert.equal(status(D(2)), 'needs_check', 'the worker never claims a paused receipt');
  assert.equal(listed(USERS.admin), D(2), 'a paused receipt stays listed until the hand send is marked handled');
  assert.equal(JSON.parse(out(closeAt(USERS.rep, D(2), 'handled', 'ki25s-handled-2', paused.queued_at)).trim().split(/\r?\n/).at(-1)).outcome, 'closed',
    'the rep who paused it closes it after their hand send, as DeliveryDetail does');
  assert.equal(listed(USERS.admin), 'none', 'after the hand send it is off the list');
  console.log('[KI-25] Email Confirmation by a sales rep: paused, not claimed, then handled by that rep');

  // Already sent: the answer says so with sent_at, which opens "Receipt may already be sent".
  const sent = JSON.parse(close(USERS.admin, D(3), 'manual_send', 'ki25s-pause-3'));
  assert.equal(sent.outcome, 'sent'); assert.ok(sent.sent_at, 'sent_at is returned');
  assert.equal(status(D(3)), 'sent');
  console.log('[KI-25] Already sent: answer "sent" with sent_at, row unchanged');

  // #2251: the close names the receipt it saw.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, completed_at, signed_by) VALUES
      ('${D(5)}', 'PROVER-KI25S-5', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat'),
      ('${D(6)}', 'PROVER-KI25S-6', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat'),
      ('${D(7)}', 'PROVER-KI25S-7', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat');
    INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, requested_by, status, last_error, receipt, created_at, next_attempt_at) VALUES
      ('${D(5)}', '${CUST}', '${USERS.admin}', 'needs_check', 'provider said no', '{"lines":[]}', ${HOUR_AGO}, now()),
      ('${D(6)}', '${CUST}', '${USERS.admin}', 'needs_check', 'provider said no', '{"lines":[]}', ${HOUR_AGO}, now()),
      ('${D(7)}', '${CUST}', '${USERS.admin}', 'needs_check', 'provider said no', '{"lines":[]}', ${HOUR_AGO}, now());`);
  // The real re-queue writer a second completion calls.
  const requeue = (delivery) => `SELECT public._enqueue_delivery_receipt('${delivery}', '${USERS.admin}');`;
  const rowId = (delivery) => scalar(`SELECT id FROM public.delivery_receipt_queue WHERE delivery_id = '${delivery}';`);
  const savedKeys = (key) => scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = '${key}';`);

  // R1: the list showed receipt A; it was handled, and a new completion re-queued B on the same row before the click.
  const a5 = queuedAt(D(5)); const id5 = rowId(D(5));
  assert.match(a5, /\.\d{1,6}(?:[+-]|Z)/, 'the screen gets created_at with its fractional seconds (Postgres trims trailing zeros)');
  assert.equal(JSON.parse(close(USERS.admin, D(5), 'handled', 'ki25s-r1-a')).outcome, 'closed');
  psql(requeue(D(5)));
  const b5 = queuedAt(D(5));
  assert.equal(rowId(D(5)), id5, 'the re-queue reuses the same row');
  assert.notEqual(b5, a5, 'with a new generation');
  const statusB5 = status(D(5));
  assert.notEqual(statusB5, 'cancelled', 'B is owed');
  assert.match(out(closeAt(USERS.rep, D(5), 'handled', 'ki25s-r1-stale', a5)), /DELIVERY_RECEIPT_CHANGED/, 'a stale close is refused');
  assert.equal(status(D(5)), statusB5, 'the new receipt is left as it was');
  assert.equal(savedKeys('ki25s-r1-stale'), '0', 'a refused call saves nothing');
  assert.equal(JSON.parse(out(closeAt(USERS.admin, D(5), 'handled', 'ki25s-r1-stale', b5)).trim().split(/\r?\n/).at(-1)).outcome, 'closed',
    'the same unused key then closes B when it names B');
  console.log('[#2251] R1: re-queued before the close: refused, B untouched; naming B closes it');

  // R2: the re-queue is still in its transaction (row locked) when the close arrives; the close waits, then is refused.
  const a6 = queuedAt(D(6));
  assert.equal(JSON.parse(close(USERS.admin, D(6), 'handled', 'ki25s-r2-a')).outcome, 'closed');
  // The holder runs detached inside the container: node blocks on spawnSync below, so it cannot feed a child's stdin.
  const holding = () => scalar(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%ki25_hold%' AND state = 'active' AND pid <> pg_backend_pid();`);
  docker(['exec', '-d', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-c', `BEGIN; ${requeue(D(6))} SELECT pg_sleep(6) AS ki25_hold; COMMIT;`]);
  for (let i = 0; i < 100 && holding() === '0'; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  assert.equal(holding(), '1', 'the re-queue is open and holding the row');
  const t0 = Date.now();
  const r2 = closeAt(USERS.rep, D(6), 'handled', 'ki25s-r2-stale', a6);
  assert.ok(Date.now() - t0 > 1000, 'the close waited for the re-queue to commit');
  for (let i = 0; i < 100 && holding() !== '0'; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  assert.notEqual(queuedAt(D(6)), a6, 'the re-queue committed a new receipt');
  assert.match(out(r2), /DELIVERY_RECEIPT_CHANGED/, 'then saw the new receipt and was refused');
  assert.notEqual(status(D(6)), 'cancelled', 'the new receipt stays owed');
  console.log('[#2251] R2: close waiting on a re-queue: refused after it commits, B stays owed');

  // R3: a receipt that is not cancelled is not replaced by another completion, so its generation stands.
  const a7 = queuedAt(D(7));
  psql(requeue(D(7)));
  assert.equal(queuedAt(D(7)), a7, 'a needs_check receipt keeps its generation');
  // R4: the same instant written in another offset is the same receipt, and the retry matches its own key.
  const sameInstant = scalar(`SELECT to_char(created_at AT TIME ZONE 'Etc/GMT+6', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '-06:00'
    FROM public.delivery_receipt_queue WHERE delivery_id = '${D(7)}';`);
  assert.notEqual(sameInstant, a7, 'written differently');
  const lastJson = (r) => JSON.parse(out(r).trim().split(/\r?\n/).at(-1));
  assert.equal(lastJson(closeAt(USERS.admin, D(7), 'manual_send', 'ki25s-r4', a7)).outcome, 'paused');
  assert.equal(lastJson(closeAt(USERS.admin, D(7), 'manual_send', 'ki25s-r4', sameInstant)).outcome, 'paused',
    'a retry naming the same instant in another offset is the same request');
  assert.equal(lastJson(closeAt(USERS.admin, D(7), 'handled', 'ki25s-r4-h', sameInstant)).outcome, 'closed');
  assert.equal(status(D(7)), 'cancelled');
  const otherIntent = out(closeAt(USERS.admin, D(7), 'manual_send', 'ki25s-r4', '2001-01-01T00:00:00Z'));
  assert.match(otherIntent, /ERROR:  IDEMPOTENCY_INTENT_MISMATCH/, 'a used key with another expected receipt is refused');
  // R5: a key first used without an expected receipt (the deployed app) still replays as itself, and not with one.
  assert.equal(JSON.parse(close(USERS.admin, D(3), 'manual_send', 'ki25s-pause-3')).outcome, 'sent', 'a key saved without an expected receipt replays');
  assert.match(out(closeAt(USERS.admin, D(3), 'manual_send', 'ki25s-pause-3', queuedAt(D(3)))), /ERROR:  IDEMPOTENCY_INTENT_MISMATCH/,
    'the same key with an expected receipt is a different request');
  // A missing row counts as a different receipt; a driver is refused even with the right receipt.
  assert.match(out(closeAt(USERS.admin, '7c7a0000-0000-4000-8000-0000000000ff', 'handled', 'ki25s-r5-none', a7)), /DELIVERY_RECEIPT_CHANGED/, 'no receipt row: refused');
  assert.match(out(closeAt(USERS.driver, D(5), 'handled', 'ki25s-r5-drv', queuedAt(D(5)))), /INSUFFICIENT_ROLE/);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'close_delivery_receipt';`), '1', 'exactly one close_delivery_receipt');
  console.log('[#2251] R3-R5: generation kept, offsets match, old keys replay, used keys bound, missing row and driver refused');

  // Admin-only, the hand-send exception is bound to its rep and its receipt: a rep cannot close a receipt someone
  // else paused, nor an old pause of their own once the receipt was cancelled and queued again.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, completed_at, signed_by) VALUES
      ('${D(8)}', 'PROVER-KI25S-8', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat'),
      ('${D(9)}', 'PROVER-KI25S-9', '${ORDER}', '${CUST}', '${USERS.admin}', 'completed', current_date, now(), 'Pat');
    INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, requested_by, status, last_error, receipt, created_at, next_attempt_at) VALUES
      ('${D(8)}', '${CUST}', '${USERS.admin}', 'pending', NULL, '{"lines":[]}', ${HOUR_AGO}, now()),
      ('${D(9)}', '${CUST}', '${USERS.admin}', 'pending', NULL, '{"lines":[]}', ${HOUR_AGO}, now());`);
  assert.equal(JSON.parse(close(USERS.admin, D(8), 'manual_send', 'ki25s-a1-pause')).outcome, 'paused');
  assert.match(out(closeAt(USERS.rep, D(8), 'handled', 'ki25s-a1-rep', queuedAt(D(8)))), /RECEIPT_HANDLED_ADMIN_ONLY/, 'another user\'s pause: refused');
  assert.equal(status(D(8)), 'needs_check');
  assert.equal(JSON.parse(close(USERS.rep, D(9), 'manual_send', 'ki25s-a2-pause')).outcome, 'paused');
  assert.equal(JSON.parse(close(USERS.admin, D(9), 'handled', 'ki25s-a2-admin')).outcome, 'closed', 'an admin closes a rep\'s paused receipt');
  psql(requeue(D(9))); // a second completion: a new receipt on the same row, still carrying the old pause's columns
  psql(`UPDATE public.delivery_receipt_queue SET status = 'needs_check', last_error = 'provider said no' WHERE delivery_id = '${D(9)}';`);
  assert.match(out(closeAt(USERS.rep, D(9), 'handled', 'ki25s-a2-rep', queuedAt(D(9)))), /RECEIPT_HANDLED_ADMIN_ONLY/, 'an old pause never covers a new receipt');
  assert.equal(status(D(9)), 'needs_check');
  assert.equal(lastJson(closeAt(USERS.admin, D(9), 'handled', 'ki25s-a2-admin2', queuedAt(D(9)))).outcome, 'closed', 'an admin can');
  console.log('[admin-only] rep refused on another user\'s pause and on a re-queued receipt; admin closes both');

  // The live smoke chain still passes on the four-argument function (its grant check finds the one signature).
  const chain = psql(readFileSync(new URL('./smoke-close-delivery-receipt-chain.sql', import.meta.url), 'utf8'), { allowFailure: true });
  assert.match(out(chain), /SMOKE_PASS_ROLLBACK/, `the close_delivery_receipt smoke chain passes: ${out(chain).slice(-400)}`);
  console.log('[#2251] smoke-close-delivery-receipt-chain.sql passes after the change');

  console.log('KI25_RECEIPT_SCREENS_PROOF_PASS');
} finally {
  removeContainer();
}
