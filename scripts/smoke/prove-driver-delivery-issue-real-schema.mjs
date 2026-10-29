#!/usr/bin/env node
// Synthetic driver -> completion RPC -> deferred office notification on a disposable,
// network-disabled PostgreSQL 17. No live URLs, production writes or external messages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reuse = process.argv.find(arg => arg.startsWith('--reuse='))?.slice('--reuse='.length);
const name = reuse || `crx-driver-issue-${process.pid}`;
assert.match(name, /^crx-driver-issue-\d+$/);
const candidate = '20261029160100_driver_delivery_issue_notifications.sql';
const baseline = path.join(root, 'supabase/baselines');
const skippedStorage = new Set(['20260914100700_customer_document_bytes_server_only.sql', '20261015230000_staff_photo_storage_access.sql', '20261016030000_staff_photo_buckets_private.sql']);
const ledgerOnly = new Set(['20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql', '20261007150200_release_reservations_of_deleted_spring_orders.sql']);
function docker(args, input, allowFailure = false) {
  const r = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.error || (!allowFailure && r.status !== 0)) throw new Error(r.error?.message || r.stderr || r.stdout);
  return r;
}
function sql(input, user = 'postgres', allowFailure = false) {
  return docker(['exec', '-i', name, 'psql', '-U', user, '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input, allowFailure);
}
const read = (file) => readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
function ledger(stem) {
  sql(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('${stem.slice(0,14)}','${stem}',ARRAY[]::text[]) ON CONFLICT DO NOTHING;`);
}
function installAuthUid() {
  // The batch-2 preflight pins live's byte-exact body, including whitespace.
  const body = '\n  select \n  coalesce(\n' + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n" + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n" + '  )::uuid\n';
  sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $uid$${body}$uid$;`, 'supabase_admin');
}
function build() {
  docker(['run','-d','--name',name,'--network','none','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m','-e','POSTGRES_PASSWORD=postgres','public.ecr.aws/supabase/postgres:17.6.1.143']);
  for (let i = 0; ; i++) {
    // The image first runs an init-only socket server; wait for the final TCP server.
    if (docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'], undefined, true).status === 0) break;
    if (i > 120) throw new Error('PostgreSQL not ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  sql(read('supabase/baselines/20260727174805_extensions.sql'));
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64*1024*1024 });
  assert.equal(schema.status, 0, schema.stderr);
  sql(schema.stdout);
  sql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets(id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text NOT NULL,name text NOT NULL,owner_id text,metadata jsonb,UNIQUE(bucket_id,name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name,'/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name,'/',array_length(string_to_array(name,'/'),1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres; GRANT ALL ON storage.objects,storage.buckets TO postgres;`, 'supabase_admin');
  sql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY,name text NOT NULL,statements text[]);');
  for (const suffix of ['acl_lockdown','platform_overlay','cron_jobs','migration_history']) {
    sql(readFileSync(path.join(baseline, `20260727174805_${suffix}.sql`),'utf8'), suffix === 'platform_overlay' ? 'supabase_admin' : 'postgres');
  }
  const plan = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr);
  const files = plan.stdout.split(/\r?\n/).filter(f => f.startsWith('supabase/migrations/'));
  assert.equal(path.basename(files.at(-1)), candidate, 'candidate must be last');
  for (const [i,file] of files.slice(0,-1).entries()) {
    const base = path.basename(file);
    if (skippedStorage.has(base)) continue;
    for (const only of ledgerOnly) if (only < base) ledger(only.slice(0,-4));
    if (ledgerOnly.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') {
      const source = read('supabase/migrations/20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql');
      const start = source.indexOf('CREATE FUNCTION public._close_undelivered_order_remainder_20260718(');
      const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
      const bodyStart = start + tag.index + tag[0].length;
      const body = source.slice(bodyStart, source.indexOf(tag[0],bodyStart)).replaceAll('\n','\r\n');
      assert.equal(body.length,15910);
      sql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $body$${body}$body$;`);
    }
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installAuthUid();
    const result = sql(`BEGIN;\n${read(file)}\nCOMMIT;`, 'postgres', true);
    assert.equal(result.status, 0, `${base}: ${result.stderr}`);
    ledger(base.slice(0,-4));
    if (i % 25 === 0) console.log(`Replayed ${i+1}/${files.length-1}`);
  }
  installAuthUid();
  console.log('Restored baseline and current migration chain; storage-only and one-shot data skips match existing provers.');
}

try {
  if (reuse) {
    assert.equal(docker(['inspect','--format','{{.HostConfig.NetworkMode}}',name]).stdout.trim(),'none');
    console.log(`Reusing own isolated container ${name}`);
  } else {
    console.log(`Building own isolated container ${name}`);
    build();
  }
  sql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens(id bigserial PRIMARY KEY,user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid);
    GRANT ALL ON auth.refresh_tokens,auth.sessions TO postgres;`, 'supabase_admin');
  // A reused container may contain the prior run's candidate/mutated trigger. Reset
  // only our own two objects before the fail-first matrix, never any shared function.
  sql('DROP TRIGGER IF EXISTS driver_delivery_issue_notice ON public.deliveries; DROP FUNCTION IF EXISTS public._notify_driver_delivery_issue();');
  const chain = read('scripts/smoke/smoke-driver-delivery-issue.sql');
  const before = sql(chain,'postgres',true);
  assert.match(before.stderr,/SMOKE_FAIL: shortage notice missing/,`fail-first: ${before.stderr}`);
  console.log('BEFORE: actual driver completion succeeds but report notice is missing.');
  sql(`BEGIN;\n${read(`supabase/migrations/${candidate}`)}\nCOMMIT;`);
  sql(`BEGIN;\n${read(`supabase/migrations/${candidate}`)}\nCOMMIT;`);
  const after = sql(chain,'postgres',true);
  assert.match(after.stderr,/SMOKE_PASS_ROLLBACK/,after.stderr);
  console.log('AFTER: shortage, damage explanation, all seven issue labels, missing details, no-issue, permissions, replay, insert failure and retry: SMOKE_PASS_ROLLBACK');
  // A synchronous trigger would read old line quantities. This mutation must be detected.
  // The postflight (correctly) refuses a non-deferred trigger, so cut it off for the mutation only.
  const immediate = read(`supabase/migrations/${candidate}`).replace('DEFERRABLE INITIALLY DEFERRED','NOT DEFERRABLE INITIALLY IMMEDIATE').split('-- Postflight:')[0];
  sql(`BEGIN;\n${immediate}\nCOMMIT;`);
  const mutation = sql(chain,'postgres',true);
  assert.match(mutation.stderr,/SMOKE_FAIL: shortage quantities/,mutation.stderr);
  console.log('MUTATION: premature notice reads stale quantities; regression catches it.');
  sql(`BEGIN;\n${read(`supabase/migrations/${candidate}`)}\nCOMMIT;`);
  sql(`BEGIN;\n${chain.replace("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';", "RAISE NOTICE 'SMOKE_COMMIT_PASS';")}\nCOMMIT;`);
  assert.equal(sql("SELECT count(*) FROM public.notifications WHERE notification_type='delivery_issue_reported';").stdout.trim(),'10');
  console.log('COMMIT: ten report notices persisted for eleven synthetic driver completions (one without an issue); a new transaction reads them.');
  console.log('DRIVER_DELIVERY_ISSUE_PROOF_PASS');
} finally {
  if (process.argv.includes('--keep-container')) console.log(`Kept own isolated container ${name}`);
  else docker(['rm','-f',name],undefined,true);
}
