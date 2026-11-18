-- ============================================================================
-- Valid quotes expire on the run's own Chicago date (the inclusive boundary), so the chain holds on any day of the season.
-- CONTAINER ONLY smoke chain for 20270125163000_ki81_invoices_bill_sent_quote_price (KI-81).
-- Run through scripts/smoke/prove-ki81-sent-quote-price-real-schema.mjs, never against a shared
-- database: it saves invoices, which draw invoice numbers a rollback does not return.
-- It needs the prover's committed fixtures (ids a81a81a8-...) and its k81.quote() helper.
--
-- Rules under test (Mason, 2026-11-17; contract docs/plans/2026-11-17-ki81-sent-price-invoices-CONTRACT.md):
--   F1  a field-app chemical on the billed grower's sent quote bills the sent price (source quoted);
--   F2  a price changed after sending, not re-sent and not recorded, refuses QUOTE_RESEND_REQUIRED, saying the price can be typed;
--   F3  a price change save_quote recorded since the send bills the new price;
--   F4  a draft, declined, cancelled or deleted quote, another grower's quote, a quote expired before the invoice
--       date, or one written after it, bills the tier price; an "expired" quote still valid that date counts, and so
--       does one whose expiry is in a later season (Mason, 2026-11-17, "Valid + written before");
--   F5  two eligible quotes at different prices refuse FIELD_APP_QUOTE_PRICE_CONFLICT; a typed price saves;
--   F6  a planted transaction-local price record refuses FIELD_APP_QUOTE_PRICE_CHANGED, never prices;
--   F7  own quote only (Mason, 2026-11-17): on a shared field, grower B's sent quote prices B's invoice, and
--       grower A's invoice bills A's tier price;
--   F8  a grower's quote on a field where that grower has no share does not price their invoice (Sol round 3);
--   P1-P3 the invoice preview shows the price the save bills: per grower (P1), not a draft quote (P2), not a quote on
--       a field the grower has no share of (P3);
--   X1-X3 the split-bill save: grower B's sent quote prices only B's share; an unsent change refuses;
--       a quote of a grower not on the bill does not count; X4 a member's quote on a field they have no share of does not count;
--   B1-B7 the blend-ticket invoice (Mason, 2026-11-18 "Yes, same rules"): the sent price bills (B1); an unsent
--       change refuses before any invoice (B2); a never-sent (B3), declined (B4), expired (B5) or later-written (B6)
--       job quote bills the tier price; on a shared field the job quote prices only its own grower, the other
--       grower bills their tier price (B7).
--   B8-B11 (Mason, 2026-11-18 "Yes, use B's quote"): on the shared field, grower B's own sent quote prices B's blend
--       share (B8); an unsent change to it refuses before any invoice (B9); a $0 on it asks for the below-cost
--       approval (B11). B10 (Taha's re-review): on a field only B owns, grower A's job quote prices nobody, so its
--       unsent change does not refuse B's invoice. B12-B13 ("Yes, price the owner from their own quote"): with the job quote declined, A's own
--       sent quote prices A (B12); a usable job quote still wins over A's own quote (B13). B14 (Luna r12): a job quote that
--       lists no product on the ticket prices nothing, so its unsent change does not refuse the invoice. B15-B16 (Taha's
--       re-review): with no job quote, each grower on the shared field bills their own sent quote (B15); the owner's own
--       $0 quote asks for the below-cost approval (B16).
-- Each case runs in its own sub-transaction (rolled back by K81_UNDO). Terminal SMOKE_PASS_ROLLBACK.
-- ============================================================================
DO $smoke$
DECLARE
  c_admin  constant uuid := 'a81a81a8-0000-4000-8000-0000000000a1';
  c_a      constant uuid := 'a81a81a8-0000-4000-8000-0000000000c1';
  c_b      constant uuid := 'a81a81a8-0000-4000-8000-0000000000c2';
  c_c      constant uuid := 'a81a81a8-0000-4000-8000-0000000000c3';
  c_g      constant uuid := 'a81a81a8-0000-4000-8000-0000000000f1';  -- grower A alone
  c_f      constant uuid := 'a81a81a8-0000-4000-8000-0000000000f2';  -- A 50% / B 50%
  c_h      constant uuid := 'a81a81a8-0000-4000-8000-0000000000f3';  -- grower B alone
  c_p      constant uuid := 'a81a81a8-0000-4000-8000-0000000000d1';  -- Gal liquid, tier 1 $10.00
  c_bp     constant uuid := 'a81a81a8-0000-4000-8000-0000000000d2';  -- blend product, tier 1 $10.00
  v_today  date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_q      uuid;
  v_q2     uuid;
  v_qi     uuid;
  v_res    jsonb;
  v_cents  bigint;
  v_src    text;
  v_err    text;
  v_job    uuid;
  v_t      uuid;
  v_n      int;
  v_n2     int;
  v_n3     int;
  v_case   text;
  v_kind   text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', c_admin::text, true);

  -- ---------------------------------------------------------------- single field-app save
  -- One chemical on field G (grower A): 16 oz/ac x 10 ac = 1.25 Gal.
  CREATE TEMP TABLE k81_save (unit_price_cents bigint, price_source text) ON COMMIT DROP;

  -- F1
  BEGIN
    v_q := k81.quote(c_a, c_g, c_p, 20.00, 'sent', v_today, true);
    SELECT * INTO v_cents, v_src FROM k81.save_single(c_admin, c_g, c_p, NULL);
    IF v_cents IS DISTINCT FROM 2000 OR v_src IS DISTINCT FROM 'quoted' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(F1): the sent price was not billed: % %', v_cents, v_src;
    END IF;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- F2
  BEGIN
    v_q := k81.quote(c_a, c_g, c_p, 20.00, 'sent', v_today, true);
    PERFORM k81.reprice(v_q, 21.00);
    BEGIN
      SELECT * INTO v_cents, v_src FROM k81.save_single(c_admin, c_g, c_p, NULL);
      RAISE EXCEPTION 'SMOKE_FAIL(F2): an unsent price was billed: % %', v_cents, v_src;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'QUOTE_RESEND_REQUIRED:%Or type the price on this invoice line%' THEN RAISE EXCEPTION 'SMOKE_FAIL(F2): wrong refusal: %', SQLERRM; END IF;
    END;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- F3: a lower price recorded by save_quote since V1 was sent.
  BEGIN
    v_q := k81.quote(c_a, c_g, c_p, 20.00, 'sent', v_today, true);
    PERFORM k81.reprice(v_q, 19.00, true);
    SELECT * INTO v_cents, v_src FROM k81.save_single(c_admin, c_g, c_p, NULL);
    IF v_cents IS DISTINCT FROM 1900 OR v_src IS DISTINCT FROM 'quoted' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(F3): the recorded price change was not billed: % %', v_cents, v_src;
    END IF;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- F4: each ineligible quote alone leaves the tier price; an expired quote valid today counts.
  FOREACH v_case IN ARRAY ARRAY['draft', 'declined', 'cancelled', 'deleted', 'other_grower', 'expired_before', 'written_after', 'crosses_season', 'expired_valid'] LOOP
    BEGIN
      v_q := k81.quote(CASE WHEN v_case = 'other_grower' THEN c_c ELSE c_a END, c_g, c_p, 30.00,
                       CASE v_case WHEN 'draft' THEN 'draft' WHEN 'declined' THEN 'declined' WHEN 'cancelled' THEN 'cancelled'
                                   WHEN 'expired_before' THEN 'expired' WHEN 'expired_valid' THEN 'expired' ELSE 'sent' END,
                       CASE v_case WHEN 'expired_before' THEN v_today - 1 WHEN 'crosses_season' THEN v_today + 400 ELSE v_today END,
                       v_case <> 'draft');
      IF v_case = 'deleted' THEN PERFORM k81.soft_delete(v_q); END IF;
      IF v_case = 'written_after' THEN PERFORM k81.set_created(v_q, now() + interval '2 days'); END IF;
      SELECT * INTO v_cents, v_src FROM k81.save_single(c_admin, c_g, c_p, NULL);
      IF v_case IN ('expired_valid', 'crosses_season') THEN
        IF v_cents IS DISTINCT FROM 3000 OR v_src IS DISTINCT FROM 'quoted' THEN
          RAISE EXCEPTION 'SMOKE_FAIL(F4 %): a quote still valid today was not billed: % %', v_case, v_cents, v_src;
        END IF;
      ELSIF v_cents IS DISTINCT FROM 1000 OR v_src IS DISTINCT FROM 'tier' THEN
        RAISE EXCEPTION 'SMOKE_FAIL(F4 %): an ineligible quote priced the line: % %', v_case, v_cents, v_src;
      END IF;
      RAISE EXCEPTION 'K81_UNDO';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  -- F5: two eligible quotes disagree; a typed price saves.
  BEGIN
    v_q := k81.quote(c_a, c_g, c_p, 20.00, 'sent', v_today, true);
    v_q2 := k81.quote(c_a, c_g, c_p, 22.00, 'accepted', v_today, true);
    BEGIN
      SELECT * INTO v_cents, v_src FROM k81.save_single(c_admin, c_g, c_p, NULL);
      RAISE EXCEPTION 'SMOKE_FAIL(F5): one of two different quoted prices was billed: % %', v_cents, v_src;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'FIELD_APP_QUOTE_PRICE_CONFLICT:%' THEN RAISE EXCEPTION 'SMOKE_FAIL(F5): wrong refusal: %', SQLERRM; END IF;
    END;
    SELECT * INTO v_cents, v_src FROM k81.save_single(c_admin, c_g, c_p, 2100);
    IF v_cents IS DISTINCT FROM 2100 OR v_src IS DISTINCT FROM 'manual' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(F5): the typed price did not save: % %', v_cents, v_src;
    END IF;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- F6: the transaction-local first answer can only refuse, never price: a planted record refuses, a
  -- second honest call returns the same price.
  BEGIN
    v_q := k81.quote(c_a, c_g, c_p, 20.00, 'sent', v_today, true);
    PERFORM set_config('crx_ki81.p' || md5(concat_ws('|', c_p, c_g::text, c_a::text, v_today)), 'v:1', true);
    BEGIN
      v_cents := public._field_app_sent_quote_price_cents(c_p, ARRAY[c_g], ARRAY[c_a], v_today);
      RAISE EXCEPTION 'SMOKE_FAIL(F6): a planted record was trusted: %', v_cents;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'FIELD_APP_QUOTE_PRICE_CHANGED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL(F6): wrong refusal: %', SQLERRM; END IF;
    END;
    PERFORM set_config('crx_ki81.p' || md5(concat_ws('|', c_p, c_g::text, c_a::text, v_today)), '', true);
    IF public._field_app_sent_quote_price_cents(c_p, ARRAY[c_g], ARRAY[c_a], v_today) IS DISTINCT FROM 2000
       OR public._field_app_sent_quote_price_cents(c_p, ARRAY[c_g], ARRAY[c_a], v_today) IS DISTINCT FROM 2000 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(F6): two honest calls did not both return the sent price';
    END IF;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- F7 + P1: field F (A 50% / B 50%), only B has a sent quote; the preview matches the save, grower by grower.
  BEGIN
    v_q := k81.quote(c_b, c_f, c_p, 20.00, 'sent', v_today, true);
    SELECT count(*) INTO v_n FROM k81.preview(ARRAY[c_f], c_p) pv
     WHERE (pv.customer_id = c_a AND pv.unit_price_cents = 1000) OR (pv.customer_id = c_b AND pv.unit_price_cents = 2000);
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(P1): the preview did not price A at tier and B at B''s quote: %',
        (SELECT jsonb_agg(to_jsonb(pv)) FROM k81.preview(ARRAY[c_f], c_p) pv);
    END IF;
    SELECT count(*) INTO v_n FROM k81.save_single_all(c_admin, ARRAY[c_f], c_p) s
     WHERE (s.customer_id = c_a AND s.unit_price_cents = 1000 AND s.price_source = 'tier')
        OR (s.customer_id = c_b AND s.unit_price_cents = 2000 AND s.price_source = 'quoted');
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(F7): a co-owner''s quote priced another grower, or B''s quote was not billed';
    END IF;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- F8 + P3: B's quote is on field G, where only A has a share; an invoice for G and F bills both at tier.
  BEGIN
    v_q := k81.quote(c_b, c_g, c_p, 20.00, 'sent', v_today, true);
    -- CodeRabbit: exactly one row each for A and B, both at the tier price (a missing or NULL row fails).
    SELECT count(*) FILTER (WHERE pv.customer_id IN (c_a, c_b) AND pv.unit_price_cents IS NOT DISTINCT FROM 1000),
           count(DISTINCT pv.customer_id), count(*)
      INTO v_n, v_n2, v_n3 FROM k81.preview(ARRAY[c_g, c_f], c_p) pv;
    IF v_n <> 2 OR v_n2 <> 2 OR v_n3 <> 2 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(P3): the preview used a quote on a field the grower has no share of: %',
        (SELECT jsonb_agg(to_jsonb(pv)) FROM k81.preview(ARRAY[c_g, c_f], c_p) pv);
    END IF;
    SELECT count(*) FILTER (WHERE s.customer_id IN (c_a, c_b) AND s.unit_price_cents IS NOT DISTINCT FROM 1000
                                  AND s.price_source IS NOT DISTINCT FROM 'tier'),
           count(DISTINCT s.customer_id), count(*)
      INTO v_n, v_n2, v_n3 FROM k81.save_single_all(c_admin, ARRAY[c_g, c_f], c_p) s;
    IF v_n <> 2 OR v_n2 <> 2 OR v_n3 <> 2 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(F8): a quote on a field the grower has no share of priced their invoice';
    END IF;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- P2: a draft quote on field G does not price the preview.
  BEGIN
    v_q := k81.quote(c_a, c_g, c_p, 30.00, 'draft', v_today, false);
    SELECT unit_price_cents INTO v_cents FROM k81.preview(ARRAY[c_g], c_p);
    IF v_cents IS DISTINCT FROM 1000 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(P2): the preview used a draft quote: %', v_cents;
    END IF;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- ---------------------------------------------------------------- split-bill save (field F: A and B)
  -- X1: grower B's sent quote prices only B's child (0.5 Gal at $20.00 = 1000); A's child bills A's tier (500).
  --     Each child records its OWN price source: B's line and share 'quoted', A's 'tier' (Codex PR review).
  -- X2: its unsent change refuses. X3: grower C (not on the bill) quoting does not count: tier $10.00.
  -- X4: B's quote is on field G (A only); a split bill for G and F bills 1 Gal at tier ($10.00 = 1000).
  FOREACH v_case IN ARRAY ARRAY['X1', 'X2', 'X3', 'X4'] LOOP
    BEGIN
      v_q := k81.quote(CASE WHEN v_case = 'X3' THEN c_c ELSE c_b END, CASE WHEN v_case = 'X4' THEN c_g ELSE c_f END,
                       c_p, 20.00, 'sent', v_today, true);
      IF v_case = 'X2' THEN PERFORM k81.reprice(v_q, 21.00); END IF;
      BEGIN
        v_cents := k81.save_split(c_admin, CASE WHEN v_case = 'X4' THEN ARRAY[c_g, c_f] ELSE ARRAY[c_f] END, c_p);
      EXCEPTION WHEN OTHERS THEN
        IF v_case = 'X2' AND SQLERRM LIKE 'QUOTE_RESEND_REQUIRED:%' THEN v_cents := -1;
        ELSE RAISE EXCEPTION 'SMOKE_FAIL(%): the split save failed: %', v_case, SQLERRM; END IF;
      END;
      IF v_cents IS DISTINCT FROM (CASE v_case WHEN 'X1' THEN 1500 WHEN 'X2' THEN -1 ELSE 1000 END) THEN
        RAISE EXCEPTION 'SMOKE_FAIL(%): the split bill totals % cents', v_case, v_cents;
      END IF;
      IF v_case = 'X1' AND (
           (SELECT count(*) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
             WHERE ii.description = 'K81 split chem' AND i.deleted_at IS NULL
               AND ii.price_source = CASE WHEN i.customer_id = c_b THEN 'quoted' ELSE 'tier' END) <> 2
        OR (SELECT count(*) FROM invoice_line_shares s JOIN invoice_items ii ON ii.id = s.invoice_item_id
             WHERE ii.description = 'K81 split chem'
               AND s.base_price_source = CASE WHEN s.customer_id = c_b THEN 'quoted' ELSE 'tier' END) <> 2) THEN
        RAISE EXCEPTION 'SMOKE_FAIL(X1): a grower''s price source is not their own: %',
          (SELECT jsonb_agg(jsonb_build_object('customer', i.customer_id, 'item', ii.price_source))
             FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ii.description = 'K81 split chem');
      END IF;
      RAISE EXCEPTION 'K81_UNDO';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  -- ---------------------------------------------------------------- blend-ticket invoice (grower A's job quote, 20 GL)
  FOREACH v_case IN ARRAY ARRAY['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'] LOOP
    BEGIN
      v_q := k81.quote(c_a, NULL, c_bp, 20.00,
                       CASE v_case WHEN 'B3' THEN 'draft' WHEN 'B4' THEN 'declined' ELSE 'sent' END,
                       CASE WHEN v_case = 'B5' THEN v_today - 5 ELSE v_today END, v_case <> 'B3');
      IF v_case = 'B6' THEN PERFORM k81.set_created(v_q, now() + interval '3 days'); END IF;
      v_t := k81.blend_ticket(c_admin, c_a, CASE WHEN v_case = 'B7' THEN c_f ELSE c_g END, c_bp, v_q);
      IF v_case = 'B2' THEN PERFORM k81.reprice(v_q, 21.00); END IF;
      BEGIN
        v_res := public.create_invoice_from_blend_ticket(v_t, c_admin, 'k81-blend-' || v_case || '-' || md5(random()::text));
        SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
          FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
           AND i.customer_id = c_a AND ii.product_id = c_bp;
      EXCEPTION WHEN OTHERS THEN
        IF v_case = 'B2' AND SQLERRM LIKE 'QUOTE_RESEND_REQUIRED:%' THEN v_cents := -1; v_src := 'refused';
        ELSE RAISE EXCEPTION 'SMOKE_FAIL(%): the blend invoice failed: %', v_case, SQLERRM; END IF;
      END;
      IF v_case = 'B2' THEN
        IF v_cents IS DISTINCT FROM -1 THEN
          RAISE EXCEPTION 'SMOKE_FAIL(B2): the blend invoice billed an unsent price: % %', v_cents, v_src;
        END IF;
        SELECT count(*) INTO v_n FROM public.invoice_items WHERE product_id = c_bp;
        IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL(B2): a refused blend invoice left % line(s)', v_n; END IF;
      ELSIF (v_case IN ('B1', 'B7') AND (v_cents IS DISTINCT FROM 2000 OR v_src IS DISTINCT FROM 'quoted'))
         OR (v_case IN ('B3', 'B4', 'B5', 'B6') AND (v_cents IS DISTINCT FROM 1000 OR v_src IS DISTINCT FROM 'tier')) THEN
        RAISE EXCEPTION 'SMOKE_FAIL(%): grower A''s blend line billed % %', v_case, v_cents, v_src;
      END IF;
      IF v_case = 'B7' THEN
        SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
          FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
           AND i.customer_id = c_b AND ii.product_id = c_bp;
        IF v_cents IS DISTINCT FROM 1000 OR v_src IS DISTINCT FROM 'tier' THEN
          RAISE EXCEPTION 'SMOKE_FAIL(B7): grower B was billed % % from grower A''s job quote', v_cents, v_src;
        END IF;
      END IF;
      RAISE EXCEPTION 'K81_UNDO';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  -- ---------------------------------------------------------------- blend-ticket invoice, grower B's own quote
  FOREACH v_case IN ARRAY ARRAY['B8', 'B9', 'B10', 'B11'] LOOP
    BEGIN
      v_q := k81.quote(c_a, NULL, c_bp, 20.00, 'sent', v_today, true);
      IF v_case <> 'B10' THEN
        v_q2 := k81.quote(c_b, c_f, c_bp, CASE WHEN v_case = 'B11' THEN 0.00 ELSE 30.00 END, 'sent', v_today, true);
      END IF;
      v_t := k81.blend_ticket(c_admin, c_a, CASE WHEN v_case = 'B10' THEN c_h ELSE c_f END, c_bp, v_q);
      IF v_case = 'B9' THEN PERFORM k81.reprice(v_q2, 31.00); END IF;
      IF v_case = 'B10' THEN PERFORM k81.reprice(v_q, 21.00); END IF;
      v_err := NULL;
      BEGIN
        v_res := public.create_invoice_from_blend_ticket(v_t, c_admin, 'k81-blend-' || v_case || '-' || md5(random()::text));
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_case = 'B9' THEN
        IF v_err IS NULL OR v_err NOT LIKE 'QUOTE_RESEND_REQUIRED:%Fix or resend the quote for [PROVER] KI81 Farm B,%' THEN
          RAISE EXCEPTION 'SMOKE_FAIL(B9): an unsent change to B''s own quote did not refuse as expected: %', v_err;
        END IF;
        SELECT count(*) INTO v_n FROM public.invoice_items WHERE product_id = c_bp;
        IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL(B9): a refused blend invoice left % line(s)', v_n; END IF;
      ELSIF v_case = 'B11' THEN
        IF v_err IS NULL OR v_err NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
          RAISE EXCEPTION 'SMOKE_FAIL(B11): B''s $0 own quote did not ask for the below-cost approval: %', v_err;
        END IF;
      ELSIF v_err IS NOT NULL THEN
        RAISE EXCEPTION 'SMOKE_FAIL(%): the blend invoice failed: %', v_case, v_err;
      ELSE
        SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
          FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
           AND i.customer_id = c_b AND ii.product_id = c_bp;
        IF (v_case = 'B8' AND (v_cents IS DISTINCT FROM 3000 OR v_src IS DISTINCT FROM 'quoted'))
           OR (v_case = 'B10' AND (v_cents IS DISTINCT FROM 1000 OR v_src IS DISTINCT FROM 'tier')) THEN
          RAISE EXCEPTION 'SMOKE_FAIL(%): grower B''s blend line billed % %', v_case, v_cents, v_src;
        END IF;
        IF v_case = 'B8' THEN
          SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
            FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
           WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
             AND i.customer_id = c_a AND ii.product_id = c_bp;
          IF v_cents IS DISTINCT FROM 2000 OR v_src IS DISTINCT FROM 'quoted' THEN
            RAISE EXCEPTION 'SMOKE_FAIL(B8): grower A''s blend line billed % % (want the job quote, 2000 quoted)', v_cents, v_src;
          END IF;
        END IF;
      END IF;
      RAISE EXCEPTION 'K81_UNDO';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  -- ---------------------------------------------------------------- blend-ticket invoice, the owner's own quote
  FOREACH v_case IN ARRAY ARRAY['B12', 'B13'] LOOP
    BEGIN
      v_q := k81.quote(c_a, NULL, c_bp, 20.00, CASE WHEN v_case = 'B12' THEN 'declined' ELSE 'sent' END, v_today, true);
      v_q2 := k81.quote(c_a, c_f, c_bp, 25.00, 'sent', v_today, true);
      v_t := k81.blend_ticket(c_admin, c_a, c_f, c_bp, v_q);
      v_res := public.create_invoice_from_blend_ticket(v_t, c_admin, 'k81-blend-' || v_case || '-' || md5(random()::text));
      SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
        FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
       WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
         AND i.customer_id = c_a AND ii.product_id = c_bp;
      IF v_cents IS DISTINCT FROM (CASE WHEN v_case = 'B12' THEN 2500 ELSE 2000 END) OR v_src IS DISTINCT FROM 'quoted' THEN
        RAISE EXCEPTION 'SMOKE_FAIL(%): grower A''s blend line billed % %', v_case, v_cents, v_src;
      END IF;
      SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
        FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
       WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
         AND i.customer_id = c_b AND ii.product_id = c_bp;
      IF v_cents IS DISTINCT FROM 1000 OR v_src IS DISTINCT FROM 'tier' THEN
        RAISE EXCEPTION 'SMOKE_FAIL(%): grower B''s blend line billed % % from A''s quote', v_case, v_cents, v_src;
      END IF;
      RAISE EXCEPTION 'K81_UNDO';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  -- ---------------------------------------------------------------- blend-ticket invoice, a job quote that prices none of it
  BEGIN
    v_q := k81.quote(c_a, c_g, c_p, 20.00, 'sent', v_today, true);  -- lists only the Gal chemical, not the blend product
    v_t := k81.blend_ticket(c_admin, c_a, c_g, c_bp, v_q);
    PERFORM k81.reprice(v_q, 21.00);
    v_res := public.create_invoice_from_blend_ticket(v_t, c_admin, 'k81-blend-B14-' || md5(random()::text));
    SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
      FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
     WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
       AND i.customer_id = c_a AND ii.product_id = c_bp;
    IF v_cents IS DISTINCT FROM 1000 OR v_src IS DISTINCT FROM 'tier' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(B14): grower A''s blend line billed % % (want 1000 tier)', v_cents, v_src;
    END IF;
    RAISE EXCEPTION 'K81_UNDO';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
  END;

  -- ---------------------------------------------------------------- blend-ticket invoice, no job quote
  FOREACH v_case IN ARRAY ARRAY['B15', 'B16'] LOOP
    BEGIN
      IF v_case = 'B15' THEN
        v_q := k81.quote(c_a, c_f, c_bp, 20.00, 'sent', v_today, true);
        v_q2 := k81.quote(c_b, c_f, c_bp, 30.00, 'sent', v_today, true);
        v_t := k81.blend_ticket(c_admin, c_a, c_f, c_bp, NULL);  -- the job points at no quote
      ELSE
        v_q := k81.quote(c_a, c_g, c_bp, 0.00, 'sent', v_today, true);
        v_t := k81.blend_ticket(c_admin, c_a, c_g, c_bp, NULL);
      END IF;
      v_err := NULL;
      BEGIN
        v_res := public.create_invoice_from_blend_ticket(v_t, c_admin, 'k81-blend-' || v_case || '-' || md5(random()::text));
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_case = 'B16' THEN
        IF v_err IS NULL OR v_err NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
          RAISE EXCEPTION 'SMOKE_FAIL(B16): the owner''s own $0 quote did not ask for the below-cost approval: %', v_err;
        END IF;
      ELSIF v_err IS NOT NULL THEN
        RAISE EXCEPTION 'SMOKE_FAIL(B15): the blend invoice failed: %', v_err;
      ELSE
        SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
          FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
           AND i.customer_id = c_a AND ii.product_id = c_bp;
        IF v_cents IS DISTINCT FROM 2000 OR v_src IS DISTINCT FROM 'quoted' THEN
          RAISE EXCEPTION 'SMOKE_FAIL(B15): grower A''s blend line billed % % (want 2000 quoted)', v_cents, v_src;
        END IF;
        SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
          FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ii.invoice_id IN (SELECT jsonb_array_elements_text(v_res->'invoice_ids')::uuid)
           AND i.customer_id = c_b AND ii.product_id = c_bp;
        IF v_cents IS DISTINCT FROM 3000 OR v_src IS DISTINCT FROM 'quoted' THEN
          RAISE EXCEPTION 'SMOKE_FAIL(B15): grower B''s blend line billed % % (want 3000 quoted)', v_cents, v_src;
        END IF;
      END IF;
      RAISE EXCEPTION 'K81_UNDO';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  RAISE NOTICE 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
