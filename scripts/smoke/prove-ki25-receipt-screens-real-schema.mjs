#!/usr/bin/env node
/**
 * Real-schema proof for the KI-25 receipt screens (W2-06) on TODAY's chain: the baseline plus every migration.
 * It calls close_delivery_receipt with the exact named arguments src/lib/receiptsToCheck.ts sends, as an office
 * user, and reads "Customer receipts to check" with the screen's own filter under RLS. Shown:
 *  - Mark handled: a needs_check receipt leaves the list and the server worker never claims it;
 *  - Email Confirmation: 'manual_send' pauses an owed receipt (it stays listed, the worker skips it), then 'handled'
 *    takes it off the list once the hand send went out;
 *  - a sent receipt answers 'sent' with sent_at, so the screen asks before a second copy;
 *  - every key the screen reads is in the answer; a driver is refused.
 *
 * Run: node scripts/smoke/prove-ki25-receipt-screens-real-schema.mjs   (needs Docker)
 * Prints KI25_RECEIPT_SCREENS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';

process.env.UNDO_PATHS_CONTAINER ||= `crx-ki25-screens-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, psql, scalar, USERS, id } = await import('./undo-paths/harness.mjs');

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

  // Mark handled (ReceiptsToCheck): off the list, and the worker never claims it.
  const handled = JSON.parse(close(USERS.rep, D(1), 'handled', 'ki25s-handled-1'));
  for (const key of ['delivery_id', 'outcome', 'previous_status', 'sent_at', 'send_authorized_at']) assert.ok(key in handled, `answer has ${key}`);
  assert.equal(handled.outcome, 'closed');
  assert.equal(status(D(1)), 'cancelled');
  assert.equal(listed(USERS.rep), D(2), 'a handled receipt leaves the list');
  console.log('[KI-25] Mark handled: closed, off the list');

  // Email Confirmation (DeliveryDetail): pause first; the worker then skips it and it stays listed until handled.
  const paused = JSON.parse(close(USERS.admin, D(2), 'manual_send', 'ki25s-pause-2'));
  assert.equal(paused.outcome, 'paused');
  assert.equal(paused.sent_at, null); assert.equal(paused.send_authorized_at, null); // the screen goes straight to the send
  assert.equal(status(D(2)), 'needs_check');
  runWorkerClaim();
  assert.equal(status(D(4)), 'sending', 'control: the worker does claim an ordinary owed receipt');
  assert.equal(status(D(1)), 'cancelled', 'the worker never claims a handled receipt');
  assert.equal(status(D(2)), 'needs_check', 'the worker never claims a paused receipt');
  assert.equal(listed(USERS.admin), D(2), 'a paused receipt stays listed until the hand send is marked handled');
  assert.equal(JSON.parse(close(USERS.admin, D(2), 'handled', 'ki25s-handled-2')).outcome, 'closed');
  assert.equal(listed(USERS.admin), 'none', 'after the hand send it is off the list');
  console.log('[KI-25] Email Confirmation: paused, not claimed, then handled');

  // Already sent: the answer says so with sent_at, which opens "Receipt may already be sent".
  const sent = JSON.parse(close(USERS.admin, D(3), 'manual_send', 'ki25s-pause-3'));
  assert.equal(sent.outcome, 'sent'); assert.ok(sent.sent_at, 'sent_at is returned');
  assert.equal(status(D(3)), 'sent');
  console.log('[KI-25] Already sent: answer "sent" with sent_at, row unchanged');

  console.log('KI25_RECEIPT_SCREENS_PROOF_PASS');
} finally {
  removeContainer();
}
