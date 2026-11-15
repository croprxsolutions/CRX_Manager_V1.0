#!/usr/bin/env node
// Reuses RT-3's real-schema bootstrap; all target actions run in its owned, network-disabled fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CANDIDATE = '20270110110000_inactive_rate_review_cleanup.sql';
const POSTGREST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14';
const ADMIN = 'a3000000-0000-4000-8000-0000000000a1';
const REP = 'a3000000-0000-4000-8000-0000000000a2';
const q = (value) => value == null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => q(JSON.stringify(value)) + '::jsonb';

export async function proveInactiveRateReview(container) {
  assert.match(container, /^crx-rt3-\d+-[a-z0-9]+$/);
  const tag = `inactive-${process.pid}-${Date.now().toString(36)}`;
  const apiName = `crx-${tag}-api`;
  function docker(args, input, allowFailure = false) {
    const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || (!allowFailure && result.status !== 0)) throw new Error(result.error?.message ?? result.stderr ?? result.stdout);
    return result;
  }
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}} {{.Name}}', container]).stdout.trim(), `none /${container}`);
  const psqlArgs = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'];
  const sql = (text, allowFailure = false) => docker(psqlArgs, text, allowFailure);
  const last = (text) => text.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const scalar = (text) => last(sql(text).stdout);
  const tx = (actor, text) => `BEGIN; SELECT set_config('request.jwt.claims', ${json({sub:actor,role:'authenticated'})}::text, true); SET LOCAL ROLE ${actor ? 'authenticated' : 'anon'}; ${text} COMMIT;`;
  const call = (text, actor = ADMIN) => {
    const result = sql(tx(actor, text));
    return JSON.parse(last(result.stdout));
  };
  const refuse = (text, pattern, actor = ADMIN) => {
    const result = sql(tx(actor, text), true);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, pattern);
  };
  const snapshot = (includeReceipts = true) => scalar(`SELECT md5(jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.product_rates r),
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.parent_id) FROM public.product_parent_rate_outcomes o),
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.product_rate_draft_events e),
    ${includeReceipts ? '(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.idempotency_key) FROM public.idempotency_keys k)' : 'NULL::jsonb'})::text);`);
  const migration = readFileSync(path.join(ROOT, 'supabase/migrations', CANDIDATE), 'utf8').replaceAll('\r\n','\n');
  const predecessor = readFileSync(path.join(ROOT, 'supabase/migrations/20270104110000_product_rate_review.sql'), 'utf8').replaceAll('\r\n','\n');
  const names = ['_product_rate_review_lock','_product_rate_review_approve','_product_rate_review_outcome','get_rate_review_workbook'];
  const definitions = names.map((name) => {
    const match = predecessor.match(new RegExp('CREATE FUNCTION public\\.' + name + '\\([\\s\\S]*?\\$function\\$;'));
    assert.ok(match, name);
    return match[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  });
  // Reset only these fixture definitions when reusing an owned development fixture.
  sql(`BEGIN; DROP FUNCTION IF EXISTS public.get_rate_review_workbook(boolean);
    ${definitions.join('\n')}
    ALTER FUNCTION public.get_rate_review_workbook() OWNER TO postgres;
    REVOKE ALL ON FUNCTION public.get_rate_review_workbook() FROM PUBLIC,anon,authenticated,service_role,metabase_ro;
    GRANT EXECUTE ON FUNCTION public.get_rate_review_workbook() TO authenticated; COMMIT;`);

  const parent = randomUUID(), destination = randomUUID(), product = randomUUID();
  const name = `[PROVER] ${tag}`;
  sql(`BEGIN; INSERT INTO public.product_parents(id,name,product_form,created_by,updated_by) VALUES
    (${q(parent)},${q(name)},'liquid',${q(ADMIN)},${q(ADMIN)}),
    (${q(destination)},${q(name+' destination')},'liquid',${q(ADMIN)},${q(ADMIN)});
    INSERT INTO public.products(id,product_name,product_form,unit_size,inventory_unit,
      current_cost,tier1_margin,tier2_margin,tier3_margin,tier1_price,tier2_price,tier3_price)
    VALUES (${q(product)},${q(name+' size')},'liquid','Gal','Gal',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO public.product_parent_members(product_id,parent_id,added_by) VALUES (${q(product)},${q(parent)},${q(ADMIN)}); COMMIT;`);
  const saved = call(`SELECT public.save_draft_product_rate(${q(parent)},NULL,NULL,'per_acre','house_standard',NULL,1,NULL,'pt',true,NULL,${q(tag+'-seed')});`);
  const download = (include = false) => call(`SELECT public.get_rate_review_workbook(${include ? 'true' : ''});`);
  const row = (p, r) => ({rate_id:r.rate_id,parent_id:p,expected_row_version:r.row_version,basis:r.basis,source:r.source,
    low:r.low,recommended:r.recommended,high:r.high,unit:r.unit,is_quoting_default:r.is_quoting_default,
    over_label_reason:r.over_label_reason,decision:null,reason:null});
  const commit = (rates, outcomes, key) => `SELECT public.commit_rate_review(${json(rates)},${json(outcomes)},${q(key)});`;
  let original = download().parents.find((p) => p.parent_id === parent);
  call(commit([{...row(parent, original.rates.find((r) => r.rate_id === saved.rate_id)),decision:'approve'}],[],tag+'-approve'));
  original = download().parents.find((p) => p.parent_id === parent);
  call(commit([],[{parent_id:parent,expected_outcome_version:original.outcome_version,outcome:'approved_default',note:null}],tag+'-outcome'));
  const beforeDeactivation = snapshot(false);
  const move = call(`SELECT public.preview_move_product_size(${q(product)},${q(destination)});`);
  call(`SELECT public.move_product_size(${q(product)},${q(destination)},${move.from_parent_version},${move.to_parent_version},
    ${q(move.size_fingerprint)},'proof: move the last size','invented fixture',${json(move.prices)},${q(tag+'-move')});`);
  assert.equal(scalar(`SELECT is_active FROM public.product_parents WHERE id=${q(parent)};`), 'f');
  assert.equal(snapshot(false), beforeDeactivation, 'deactivation must preserve rates/outcomes/history');
  assert.equal(download().parents.some((p) => p.parent_id === parent), false);
  // The move adds its own parent-event/receipt; rate history above remains untouched.
  const approved = JSON.parse(scalar(`SELECT to_jsonb(r) || jsonb_build_object(
    'low',r.low::text,'recommended',r.recommended::text,'high',r.high::text)
    FROM public.product_rates r WHERE id=${q(saved.rate_id)};`));
  const approvedRow = {...approved, rate_id:approved.id};
  const reopen = {...row(parent, approvedRow),decision:'reopen',reason:'cleanup inactive rate history'};
  refuse(commit([reopen],[],tag+'-before'), /RATE_REVIEW_REFUSED[\s\S]*PARENT_NOT_FOUND/);
  console.log('[inactive] BEFORE: real last-size move preserves approval; existing workbook cannot reopen its inactive rate');

  // Same-name active groups are valid and must not be hidden or made ambiguous by the old download.
  sql(`UPDATE public.product_parents SET name=${q(name)} WHERE id=${q(destination)};`);
  const outcomeOnly=randomUUID();
  sql(`INSERT INTO public.product_parents(id,name,product_form,created_by,updated_by)
    VALUES (${q(outcomeOnly)},${q(name+' outcome only')},'liquid',${q(ADMIN)},${q(ADMIN)});`);
  call(commit([],[{parent_id:outcomeOnly,expected_outcome_version:0,outcome:'needs_label_data',note:'keep this note in history'}],tag+'-outcome-only'));
  // Fixture for a historical decision with no remaining rows; actual last-size movement is exercised above.
  sql(`UPDATE public.product_parents SET is_active=false WHERE id=${q(outcomeOnly)};`);
  const oldJson = download();
  const beforeInstall = snapshot();
  for (const [index, definition] of definitions.entries()) {
    const drift = definition.replace('$function$;', '-- deliberately wrong fixture predecessor\n$function$;');
    const result = sql(`BEGIN; ${drift}\n${migration}`, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /INACTIVE_RATE_REVIEW_PREFLIGHT/);
    assert.equal(snapshot(), beforeInstall, `drift case ${index} wrote data`);
  }
  console.log('[inactive] all four predecessor mutations refuse before installation and roll back');

  const secret = randomBytes(32).toString('hex');
  function token(actor) {
    const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const claims = Buffer.from(JSON.stringify({role:'authenticated',sub:actor,exp:Math.floor(Date.now()/1000)+1800})).toString('base64url');
    return `${header}.${claims}.${createHmac('sha256',secret).update(header+'.'+claims).digest('base64url')}`;
  }
  function rest(body, actor = ADMIN) {
    const args = ['exec',container,'curl','-sS','--max-time','5','-X','POST','http://127.0.0.1:3000/rpc/get_rate_review_workbook',
      '-H','Content-Type: application/json','-H',`Authorization: Bearer ${token(actor)}`,'--data',JSON.stringify(body),'-w','\n%{http_code}'];
    const result = docker(args,undefined,true);
    const lines = result.stdout.trim().split('\n');
    return {status:Number(lines.pop()),body:lines.join('\n'),exit:result.status};
  }
  let apiStarted = false;
  try {
    docker(['run','-d','--name',apiName,'--label',`crx.proof.owner=${process.pid}`,'--network',`container:${container}`,
      '-e','PGRST_DB_URI=postgres://postgres:postgres@127.0.0.1/postgres','-e','PGRST_DB_SCHEMAS=public',
      '-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,POSTGREST_IMAGE]);
    apiStarted = true;
    let oldResponse;
    for (let i=0;i<50;i++) { oldResponse=rest({}); if(oldResponse.status===200)break; await new Promise((resolve)=>setTimeout(resolve,100)); }
    assert.equal(oldResponse.status,200,oldResponse.body);
    assert.deepEqual(JSON.parse(oldResponse.body),oldJson);
    assert.notEqual(rest({p_include_inactive:true}).status,200,'new argument must be absent before install');
    sql(migration);
    assert.equal(snapshot(),beforeInstall,'candidate must not backfill data');
    let historyResponse;
    for(let i=0;i<50;i++){historyResponse=rest({p_include_inactive:true});if(historyResponse.status===200)break;await new Promise((resolve)=>setTimeout(resolve,100));}
    assert.equal(historyResponse.status,200,historyResponse.body);
    assert.deepEqual(JSON.parse(rest({}).body),oldJson,'old PostgREST empty-body request must retain the old JSON');
    const history=JSON.parse(historyResponse.body);
    const inactive=history.parents.find((p)=>p.parent_id===parent);
    assert.equal(inactive.is_active,false); assert.equal(inactive.rates[0].status,'approved');
    assert.equal(inactive.outcome,'approved_default');
    for(const [key,value] of Object.entries(oldJson.totals)) {
      assert.equal(history.totals[key],value,`active readiness total ${key} changed when history was requested`);
    }
    assert.ok(history.totals.inactive_parents>=1); assert.ok(history.totals.inactive_approved>=1);
    assert.equal(history.parents.filter((p)=>p.parent_name===name).length,2);
    console.log('[inactive] actual PostgREST: old empty body unchanged before/after; explicit history works after reload; active/inactive names coexist');

    const sameDecision={parent_id:parent,expected_outcome_version:inactive.outcome_version,outcome:inactive.outcome,note:inactive.outcome_note};
    refuse(commit([],[sameDecision],tag+'-reconfirm'),/PRODUCT_RATE_PARENT_INACTIVE/);
    const historicalDecision=history.parents.find((p)=>p.parent_id===outcomeOnly);
    refuse(commit([],[{parent_id:outcomeOnly,expected_outcome_version:historicalDecision.outcome_version,outcome:null,note:historicalDecision.outcome_note}],tag+'-clear-keep-note'),/note needs an outcome/);
    call(commit([],[{parent_id:outcomeOnly,expected_outcome_version:historicalDecision.outcome_version,outcome:null,note:null}],tag+'-clear'));
    assert.equal(download(true).parents.some((p)=>p.parent_id===outcomeOnly),false);
    assert.equal(scalar(`SELECT count(*) FROM public.product_rate_draft_events WHERE parent_id=${q(outcomeOnly)} AND before_values->>'note'='keep this note in history';`),'1');
    console.log('[inactive] explicit clear removes the associated note but retains it in history; identical non-null reconfirm refuses');

    const combinedBefore=snapshot();
    refuse(commit([{...reopen,recommended:'2'}],[],tag+'-no-partial-reopen-edit'),/PARENT_NOT_FOUND/);
    assert.equal(snapshot(),combinedBefore,'legacy reopen plus forbidden value edit must roll back the temporary reopen and outcome clearing');

    const previewBefore=snapshot();
    const preview=call(`SELECT public.preview_rate_review(${json([reopen])},'[]'::jsonb);`);
    assert.equal(preview.rates[0].status,'change'); assert.equal(snapshot(),previewBefore);
    const receipt=call(commit([reopen],[],tag+'-reopen'));
    assert.deepEqual(call(commit([reopen],[],tag+'-reopen')),receipt);
    refuse(commit([{...reopen,reason:'different request'}],[],tag+'-reopen'),/KEY_REUSED|IDEMPOTENCY|REPLAY/);
    let current=download(true).parents.find((p)=>p.parent_id===parent);
    assert.equal(current.rates[0].status,'draft'); assert.equal(current.outcome,null);
    const draft=row(parent,current.rates[0]);
    const noWrite=snapshot();
    refuse(commit([{...draft,decision:'approve'}],[],tag+'-no-approve'),/PRODUCT_RATE_PARENT_INACTIVE/);
    refuse(commit([{...draft,recommended:'2'}],[],tag+'-no-edit'),/PARENT_NOT_FOUND/);
    refuse(commit([{...draft,rate_id:null,expected_row_version:null}],[],tag+'-no-new'),/PARENT_NOT_FOUND/);
    for(const outcome of ['approved_default','no_per_acre_default','needs_label_data']) {
      refuse(commit([],[{parent_id:parent,expected_outcome_version:current.outcome_version,outcome,note:null}],tag+'-'+outcome),/PRODUCT_RATE_PARENT_INACTIVE/);
    }
    refuse(commit([{...draft,expected_row_version:0,decision:'delete',reason:'stale deletion'}],[],tag+'-stale'),/stale|changed/);
    refuse(commit([{...draft,parent_id:destination,decision:'delete',reason:'foreign parent'}],[],tag+'-foreign'),/different parent/);
    assert.equal(snapshot(),noWrite);
    call(commit([{...draft,decision:'delete',reason:'remove obsolete draft'}],[],tag+'-delete'));
    assert.equal(download(true).parents.some((p)=>p.parent_id===parent),false,'empty inactive group with null outcome must disappear');
    const driver=randomUUID(),applicator=randomUUID();
    sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
      (${q(driver)},${q(tag+'-driver@example.invalid')},${json({full_name:'[PROVER] '+tag+' driver',role:'driver'})}),
      (${q(applicator)},${q(tag+'-applicator@example.invalid')},${json({full_name:'[PROVER] '+tag+' applicator',role:'applicator'})});`);
    assert.equal(scalar(`SELECT role FROM public.profiles WHERE id=${q(driver)};`),'driver');
    assert.equal(scalar(`SELECT role FROM public.profiles WHERE id=${q(applicator)};`),'applicator');
    for(const actor of [REP,driver,applicator,null]) {
      refuse('SELECT public.get_rate_review_workbook(true);',/ADMIN_REQUIRED|permission denied/,actor);
      refuse(commit([],[],tag+'-denied-'+actor),/ADMIN_REQUIRED|permission denied/,actor);
    }
    assert.notEqual(rest({p_include_inactive:true},REP).status,200);
    assert.equal(scalar("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_rate_review_workbook';"),'1');
    console.log('[inactive] preview rollback, cleanup, replay, changed-key refusal, inactive new decisions/edits, stale/foreign identity and denied callers passed');

    const concurrent=call(`SELECT public.save_draft_product_rate(${q(destination)},NULL,NULL,'per_acre','house_standard',NULL,1,NULL,'pt',true,NULL,${q(tag+'-concurrent-seed')});`);
    let active=download(true).parents.find((p)=>p.parent_id===destination);
    call(commit([{...row(destination,active.rates.find((r)=>r.rate_id===concurrent.rate_id)),decision:'approve'}],[],tag+'-concurrent-approve'));
    active=download(true).parents.find((p)=>p.parent_id===destination);
    const concurrentRow=active.rates.find((r)=>r.rate_id===concurrent.rate_id);
    const third=randomUUID();
    sql(`INSERT INTO public.product_parents(id,name,product_form,created_by,updated_by)
      VALUES (${q(third)},${q(name+' third')},'liquid',${q(ADMIN)},${q(ADMIN)});`);
    const secondMove=call(`SELECT public.preview_move_product_size(${q(product)},${q(third)});`);
    const holderName=tag+'-holder',waiterName=tag+'-waiter';
    function connection() {
      const child=spawn('docker',psqlArgs,{cwd:ROOT,stdio:['pipe','pipe','pipe']});
      let stdout='',stderr=''; child.stdout.on('data',(value)=>{stdout+=value});child.stderr.on('data',(value)=>{stderr+=value});
      const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(status)=>resolve({status,stdout,stderr}))});
      return {child,done};
    }
    async function waitFor(query,expected) {
      for(let i=0;i<50;i++){if(scalar(query)===expected)return;await new Promise((resolve)=>setTimeout(resolve,50));}
      throw new Error('Did not observe '+expected+' for '+query);
    }
    const holder=connection();
    let waiter;
    try {
      holder.child.stdin.write(`SET application_name=${q(holderName)}; BEGIN;
        SELECT set_config('request.jwt.claims',${json({sub:ADMIN,role:'authenticated'})}::text,true); SET LOCAL ROLE authenticated;
        SELECT public.move_product_size(${q(product)},${q(third)},${secondMove.from_parent_version},${secondMove.to_parent_version},
          ${q(secondMove.size_fingerprint)},'proof: concurrent final-size move','invented fixture',${json(secondMove.prices)},${q(tag+'-concurrent-move')});\n`);
      await waitFor(`SELECT state FROM pg_stat_activity WHERE application_name=${q(holderName)};`,'idle in transaction');
      waiter=connection();
      waiter.child.stdin.end(`SET application_name=${q(waiterName)}; ${tx(ADMIN,commit([{...row(destination,concurrentRow),decision:'reopen',reason:'concurrent inactive cleanup'}],[],tag+'-concurrent-reopen'))}`);
      await waitFor(`SELECT wait_event_type FROM pg_stat_activity WHERE application_name=${q(waiterName)};`,'Lock');
      holder.child.stdin.end('COMMIT;\n');
      const [held,waiting]=await Promise.all([holder.done,waiter.done]);
      assert.equal(held.status,0,held.stderr);assert.equal(waiting.status,0,waiting.stderr);
      const after=download(true).parents.find((p)=>p.parent_id===destination);
      assert.equal(after.is_active,false);assert.equal(after.rates[0].status,'draft');
      refuse(commit([{...row(destination,concurrentRow),decision:'delete',reason:'stale second editor'}],[],tag+'-concurrent-stale'),/stale|changed/);
      console.log('[inactive] real last-size move holds parent lock; cleanup visibly waits, succeeds after deactivation, and stale second editor refuses');
    } finally {
      if(holder.child.exitCode===null)holder.child.stdin.end('ROLLBACK;\n');
      if(waiter&&waiter.child.exitCode===null)waiter.child.stdin.end();
      await Promise.all([holder.done,waiter?.done]);
    }
    console.log('INACTIVE_RATE_REVIEW_PROOF_PASS');
  } finally {
    if(apiStarted) {
      assert.equal(docker(['inspect','--format','{{index .Config.Labels "crx.proof.owner"}}',apiName]).stdout.trim(),String(process.pid));
      docker(['rm','-f',apiName]);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=spawnSync(process.execPath,['scripts/smoke/prove-product-rate-review-real-schema.mjs'],{cwd:ROOT,stdio:'inherit',env:process.env});
  if(result.error)throw result.error;
  process.exit(result.status??1);
}
