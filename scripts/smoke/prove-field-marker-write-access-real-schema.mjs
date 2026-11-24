#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  NAME, USERS, buildContainer, claims, docker, id, psql, removeContainer, scalar, seedUsers,
} from './undo-paths/harness.mjs';

const candidate = '20270303150000_field_marker_write_access.sql';
const field = id(3001);
const unassignedField = id(3002);
const job = id(3003);
const legacy = id(3004);
const coworker = id('b1');
const inactive = id('b2');
const recipient = id('b3');
const { admin, rep, driver, applicator } = USERS;
const point = '{"type":"Point","coordinates":[-89.5,40.5]}';
const migration = readFileSync(new URL('../../supabase/migrations/' + candidate, import.meta.url), 'utf8');
const pgArgs = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'];

function transaction(actor, statement, finish = 'ROLLBACK') {
  return "BEGIN; SET LOCAL request.jwt.claim.sub = '" + actor
    + "'; SET LOCAL ROLE authenticated; " + statement + '; ' + finish + ';';
}

function allowed(actor, statement, finish) {
  return docker(pgArgs, { input: transaction(actor, statement, finish) }).stdout.trim();
}

function refused(actor, statement, error) {
  const result = docker(pgArgs, { input: transaction(actor, statement), allowFailure: true });
  assert.notEqual(result.status, 0, statement);
  assert.match(result.stderr, error);
}

function insert(marker, kind = 'washout', fieldId = field) {
  return "INSERT INTO public.field_obstacles (id, field_id, kind, point_geojson)"
    + " VALUES ('" + marker + "','" + fieldId + "','" + kind + "','" + point + "')";
}

function seed() {
  seedUsers();
  const extra = [[coworker, 'applicator'], [inactive, 'applicator'], [recipient, 'entity_recipient']];
  for (const [user, role] of extra) {
    const metadata = JSON.stringify({ full_name: 'Marker fixture ' + user, role });
    psql("INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('"
      + user + "','" + user + "@example.invalid','" + metadata + "');");
  }
  psql([
    'BEGIN;', claims(admin),
    "UPDATE public.profiles SET is_active = false WHERE id = '" + inactive + "';",
    "INSERT INTO public.customers (id, farm_name) VALUES ('" + id(3000) + "','Marker proof farm');",
    "INSERT INTO public.fields (id, customer_id, field_name) VALUES ('" + field + "','" + id(3000) + "','Assigned field'),"
      + "('" + unassignedField + "','" + id(3000) + "','Unassigned field');",
    "INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id) VALUES ('"
      + job + "','MARKER-PROOF','" + id(3000) + "',CURRENT_DATE,'scheduled','" + applicator + "');",
    "INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('" + id(3005) + "','" + job + "','" + field + "');",
    insert(legacy, 'oil_well').replace(point, '{"type":"Polygon"}') + ';',
    'COMMIT;',
  ].join('\n'));
}

const wherePin = (pin) => " WHERE id = '" + pin + "'";
const update = (pin, patch) => 'UPDATE public.field_obstacles SET ' + patch + wherePin(pin);
const remove = (pin) => 'DELETE FROM public.field_obstacles' + wherePin(pin);
const read = (actor, fieldId = field) => JSON.parse(allowed(actor, "SELECT public.get_field_marker_read('" + fieldId + "')"));

function proveAccess() {
  const marker = id(3010);
  const next = id(3011);
  assert.deepEqual(read(rep, unassignedField), { available: true, count: 0, markers: [] });
  assert.equal(read(applicator).markers[0].point_geojson.type, 'Polygon');
  assert.deepEqual(read(applicator, unassignedField), { available: false });
  assert.equal(allowed(applicator, "SELECT full_name FROM public.profile_public_view WHERE id = '" + admin + "'"), '[UNDO] Admin');
  assert.equal(allowed(applicator, insert(marker) + ' RETURNING created_by', 'COMMIT'), applicator);
  assert.equal(allowed(applicator, update(marker, "label = 'My note'") + ' RETURNING label'), 'My note');
  assert.equal(allowed(applicator, remove(marker) + ' RETURNING id'), marker);
  assert.equal(allowed(applicator, update(legacy, "label = 'Denied'") + ' RETURNING id'), '');
  assert.equal(allowed(applicator, remove(legacy) + ' RETURNING id'), '');
  for (const actor of [coworker, inactive, driver, recipient]) {
    assert.deepEqual(read(actor), { available: false });
    refused(actor, insert(next), /row-level security/);
  }
  refused(applicator, insert(next, 'field_entrance', unassignedField), /FIELD_MARKER_ACCESS_REQUIRED/);
  assert.match(psql("BEGIN; SET LOCAL ROLE anon; SELECT public.get_field_marker_read('" + field + "');", { allowFailure: true }).stderr, /permission denied/);
  for (const office of [admin, rep]) {
    assert.equal(allowed(office, insert(next) + ' RETURNING created_by'), office);
    assert.equal(allowed(office, update(legacy, "label = 'Office'") + ' RETURNING label'), 'Office');
    assert.equal(allowed(office, remove(marker) + ' RETURNING id'), marker);
  }
  psql('BEGIN; ' + claims(admin) + " UPDATE public.jobs SET applicator_id = '" + coworker + "' WHERE id = '" + job + "'; COMMIT;");
  assert.deepEqual(read(applicator), { available: false });
  refused(applicator, insert(next), /row-level security/);
  assert.equal(read(coworker).count, 2);
  for (const actor of [applicator, coworker]) {
    assert.equal(allowed(actor, update(marker, "label = 'Denied'") + ' RETURNING id'), '');
    assert.equal(allowed(actor, remove(marker) + ' RETURNING id'), '');
  }
}

