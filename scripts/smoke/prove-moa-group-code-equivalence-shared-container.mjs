#!/usr/bin/env node
/**
 * Focused real-schema proof for 20270115100000_moa_group_code_equivalence.
 * Uses only the already-running shared PG17, network-none proof container. All DDL and seed
 * rows live inside one transaction and are rolled back, including the temporary base MOA install.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const container = process.env.CRX_MOA_PROOF_CONTAINER || 'crx-brandb1b-47836-mwfbry5z';
assert.match(container, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'provide an existing isolated Docker proof container name');
const docker = (args, input, allowFailure = false) => {
  const r = spawnSync('docker', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || (!allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`);
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
};
const inspect = docker(['inspect', container, '--format', '{{.State.Running}} {{.HostConfig.NetworkMode}} {{.Config.Image}}']).output.trim();
assert.equal(inspect, 'true none public.ecr.aws/supabase/postgres:17.6.1.143', 'authorized shared proof container identity changed');
const active = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-c',
  "SELECT count(*) FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid() AND state='active' AND application_name NOT IN ('pg_net 0.20.3','pg_cron scheduler');"]).output.trim();
assert.equal(active, '0', 'shared proof container has an active non-idle proof session');
const read = (f) => readFileSync(path.join(root, f), 'utf8').replaceAll('\r\n', '\n');
const base = read('supabase/migrations/20270108100000_ingredient_modes_of_action.sql');
const candidate = read('supabase/migrations/20270115100000_moa_group_code_equivalence.sql');
const costPredicate = read('scripts/db-invariant-sweeps/predicates/cost-exposure-review.sql').replace(/;\s*$/, '');
const originalApply = read('supabase/migrations/20261211100000_product_chemistry_confirmed_swaps.sql');
const moaconfirm = (sql) => {
  const fn = sourceBodyFromText(sql, '_apply_parent_chemistry');
  return fn;
};
function sourceBodyFromText(text, name) {
  const match = new RegExp('CREATE (?:OR REPLACE )?FUNCTION public\\.' + name + '\\(').exec(text);
  assert.ok(match, `missing ${name} source`);
  const end = text.indexOf('$function$;', match.index);
  return /\$function\$(.*?)\$function\$;/s.exec(text.slice(match.index, end + '$function$;'.length))?.[1];
}
const oldApply=moaconfirm(originalApply), newApply=moaconfirm(candidate);
const exactConfirm=`IF v_moa.source <> 'epa_lookup' THEN\n          UPDATE public.product_parent_modes_of_action SET source = 'epa_lookup', row_version = row_version + 1, updated_by = v_actor, updated_at = now()\n           WHERE id = v_moa.id;\n          v_changed := true;\n        END IF;`;
const exactInsert=`INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, source, created_by, updated_by)\n        VALUES (p_parent_id, v_ing, v_scheme, v_code, CASE WHEN p_mode = 'epa' THEN 'epa_lookup' ELSE 'typed' END, v_actor, v_actor);`;
assert.ok(oldApply.includes(exactConfirm) && newApply.includes(exactConfirm), 'EPA exact-match confirmation body changed');
assert.ok(oldApply.includes(exactInsert) && newApply.includes(exactInsert), 'EPA insertion body changed');
assert.match(newApply,/IF NOT FOUND AND p_mode <> 'epa' THEN[\s\S]*?_moa_group_code_key\(group_code\)/,'canonical existing-row lookup must stay outside the exact EPA branch');
assert.match(newApply,/CASE WHEN p_mode = 'epa' THEN v_code ELSE public\._moa_group_code_key\(v_code\) END/,'EPA request identity must retain exact code spelling');
const record = read('docs/reference/migrations.d/20270115100000_moa_group_code_equivalence.md');
const rollback = /````sql\n([\s\S]*?)\n````/.exec(record)?.[1];
assert.ok(rollback, 'migration record must contain rollback SQL');
assert.match(rollback, /MOA_GROUP_EQUIVALENCE_ROLLBACK_NOT_IN_TRANSACTION/);
assert.equal((rollback.match(/md5\(replace\(\(SELECT prosrc/g) ?? []).length, 5, 'all five rollback body guards must normalize CRLF before hashing');
function sourceBody(file, name) {
  const text = read(file), match = new RegExp('CREATE (?:OR REPLACE )?FUNCTION public\\.' + name + '\\(').exec(text);
  assert.ok(match, `missing source body ${name}`);
  const end = text.indexOf('$function$;', match.index);
  return /\$function\$(.*?)\$function\$;/s.exec(text.slice(match.index, end + '$function$;'.length))?.[1];
}
const originals = [
  ['_ingredient_modes_input','(jsonb,text)','supabase/migrations/20270108100000_ingredient_modes_of_action.sql'],
  ['_parent_mode_groups','(uuid)','supabase/migrations/20270108100000_ingredient_modes_of_action.sql'],
  ['set_active_ingredient_modes','(uuid,jsonb,jsonb,text,text)','supabase/migrations/20270108100000_ingredient_modes_of_action.sql'],
  ['_apply_parent_chemistry','(uuid,jsonb,text,text,text)','supabase/migrations/20261211100000_product_chemistry_confirmed_swaps.sql'],
].map(([name,sig,file])=>({name,sig,hash:createHash('md5').update(sourceBody(file,name)).digest('hex')}));
console.log(`MOA prior-source prosrc MD5 (LF-normalized): ${originals.map(x=>`${x.name}=${x.hash}`).join(' ')};`);
const uid = 'd8000000-0000-4000-8000-00000000b1b1';
const rep = 'd8000000-0000-4000-8000-00000000b1b6';
const driver = 'd8000000-0000-4000-8000-00000000b1c0';
const applicator = 'd8000000-0000-4000-8000-00000000b1c1';
const roleIng = 'd8000000-0000-4000-8000-00000000b1c2';
const ing = 'd8000000-0000-4000-8000-00000000b1b2';
const ing2 = 'd8000000-0000-4000-8000-00000000b1b3';
const parent = 'd8000000-0000-4000-8000-00000000b1b4';
const ing3 = 'd8000000-0000-4000-8000-00000000b1b5';
const ing4 = 'd8000000-0000-4000-8000-00000000b1b7';
const acid = 'd8000000-0000-4000-8000-00000000b1b8';
const ester = 'd8000000-0000-4000-8000-00000000b1b9';
const swapSource = 'd8000000-0000-4000-8000-00000000b1ba';
const swapTarget = 'd8000000-0000-4000-8000-00000000b1bb';
const sql = `BEGIN;
${base}
INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
  ('${uid}','moa-equivalence@example.invalid','{"full_name":"[PROVER] MOA equivalence","role":"admin"}'),
  ('${rep}','moa-equivalence-rep@example.invalid','{"full_name":"[PROVER] MOA rep","role":"sales_rep"}'),
  ('${driver}','moa-equivalence-driver@example.invalid','{"full_name":"[PROVER] MOA driver","role":"driver"}'),
  ('${applicator}','moa-equivalence-applicator@example.invalid','{"full_name":"[PROVER] MOA applicator","role":"applicator"}');
SET session_replication_role = replica;
UPDATE public.profiles SET role='admin',is_active=true WHERE id='${uid}'; UPDATE public.profiles SET role='sales_rep',is_active=true WHERE id='${rep}'; UPDATE public.profiles SET role='driver',is_active=true WHERE id='${driver}'; UPDATE public.profiles SET role='applicator',is_active=true WHERE id='${applicator}';
INSERT INTO public.product_categories (name,sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
INSERT INTO public.active_ingredients (id,name,created_by,updated_by) VALUES
  ('${ing}','[PROVER] MOA equivalence','${uid}','${uid}'), ('${ing2}','[PROVER] MOA derived','${uid}','${uid}'), ('${ing3}','[PROVER] MOA consolidation source','${uid}','${uid}'), ('${ing4}','[PROVER] MOA request duplicate','${uid}','${uid}'), ('${roleIng}','[PROVER] MOA role matrix','${uid}','${uid}'), ('${swapSource}','[PROVER] MOA swap source','${uid}','${uid}'), ('${swapTarget}','[PROVER] MOA swap target','${uid}','${uid}');
INSERT INTO public.active_ingredients(id,name,is_parent_form,created_by,updated_by) VALUES ('${acid}','[PROVER] MOA acid',true,'${uid}','${uid}');
INSERT INTO public.active_ingredients(id,name,canonical_ingredient_id,canonical_fraction,fraction_basis,created_by,updated_by)
  VALUES ('${ester}','[PROVER] MOA ester','${acid}',0.8,'acid_equivalent','${uid}','${uid}');
INSERT INTO public.product_parents (id,name,product_form,formulation_type,category,is_active,created_by,updated_by)
  VALUES ('${parent}','[PROVER] MOA parent','liquid','SL','Herbicide',true,'${uid}','${uid}');
INSERT INTO public.product_parent_ingredients (parent_id,ingredient_id,strength_value,strength_unit,strength_basis,source,source_note,created_by,updated_by)
  VALUES ('${parent}','${ing2}',1,'pct_ww','active_ingredient','label','proof','${uid}','${uid}'),('${parent}','${ing3}',1,'pct_ww','active_ingredient','label','proof','${uid}','${uid}'),('${parent}','${ing4}',1,'pct_ww','active_ingredient','label','proof','${uid}','${uid}'),('${parent}','${ester}',1,'pct_ww','active_ingredient','label','proof','${uid}','${uid}'),('${parent}','${swapSource}',1,'pct_ww','active_ingredient','label','proof','${uid}','${uid}');
SET session_replication_role = origin;
INSERT INTO public.active_ingredient_modes_of_action (ingredient_id,scheme,group_code,source_note,created_by,updated_by)
  VALUES ('${ing2}','HRAC','M1','derived spelling','${uid}','${uid}'),('${acid}','HRAC','M1','acid derived spelling','${uid}','${uid}');
INSERT INTO public.product_parent_modes_of_action (parent_id,ingredient_id,scheme,group_code,source,created_by,updated_by)
  VALUES ('${parent}','${ing2}','HRAC','M01','typed','${uid}','${uid}'),('${parent}','${ing3}','HRAC','M1','typed','${uid}','${uid}'),('${parent}','${ester}','HRAC','M01','typed','${uid}','${uid}'),('${parent}','${ing4}','HRAC','M2','typed','${uid}','${uid}'),('${parent}','${ing4}','FRAC','M01','typed','${uid}','${uid}'),('${parent}','${swapSource}','HRAC','M01','typed','${uid}','${uid}');
CREATE TEMP TABLE cost_exposure_before AS
${costPredicate};
${candidate}
CREATE TEMP TABLE cost_exposure_after AS
${costPredicate};
SELECT 'COST_EXPOSURE_REKEY ' || COALESCE(regexp_replace(b.violation_key,'#[0-9a-f]{12}$',''),regexp_replace(a.violation_key,'#[0-9a-f]{12}$','')) || ' old=' || COALESCE(b.violation_key,'<absent>') || ' new=' || COALESCE(a.violation_key,'<absent>')
FROM cost_exposure_before b FULL JOIN cost_exposure_after a
  ON regexp_replace(b.violation_key,'#[0-9a-f]{12}$','') = regexp_replace(a.violation_key,'#[0-9a-f]{12}$','')
WHERE b.violation_key IS DISTINCT FROM a.violation_key
ORDER BY 1;
SELECT set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT public.set_active_ingredient_modes('${roleIng}','[]'::jsonb,'[{"scheme":"HRAC","group_code":"8","source_note":"admin role"}]'::jsonb,'admin SQL role proof','moa-role-admin');
RESET ROLE;
SELECT set_config('request.jwt.claims','{"sub":"${rep}","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $sales_rep_role$
DECLARE v_error text;
BEGIN
  BEGIN PERFORM public.set_active_ingredient_modes('${roleIng}','[]'::jsonb,'[]'::jsonb,'sales rep role proof','moa-role-rep');
    RAISE EXCEPTION 'MOA_PROOF: sales_rep role writer unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT; IF v_error NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE; END IF;
  END;
END
$sales_rep_role$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{"sub":"${driver}","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $driver_role$
DECLARE v_error text;
BEGIN
  BEGIN PERFORM public.set_active_ingredient_modes('${roleIng}','[]'::jsonb,'[]'::jsonb,'driver role proof','moa-role-driver');
    RAISE EXCEPTION 'MOA_PROOF: driver role writer unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT; IF v_error NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE; END IF;
  END;
END
$driver_role$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{"sub":"${applicator}","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $applicator_role$
DECLARE v_error text;
BEGIN
  BEGIN PERFORM public.set_active_ingredient_modes('${roleIng}','[]'::jsonb,'[]'::jsonb,'applicator role proof','moa-role-applicator');
    RAISE EXCEPTION 'MOA_PROOF: applicator role writer unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT; IF v_error NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE; END IF;
  END;
END
$applicator_role$;
RESET ROLE;
SELECT set_config('request.jwt.claims','',true);
SET LOCAL ROLE anon;
DO $anon_execute$
BEGIN
  BEGIN PERFORM public.set_active_ingredient_modes('${roleIng}','[]'::jsonb,'[]'::jsonb,'anon SQL role proof','moa-role-anon');
    RAISE EXCEPTION 'MOA_PROOF: anon EXECUTE unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$anon_execute$;
RESET ROLE;
DO $proof$
DECLARE v text; v_before jsonb; v_rows_before jsonb; v_events bigint; v_err text; v_version bigint; v_seed_result jsonb; v_replay jsonb; v_group jsonb; v_changes jsonb; v_preview text;
BEGIN
  IF public._moa_group_code_key('M001A02') <> 'M1A2'
     OR public._moa_group_code_key('M000') <> 'M0'
     OR public._moa_group_code_key('M000A') <> 'M0A'
     OR public._moa_group_code_key('M00A00B') <> public._moa_group_code_key('M00A0B')
     OR public._moa_group_code_key('M00A00B') <> 'M0A0B'
     OR public._moa_group_code_key('000A') <> '0A'
     OR public._moa_group_code_key('9999999999') <> '9999999999'
     OR public._moa_group_code_key('M-01') <> 'M-01'
     OR public._moa_group_code_key('M 01') <> 'M 01'
     OR public._moa_group_code_key('M٠1') <> 'M٠1' THEN
    RAISE EXCEPTION 'MOA_PROOF: comparison key altered unsupported text or missed ASCII zero normalization';
  END IF;
  BEGIN
    PERFORM public._ingredient_modes_input('[{"scheme":"FRAC","group_code":"M1","source_note":"proof"},{"scheme":"FRAC","group_code":"M01","source_note":"proof"}]'::jsonb,'proof');
    RAISE EXCEPTION 'MOA_PROOF: same-scheme aliases unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CHEMISTRY_MOA_INVALID:%' OR position('FRAC M1' in v_err)=0 OR position('FRAC M01' in v_err)=0 THEN RAISE; END IF;
  END;
  IF (SELECT e->>'group_code' FROM jsonb_array_elements(public._ingredient_modes_input('[{"scheme":"FRAC","group_code":"m01","source_note":"proof"},{"scheme":"HRAC","group_code":"M1","source_note":"proof"}]'::jsonb,'proof')) e WHERE e->>'scheme'='FRAC') <> 'M01' THEN
    RAISE EXCEPTION 'MOA_PROOF: accepted list did not preserve normalized requested spelling';
  END IF;
  PERFORM set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
  v_seed_result := public.set_active_ingredient_modes('${ing}', '[]'::jsonb,
    '[{"scheme":"FRAC","group_code":"M1","source_note":"first"}]'::jsonb, 'proof seed', 'moa-proof-seed');
  v_replay := public.set_active_ingredient_modes('${ing}', '[]'::jsonb,
    '[{"scheme":"FRAC","group_code":"M1","source_note":"first"}]'::jsonb, 'proof seed', 'moa-proof-seed');
  IF v_replay IS DISTINCT FROM v_seed_result THEN RAISE EXCEPTION 'MOA_PROOF: exact retry did not replay the saved result'; END IF;
  v_before := public._ingredient_mode_list('${ing}');
  SELECT count(*) INTO v_events FROM public.active_ingredient_events WHERE ingredient_id='${ing}';
  SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) INTO v_rows_before
    FROM public.active_ingredient_modes_of_action m WHERE m.ingredient_id='${ing}';
  IF (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='moa-proof-seed') <> 1 THEN RAISE EXCEPTION 'MOA_PROOF: exact retry wrote another receipt'; END IF;
  BEGIN
    PERFORM public.set_active_ingredient_modes('${ing}',v_before,
      '[{"scheme":"FRAC","group_code":"M1","source_note":"same-request first"},{"scheme":"FRAC","group_code":"M01","source_note":"same-request alias"}]'::jsonb,
      'proof same-request aliases','moa-proof-same-request-aliases');
    RAISE EXCEPTION 'MOA_PROOF: ingredient writer accepted same-request aliases';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CHEMISTRY_MOA_INVALID:%FRAC M01%FRAC M1%' THEN RAISE; END IF;
  END;
  IF public._ingredient_mode_list('${ing}') IS DISTINCT FROM v_before
     OR (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM public.active_ingredient_modes_of_action m WHERE m.ingredient_id='${ing}') IS DISTINCT FROM v_rows_before
     OR (SELECT count(*) FROM public.active_ingredient_events WHERE ingredient_id='${ing}') <> v_events
     OR (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='moa-proof-same-request-aliases') <> 0 THEN
    RAISE EXCEPTION 'MOA_PROOF: same-request alias refusal changed MOA rows/versions, events, or receipt';
  END IF;
  BEGIN
    PERFORM public.set_active_ingredient_modes('${ing}', '[]'::jsonb,
      '[{"scheme":"FRAC","group_code":"M1","source_note":"changed"}]'::jsonb, 'proof seed changed', 'moa-proof-seed');
    RAISE EXCEPTION 'MOA_PROOF: changed payload reused an idempotency key';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'IDEMPOTENCY_PAYLOAD_MISMATCH%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.set_active_ingredient_modes('${ing}', v_before,
      '[{"scheme":"FRAC","group_code":"M01","source_note":"alternate"}]'::jsonb, 'proof alternate spelling', 'moa-proof-alias');
    RAISE EXCEPTION 'MOA_PROOF: alternate active spelling unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CHEMISTRY_MOA_INVALID:%FRAC M01%FRAC M1%' THEN RAISE; END IF;
  END;
  IF public._ingredient_mode_list('${ing}') IS DISTINCT FROM v_before
     OR (SELECT count(*) FROM public.active_ingredient_events WHERE ingredient_id='${ing}') <> v_events
     OR (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='moa-proof-alias') <> 0 THEN
    RAISE EXCEPTION 'MOA_PROOF: rejected alternate spelling partially changed rows, history, or receipt';
  END IF;
  BEGIN
    PERFORM public.set_active_ingredient_modes('${ing}','[]'::jsonb,'[]'::jsonb,'stale list proof','moa-proof-stale-list');
    RAISE EXCEPTION 'MOA_PROOF: ingredient writer accepted a stale expected list';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'MOA_LIST_STALE:%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.active_ingredient_modes_of_action(ingredient_id,scheme,group_code,source_note,created_by,updated_by)
      VALUES ('${ing}','FRAC','M01','direct-write probe','${uid}','${uid}');
    RAISE EXCEPTION 'MOA_PROOF: canonical ingredient index accepted a direct alias insert';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  v_before := public._ingredient_mode_list('${ing}');
  PERFORM public.set_active_ingredient_modes('${ing}',v_before,'[]'::jsonb,'two-save retire proof','moa-proof-retire');
  v_before := public._ingredient_mode_list('${ing}');
  PERFORM public.set_active_ingredient_modes('${ing}',v_before,
    '[{"scheme":"FRAC","group_code":"M01","source_note":"second save"}]'::jsonb,'two-save add proof','moa-proof-add-after-retire');
  IF NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action WHERE ingredient_id='${ing}' AND scheme='FRAC' AND group_code='M1' AND status='retired')
     OR NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action WHERE ingredient_id='${ing}' AND scheme='FRAC' AND group_code='M01' AND status='active') THEN
    RAISE EXCEPTION 'MOA_PROOF: retire-then-add correction path did not preserve old history and accept the new spelling';
  END IF;
  SELECT i INTO v_group FROM jsonb_array_elements(public._parent_mode_groups('${parent}') -> 'ingredients') i WHERE i->>'ingredient_id'='${ing2}';
  IF v_group #>> '{schemes,0,status}' <> 'matches'
     OR v_group #>> '{schemes,0,derived,0}' <> 'M1'
     OR v_group #>> '{schemes,0,typed,0,group_code}' <> 'M01'
     OR public._parent_mode_groups('${parent}') #>> '{summary,0,group_code}' <> 'M01' THEN
    RAISE EXCEPTION 'MOA_PROOF: derived/typed alias comparison or stored spellings differ';
  END IF;
  UPDATE public.product_parent_modes_of_action SET group_code='M02'
   WHERE parent_id='${parent}' AND ingredient_id='${ing2}' AND scheme='HRAC' AND status='active';
  SELECT i INTO v_group FROM jsonb_array_elements(public._parent_mode_groups('${parent}') -> 'ingredients') i WHERE i->>'ingredient_id'='${ing2}';
  IF v_group #>> '{schemes,0,status}' <> 'differs'
     OR v_group #>> '{schemes,0,derived,0}' <> 'M1'
     OR v_group #>> '{schemes,0,typed,0,group_code}' <> 'M02' THEN
    RAISE EXCEPTION 'MOA_PROOF: genuinely different typed and derived sets must remain differs and retain both sides';
  END IF;
  UPDATE public.product_parent_modes_of_action SET group_code='M01'
   WHERE parent_id='${parent}' AND ingredient_id='${ing2}' AND scheme='HRAC' AND group_code='M02' AND status='active';
  SELECT i INTO v_group FROM jsonb_array_elements(public._parent_mode_groups('${parent}') -> 'ingredients') i WHERE i->>'ingredient_id'='${ester}';
  IF v_group #>> '{derived_from}' <> 'from_acid'
     OR v_group #>> '{schemes,0,status}' <> 'matches'
     OR v_group #>> '{schemes,0,derived,0}' <> 'M1'
     OR v_group #>> '{schemes,0,typed,0,group_code}' <> 'M01' THEN
    RAISE EXCEPTION 'MOA_PROOF: acid-fallback alias comparison did not preserve source spellings';
  END IF;
  IF jsonb_array_length(public._parent_mode_groups('${parent}') -> 'summary') <> 3
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public._parent_mode_groups('${parent}') -> 'summary') s WHERE s->>'scheme'='HRAC' AND s->>'group_code'='M01')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public._parent_mode_groups('${parent}') -> 'summary') s WHERE s->>'scheme'='HRAC' AND s->>'group_code'='M2')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public._parent_mode_groups('${parent}') -> 'summary') s WHERE s->>'scheme'='FRAC' AND s->>'group_code'='M01') THEN
    RAISE EXCEPTION 'MOA_PROOF: summary must collapse aliases while keeping distinct groups and schemes separate';
  END IF;
  SELECT COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id='${parent}'),0) INTO v_version;
  BEGIN
    PERFORM public.set_parent_chemistry('${parent}',v_version,
      '[{"kind":"mode_of_action","ingredient_id":"${ing2}","scheme":"HRAC","group_code":"M1"}]'::jsonb,
      'moa-product-alias-proof');
    RAISE EXCEPTION 'MOA_PROOF: product writer accepted alternate active spelling';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CHEMISTRY_ROW_EXISTS:%HRAC M1%HRAC M01%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.set_parent_chemistry('${parent}',v_version,
      '[{"kind":"mode_of_action","ingredient_id":"${ing4}","scheme":"HRAC","group_code":"M1"},{"kind":"mode_of_action","ingredient_id":"${ing4}","scheme":"HRAC","group_code":"M01"}]'::jsonb,
      'moa-product-request-alias-proof');
    RAISE EXCEPTION 'MOA_PROOF: product writer accepted two aliases in one request';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CHEMISTRY_DUPLICATE_CHANGE:%' OR position('HRAC M1' in v_err)=0 OR position('HRAC M01' in v_err)=0 THEN RAISE; END IF;
  END;
  -- Same-request aliases are named even when one of them is already the active stored spelling.
  BEGIN
    PERFORM public.set_parent_chemistry('${parent}',v_version,
      '[{"kind":"mode_of_action","ingredient_id":"${ing2}","scheme":"HRAC","group_code":"M01"},{"kind":"mode_of_action","ingredient_id":"${ing2}","scheme":"HRAC","group_code":"M1"}]'::jsonb,
      'moa-product-request-alias-active-proof');
    RAISE EXCEPTION 'MOA_PROOF: product writer accepted two aliases of an active row in one request';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err NOT LIKE 'CHEMISTRY_DUPLICATE_CHANGE:%' OR position('HRAC M1' in v_err)=0 OR position('HRAC M01' in v_err)=0 THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.product_parent_modes_of_action(parent_id,ingredient_id,scheme,group_code,created_by,updated_by)
      VALUES ('${parent}','${ing2}','HRAC','M1','${uid}','${uid}');
    RAISE EXCEPTION 'MOA_PROOF: canonical product index accepted a direct alias insert';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF NOT has_function_privilege('authenticated','public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text)','EXECUTE')
     OR has_function_privilege('anon','public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'MOA_PROOF: ingredient writer grants differ for authenticated and anon';
  END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"${rep}","role":"authenticated"}',true);
  BEGIN
    PERFORM public.set_active_ingredient_modes('${ing}','[]'::jsonb,'[]'::jsonb,'rep role proof','moa-proof-rep');
    RAISE EXCEPTION 'MOA_PROOF: non-admin ingredient writer succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err=MESSAGE_TEXT;
    IF v_err NOT LIKE 'ADMIN_REQUIRED%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims','',true);
  BEGIN
    PERFORM public.set_active_ingredient_modes('${ing}','[]'::jsonb,'[]'::jsonb,'anon role proof','moa-proof-anon');
    RAISE EXCEPTION 'MOA_PROOF: anonymous ingredient writer succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err=MESSAGE_TEXT;
    IF v_err NOT LIKE 'AUTH_REQUIRED%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated"}',true);
  PERFORM public.set_parent_chemistry('${parent}',v_version,
    '[{"kind":"mode_of_action","ingredient_id":"${ing2}","scheme":"FRAC","group_code":"M01"}]'::jsonb,
    'moa-cross-scheme-proof');
  IF (SELECT group_code FROM public.product_parent_modes_of_action WHERE parent_id='${parent}' AND ingredient_id='${ing2}' AND status='active' AND scheme='FRAC') <> 'M01' THEN
    RAISE EXCEPTION 'MOA_PROOF: cross-scheme spelling was not accepted or preserved';
  END IF;
  SELECT chemistry_version INTO v_version FROM public.product_parent_chemistry_state WHERE parent_id='${parent}';
  v_changes := jsonb_build_array(jsonb_build_object('kind','ingredient','action','consolidate',
      'row_id',(SELECT id FROM public.product_parent_ingredients WHERE parent_id='${parent}' AND ingredient_id='${ing3}' AND status='active'),
      'into_row_id',(SELECT id FROM public.product_parent_ingredients WHERE parent_id='${parent}' AND ingredient_id='${ing2}' AND status='active'),
      'strength_value',1,'strength_unit','pct_ww','strength_basis','active_ingredient','source','label','source_note','proof',
      'modes_of_action',jsonb_build_array(jsonb_build_object('scheme','HRAC','group_code','M1'))));
  v_preview := public._chemistry_preview_fingerprint('${parent}',v_changes);
  PERFORM public.correct_parent_chemistry('${parent}',v_version,v_preview,v_changes,
    'proof consolidation','evidence snapshot','moa-proof-consolidation');
  IF (SELECT group_code FROM public.product_parent_modes_of_action WHERE parent_id='${parent}' AND ingredient_id='${ing2}' AND status='active' AND scheme='HRAC') <> 'M01'
     OR EXISTS (SELECT 1 FROM public.product_parent_modes_of_action WHERE parent_id='${parent}' AND ingredient_id='${ing2}' AND status='active' AND scheme='HRAC' AND group_code='M1')
     OR NOT EXISTS (SELECT 1 FROM public.product_parent_modes_of_action WHERE parent_id='${parent}' AND ingredient_id='${ing3}' AND status='retired' AND scheme='HRAC' AND group_code='M1') THEN
    RAISE EXCEPTION 'MOA_PROOF: consolidation failed to keep destination spelling and retire selected source history';
  END IF;
  SELECT chemistry_version INTO v_version FROM public.product_parent_chemistry_state WHERE parent_id='${parent}';
  v_changes := jsonb_build_array(jsonb_build_object('kind','ingredient','action','consolidate',
      'row_id',(SELECT id FROM public.product_parent_ingredients WHERE parent_id='${parent}' AND ingredient_id='${ing4}' AND status='active'),
      'into_row_id',(SELECT id FROM public.product_parent_ingredients WHERE parent_id='${parent}' AND ingredient_id='${ing2}' AND status='active'),
      'strength_value',1,'strength_unit','pct_ww','strength_basis','active_ingredient','source','label','source_note','proof',
      'modes_of_action',jsonb_build_array(jsonb_build_object('scheme','HRAC','group_code','M2'))));
  v_preview := public._chemistry_preview_fingerprint('${parent}',v_changes);
  PERFORM public.correct_parent_chemistry('${parent}',v_version,v_preview,v_changes,
    'proof consolidation new group','evidence snapshot','moa-proof-consolidation-new-group');
  IF NOT EXISTS (SELECT 1 FROM public.product_parent_modes_of_action WHERE parent_id='${parent}' AND ingredient_id='${ing2}' AND status='active' AND scheme='HRAC' AND group_code='M2')
     OR NOT EXISTS (SELECT 1 FROM public.product_parent_modes_of_action WHERE parent_id='${parent}' AND ingredient_id='${ing4}' AND status='retired' AND scheme='HRAC' AND group_code='M2') THEN
    RAISE EXCEPTION 'MOA_PROOF: consolidation without an equivalent destination group did not insert the source spelling';
  END IF;
  SELECT chemistry_version INTO v_version FROM public.product_parent_chemistry_state WHERE parent_id='${parent}';
  v_changes := jsonb_build_array(jsonb_build_object('kind','ingredient','action','swap',
      'row_id',(SELECT id FROM public.product_parent_ingredients WHERE parent_id='${parent}' AND ingredient_id='${swapSource}' AND status='active'),
      'ingredient_id','${swapTarget}',
      'strength_value',1,'strength_unit','pct_ww','strength_basis','active_ingredient','source','label','source_note','proof',
      'modes_of_action',jsonb_build_array(jsonb_build_object('scheme','HRAC','group_code','M01'))));
  v_preview := public._chemistry_preview_fingerprint('${parent}',v_changes);
  PERFORM public.correct_parent_chemistry('${parent}',v_version,v_preview,v_changes,
    'proof swap spelling','evidence snapshot','moa-proof-swap-spelling');
  IF NOT EXISTS (SELECT 1 FROM public.product_parent_modes_of_action WHERE parent_id='${parent}' AND ingredient_id='${swapTarget}' AND status='active' AND scheme='HRAC' AND group_code='M01')
     OR NOT EXISTS (SELECT 1 FROM public.product_parent_modes_of_action WHERE parent_id='${parent}' AND ingredient_id='${swapSource}' AND status='retired' AND scheme='HRAC' AND group_code='M01') THEN
    RAISE EXCEPTION 'MOA_PROOF: swap did not preserve the selected exact spelling';
  END IF;
END
$proof$;
${rollback}
DO $rollback_proof$
BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES
${originals.map(x=>`    ('${x.name}','${x.sig}','${x.hash}')`).join(',\n')}
  ) AS expected(name,sig,body_md5)
  JOIN pg_proc p ON p.oid = (('public.' || expected.name || expected.sig)::regprocedure)
  WHERE md5(replace(p.prosrc,chr(13),'')) <> expected.body_md5)
     OR to_regprocedure('public._moa_group_code_key(text)') IS NOT NULL
     OR to_regclass('public.active_ingredient_modes_of_action_canonical_one_active') IS NOT NULL
     OR to_regclass('public.product_parent_modes_of_action_canonical_one_active') IS NOT NULL THEN
    RAISE EXCEPTION 'MOA_PROOF: rollback did not restore original function bodies or remove candidate objects';
  END IF;
END
$rollback_proof$;
ROLLBACK;
`;
const tmp = path.join(tmpdir(), `moa-equivalence-${process.pid}.sql`);
writeFileSync(tmp, sql, 'utf8');
try {
  docker(['cp', tmp, `${container}:/tmp/moa-equivalence-proof.sql`]);
  const r = docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/moa-equivalence-proof.sql'], undefined, true);
  assert.equal(r.status, 0, r.output);
  const after = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-c',
    "SELECT (to_regclass('public.active_ingredient_modes_of_action') IS NULL)::text || ':' || (to_regprocedure('public._moa_group_code_key(text)') IS NULL)::text || ':' || (to_regclass('public.active_ingredient_modes_of_action_canonical_one_active') IS NULL)::text;"]).output.trim();
  assert.equal(after, 'true:true:true', 'transaction rollback left candidate MOA objects installed');
  const rbTmp = path.join(tmpdir(), `moa-equivalence-rollback-${process.pid}.sql`);
  const rollbackStateSetup = `CREATE TEMP VIEW moa_equivalence_candidate_state AS
SELECT 'function:' || p.oid::regprocedure::text AS object_name,
       md5(pg_get_functiondef(p.oid) || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || COALESCE(array_to_string(p.proconfig,','),'') || '|' || COALESCE(p.proacl::text,'')) AS fingerprint
  FROM pg_proc p WHERE p.oid IN (
    'public._ingredient_modes_input(jsonb,text)'::regprocedure,'public._parent_mode_groups(uuid)'::regprocedure,
    'public.set_active_ingredient_modes(uuid,jsonb,jsonb,text,text)'::regprocedure,'public._apply_parent_chemistry(uuid,jsonb,text,text,text)'::regprocedure,
    'public._moa_group_code_key(text)'::regprocedure)
UNION ALL
SELECT 'index:' || i.indexrelid::regclass::text,
       md5(pg_get_indexdef(i.indexrelid) || '|' || i.indisvalid::text || '|' || i.indisready::text || '|' || i.indislive::text || '|' || c.relowner::regrole::text)
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
 WHERE i.indexrelid IN ('public.active_ingredient_modes_of_action_canonical_one_active'::regclass,'public.product_parent_modes_of_action_canonical_one_active'::regclass);
CREATE TEMP TABLE moa_equivalence_candidate_state_before AS SELECT * FROM moa_equivalence_candidate_state;
`;
  const rollbackStateAssert = `DO $state$
BEGIN
  IF EXISTS (SELECT * FROM moa_equivalence_candidate_state EXCEPT SELECT * FROM moa_equivalence_candidate_state_before)
     OR EXISTS (SELECT * FROM moa_equivalence_candidate_state_before EXCEPT SELECT * FROM moa_equivalence_candidate_state) THEN
    RAISE EXCEPTION 'MOA_PROOF: rollback refusal changed candidate function/index metadata';
  END IF;
END $state$;
`;
  const rbGuardTest = `\\set ON_ERROR_STOP on\nBEGIN;\n\\i /tmp/moa-equivalence-base.sql\n\\i /tmp/moa-equivalence-candidate.sql\n${rollbackStateSetup}\nSAVEPOINT rollback_guard_test;\nCREATE OR REPLACE FUNCTION public._moa_group_code_key(p_code text) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = public, pg_temp AS $changed$ SELECT p_code || 'changed' $changed$;\n\\set ON_ERROR_STOP off\n\\i /tmp/moa-equivalence-rollback.sql\n\\if :ERROR\n\\echo EXPECTED_ROLLBACK_BODY_GUARD_REFUSAL\n\\else\n\\echo ROLLBACK_BODY_GUARD_DID_NOT_REFUSE\n\\quit 9\n\\endif\n\\set ON_ERROR_STOP on\nROLLBACK TO SAVEPOINT rollback_guard_test;\n${rollbackStateAssert}DROP VIEW moa_equivalence_candidate_state; DROP TABLE moa_equivalence_candidate_state_before;\n\\i /tmp/moa-equivalence-rollback.sql\nDO $ok$ BEGIN IF to_regprocedure('public._moa_group_code_key(text)') IS NOT NULL THEN RAISE EXCEPTION 'rollback helper remains'; END IF; END $ok$;\nROLLBACK;\n`;
  writeFileSync(rbTmp, rbGuardTest, 'utf8');
  try {
    docker(['cp', path.join(root, 'supabase/migrations/20270108100000_ingredient_modes_of_action.sql'), `${container}:/tmp/moa-equivalence-base.sql`]);
    docker(['cp', path.join(root, 'supabase/migrations/20270115100000_moa_group_code_equivalence.sql'), `${container}:/tmp/moa-equivalence-candidate.sql`]);
    docker(['cp', path.join(root, 'docs/reference/migrations.d/20270115100000_moa_group_code_equivalence.md'), `${container}:/tmp/moa-equivalence-record.md`]);
    const rbText = /````sql\n([\s\S]*?)\n````/.exec(read('docs/reference/migrations.d/20270115100000_moa_group_code_equivalence.md'))?.[1];
    assert.ok(rbText);
    const rbOnly = path.join(tmpdir(), `moa-equivalence-rb-${process.pid}.sql`);
    writeFileSync(rbOnly, rbText, 'utf8');
    try { docker(['cp', rbOnly, `${container}:/tmp/moa-equivalence-rollback.sql`]); }
    finally { try { unlinkSync(rbOnly); } catch {} }
    const outsideTx = docker(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-f','/tmp/moa-equivalence-rollback.sql'], undefined, true);
    assert.notEqual(outsideTx.status, 0, 'rollback must refuse outside an explicit transaction');
    assert.match(outsideTx.output,/MOA_GROUP_EQUIVALENCE_ROLLBACK_NOT_IN_TRANSACTION/);
    const afterOutsideTx = docker(['exec',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-c',
      "SELECT (to_regprocedure('public._moa_group_code_key(text)') IS NULL)::text || ':' || (to_regclass('public.active_ingredient_modes_of_action_canonical_one_active') IS NULL)::text;"]).output.trim();
    assert.equal(afterOutsideTx,'true:true','out-of-transaction refusal left persistent candidate objects');
    docker(['cp', rbTmp, `${container}:/tmp/moa-equivalence-rollback-proof.sql`]);
    const guarded = docker(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-f','/tmp/moa-equivalence-rollback-proof.sql'], undefined, true);
    assert.equal(guarded.status, 0, guarded.output);
    assert.match(guarded.output, /EXPECTED_ROLLBACK_BODY_GUARD_REFUSAL/);
    assert.match(guarded.output, /MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: _moa_group_code_key body changed/);
    const afterGuard = docker(['exec',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-c',
      "SELECT (to_regprocedure('public._moa_group_code_key(text)') IS NULL)::text || ':' || (to_regclass('public.active_ingredient_modes_of_action') IS NULL)::text;"]).output.trim();
    assert.equal(afterGuard, 'true:true', 'rollback guard proof transaction left objects behind');
    const rbCallerTmp = path.join(tmpdir(), `moa-equivalence-rollback-caller-${process.pid}.sql`);
    const rbCallerTest = `\\set ON_ERROR_STOP on\nBEGIN;\n\\i /tmp/moa-equivalence-base.sql\n\\i /tmp/moa-equivalence-candidate.sql\n${rollbackStateSetup}\nSAVEPOINT rollback_later_caller_guard;\nCREATE SCHEMA moa_future_probe;\nCREATE FUNCTION moa_future_probe.call_group() RETURNS text LANGUAGE plpgsql AS $later$ BEGIN RETURN public._moa_group_code_key('M01'); END $later$;\nCREATE FUNCTION moa_future_probe.call_group_upper() RETURNS text LANGUAGE plpgsql AS $upper$ BEGIN RETURN public._MOA_GROUP_CODE_KEY('M01'); END $upper$;\nDO $no_catalog_dependency$ BEGIN IF EXISTS (SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass AND objid IN ('moa_future_probe.call_group()'::regprocedure,'moa_future_probe.call_group_upper()'::regprocedure) AND refclassid='pg_proc'::regclass AND refobjid='public._moa_group_code_key(text)'::regprocedure) THEN RAISE EXCEPTION 'fixture unexpectedly has a tracked PL/pgSQL call dependency'; END IF; END $no_catalog_dependency$;\n\\set ON_ERROR_STOP off\n\\i /tmp/moa-equivalence-rollback.sql\n\\if :ERROR\n\\echo EXPECTED_ROLLBACK_LATER_CALLER_REFUSAL\n\\else\n\\echo ROLLBACK_LATER_CALLER_DID_NOT_REFUSE\n\\quit 9\n\\endif\n\\set ON_ERROR_STOP on\nROLLBACK TO SAVEPOINT rollback_later_caller_guard;\n${rollbackStateAssert}DROP VIEW moa_equivalence_candidate_state; DROP TABLE moa_equivalence_candidate_state_before;\n\\i /tmp/moa-equivalence-rollback.sql\nDO $ok$ BEGIN IF to_regprocedure('public._moa_group_code_key(text)') IS NOT NULL OR to_regnamespace('moa_future_probe') IS NOT NULL THEN RAISE EXCEPTION 'rollback did not remove candidate helper/schema'; END IF; END $ok$;\nROLLBACK;\n`;
    writeFileSync(rbCallerTmp, rbCallerTest, 'utf8');
    try {
      docker(['cp',rbCallerTmp,`${container}:/tmp/moa-equivalence-rollback-caller-proof.sql`]);
      const callerGuard=docker(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-f','/tmp/moa-equivalence-rollback-caller-proof.sql'],undefined,true);
      assert.equal(callerGuard.status,0,callerGuard.output);
      assert.match(callerGuard.output,/EXPECTED_ROLLBACK_LATER_CALLER_REFUSAL/);
      assert.match(callerGuard.output,/MOA_GROUP_EQUIVALENCE_ROLLBACK_REFUSED: helper has later pg_proc source consumers/);
      assert.match(callerGuard.output,/moa_future_probe.call_group\(\)/);
      assert.match(callerGuard.output,/moa_future_probe.call_group_upper\(\)/);
      const afterCallerGuard=docker(['exec',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-c',
        "SELECT (to_regprocedure('public._moa_group_code_key(text)') IS NULL)::text || ':' || (to_regclass('public.active_ingredient_modes_of_action_canonical_one_active') IS NULL)::text;"]).output.trim();
      assert.equal(afterCallerGuard,'true:true','later-caller guard proof transaction left candidate objects behind');
    } finally { try{unlinkSync(rbCallerTmp);}catch{} }
    const crlfCandidate = path.join(tmpdir(), `moa-equivalence-candidate-crlf-${process.pid}.sql`);
    writeFileSync(crlfCandidate, readFileSync(path.join(root, 'supabase/migrations/20270115100000_moa_group_code_equivalence.sql'), 'utf8').replaceAll('\r\n','\n').replaceAll('\n','\r\n'), 'utf8');
    const crlfProof = path.join(tmpdir(), `moa-equivalence-crlf-proof-${process.pid}.sql`);
    writeFileSync(crlfProof, `\\set ON_ERROR_STOP on\nBEGIN;\n\\i /tmp/moa-equivalence-base.sql\n\\i /tmp/moa-equivalence-candidate-crlf.sql\n\\i /tmp/moa-equivalence-rollback.sql\nDO $crlf$ BEGIN IF to_regprocedure('public._moa_group_code_key(text)') IS NOT NULL OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid='public._ingredient_modes_input(jsonb,text)'::regprocedure),chr(13),'')) <> '${originals[0].hash}' THEN RAISE EXCEPTION 'CRLF rollback did not restore normalized source'; END IF; END $crlf$;\nROLLBACK;\n`, 'utf8');
    try {
      docker(['cp',crlfCandidate,`${container}:/tmp/moa-equivalence-candidate-crlf.sql`]);
      docker(['cp',crlfProof,`${container}:/tmp/moa-equivalence-crlf-proof.sql`]);
      const crlf = docker(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-f','/tmp/moa-equivalence-crlf-proof.sql'], undefined, true);
      assert.equal(crlf.status,0,crlf.output);
      assert.match(crlf.output,/ROLLBACK/);
    } finally { try{unlinkSync(crlfCandidate);}catch{} try{unlinkSync(crlfProof);}catch{} }
  } finally { try { unlinkSync(rbTmp); } catch {} }
  const collisionSql = `\\set ON_ERROR_STOP on\nBEGIN;\n\\i /tmp/moa-equivalence-base.sql\nINSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${uid}','moa-collision@example.invalid','{"full_name":"[PROVER] MOA collision","role":"admin"}');\nSET session_replication_role=replica; UPDATE public.profiles SET role='admin',is_active=true WHERE id='${uid}'; INSERT INTO public.active_ingredients(id,name,created_by,updated_by) VALUES ('${ing}','[PROVER] collision','${uid}','${uid}'); INSERT INTO public.product_categories(name,sort_order) VALUES ('Herbicide',60) ON CONFLICT DO NOTHING; INSERT INTO public.product_parents(id,name,product_form,formulation_type,category,is_active,created_by,updated_by) VALUES ('${parent}','[PROVER] collision','liquid','SL','Herbicide',true,'${uid}','${uid}'); SET session_replication_role=origin;\nINSERT INTO public.active_ingredient_modes_of_action(ingredient_id,scheme,group_code,source_note,created_by,updated_by) VALUES ('${ing}','FRAC','M1','proof','${uid}','${uid}'),('${ing}','FRAC','M01','proof','${uid}','${uid}');\nINSERT INTO public.product_parent_modes_of_action(parent_id,ingredient_id,scheme,group_code,created_by,updated_by) VALUES ('${parent}','${ing}','FRAC','M1','${uid}','${uid}'),('${parent}','${ing}','FRAC','M01','${uid}','${uid}');\nSAVEPOINT collision_preflight;\n\\set ON_ERROR_STOP off\n\\i /tmp/moa-equivalence-candidate.sql\n\\if :ERROR\n\\echo EXPECTED_CANONICAL_COLLISION_PREFLIGHT\n\\else\n\\echo COLLISION_PREFLIGHT_DID_NOT_REFUSE\n\\quit\n\\endif\n\\set ON_ERROR_STOP on\nROLLBACK TO SAVEPOINT collision_preflight;\nDO $collision$ BEGIN IF (SELECT count(*) FROM public.active_ingredient_modes_of_action WHERE ingredient_id='${ing}') <> 2 OR (SELECT count(*) FROM public.product_parent_modes_of_action WHERE parent_id='${parent}') <> 2 OR to_regprocedure('public._moa_group_code_key(text)') IS NOT NULL THEN RAISE EXCEPTION 'collision refusal was partial'; END IF; END $collision$;\nUPDATE public.active_ingredient_modes_of_action SET status='retired' WHERE ingredient_id='${ing}' AND group_code='M01';\nUPDATE public.product_parent_modes_of_action SET status='retired' WHERE parent_id='${parent}' AND group_code='M01';\n\\i /tmp/moa-equivalence-candidate.sql\n\\i /tmp/moa-equivalence-rollback.sql\nROLLBACK;\n`;
  const collisionTmp=path.join(tmpdir(),`moa-equivalence-collision-${process.pid}.sql`);
  writeFileSync(collisionTmp,collisionSql,'utf8');
  try {
    docker(['cp',collisionTmp,`${container}:/tmp/moa-equivalence-collision-proof.sql`]);
    const collision=docker(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-f','/tmp/moa-equivalence-collision-proof.sql'],undefined,true);
    assert.equal(collision.status,0,collision.output);
    assert.match(collision.output,/EXPECTED_CANONICAL_COLLISION_PREFLIGHT/);
    assert.match(collision.output,/MOA_GROUP_EQUIVALENCE_COLLISIONS/);
    const afterCollision=docker(['exec',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-c',
      "SELECT (to_regprocedure('public._moa_group_code_key(text)') IS NULL)::text || ':' || (to_regclass('public.active_ingredient_modes_of_action') IS NULL)::text;"]).output.trim();
    assert.equal(afterCollision,'true:true','collision proof transaction left objects behind');
  } finally { try{unlinkSync(collisionTmp);}catch{} }
  const driftSql=`\\set ON_ERROR_STOP on\nBEGIN;\n\\i /tmp/moa-equivalence-base.sql\nCREATE OR REPLACE FUNCTION public._ingredient_modes_input(p_modes jsonb,p_label text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $drift$ SELECT '[]'::jsonb $drift$;\nSAVEPOINT source_drift_guard;\n\\set ON_ERROR_STOP off\n\\i /tmp/moa-equivalence-candidate.sql\n\\if :ERROR\n\\echo EXPECTED_SOURCE_BODY_DRIFT_REFUSAL\n\\else\n\\echo SOURCE_BODY_DRIFT_DID_NOT_REFUSE\n\\quit\n\\endif\n\\set ON_ERROR_STOP on\nROLLBACK TO SAVEPOINT source_drift_guard;\nDO $drift_check$ BEGIN IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid='public._ingredient_modes_input(jsonb,text)'::regprocedure),chr(13),''))='c8833aee7021ae4cbabb82f71cf5aaec' OR to_regprocedure('public._moa_group_code_key(text)') IS NOT NULL OR to_regclass('public.active_ingredient_modes_of_action_canonical_one_active') IS NOT NULL OR to_regclass('public.product_parent_modes_of_action_canonical_one_active') IS NOT NULL THEN RAISE EXCEPTION 'source drift refusal altered a function or left candidate objects'; END IF; END $drift_check$;\nROLLBACK;\n`;
  const driftTmp=path.join(tmpdir(),`moa-equivalence-source-drift-${process.pid}.sql`);
  writeFileSync(driftTmp,driftSql,'utf8');
  try {
    docker(['cp',driftTmp,`${container}:/tmp/moa-equivalence-source-drift-proof.sql`]);
    const drift=docker(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-f','/tmp/moa-equivalence-source-drift-proof.sql'],undefined,true);
    assert.equal(drift.status,0,drift.output);
    assert.match(drift.output,/EXPECTED_SOURCE_BODY_DRIFT_REFUSAL/);
    assert.match(drift.output,/MOA_GROUP_EQUIVALENCE_SOURCE_DRIFT/);
    const afterDrift=docker(['exec',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-c',
      "SELECT (to_regprocedure('public._moa_group_code_key(text)') IS NULL)::text || ':' || (to_regclass('public.active_ingredient_modes_of_action_canonical_one_active') IS NULL)::text || ':' || (to_regclass('public.active_ingredient_modes_of_action') IS NULL)::text;"]).output.trim();
    assert.equal(afterDrift,'true:true:true','source-drift proof transaction left objects behind');
  } finally { try{unlinkSync(driftTmp);}catch{} }
  console.log('MOA_GROUP_CODE_EQUIVALENCE_SHARED_CONTAINER_PROOF_PASS');
  console.log('Observed: real SQL-role switching, source-body drift refusal before reissue/index, key/input and public writer behavior, derived/consolidation/swap/stale-list and same-request ingredient-writer refusal, collision preflight, rollback LF-normalized restoration, outside-transaction, later-caller and changed-body refusal, metadata preservation, and transaction cleanup.');
} finally {
  try { unlinkSync(tmp); } catch {}
}
