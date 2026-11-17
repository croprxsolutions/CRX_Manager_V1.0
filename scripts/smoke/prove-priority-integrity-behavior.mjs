#!/usr/bin/env node
// Uses an explicitly owned, already rebuilt B-1b disposable database; every candidate change and fixture rolls back.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const container = process.argv[2];
assert.match(container ?? '', /^crx-brandb1b-\d+-[a-z0-9]+$/, 'Pass the owned invoice-brand prover container explicitly.');
const metadata = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(metadata.HostConfig.NetworkMode, 'none', 'Mutation proof requires a network-disabled disposable database.');
assert.match(metadata.Config.Image, /supabase\/postgres:17\./);
const candidate = readFileSync(new URL('../../supabase/migrations/20270114100000_priority_integrity_followups.sql', import.meta.url), 'utf8');
const id = n => `bb1b0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const A = id(1), REP = id(2), DRIVER = id(3), CUSTOMER = id(10), PRODUCT = id(40);
const D = id(0x1000 + 700), ORDER = id(0x2000 + 700), OI = id(0x30000 + 700 * 16), DI = id(0x40000 + 700 * 16);
const PARENT = id(0x80000), OTHER_PARENT = id(0x80001);
const q = s => `'${s.replaceAll("'", "''")}'`;
const J = v => `${q(JSON.stringify(v))}::jsonb`;
const actor = uid => `RESET ROLE; SELECT set_config('request.jwt.claims', ${q(JSON.stringify({sub: uid, role: 'authenticated'}))}, true); SET LOCAL ROLE authenticated;`;
const owner = `RESET ROLE; SELECT set_config('request.jwt.claims', '{}', true);`;
const assertSql = (condition, message) => `SELECT pg_temp.check_true((${condition}), ${q(message)});`;
const typed = qty => ({typed_name: '[PROVER] Priority typed blue', typed_epa: '100-997', typed_manufacturer: 'Priority Maker', quantity: qty});
const lines = picks => J([{delivery_item_id: DI, picks}]);
const seq = `public._delivery_brand_max_seq('${D}')`;
const correct = (picks, key, base = `(public.get_delivery_brands('${D}')->>'event_seq')::bigint`) => `SELECT public.correct_delivery_brands('${D}',${lines(picks)},'Fix amount',${base},'${key}');`;
const reject = (sql, pattern) => `SELECT pg_temp.refused(${q(sql)},${q(pattern)});`;
const save = (key, reason = null) => `SELECT public.save_draft_product_rate('${PARENT}',NULL,NULL,'per_acre','house_standard',NULL,1,NULL,'pt',false,${reason === null ? 'NULL' : q(reason)},'${key}');`;

