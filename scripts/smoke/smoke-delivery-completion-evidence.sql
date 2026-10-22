-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261022010000_delivery_completion_evidence.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-delivery-completion-evidence-real-schema.mjs,
-- never against the live database. Completing a delivery on an order writes the order's automatic
-- draft invoice, whose invoice number draws from a sequence a rollback does not return, and the
-- chain plants [SMOKE] users, customers, products, inventory, orders, deliveries and storage rows.
--
-- Rule under test (Goal 5): a completion names its proof (p_evidence + p_evidence_ref) and is
-- refused, changing no delivery, stock or invoice, unless exactly that proof is saved; the proof
-- accepted is recorded and cannot be changed afterwards.
--   a. signature: the only accepted image is signatures/<id>/<left(sha256(key),32)>.png uploaded by
--      the caller. Refused: no image; the image of ANOTHER key; the right path uploaded by someone
--      else (all with status, stock, invoices and evidence unchanged). Accepted: the right image ->
--      completed, evidence + ref + signature_url recorded; the exact retry replays (no more stock);
--   b. paper_ticket: refused with no photo id, a photo id of another delivery, a ticket photo whose
--      file is in another delivery's folder; accepted with this delivery's photo id; ref recorded;
--   c. left_at_site: refused with a paper-ticket photo id, and with another signer text; accepted
--      with a drop-location photo id and the "No one present — left at site" signer;
--   d. NULL p_evidence never completes (COMPLETION_EVIDENCE_REQUIRED, no receipt); an unknown value
--      or a missing reference is COMPLETION_EVIDENCE_INVALID;
--   e. a fresh call on a completed delivery reports the status, not missing evidence;
--   f. start_and_complete_delivery: NULL evidence refused (stays scheduled); with the image at the
--      path of '<key>:complete' it starts, completes and records 'signature';
--   g. in the SAME transaction, right after those completions and with nothing cleared: a direct
--      UPDATE in_progress -> completed, a direct INSERT of a completed delivery, and rewriting the
--      evidence, signed_by or signature_url of a completed delivery are all refused;
--   h. get_delivery_receipt_recipient: the assigned driver of an OPEN stop scheduled 10 days ago
--      gets the email; the same driver is refused once it is completed; another driver is refused
--      with the same message as an unknown id; an admin gets it.
--
-- Fail-first: before the migration complete_delivery takes no p_evidence (step a fails).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_driver uuid := gen_random_uuid();
  v_driver_b uuid := gen_random_uuid();
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_customer uuid;
  v_product uuid;
  v_pricing jsonb;
  v_order uuid;
  v_oi uuid;
  v_del uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_i int;
  v_res jsonb;
  v_res2 jsonb;
  v_avail numeric;
  v_invoices int;
  v_status text;
  v_evidence text;
  v_ref text;
  v_sig text;
  v_err text;
  v_key text;
  v_path text;
  v_photo uuid;
  v_photo_other uuid;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: an active admin profile is required'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_prefix := 'smk-dce-' || v_suffix || '-';

  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_driver, 'smk-dce-a-' || v_suffix || '@example.invalid', '{"full_name":"[SMOKE] Driver A","role":"driver"}'::jsonb),
    (v_driver_b, 'smk-dce-b-' || v_suffix || '@example.invalid', '{"full_name":"[SMOKE] Driver B","role":"driver"}'::jsonb);
  UPDATE public.profiles SET role = 'driver', is_active = true WHERE id IN (v_driver, v_driver_b);

  INSERT INTO public.customers (farm_name, account_number, email)
  VALUES ('[SMOKE] Evidence Farm ' || v_suffix, '[SMOKE]-DCE-' || v_suffix, 'smk-dce-' || v_suffix || '@example.invalid')
  RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Evidence Product ' || v_suffix, 'GL', '[SMOKE]-EPA-DCE-' || v_suffix, 'liquid')
  RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, v_prefix || 'pricing-preview');
  PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin, v_prefix || 'pricing-apply');
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 0, 'GL');

  -- Deliveries 1-4 and 6 in_progress (driver A; 6 scheduled 10 days ago); 5 scheduled (the list).
  INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
  VALUES ('[SMOKE] DCE-' || v_suffix, v_customer, 'confirmed', false) RETURNING id INTO v_order;
  FOR v_i IN 1..6 LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product, '[SMOKE] line ' || v_i, 10, 6, 2, 20, 8, 40, 0, 2) RETURNING id INTO v_oi;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, created_by)
    VALUES ('[SMOKE] DCE-DEL-' || v_i || '-' || v_suffix, v_order, v_customer, v_driver,
            CASE WHEN v_i = 6 THEN CURRENT_DATE - 10 ELSE CURRENT_DATE END, 'scheduled', v_admin)
    RETURNING id INTO v_id;
    v_del := v_del || v_id;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_id, v_oi, v_product, 2, 0, 'GL');
    IF v_i <> 5 THEN UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_id; END IF;
  END LOOP;

  -- h (first half). Receipt recipient while delivery 6 is open, as its driver.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  IF (public.get_delivery_receipt_recipient(v_del[6]))->>'email' IS DISTINCT FROM 'smk-dce-' || v_suffix || '@example.invalid' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: h. the assigned driver of an open old stop did not get the receipt email';
  END IF;

  -- a. Signature path, as the assigned driver.
  SELECT count(*) INTO v_invoices FROM public.invoices WHERE order_id = v_order;
  v_key := v_prefix || 'a-sig';
  v_path := 'signatures/' || v_del[1] || '/' || left(encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), 32) || '.png';
  BEGIN
    PERFORM public.complete_delivery(v_del[1], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_key, NULL, 'signature', v_path);
    RAISE EXCEPTION 'SMOKE_FAIL: a signature completion with no saved image was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'SIGNATURE_IMAGE_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: a. no image: expected SIGNATURE_IMAGE_MISSING, got %', v_err; END IF;
  END;
  -- The image of another attempt (another key) of the same delivery and caller does not count.
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('delivery-signatures',
    'signatures/' || v_del[1] || '/' || left(encode(sha256(convert_to(v_prefix || 'a-other', 'UTF8')), 'hex'), 32) || '.png', v_driver::text);
  BEGIN
    PERFORM public.complete_delivery(v_del[1], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_key, NULL, 'signature',
      'signatures/' || v_del[1] || '/' || left(encode(sha256(convert_to(v_prefix || 'a-other', 'UTF8')), 'hex'), 32) || '.png');
    RAISE EXCEPTION 'SMOKE_FAIL: a signature image of another attempt was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'SIGNATURE_IMAGE_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: a. other key: expected SIGNATURE_IMAGE_MISSING, got %', v_err; END IF;
  END;
  -- The right path uploaded by someone else does not count either.
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('delivery-signatures', v_path, v_driver_b::text);
  BEGIN
    PERFORM public.complete_delivery(v_del[1], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_key, NULL, 'signature', v_path);
    RAISE EXCEPTION 'SMOKE_FAIL: a signature image uploaded by someone else was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'SIGNATURE_IMAGE_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: a. other owner: expected SIGNATURE_IMAGE_MISSING, got %', v_err; END IF;
  END;
  SELECT status, completion_evidence INTO v_status, v_evidence FROM public.deliveries WHERE id = v_del[1];
  SELECT quantity_available INTO v_avail FROM public.inventory WHERE product_id = v_product;
  IF v_status <> 'in_progress' OR v_evidence IS NOT NULL OR v_avail <> 100
     OR (SELECT count(*) FROM public.invoices WHERE order_id = v_order) <> v_invoices
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_key) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. a refused completion changed something (status %, evidence %, stock %)', v_status, v_evidence, v_avail;
  END IF;
  UPDATE storage.objects SET owner_id = v_driver::text WHERE bucket_id = 'delivery-signatures' AND name = v_path;
  v_res := public.complete_delivery(v_del[1], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_key, NULL, 'signature', v_path);
  SELECT status, completion_evidence, completion_evidence_ref, signature_url INTO v_status, v_evidence, v_ref, v_sig
    FROM public.deliveries WHERE id = v_del[1];
  SELECT quantity_available INTO v_avail FROM public.inventory WHERE product_id = v_product;
  IF v_status <> 'completed' OR v_evidence IS DISTINCT FROM 'signature' OR v_ref IS DISTINCT FROM v_path
     OR v_sig IS DISTINCT FROM v_path OR v_avail <> 98
     OR (SELECT count(*) FROM public.invoices WHERE order_id = v_order) <= v_invoices THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. signature completion: status %, evidence %, ref %, signature_url %, stock %', v_status, v_evidence, v_ref, v_sig, v_avail;
  END IF;
  v_res2 := public.complete_delivery(v_del[1], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_key, NULL, 'signature', v_path);
  SELECT quantity_available INTO v_avail FROM public.inventory WHERE product_id = v_product;
  IF v_res2 IS DISTINCT FROM v_res OR v_avail <> 98 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. the exact retry did not replay (% vs %, stock %)', v_res2, v_res, v_avail;
  END IF;

  -- e. A fresh key on the completed delivery reports its status, not missing evidence.
  BEGIN
    PERFORM public.complete_delivery(v_del[1], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'e-again', NULL, 'paper_ticket', gen_random_uuid()::text);
    RAISE EXCEPTION 'SMOKE_FAIL: e. a completed delivery was completed again';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'Delivery must be in_progress to complete (current status: completed)%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: e. expected the in_progress status refusal, got %', v_err;
    END IF;
  END;

  -- b. Paper ticket.
  BEGIN
    PERFORM public.complete_delivery(v_del[2], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'b-none', NULL, 'paper_ticket', gen_random_uuid()::text);
    RAISE EXCEPTION 'SMOKE_FAIL: b. paper completion with an unknown photo id was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'PAPER_TICKET_PHOTO_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: b. expected PAPER_TICKET_PHOTO_MISSING, got %', v_err; END IF;
  END;
  -- A ticket photo of ANOTHER delivery does not count.
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('delivery-photos', 'delivery-photos/' || v_del[3] || '/t3.jpg', v_driver::text);
  INSERT INTO public.delivery_photos (delivery_id, storage_path, image_url, uploaded_by, caption, sort_order)
  VALUES (v_del[3], 'delivery-photos/' || v_del[3] || '/t3.jpg', 'x', v_driver, 'Signed paper delivery ticket', 0)
  RETURNING id INTO v_photo_other;
  BEGIN
    PERFORM public.complete_delivery(v_del[2], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'b-other', NULL, 'paper_ticket', v_photo_other::text);
    RAISE EXCEPTION 'SMOKE_FAIL: b. another delivery''s ticket photo was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'PAPER_TICKET_PHOTO_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: b. other delivery: expected PAPER_TICKET_PHOTO_MISSING, got %', v_err; END IF;
  END;
  -- Another delivery's row, even with its file stored in THIS delivery's folder, does not count
  -- (only the photo's own delivery id refuses this one).
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('delivery-photos', 'delivery-photos/' || v_del[2] || '/x3.jpg', v_driver::text);
  INSERT INTO public.delivery_photos (delivery_id, storage_path, image_url, uploaded_by, caption, sort_order)
  VALUES (v_del[3], 'delivery-photos/' || v_del[2] || '/x3.jpg', 'x', v_driver, 'Signed paper delivery ticket', 2)
  RETURNING id INTO v_photo;
  BEGIN
    PERFORM public.complete_delivery(v_del[2], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'b-other-row', NULL, 'paper_ticket', v_photo::text);
    RAISE EXCEPTION 'SMOKE_FAIL: b. another delivery''s ticket photo was accepted (file in this folder)';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'PAPER_TICKET_PHOTO_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: b. other-delivery row: expected PAPER_TICKET_PHOTO_MISSING, got %', v_err; END IF;
  END;
  -- This delivery's row pointing at a file in another delivery's folder does not count.
  INSERT INTO public.delivery_photos (delivery_id, storage_path, image_url, uploaded_by, caption, sort_order)
  VALUES (v_del[2], 'delivery-photos/' || v_del[3] || '/t3.jpg', 'x', v_driver, 'Signed paper delivery ticket', 0)
  RETURNING id INTO v_photo;
  BEGIN
    PERFORM public.complete_delivery(v_del[2], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'b-foreign', NULL, 'paper_ticket', v_photo::text);
    RAISE EXCEPTION 'SMOKE_FAIL: b. a ticket photo from another delivery''s folder was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'PAPER_TICKET_PHOTO_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: b. foreign photo: expected PAPER_TICKET_PHOTO_MISSING, got %', v_err; END IF;
  END;
  IF (SELECT status FROM public.deliveries WHERE id = v_del[2]) <> 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: b. a refused paper completion changed the delivery';
  END IF;
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('delivery-photos', 'delivery-photos/' || v_del[2] || '/t2.jpg', v_driver::text);
  INSERT INTO public.delivery_photos (delivery_id, storage_path, image_url, uploaded_by, caption, sort_order)
  VALUES (v_del[2], 'delivery-photos/' || v_del[2] || '/t2.jpg', 'x', v_driver, 'Signed paper delivery ticket', 1)
  RETURNING id INTO v_photo;
  PERFORM public.complete_delivery(v_del[2], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'b-ok', NULL, 'paper_ticket', v_photo::text);
  SELECT status, completion_evidence, completion_evidence_ref, signature_url INTO v_status, v_evidence, v_ref, v_sig
    FROM public.deliveries WHERE id = v_del[2];
  IF v_status <> 'completed' OR v_evidence IS DISTINCT FROM 'paper_ticket' OR v_ref IS DISTINCT FROM v_photo::text OR v_sig IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: b. paper completion: status %, evidence %, ref %, signature_url %', v_status, v_evidence, v_ref, v_sig;
  END IF;

  -- c. Left at site.
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES
    ('delivery-photos', 'delivery-photos/' || v_del[3] || '/drop.jpg', v_driver::text);
  INSERT INTO public.delivery_photos (delivery_id, storage_path, image_url, uploaded_by, caption, sort_order)
  VALUES (v_del[3], 'delivery-photos/' || v_del[3] || '/drop.jpg', 'x', v_driver, 'Left at site — drop location', 1)
  RETURNING id INTO v_photo;
  BEGIN
    PERFORM public.complete_delivery(v_del[3], 'No one present — left at site', v_driver, NULL, NULL, NULL, v_prefix || 'c-ticket', NULL, 'left_at_site', v_photo_other::text);
    RAISE EXCEPTION 'SMOKE_FAIL: c. left-at-site completion with a ticket photo was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'LEFT_AT_SITE_PHOTO_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: c. expected LEFT_AT_SITE_PHOTO_MISSING, got %', v_err; END IF;
  END;
  BEGIN
    PERFORM public.complete_delivery(v_del[3], '[SMOKE] Someone', v_driver, NULL, NULL, NULL, v_prefix || 'c-signer', NULL, 'left_at_site', v_photo::text);
    RAISE EXCEPTION 'SMOKE_FAIL: c. left-at-site completion with a named signer was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'LEFT_AT_SITE_SIGNER_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: c. expected LEFT_AT_SITE_SIGNER_MISMATCH, got %', v_err; END IF;
  END;
  PERFORM public.complete_delivery(v_del[3], 'No one present — left at site', v_driver, NULL, NULL, NULL, v_prefix || 'c-ok', NULL, 'left_at_site', v_photo::text);
  IF (SELECT completion_evidence FROM public.deliveries WHERE id = v_del[3]) IS DISTINCT FROM 'left_at_site' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: c. left_at_site was not recorded';
  END IF;

  -- d. NULL evidence never completes; unknown values and missing references are refused.
  BEGIN
    PERFORM public.complete_delivery(v_del[4], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'd-null', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: d. a completion with no p_evidence was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: d. expected COMPLETION_EVIDENCE_REQUIRED, got %', v_err; END IF;
  END;
  BEGIN
    PERFORM public.complete_delivery(v_del[4], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'd-bad', NULL, 'photo', 'x');
    RAISE EXCEPTION 'SMOKE_FAIL: d. an unknown p_evidence was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_INVALID%' THEN RAISE EXCEPTION 'SMOKE_FAIL: d. expected COMPLETION_EVIDENCE_INVALID, got %', v_err; END IF;
  END;
  BEGIN
    PERFORM public.complete_delivery(v_del[4], '[SMOKE] Signer', v_driver, NULL, NULL, NULL, v_prefix || 'd-noref', NULL, 'signature', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: d. a signature completion with no reference was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_INVALID%' THEN RAISE EXCEPTION 'SMOKE_FAIL: d. no ref: expected COMPLETION_EVIDENCE_INVALID, got %', v_err; END IF;
  END;
  IF (SELECT status FROM public.deliveries WHERE id = v_del[4]) <> 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: d. a refused completion changed delivery 4';
  END IF;

  -- f. Deliveries list (one call), as an admin.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.start_and_complete_delivery(v_del[5], '[SMOKE] Signer', v_today, v_admin, NULL, NULL, NULL, v_prefix || 'f-null');
    RAISE EXCEPTION 'SMOKE_FAIL: f. the list completed with no evidence';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: f. expected COMPLETION_EVIDENCE_REQUIRED, got %', v_err; END IF;
  END;
  v_key := v_prefix || 'f-ok';
  v_path := 'signatures/' || v_del[5] || '/' || left(encode(sha256(convert_to(v_key || ':complete', 'UTF8')), 'hex'), 32) || '.png';
  BEGIN
    PERFORM public.start_and_complete_delivery(v_del[5], '[SMOKE] Signer', v_today, v_admin, NULL, NULL, NULL, v_key, 'signature', v_path);
    RAISE EXCEPTION 'SMOKE_FAIL: f. the list completed with no signature image';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'SIGNATURE_IMAGE_MISSING%' THEN RAISE EXCEPTION 'SMOKE_FAIL: f. expected SIGNATURE_IMAGE_MISSING, got %', v_err; END IF;
  END;
  IF (SELECT status FROM public.deliveries WHERE id = v_del[5]) <> 'scheduled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: f. a refused list completion left the delivery started';
  END IF;
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('delivery-signatures', v_path, v_admin::text);
  v_res := public.start_and_complete_delivery(v_del[5], '[SMOKE] Signer', v_today, v_admin, NULL, NULL, NULL, v_key, 'signature', v_path);
  IF (v_res->>'started')::boolean IS DISTINCT FROM true
     OR (SELECT completion_evidence_ref FROM public.deliveries WHERE id = v_del[5]) IS DISTINCT FROM v_path THEN
    RAISE EXCEPTION 'SMOKE_FAIL: f. list signature completion: %', v_res;
  END IF;

  -- g. The direct-table route, in the SAME transaction right after the completions, nothing cleared.
  BEGIN
    UPDATE public.deliveries SET status = 'completed', signed_by = 'x' WHERE id = v_del[4];
    RAISE EXCEPTION 'SMOKE_FAIL: g. a direct UPDATE completed a delivery';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: g. update: expected COMPLETION_EVIDENCE_REQUIRED, got %', v_err; END IF;
  END;
  BEGIN
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, signed_by, created_by)
    VALUES ('[SMOKE] DCE-FORGED-' || v_suffix, v_order, v_customer, CURRENT_DATE, 'completed', 'x', v_admin);
    RAISE EXCEPTION 'SMOKE_FAIL: g. a completed delivery was inserted directly';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: g. insert: expected COMPLETION_EVIDENCE_REQUIRED, got %', v_err; END IF;
  END;
  BEGIN
    UPDATE public.deliveries SET completion_evidence = 'paper_ticket' WHERE id = v_del[1];
    RAISE EXCEPTION 'SMOKE_FAIL: g. completion_evidence was rewritten directly';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_LOCKED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: g. evidence: expected COMPLETION_EVIDENCE_LOCKED, got %', v_err; END IF;
  END;
  BEGIN
    UPDATE public.deliveries SET signature_url = 'signatures/forged.png' WHERE id = v_del[1];
    RAISE EXCEPTION 'SMOKE_FAIL: g. a completed delivery''s signature_url was rewritten directly';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_LOCKED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: g. signature_url: expected COMPLETION_EVIDENCE_LOCKED, got %', v_err; END IF;
  END;
  BEGIN
    UPDATE public.deliveries SET signed_by = '[SMOKE] Someone else' WHERE id = v_del[2];
    RAISE EXCEPTION 'SMOKE_FAIL: g. a completed delivery''s signed_by was rewritten directly';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_LOCKED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: g. signed_by: expected COMPLETION_EVIDENCE_LOCKED, got %', v_err; END IF;
  END;

  -- h (second half). Receipt recipient.
  IF (public.get_delivery_receipt_recipient(v_del[1]))->>'email' IS DISTINCT FROM 'smk-dce-' || v_suffix || '@example.invalid' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: h. an admin did not get the receipt email';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  BEGIN
    PERFORM public.get_delivery_receipt_recipient(v_del[1]);
    RAISE EXCEPTION 'SMOKE_FAIL: h. the driver read the receipt email of a completed delivery';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'Not authorized to view this delivery%' THEN RAISE EXCEPTION 'SMOKE_FAIL: h. completed: expected Not authorized, got %', v_err; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver_b::text, true);
  BEGIN
    PERFORM public.get_delivery_receipt_recipient(v_del[6]);
    RAISE EXCEPTION 'SMOKE_FAIL: h. another driver read the receipt email';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'Not authorized to view this delivery%' THEN RAISE EXCEPTION 'SMOKE_FAIL: h. expected Not authorized, got %', v_err; END IF;
  END;
  BEGIN
    PERFORM public.get_delivery_receipt_recipient(gen_random_uuid());
    RAISE EXCEPTION 'SMOKE_FAIL: h. an unknown delivery id was answered';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'Not authorized to view this delivery%' THEN RAISE EXCEPTION 'SMOKE_FAIL: h. unknown id: expected the same refusal, got %', v_err; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