function proveValidation() {
  const pin = id(3014);
  for (const kind of ['oil_well', 'windmill', 'tower', 'tree_line', 'power_line', 'waterway', 'other',
    'field_entrance', 'washout', 'pole', 'garden', 'well', 'pivot', 'sensitive_crop', 'gate']) {
    assert.equal(allowed(admin, insert(pin, kind) + ' RETURNING kind'), kind);
  }
  refused(admin, insert(pin, 'unsupported'), /field_obstacles_kind_check/);
  for (const coordinates of [null, [null, 40], [181, 40], [-89, 91], [-89, 40, 10], ['-89', 40]]) {
    refused(admin, insert(pin).replace(point, JSON.stringify({ type: 'Point', coordinates })), /FIELD_MARKER_POINT_INVALID/);
  }
  const forged = 'INSERT INTO public.field_obstacles (id, field_id, kind, point_geojson, created_by, created_at, updated_at, entrance_number)'
    + " VALUES ('" + pin + "','" + field + "','well','" + point + "','" + recipient + "','2000-01-01','2000-01-01',999)";
  assert.equal(allowed(coworker, forged + " RETURNING (created_by = '" + coworker + "' AND created_at = updated_at"
    + " AND created_at > now() - interval '1 minute' AND entrance_number IS NULL)::text", 'COMMIT'), 'true');
  refused(coworker, insert(pin), /field_obstacles_pkey/);
  for (const change of ["id = '" + id(3020) + "'", "field_id = '" + unassignedField + "'", "created_by = '" + recipient + "'", "created_at = '2000-01-01'"]) {
    refused(coworker, update(pin, change), /FIELD_MARKER_IDENTITY_IMMUTABLE/);
  }
  refused(coworker, update(pin, "label = repeat('a', 501)"), /FIELD_MARKER_NOTE_TOO_LONG/);
  refused(admin, update(legacy, "point_geojson = '{}'"), /FIELD_MARKER_POINT_INVALID/);
  const version = allowed(coworker, 'SELECT updated_at FROM public.field_obstacles' + wherePin(pin));
  const versionCheck = " AND field_id = '" + field + "' AND updated_at = '" + version + "'";
  assert.equal(allowed(coworker, update(pin, "label = 'First', updated_at = '2000-01-01'")
    + versionCheck + " RETURNING (updated_at > '" + version + "')::text", 'COMMIT'), 'true');
  assert.equal(allowed(coworker, update(pin, "label = 'Second'") + versionCheck + ' RETURNING id'), '');
  assert.equal(allowed(coworker, remove(pin) + versionCheck + ' RETURNING id'), '');
  refused(coworker, 'SELECT * FROM public.field_entrance_counters', /permission denied/);
}

async function proveEntranceNumbers() {
  const exec = promisify(execFile);
  await Promise.all([id(3030), id(3031)].map((pin) => exec('docker', [...pgArgs, '-c',
    transaction(coworker, insert(pin, 'field_entrance') + '; SELECT pg_sleep(0.25)', 'COMMIT')])));
  assert.equal(scalar("SELECT string_agg(entrance_number::text, ',' ORDER BY entrance_number)"
    + " FROM public.field_obstacles WHERE field_id = '" + field + "'"), '1,2');
  const two = scalar('SELECT id FROM public.field_obstacles WHERE entrance_number = 2');
  allowed(coworker, 'DELETE FROM public.field_obstacles WHERE entrance_number = 1', 'COMMIT');
  assert.equal(allowed(coworker, update(two, 'entrance_number = 99') + ' RETURNING entrance_number', 'COMMIT'), '2');
  assert.equal(allowed(coworker, insert(id(3032), 'field_entrance') + ' RETURNING entrance_number', 'COMMIT'), '3');
  assert.equal(allowed(coworker, update(two, "kind = 'gate'") + ' RETURNING (entrance_number IS NULL)::text', 'COMMIT'), 'true');
  assert.equal(allowed(coworker, update(two, "kind = 'field_entrance'") + ' RETURNING entrance_number', 'COMMIT'), '4');
}

try {
  // Include the newest marker access predicate and the separate older-record field read policy.
  buildContainer({ stopBefore: '20261221100000_close_delivery_receipt.sql' });
  seed();
  const policy = "SELECT qual FROM pg_policies WHERE tablename = 'field_obstacles' AND cmd = 'SELECT'";
  const previousSelect = scalar(policy);
  psql('BEGIN;\n' + migration + '\nCOMMIT;');
  assert.equal(scalar(policy), previousSelect);
  assert.equal(scalar("SELECT has_function_privilege('authenticated','public.set_field_marker_write_metadata()','EXECUTE')"), 'f');
  proveAccess();
  proveValidation();
  await proveEntranceNumbers();
  console.log('FIELD_MARKER_WRITE_ACCESS_PROOF_PASS');
} finally {
  removeContainer();
}
