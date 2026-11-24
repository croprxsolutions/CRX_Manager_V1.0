#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 regression for audit-log-completeness's actor
 * contract row: financial_audit_log.actor_user_id DEFAULT auth.uid() and the
 * trg_fill_audit_actor BEFORE INSERT trigger. The healthy shape must be quiet;
 * every drift must raise the single financial_audit_log:actor-contract row.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREDICATE = readFileSync(
  path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'audit-log-completeness.sql'),
  'utf8',
);
const CONTAINER = `crx-audit-log-completeness-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const KEY = 'financial_audit_log:actor-contract';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function psql(sql) {
  return docker(
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tAX'],
    { input: sql },
  ).stdout.trim();
}

// Apply the drift, run the predicate, roll back so each case starts healthy.
function keysAfter(drift) {
  const out = psql(`BEGIN;\n${drift}\n${PREDICATE}\nROLLBACK;`);
  return out ? out.split(/\r?\n/).map((row) => row.split('|')[0]) : [];
}

try {
  docker([
    'run', '--detach', '--name', CONTAINER, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
    '--env', 'POSTGRES_PASSWORD=disposable-only', 'postgres:17-alpine',
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    ready = docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0;
    if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  assert.ok(ready, 'disposable PostgreSQL container did not become ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);

  psql(`
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
CREATE FUNCTION auth.other_uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
CREATE TABLE public.financial_audit_log (id bigserial, actor_user_id uuid NOT NULL DEFAULT auth.uid());
CREATE FUNCTION public._fill_audit_actor() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE FUNCTION public._other_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE TRIGGER trg_fill_audit_actor BEFORE INSERT ON public.financial_audit_log
  FOR EACH ROW EXECUTE FUNCTION public._fill_audit_actor();
`);

  assert.deepEqual(keysAfter(''), [], 'healthy configuration must produce no rows');
  assert.deepEqual(keysAfter('ALTER TABLE public.financial_audit_log ENABLE ALWAYS TRIGGER trg_fill_audit_actor;'), [],
    'ENABLE ALWAYS is still enforced');

  const drifts = {
    'default dropped': 'ALTER TABLE public.financial_audit_log ALTER COLUMN actor_user_id DROP DEFAULT;',
    'default changed': 'ALTER TABLE public.financial_audit_log ALTER COLUMN actor_user_id SET DEFAULT auth.other_uid();',
    'default wrapped': "ALTER TABLE public.financial_audit_log ALTER COLUMN actor_user_id SET DEFAULT coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000');",
    'nullable': 'ALTER TABLE public.financial_audit_log ALTER COLUMN actor_user_id DROP NOT NULL;',
    'type changed': 'ALTER TABLE public.financial_audit_log ALTER COLUMN actor_user_id DROP DEFAULT, ALTER COLUMN actor_user_id TYPE text, ALTER COLUMN actor_user_id SET DEFAULT auth.uid();',
    'column dropped': 'ALTER TABLE public.financial_audit_log DROP COLUMN actor_user_id;',
    'trigger dropped': 'DROP TRIGGER trg_fill_audit_actor ON public.financial_audit_log;',
    'trigger disabled': 'ALTER TABLE public.financial_audit_log DISABLE TRIGGER trg_fill_audit_actor;',
    'trigger replica only': 'ALTER TABLE public.financial_audit_log ENABLE REPLICA TRIGGER trg_fill_audit_actor;',
    'trigger AFTER': 'DROP TRIGGER trg_fill_audit_actor ON public.financial_audit_log; CREATE TRIGGER trg_fill_audit_actor AFTER INSERT ON public.financial_audit_log FOR EACH ROW EXECUTE FUNCTION public._fill_audit_actor();',
    'trigger INSERT OR UPDATE': 'DROP TRIGGER trg_fill_audit_actor ON public.financial_audit_log; CREATE TRIGGER trg_fill_audit_actor BEFORE INSERT OR UPDATE ON public.financial_audit_log FOR EACH ROW EXECUTE FUNCTION public._fill_audit_actor();',
    'trigger statement-level': 'DROP TRIGGER trg_fill_audit_actor ON public.financial_audit_log; CREATE TRIGGER trg_fill_audit_actor BEFORE INSERT ON public.financial_audit_log FOR EACH STATEMENT EXECUTE FUNCTION public._fill_audit_actor();',
    'trigger WHEN clause': 'DROP TRIGGER trg_fill_audit_actor ON public.financial_audit_log; CREATE TRIGGER trg_fill_audit_actor BEFORE INSERT ON public.financial_audit_log FOR EACH ROW WHEN (false) EXECUTE FUNCTION public._fill_audit_actor();',
    'trigger other function': 'DROP TRIGGER trg_fill_audit_actor ON public.financial_audit_log; CREATE TRIGGER trg_fill_audit_actor BEFORE INSERT ON public.financial_audit_log FOR EACH ROW EXECUTE FUNCTION public._other_trigger();',
    'trigger renamed': 'ALTER TRIGGER trg_fill_audit_actor ON public.financial_audit_log RENAME TO trg_other;',
    'trigger on other table': 'DROP TRIGGER trg_fill_audit_actor ON public.financial_audit_log; CREATE TABLE public.decoy (actor_user_id uuid); CREATE TRIGGER trg_fill_audit_actor BEFORE INSERT ON public.decoy FOR EACH ROW EXECUTE FUNCTION public._fill_audit_actor();',
    'table missing': 'DROP TABLE public.financial_audit_log;',
  };
  for (const [name, sql] of Object.entries(drifts)) {
    assert.deepEqual(keysAfter(sql), [KEY], `${name} must raise exactly one ${KEY} row`);
  }
  console.log(`audit-log-completeness actor contract: healthy quiet, ${Object.keys(drifts).length} drifts flagged`);
} finally {
  docker(['rm', '--force', CONTAINER], { allowFailure: true });
}