const sql = `BEGIN;
${candidate}
CREATE FUNCTION pg_temp.check_true(p_ok boolean, p_message text) RETURNS void LANGUAGE plpgsql AS $a$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'PROOF_FAILED: %',p_message; END IF; END $a$;
CREATE FUNCTION pg_temp.refused(p_sql text,p_pattern text) RETURNS void LANGUAGE plpgsql AS $a$
DECLARE failed boolean := false;
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~ p_pattern THEN RAISE; END IF; failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'PROOF_EXPECTED_REFUSAL: %',p_pattern; END IF;
END $a$;
CREATE FUNCTION pg_temp.rate_input(p_rate uuid,p_decision text,p_reason text) RETURNS jsonb LANGUAGE sql AS $a$
 SELECT jsonb_build_object('parent_id',parent_id,'rate_id',id,'expected_row_version',row_version,
 'basis',basis,'source',source,'low',low::text,'recommended',recommended::text,'high',high::text,'unit',unit,
 'is_quoting_default',is_quoting_default,'over_label_reason',over_label_reason,'decision',p_decision,'reason',p_reason)
 FROM public.product_rates WHERE id=p_rate;
$a$;

-- The source prover's synthetic identities must exist; never silently target a different database.
${assertSql(`EXISTS(SELECT 1 FROM public.profiles WHERE id='${A}' AND role='admin' AND is_active)`, 'B1b synthetic admin exists')}
SET LOCAL session_replication_role=replica;
INSERT INTO public.orders(id,order_number,customer_id,order_date,status,booking_draw,salesman_id)
 VALUES('${ORDER}','PROVER-PRIORITY-700','${CUSTOMER}',current_date,'confirmed',false,'${A}');
INSERT INTO public.order_items(id,order_id,product_id,product_name,price_per_unit,cost_per_unit,total_units_needed,total_price,profit,net_margin,quantity_delivered,quantity_remaining)
 VALUES('${OI}','${ORDER}','${PRODUCT}','[PROVER] Priority product',10,6,10,100,40,40,0,10);
INSERT INTO public.deliveries(id,delivery_number,order_id,customer_id,created_by,status,scheduled_date,assigned_driver)
 VALUES('${D}','PROVER-PRIORITY-D700','${ORDER}','${CUSTOMER}','${A}','in_progress',current_date,'${DRIVER}');
INSERT INTO public.delivery_items(id,delivery_id,order_item_id,product_id,quantity,unit_size)
 VALUES('${DI}','${D}','${OI}','${PRODUCT}',10,'GL');
UPDATE public.inventory SET quantity_available=100000 WHERE product_id='${PRODUCT}';
INSERT INTO public.vendors(name) VALUES('[PROVER] Priority vendor');
INSERT INTO public.product_parents(id,name,product_form,is_active,created_by,updated_by)
 VALUES('${PARENT}','[PROVER] Priority reasons','liquid',true,'${A}','${A}'),
       ('${OTHER_PARENT}','[PROVER] Priority other','liquid',true,'${A}','${A}');
SET LOCAL session_replication_role=origin;

-- A real rep records a typed pick; a real admin reviews and completes it.
${actor(REP)}
SELECT public.set_delivery_brands('${D}',${lines([typed(10)])},0,'priority-set');
${owner}
SET LOCAL session_replication_role=replica;
UPDATE public.delivery_item_brands SET entered_at=now()-interval '4 days' WHERE delivery_item_id='${DI}';
SET LOCAL session_replication_role=origin;
${actor(A)}
SELECT public.review_typed_brand((SELECT (p->>'id')::uuid FROM jsonb_array_elements(public.get_delivery_brands('${D}')->'lines'->0->'picks') p),
 'dismiss',NULL,'Checked the jug','priority-review');
SELECT public.complete_delivery(p_delivery_id=>'${D}',p_signed_by=>'No proof — recorded by office',p_performed_by=>'${A}',
 p_quantities=>${J([{delivery_item_id:DI,quantity_delivered:10}])},p_idempotency_key=>'priority-complete',
 p_evidence=>'no_proof',p_evidence_ref=>'[PROVER] no proof on stop');
${owner}
CREATE TEMP TABLE original_pick AS SELECT * FROM public.delivery_item_brands WHERE delivery_item_id='${DI}' AND superseded_at IS NULL;
CREATE TEMP TABLE correction_base AS SELECT ${seq} AS seq;
GRANT SELECT ON correction_base TO authenticated;
${actor(A)}
${correct([typed(7), {typed_name:'[PROVER] Priority remainder',quantity:3}], 'priority-correct', '(SELECT seq FROM correction_base)')}
${owner}
${assertSql(`(SELECT b.review_state='dismissed' AND b.review_reason=o.review_reason
 AND b.reviewed_by=o.reviewed_by AND b.reviewed_at=o.reviewed_at AND b.entered_by=o.entered_by
 AND b.entered_at=o.entered_at AND b.id<>o.id AND b.quantity=7
 FROM public.delivery_item_brands b CROSS JOIN original_pick o WHERE b.delivery_item_id='${DI}'
 AND b.brand_name=o.brand_name AND b.superseded_at IS NULL)`, 'quantity-only correction retains review and original entry')}
${assertSql(`(SELECT superseded_at IS NOT NULL FROM public.delivery_item_brands WHERE id=(SELECT id FROM original_pick))`, 'original reviewed snapshot preserved')}
${assertSql(`EXISTS(SELECT 1 FROM public.delivery_brand_events e CROSS JOIN LATERAL jsonb_array_elements(e.after_rows) r
 JOIN public.delivery_item_brands b ON b.id=(r->>'id')::uuid WHERE e.delivery_id='${D}' AND e.event_type='corrected'
 AND b.review_state='dismissed' AND r->>'review_state'=b.review_state
 AND (r->>'reviewed_by')::uuid=b.reviewed_by)`, 'event review and new ids equal stored rows')}
CREATE TEMP TABLE correction_seq AS SELECT ${seq} AS seq;
GRANT SELECT ON correction_seq TO authenticated;
${actor(A)}
${correct([typed(7), {typed_name:'[PROVER] Priority remainder',quantity:3}], 'priority-correct', '(SELECT seq FROM correction_base)')}
${reject(correct([typed(7), {typed_name:'[PROVER] Priority remainder',quantity:3}], 'priority-stale','0'),'BRAND_PICKS_CHANGED')}
${reject(correct([{...typed(7),review_state:'dismissed',reviewed_by:A}, {typed_name:'[PROVER] Priority remainder',quantity:3}], 'priority-correct','0'),'IDEMPOTENCY_PAYLOAD_MISMATCH')}
${owner}
${assertSql(`${seq}=(SELECT seq FROM correction_seq)`, 'refused corrections leave event sequence unchanged')}
${actor(REP)}
${reject(correct([typed(10)],'priority-rep-refusal'),'ADMIN_REQUIRED')}
${actor(A)}
${correct([{...typed(10),typed_manufacturer:'Different Maker',review_state:'dismissed',reviewed_by:A}], 'priority-identity')}
${owner}
${assertSql(`(SELECT review_state='pending' AND reviewed_by IS NULL FROM public.delivery_item_brands WHERE delivery_item_id='${DI}' AND superseded_at IS NULL)`, 'identity edit discards client review assertion')}
${actor(A)}
SELECT public.review_typed_brand((public.get_delivery_brands('${D}')->'lines'->0->'picks'->0->>'id')::uuid,
 'link','${id(30)}','Matched listed brand','priority-link');
${correct([{...typed(10),typed_manufacturer:'Different Maker'}], 'priority-confirm-linked')}
${owner}
${assertSql(`(SELECT review_state='added' AND review_brand_ref='${id(30)}'::uuid AND review_reason='Matched listed brand'
 AND reviewed_by='${A}'::uuid FROM public.delivery_item_brands WHERE delivery_item_id='${DI}' AND superseded_at IS NULL)`, 'confirm-as-is retains linked review and reason')}

-- Build and reverse a real closed-short PO through its existing RPCs, then attack the combined-write boundary.
CREATE TEMP TABLE po_state(po uuid,item uuid,receipt uuid,stock numeric);
GRANT ALL ON po_state TO authenticated;
${actor(A)}
DO $po$
DECLARE p uuid; i uuid; receipt uuid; r jsonb;
BEGIN
 r := public.save_purchase_order(NULL,jsonb_build_object('po_number','PROVER-PRIORITY-PO','vendor','[PROVER] Priority vendor','status','draft'),
   jsonb_build_array(jsonb_build_object('product_id','${PRODUCT}','product_name','[PROVER] Priority product',
      'quantity_ordered',10,'unit_cost_cents',100,'unit_size','GL')),'${A}','priority-po-save');
 p := (r->>'po_id')::uuid;
 PERFORM public.submit_purchase_order(p,'${A}','priority-po-submit');
 SELECT id INTO i FROM public.purchase_order_items WHERE purchase_order_id=p;
 r := public.receive_po_items(jsonb_build_array(jsonb_build_object('po_item_id',i,'quantity',2,
   'storage_location','Main Warehouse','condition','good')),'${A}','priority-po-receive',false);
 receipt := (r->'receiving_record_ids'->>0)::uuid;
 PERFORM public.close_purchase_order_short(p,'Vendor discontinued','priority-po-close');
 INSERT INTO po_state SELECT p,i,receipt,quantity_available FROM public.inventory WHERE product_id='${PRODUCT}' AND location='Main Warehouse';
END $po$;
${owner}
SELECT set_config('app.reversal_rpc_active','true',true);
${reject(`UPDATE public.purchase_order_items SET quantity_received=1,unit_cost=0.5 WHERE id=(SELECT item FROM po_state)`,'PO_CLOSED_COST_CUT')}
${reject(`UPDATE public.purchase_order_items SET quantity_received=1,unit_cost=NULL WHERE id=(SELECT item FROM po_state)`,'PO_CLOSED_COST_CUT')}
SELECT set_config('app.reversal_rpc_active','',true);
${assertSql(`(SELECT quantity_received=2 AND unit_cost=1 FROM public.purchase_order_items WHERE id=(SELECT item FROM po_state))`, 'combined cost-cut refusals leave receipt/cost unchanged')}
UPDATE public.purchase_order_items SET unit_cost=1.25 WHERE id=(SELECT item FROM po_state);
${actor(A)}
SELECT public.reverse_receiving_record((SELECT receipt FROM po_state),'Wrong receipt','${A}','priority-po-reverse');
SELECT public.reverse_receiving_record((SELECT receipt FROM po_state),'Wrong receipt','${A}','priority-po-reverse');
${owner}
${assertSql(`(SELECT p.status='closed' AND i.quantity_received=0 AND i.unit_cost=1.25
 FROM public.purchase_orders p JOIN public.purchase_order_items i ON i.purchase_order_id=p.id WHERE i.id=(SELECT item FROM po_state))`, 'actual receipt reversal retains closed status and raised cost')}
${assertSql(`(SELECT quantity_available=(SELECT stock-2 FROM po_state) FROM public.inventory WHERE product_id='${PRODUCT}' AND location='Main Warehouse')`, 'reversal retry changes stock exactly once')}

-- New photo metadata must bind the existing owned file to the same delivery folder.
INSERT INTO storage.objects(bucket_id,name,owner_id,metadata,created_at)
 VALUES('delivery-photos','delivery-photos/${D}/priority.jpg','${DRIVER}','{"mimetype":"image/jpeg","size":100}', '2026-01-02T03:04:05Z'),
 ('delivery-photos','delivery-photos/${id(9999)}/priority.jpg','${DRIVER}','{"mimetype":"image/jpeg","size":100}',now());
${actor(DRIVER)}
INSERT INTO public.delivery_photos(delivery_id,storage_path,uploaded_by,image_url)
 VALUES('${D}','delivery-photos/${D}/priority.jpg','${DRIVER}','[PROVER] image');
${reject(`INSERT INTO public.delivery_photos(delivery_id,storage_path,uploaded_by,image_url) VALUES('${D}','delivery-photos/${id(9999)}/priority.jpg','${DRIVER}','[PROVER] image')`,'DELIVERY_PHOTO_FOLDER_MISMATCH')}
${owner}
${assertSql(`(SELECT uploaded_at='2026-01-02T03:04:05Z'::timestamptz FROM public.delivery_photos WHERE storage_path='delivery-photos/${D}/priority.jpg')`, 'file upload time preserved')}
INSERT INTO public.delivery_photos(delivery_id,storage_path,uploaded_by,image_url)
 VALUES('${D}','[PROVER] legacy no-auth row','${DRIVER}','[PROVER] image');
${assertSql(`EXISTS(SELECT 1 FROM public.delivery_photos WHERE storage_path='[PROVER] legacy no-auth row')`, 'KI77 no-auth legacy insertion remains accepted')}

-- Real admin save/delete/reopen paths share the same boundary trim; every supported character is tested.
${actor(A)}
${save('priority-rate-1')}
${owner}
CREATE TEMP TABLE proof_rate AS SELECT id,row_version FROM public.product_rates WHERE parent_id='${PARENT}';
GRANT SELECT ON proof_rate TO authenticated;
DO $trim$
DECLARE cp integer;
BEGIN
 FOREACH cp IN ARRAY ARRAY[9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,173,8203,8204,8205,8288,65279] LOOP
  PERFORM pg_temp.check_true(public._product_rate_reason_trim(chr(cp)||'why'||chr(cp))='why','trim '||cp);
 END LOOP;
END $trim$;
${assertSql(`public._product_rate_reason_trim('a'||chr(8203)||'b')='a'||chr(8203)||'b'`, 'meaningful interior characters preserved')}
${actor(A)}
DO $reasons$
DECLARE cp integer; r uuid; v bigint; pad text;
BEGIN
 SELECT id,row_version INTO r,v FROM proof_rate;
 FOREACH cp IN ARRAY ARRAY[9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,173,8203,8204,8205,8288,65279] LOOP
  pad := chr(cp);
  PERFORM pg_temp.refused(format('SELECT public.delete_draft_product_rate(%L,%s,%L,%L)',r,v,pad,'priority-blank-'||cp),'PRODUCT_RATE_REASON_REQUIRED');
 END LOOP;
END $reasons$;
${owner}
${assertSql(`(SELECT count(*)=1 FROM public.product_rates WHERE parent_id='${PARENT}')`, 'blank delete refusals leave rate intact')}
${reject(`UPDATE public.product_rates SET over_label_reason=chr(12288) WHERE parent_id='${PARENT}'`,'product_rates_over_label_reason_check')}
${reject(`UPDATE public.product_rates SET over_label_reason=chr(12288)||'why' WHERE parent_id='${PARENT}'`,'product_rates_over_label_reason_check')}
UPDATE public.product_rates SET over_label_reason=repeat('a',500) WHERE parent_id='${PARENT}';
${reject(`UPDATE public.product_rates SET over_label_reason=repeat('a',501) WHERE parent_id='${PARENT}'`,'product_rates_over_label_reason_check')}
${actor(A)}
SELECT public.commit_rate_review(jsonb_build_array(pg_temp.rate_input((SELECT id FROM proof_rate),'approve',NULL)),
 '[]'::jsonb,'priority-approve');
DO $reopen_reasons$
DECLARE cp integer; r uuid;
BEGIN
 SELECT id INTO r FROM proof_rate;
 FOREACH cp IN ARRAY ARRAY[9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,173,8203,8204,8205,8288,65279] LOOP
  PERFORM pg_temp.refused(format('SELECT public.commit_rate_review(jsonb_build_array(pg_temp.rate_input(%L,''reopen'',%L)),''[]''::jsonb,%L)',
   r,chr(cp),'priority-reopen-blank-'||cp),'PRODUCT_RATE_REASON_REQUIRED');
 END LOOP;
END $reopen_reasons$;
SELECT public.commit_rate_review(jsonb_build_array(pg_temp.rate_input((SELECT id FROM proof_rate),'reopen',chr(12288)||repeat('a',500)||chr(8203))),
 '[]'::jsonb,'priority-reopen-valid');
${owner}
${assertSql(`(SELECT status='draft' FROM public.product_rates WHERE id=(SELECT id FROM proof_rate))`, '500 meaningful characters plus Unicode padding reopens')}
${assertSql(`(SELECT length(reason)=500 FROM public.product_rate_draft_events WHERE parent_id='${PARENT}' AND event_type='reopened' ORDER BY id DESC LIMIT 1)`, 'saved reopening reason has trimmed length500')}
-- An authenticated RPC executes the private helper as its definer; app roles cannot invoke it directly.
${actor(A)}
${reject(`SELECT public._product_rate_reason_trim('why')`,'permission denied')}
${owner}
-- Record an outcome as a signed-in admin, then trigger its automatic clearance without a user.
SELECT set_config('request.jwt.claims','{"sub":"${A}","role":"authenticated"}',true);
SELECT public._product_rate_review_outcome('${PARENT}',(SELECT outcome_version FROM public.product_parent_rate_outcomes WHERE parent_id='${PARENT}'),'needs_label_data',NULL,'${A}');
UPDATE public.product_rates SET high=2 WHERE parent_id='${PARENT}';
${assertSql(`(SELECT changed_by='${A}'::uuid FROM public.product_rate_draft_events WHERE parent_id='${PARENT}' AND event_type='outcome_cleared' ORDER BY id DESC LIMIT 1)`, 'signed-in event names admin')}
SELECT public._product_rate_review_outcome('${PARENT}',(SELECT outcome_version FROM public.product_parent_rate_outcomes WHERE parent_id='${PARENT}'),'needs_label_data',NULL,'${A}');
SELECT set_config('request.jwt.claims','{}',true);
UPDATE public.product_rates SET high=3 WHERE parent_id='${PARENT}';
${assertSql(`(SELECT changed_by IS NULL AND reason='the parent''s rates changed' FROM public.product_rate_draft_events WHERE parent_id='${PARENT}' AND event_type='outcome_cleared' ORDER BY id DESC LIMIT 1)`, 'automatic event records System, not prior editor')}
${reject(`INSERT INTO public.product_rate_draft_events(parent_id,event_type,reason,changed_by) VALUES('${PARENT}','outcome_cleared',NULL,NULL)`,'product_rate_draft_events_actor_required')}
${reject(`INSERT INTO public.product_rate_draft_events(parent_id,event_type,reason,changed_by) VALUES('${PARENT}','saved','the parent''s rates changed',NULL)`,'product_rate_draft_events_actor_required')}

ROLLBACK;
`;
try {
  const preflightFixture = reason => `BEGIN;
    SET LOCAL session_replication_role=replica;
    INSERT INTO public.product_parents(id,name,product_form,is_active,created_by,updated_by)
      VALUES('${PARENT}','[PROVER] Apply reason','liquid',true,'${A}','${A}');
    INSERT INTO public.product_rates(parent_id,basis,source,recommended,unit,origin,basis_confirmed,created_by,updated_by,over_label_reason)
      VALUES('${PARENT}','per_acre','house_standard',1,'pt','manual',true,'${A}','${A}',${reason});
    SET LOCAL session_replication_role=origin;
    ${candidate}
    ROLLBACK;`;
  const args = ['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1'];
  execFileSync('docker',args,{input:preflightFixture("'Valid saved reason'"),encoding:'utf8',stdio:['pipe','pipe','pipe']});
  let invalidRefused=false;
  try { execFileSync('docker',args,{input:preflightFixture('chr(12288)'),encoding:'utf8',stdio:['pipe','pipe','pipe']}); }
  catch (error) { assert.match(String(error.stderr),/PRIORITY_EXISTING_REASON_INVALID/); invalidRefused=true; }
  assert.ok(invalidRefused,'invalid existing reason must refuse candidate apply');
  execFileSync('docker', ['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1'],
    {input:sql,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']});
  const evidenceSmoke=readFileSync(new URL('./smoke-delivery-completion-evidence.sql',import.meta.url),'utf8');
  let evidencePassed=false;
  try { execFileSync('docker',args,{input:`BEGIN;\n${candidate}\n${evidenceSmoke}\nROLLBACK;`,encoding:'utf8',stdio:['pipe','pipe','pipe']}); }
  catch (error) { assert.match(String(error.stderr),/ERROR:\s+SMOKE_PASS_ROLLBACK/); evidencePassed=true; }
  assert.ok(evidencePassed,'completion-evidence smoke must end at its rollback pass sentinel');
} catch (error) {
  process.stderr.write(String(error.stderr ?? error.message));
  process.exitCode=1;
}
if (!process.exitCode) console.log('PRIORITY_INTEGRITY_PROOF_PASS: candidate and synthetic fixture changes rolled back.');
