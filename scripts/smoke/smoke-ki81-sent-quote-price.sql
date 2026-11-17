-- ============================================================================
-- Valid quotes expire on the run's own Chicago date (the inclusive boundary), so the chain holds on any day of the season.
-- CONTAINER ONLY smoke chain for 20270123100000_ki81_invoices_bill_sent_quote_price (KI-81).
-- Run through scripts/smoke/prove-ki81-sent-quote-price-real-schema.mjs, never against a shared
-- database: it saves invoices, which draw invoice numbers a rollback does not return.
-- It needs the prover's committed fixtures (ids a81a81a8-...) and its k81.quote() helper.
--
-- Rules under test (Mason, 2026-11-17; contract docs/plans/2026-11-17-ki81-sent-price-invoices-CONTRACT.md):
--   F1  a field-app chemical on the billed grower's sent quote bills the sent price (source quoted);
--   F2  a price changed after sending, not re-sent and not recorded, refuses QUOTE_RESEND_REQUIRED;
--   F3  a price change save_quote recorded since the send bills the new price;
--   F4  a draft, declined, cancelled or deleted quote, another grower's quote, or a quote expired before
--       the invoice date, or a later season's quote, bills the tier price; an "expired" quote still valid that date counts;
--   F5  two eligible quotes at different prices refuse FIELD_APP_QUOTE_PRICE_CONFLICT; a typed price saves;
--   X1-X3 the split-bill save: a co-owner's sent quote prices both children; an unsent change refuses;
--       a quote of a grower not on the bill does not count;
--   B1-B3 the blend-ticket invoice: the sent price bills; an unsent change refuses before any invoice;
--       a never-sent job quote still prices the blend.
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
      IF SQLERRM NOT LIKE 'QUOTE_RESEND_REQUIRED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL(F2): wrong refusal: %', SQLERRM; END IF;
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
  FOREACH v_case IN ARRAY ARRAY['draft', 'declined', 'cancelled', 'deleted', 'other_grower', 'expired_before', 'next_season', 'expired_valid'] LOOP
    BEGIN
      v_q := k81.quote(CASE WHEN v_case = 'other_grower' THEN c_c ELSE c_a END, c_g, c_p, 30.00,
                       CASE v_case WHEN 'draft' THEN 'draft' WHEN 'declined' THEN 'declined' WHEN 'cancelled' THEN 'cancelled'
                                   WHEN 'expired_before' THEN 'expired' WHEN 'expired_valid' THEN 'expired' ELSE 'sent' END,
                       CASE v_case WHEN 'expired_before' THEN v_today - 1 WHEN 'next_season' THEN v_today + 400 ELSE v_today END,
                       v_case <> 'draft');
      IF v_case = 'deleted' THEN PERFORM k81.soft_delete(v_q); END IF;
      SELECT * INTO v_cents, v_src FROM k81.save_single(c_admin, c_g, c_p, NULL);
      IF v_case = 'expired_valid' THEN
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

  -- ---------------------------------------------------------------- split-bill save (field F: A and B)
  -- X1: grower B's sent quote prices the chemical for both children (1 Gal at $20.00 = 2000, split 1000 / 1000).
  -- X2: its unsent change refuses. X3: grower C (not on the bill) quoting does not count: tier $10.00.
  FOREACH v_case IN ARRAY ARRAY['X1', 'X2', 'X3'] LOOP
    BEGIN
      v_q := k81.quote(CASE WHEN v_case = 'X3' THEN c_c ELSE c_b END, c_f, c_p, 20.00, 'sent', v_today, true);
      IF v_case = 'X2' THEN PERFORM k81.reprice(v_q, 21.00); END IF;
      BEGIN
        v_cents := k81.save_split(c_admin, c_f, c_p);
      EXCEPTION WHEN OTHERS THEN
        IF v_case = 'X2' AND SQLERRM LIKE 'QUOTE_RESEND_REQUIRED:%' THEN v_cents := -1;
        ELSE RAISE EXCEPTION 'SMOKE_FAIL(%): the split save failed: %', v_case, SQLERRM; END IF;
      END;
      IF v_cents IS DISTINCT FROM (CASE v_case WHEN 'X1' THEN 2000 WHEN 'X2' THEN -1 ELSE 1000 END) THEN
        RAISE EXCEPTION 'SMOKE_FAIL(%): the split bill totals % cents', v_case, v_cents;
      END IF;
      RAISE EXCEPTION 'K81_UNDO';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  -- ---------------------------------------------------------------- blend-ticket invoice (grower A, 20 GL)
  FOREACH v_case IN ARRAY ARRAY['B1', 'B2', 'B3'] LOOP
    BEGIN
      v_q := k81.quote(c_a, NULL, c_bp, 20.00, CASE WHEN v_case = 'B3' THEN 'draft' ELSE 'sent' END, v_today, v_case <> 'B3');
      v_t := k81.blend_ticket(c_admin, c_a, c_g, c_bp, v_q);
      IF v_case = 'B2' THEN PERFORM k81.reprice(v_q, 21.00); END IF;
      BEGIN
        v_res := public.create_invoice_from_blend_ticket(v_t, c_admin, 'k81-blend-' || v_case || '-' || md5(random()::text));
        SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_src
          FROM public.invoice_items ii
         WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = c_bp;
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
      ELSIF v_cents IS DISTINCT FROM 2000 OR v_src IS DISTINCT FROM 'quoted' THEN
        RAISE EXCEPTION 'SMOKE_FAIL(%): the blend invoice billed % %', v_case, v_cents, v_src;
      END IF;
      RAISE EXCEPTION 'K81_UNDO';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'K81_UNDO' THEN RAISE; END IF;
    END;
  END LOOP;

  RAISE NOTICE 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
