#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { USERS, buildContainer, claims, id, psql, removeContainer, scalar, seedUsers } from './undo-paths/harness.mjs';

const migration = '20270306220000_field_marker_create_receipts.sql';
const { admin, rep, driver, applicator } = USERS;
const farm = id(3400);
const field = id(3401);
const otherField = id(3402);
const job = id(3403);
const existing = id(3404);
const retry = id(3405);
const notSent = id(3406);

function statement(actor, sql, end = 'ROLLBACK') {
  return `BEGIN; ${claims(actor)} SET LOCAL ROLE authenticated; ${sql}; ${end};`;
}

function allowed(actor, sql, end) {
  return scalar(statement(actor, sql, end));
}

function denied(actor, sql, pattern) {
  const result = psql(statement(actor, sql), { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  return result.stderr;
}

function place(pin, kind = 'field_entrance') {
  return `INSERT INTO public.field_obstacles (id,field_id,kind,point_geojson)
    VALUES ('${pin}','${field}','${kind}','{"type":"Point","coordinates":[-89,40]}')`;
}

function state(actor, pin, fieldId = field) {
  const sql = `SELECT public.get_field_marker_create_result('${fieldId}','${pin}')->>'state'`;
  return allowed(actor, sql);
}

function remove(actor, pin) {
  assert.equal(allowed(actor, `DELETE FROM public.field_obstacles WHERE id = '${pin}' RETURNING id`, 'COMMIT'), pin);
}

try {
  buildContainer({ stopBefore: migration });
  seedUsers();
  psql(`BEGIN; ${claims(admin)}
    INSERT INTO public.customers (id,farm_name) VALUES ('${farm}','Marker receipt proof');
    INSERT INTO public.fields (id,customer_id,field_name)
      VALUES ('${field}','${farm}','Assigned field'), ('${otherField}','${farm}','Unassigned field');
    INSERT INTO public.jobs (id,job_number,customer_id,job_date,status,applicator_id)
      VALUES ('${job}','MARKER-RECEIPT-QA','${farm}',CURRENT_DATE,'scheduled','${applicator}');
    INSERT INTO public.job_fields (id,job_id,field_id) VALUES ('${id(3407)}','${job}','${field}');
    ${place(existing, 'washout')};
    COMMIT;`);
  psql('BEGIN;\n' + readFileSync(new URL('../../supabase/migrations/' + migration, import.meta.url), 'utf8') + '\nCOMMIT;');

  assert.equal(state(admin, existing), 'saved');
  remove(admin, existing);
  assert.equal(state(admin, existing), 'removed');
  denied(admin, place(existing), /field_obstacles_pkey/);

  assert.equal(state(applicator, retry), 'missing');
  assert.equal(allowed(applicator, place(retry) + ' RETURNING entrance_number', 'COMMIT'), '1');
  const stillSavedError = denied(applicator, place(retry), /field_obstacles_pkey/);
  assert.equal(state(applicator, retry), 'saved');
  assert.equal(state(rep, retry), 'missing');
  assert.equal(state(applicator, retry, otherField), 'unavailable');
  assert.equal(state(driver, retry), 'unavailable');
  assert.equal(allowed(rep, `SELECT count(*) FROM public.field_marker_create_receipts WHERE id = '${retry}'`), '0');
  denied(applicator, "DELETE FROM public.field_marker_create_receipts WHERE id = '" + retry + "'", /permission denied/);
  denied(applicator, 'SELECT public.record_field_marker_create_receipt()', /permission denied/);
  assert.equal(scalar("SELECT has_function_privilege('anon','public.get_field_marker_create_result(uuid,uuid)','EXECUTE')"), 'f');

  remove(admin, retry);
  assert.equal(state(applicator, retry), 'removed');
  const removedError = denied(applicator, place(retry), /field_obstacles_pkey/);
  const publicError = (stderr) => stderr.split(/\r?\n/).filter((line) => /^(ERROR|DETAIL):/.test(line));
  assert.deepEqual(publicError(removedError), publicError(stillSavedError));
  assert.equal(state(applicator, retry), 'removed');
  assert.equal(allowed(applicator, place(notSent) + ' RETURNING entrance_number', 'COMMIT'), '2');

  psql(`BEGIN; ${claims(admin)} UPDATE public.jobs SET applicator_id = NULL WHERE id = '${job}'; COMMIT;`);
  assert.equal(state(applicator, retry), 'unavailable');
  assert.equal(allowed(applicator, `SELECT count(*) FROM public.field_marker_create_receipts WHERE id = '${retry}'`), '0');
  console.log('FIELD_MARKER_CREATE_RECEIPTS_PROOF_PASS');
} finally {
  removeContainer();
}
