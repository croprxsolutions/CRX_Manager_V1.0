-- Transfer to Invoice bills the sent quote price (Mason, 2026-11-21, answering Taha's Week 4 report; tracked
-- beside #2061). Contract: docs/plans/2026-11-21-job-transfer-bills-sent-quote-price-CONTRACT.md.
--
-- WHY: _transfer_job_to_invoice_intent_impl_20260908 (behind transfer_job_to_invoice, the "Create Invoice" button on a
-- completed spray job) billed each chemical at the job line's own price. A job typed straight into Scheduling carries
-- the price list (tier) price, so a field the grower was sent a quote for was billed list price, not the quote.
--
-- WHAT:
--  1. New private _job_transfer_quote_price_cents_20270207(product, name, line unit, stock unit, fields, grower, date):
--     asks KI-81's _field_app_sent_quote_price_cents (unchanged) for the grower's own sent quote price on those fields,
--     valid on the date. Its rules are KI-81's (Mason 2026-11-17): own quote only; sent; not draft, declined,
--     cancelled or deleted; written on or before the date and not expired by it; passes the sent-price lock; quote unit
--     is the stock unit; two different prices stop. Its refusals end with what to do from a job instead of "type the
--     price on this invoice line". A job line in another unit than the stock unit is converted (Mason, 2026-11-21,
--     "Convert automatically"): _job_transfer_qty_in_stock_unit_20270207 turns its quantity into stock units with the
--     unit_conversions factors (via _unit_factor_oz), only within liquid or within dry and only where both factors are
--     whole fluid/dry ounces (fl oz, Pt, Qt, Gal; Dry oz, Lb), so the conversion is exact. The line then bills
--     ROUND(quote cents x converted quantity) through safe_cents_qty, as a same-unit line does. Units that can't be
--     converted that way (volume vs weight, Ea, grams, unknown) still stop (JOB_QUOTE_UNIT_MISMATCH).
--     Not SECURITY DEFINER; owned by postgres; executable by no API role.
--  2. The transfer body: each billable chemical line asks (1) on the job's date (else Chicago today).
--     Single owner: the paying grower (the one billing-default customer of the job's fields, else the job's
--     customer), all job fields; a found price bills safe_cents_qty(price, quantity), price_source 'quoted'; when
--     any line was quote-priced, the header and invoice_shares start from the sum of the written lines instead of
--     the stored job total (figured at the old prices). A per-acre all-inclusive field price still wins, as today.
--     Multi-owner: each owner, the job fields billed to them; a found price bills their acre share of the quantity;
--     an owner with no quote keeps their acre share of the job price. No price found: exactly as before.
--     Customer-supplied lines stay $0 and never look. Nothing else in the body changes.
--  3. Typed prices (Mason, 2026-11-21): new job_chemicals.price_typed (false for every existing line), stored by the
--     job save (_save_job_cost_step2_impl, re-emitted from its live body with only that column added). A typed line
--     keeps its own price (price_source 'manual') and is never re-priced from a quote; when the paying grower's sent
--     quote differs (or can't be read), Create Invoice returns a plain sentence in price_warnings for the screen.
--     _job_transfer_typed_price_warning_20270207 writes it; it never stops the invoice.
--  Grants, owner, SECURITY DEFINER, search_path and idempotency of the transfer are unchanged. No stored row changes
--  (live 2026-11-21, read only: 0 completed unbilled jobs). Taha's #2061 plans its own change in this same body.
--
-- ROLLBACK: re-run the body of 20261120100000 (lines 301-1023) and its REVOKE/GRANT; re-create
-- _save_job_cost_step2_impl from the save_job body of 20260904185900 (owner postgres, SECURITY DEFINER,
-- search_path public, pg_temp, EXECUTE postgres only); DROP FUNCTION
-- public._job_transfer_quote_price_cents_20270207(uuid, text, text, text, uuid[], uuid, date) and
-- public._job_transfer_typed_price_warning_20270207(uuid, text, text, text, uuid[], uuid, date, bigint, text) and
-- public._job_transfer_qty_in_stock_unit_20270207(numeric, text, text); then
-- ALTER TABLE public.job_chemicals DROP COLUMN price_typed (the typed marks are lost).

DO $preflight$
DECLARE
  v_impl oid := to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)');
BEGIN
  IF v_impl IS NULL
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = v_impl) IS DISTINCT FROM 'a54e3e6a3a2b920e9bcd1a350cd92423'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = v_impl AND p.prosecdef
                       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                       AND p.proowner = 'postgres'::regrole
                       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]) THEN
    RAISE EXCEPTION 'JOB_QUOTE_PRICE_PREFLIGHT: the transfer body, owner, settings or grants are not the reviewed ones (20261120100000)';
  END IF;
  IF to_regprocedure('public._field_app_sent_quote_price_cents(uuid,uuid[],uuid[],date)') IS NULL
     OR to_regprocedure('public._unit_matches_stock_unit(text,text)') IS NULL
     OR to_regprocedure('public._unit_factor_oz(text,text)') IS NULL
     OR to_regprocedure('public._quote_item_sent_field_20270129(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'JOB_QUOTE_PRICE_PREFLIGHT: KI-81 (20270129180000) or the stock-unit check (20270121110000) is missing';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)')) IS DISTINCT FROM '8acf34542105a90212ddb0a5e7c5d272'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)')
                       AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                       AND p.proowner = 'postgres'::regrole AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]) THEN
    RAISE EXCEPTION 'JOB_QUOTE_PRICE_PREFLIGHT: the job save body, owner, settings or grants are not the reviewed ones (20260904185900)';
  END IF;
  IF to_regprocedure('public._job_transfer_quote_price_cents_20270207(uuid,text,text,text,uuid[],uuid,date)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'job_chemicals' AND column_name = 'price_typed') THEN
    RAISE EXCEPTION 'JOB_QUOTE_PRICE_PREFLIGHT: already applied';
  END IF;
END;
$preflight$;

ALTER TABLE public.job_chemicals ADD COLUMN price_typed boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.job_chemicals.price_typed IS
  'Staff typed this line''s price by hand (Mason, 2026-11-21): Create Invoice bills it as is, never from a quote, and warns when the sent quote differs.';
-- job_chemicals is column-carved (live: authenticated SELECT + REFERENCES per column, anon nothing, no API writes),
-- so the new column gets the same read grants and nothing else.
GRANT SELECT (price_typed) ON public.job_chemicals TO authenticated;
GRANT REFERENCES (price_typed) ON public.job_chemicals TO authenticated;

-- Rule 3 (Mason, 2026-11-21, "Convert automatically"): a job line's quantity in the product's stock (quote) unit.
-- Same unit (or a blank one): the quantity unchanged. Else both units must be in unit_conversions as the same kind
-- (liquid or dry, never "both"/Ea) with whole-ounce factors (fl oz 1, Pt 16, Qt 32, Gal 128; Dry oz 1, Lb 16), so
-- quantity x from / to is exact (every such divisor is a power of two). NULL when the units can't be converted.
-- Example: 16 Pt in Gal = 16 x 16 / 128 = 2.
CREATE FUNCTION public._job_transfer_qty_in_stock_unit_20270207(p_qty numeric, p_line_unit text, p_stock_unit text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_kind text;
  v_from numeric;
  v_to   numeric;
BEGIN
  IF public._unit_matches_stock_unit(p_line_unit, p_stock_unit) THEN
    RETURN p_qty;
  END IF;
  FOREACH v_kind IN ARRAY ARRAY['liquid', 'dry'] LOOP
    v_from := public._unit_factor_oz(p_line_unit, v_kind);
    v_to   := public._unit_factor_oz(p_stock_unit, v_kind);
    IF v_from IS NOT NULL AND v_to IS NOT NULL AND v_from = trunc(v_from) AND v_to = trunc(v_to) THEN
      RETURN p_qty * v_from / v_to;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;
ALTER FUNCTION public._job_transfer_qty_in_stock_unit_20270207(numeric, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_transfer_qty_in_stock_unit_20270207(numeric, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._job_transfer_quote_price_cents_20270207(
  p_product_id   uuid,
  p_product_name text,
  p_line_unit    text,
  p_stock_unit   text,
  p_field_ids    uuid[],
  p_customer_id  uuid,
  p_on           date
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cents bigint;
  v_msg   text;
BEGIN
  IF p_product_id IS NULL OR p_customer_id IS NULL OR COALESCE(cardinality(p_field_ids), 0) = 0 THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_cents := public._field_app_sent_quote_price_cents(p_product_id, p_field_ids, ARRAY[p_customer_id], p_on);
  EXCEPTION WHEN raise_exception THEN
    -- KI-81's messages tell the field-app screen to type the price; from a job, say what to do instead.
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'QUOTE_RESEND_REQUIRED:%' OR v_msg LIKE 'FIELD_APP_QUOTE_PRICE_%' THEN
      v_msg := regexp_replace(v_msg,
        '\s*(Or type the price on this invoice line, then save again\.|Type the agreed price on that line, then save again\.|Save again\.)$', '');
      RAISE EXCEPTION '% Nothing was billed. Fix or resend the quote, then create the invoice again, or bill this job through Split Billing (per line) and type the price.', v_msg
        USING ERRCODE = 'P0001';
    END IF;
    RAISE;
  END;
  IF v_cents IS NOT NULL AND public._job_transfer_qty_in_stock_unit_20270207(1, p_line_unit, p_stock_unit) IS NULL THEN
    RAISE EXCEPTION 'JOB_QUOTE_UNIT_MISMATCH: % is quoted per % but this job bills it per %, and those units can''t be converted, so the quote price can''t be billed. Nothing was billed. Change the job line to %, or bill this job through Split Billing (per line) and type the price.',
      COALESCE(p_product_name, 'A product'), p_stock_unit, p_line_unit, p_stock_unit
      USING ERRCODE = 'P0001';
  END IF;
  RETURN v_cents;
END;
$fn$;
ALTER FUNCTION public._job_transfer_quote_price_cents_20270207(uuid, text, text, text, uuid[], uuid, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_transfer_quote_price_cents_20270207(uuid, text, text, text, uuid[], uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;

-- Typed price warning (Mason, 2026-11-21): NULL when the paying grower has no sent quote for this product on these
-- fields or it agrees with the typed price; else one sentence for staff. Never stops the invoice: a quote that can't
-- be read becomes a warning too. Its lookup runs in a subtransaction, so a refusal leaves nothing behind.
CREATE FUNCTION public._job_transfer_typed_price_warning_20270207(
  p_product_id   uuid,
  p_product_name text,
  p_line_unit    text,
  p_stock_unit   text,
  p_field_ids    uuid[],
  p_customer_id  uuid,
  p_on           date,
  p_typed_cents  bigint,
  p_owner_name   text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cents bigint;
  v_msg   text;
  v_what  text := COALESCE(p_product_name, 'A product') || CASE WHEN p_owner_name IS NULL THEN '' ELSE ' (' || p_owner_name || ')' END;
BEGIN
  IF p_product_id IS NULL OR p_customer_id IS NULL OR COALESCE(cardinality(p_field_ids), 0) = 0 THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_cents := public._field_app_sent_quote_price_cents(p_product_id, p_field_ids, ARRAY[p_customer_id], p_on);
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'QUOTE_RESEND_REQUIRED:%' OR v_msg LIKE 'FIELD_APP_QUOTE_PRICE_%' THEN
      v_msg := regexp_replace(regexp_replace(v_msg, '^[A-Z_]+:[[:space:]]*', ''),
        '[[:space:]]*(Or type the price on this invoice line, then save again[.]|Type the agreed price on that line, then save again[.]|Save again[.])$', '');
      RETURN format('%s: the typed price was billed, but it could not be checked against the sent quote: %s', v_what, v_msg);
    END IF;
    RAISE;
  END;
  IF v_cents IS NULL THEN
    RETURN NULL;
  END IF;
  -- Same price once converted (e.g. $10.50 per Qt against $42.00 per Gal): no warning.
  IF COALESCE(v_cents * public._job_transfer_qty_in_stock_unit_20270207(1, p_line_unit, p_stock_unit) = COALESCE(p_typed_cents, 0), false) THEN
    RETURN NULL;
  END IF;
  RETURN format('%s: the typed price of $%s per %s was billed; the sent quote is $%s per %s.', v_what,
    to_char(COALESCE(p_typed_cents, 0) / 100.0, 'FM999,999,990.00'), COALESCE(NULLIF(btrim(p_line_unit), ''), p_stock_unit),
    to_char(v_cents / 100.0, 'FM999,999,990.00'), p_stock_unit);
END;
$fn$;
ALTER FUNCTION public._job_transfer_typed_price_warning_20270207(uuid, text, text, text, uuid[], uuid, date, bigint, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_transfer_typed_price_warning_20270207(uuid, text, text, text, uuid[], uuid, date, bigint, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- The job save stores the typed mark; everything else is its live body, unchanged.
CREATE OR REPLACE FUNCTION public._save_job_cost_step2_impl(
  p_job_id uuid,
  p_job_payload jsonb,
  p_fields jsonb,
  p_chemicals jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_job_id uuid;
  v_is_new boolean := (p_job_id IS NULL);
  v_field jsonb;
  v_chem jsonb;
  v_share jsonb;
  v_field_id uuid;
  v_season integer;
  v_job_date date;
  v_existing jsonb;
  v_fingerprint text;
  v_result jsonb;
  v_share_total numeric;
  -- Chemical-unit invariant + derived totals (this migration).
  v_acres numeric;
  v_raw_rate_unit text;
  v_rate_base text;
  v_denom_probe text;
  v_denom_canon text;
  v_base_folded text;
  v_stock_canon text;
  v_qty_unit text;
  v_price_unit text;
  v_qty numeric;
  v_rate numeric;
  v_carried numeric;
  v_form text;
  v_product_name text;
  v_driver text;
  v_total_cost_cents bigint;
  v_total_price_cents bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency: replay with the same key returns the original result without
  -- creating a second job (the create-path double-submit hazard).
  --
  -- This now routes through the canonical check_idempotency helper family the rest
  -- of the app already uses -- specifically check_idempotency_intent, the same helper
  -- nine live money RPCs call today (the whole return family plus create/post/void
  -- commission payment; read read-only from pg_proc 2026-08-24). Round 8 landed the
  -- plain key+operation helper here and round 9 tightened it to the intent form; the
  -- reasoning for both is kept below rather than rewritten, because the round-8 hole
  -- is still the reason the raw lookup can never come back.
  -- The previous code -- carried unchanged from the live body, so this
  -- is a PRE-EXISTING defect this migration closes rather than one it caused --
  -- did its own unlocked lookup filtered to operation = 'save_job', and then
  -- recorded with ON CONFLICT (idempotency_key) DO NOTHING. The live uniqueness
  -- constraint is idempotency_keys_idempotency_key_key, on the KEY ALONE and NOT
  -- on (key, operation) -- read read-only 2026-08-24. Those two facts together
  -- are the bug: a key already spent by ANOTHER operation is invisible to a
  -- lookup filtered by operation, so the job is created, the receipt INSERT is
  -- swallowed by the conflict, and the NEXT retry with that key finds nothing
  -- again and creates a SECOND JOB. A duplicate job is a duplicate bill.
  -- Two callers racing on one key could likewise both pass the unlocked lookup.
  --
  -- check_idempotency closes both: it takes pg_advisory_xact_lock on the key, so
  -- concurrent callers serialize, and it RAISES IDEMPOTENCY_CROSS_OP_KEY_REUSE
  -- rather than letting a foreign key silently through. Found by the exact-SHA
  -- gpt-5.6-sol proof gate (2026-08-24); Mason approved closing it here rather
  -- than in a follow-up, because a second migration replacing this same body is
  -- the non-atomic hazard round 3 already caught. No grant change is needed:
  -- check_idempotency is executable by postgres and service_role only, and this
  -- function is SECURITY DEFINER owned by postgres, so the inner call runs with
  -- the owner's rights. T26 pins the cross-operation refusal, T27 the replay.
  -- ROUND 9: bound to the ACTOR and to a FINGERPRINT of what was actually asked for,
  -- not merely to the key. check_idempotency alone still let a completed key be reused
  -- for a DIFFERENT job or a CHANGED payload: it matches on the key, so the caller got
  -- back the earlier success and the current request was never saved. The operator sees
  -- "saved" while the edited quantities, cents or job details went nowhere.
  --
  -- Reachability, stated honestly because the gate overstated it: one in-repository CRX
  -- Manager browser caller is JobDetail.tsx (performSave near line 2360; save_job call
  -- near line 2468). runJobSave
  -- normally resets its key for a new save; the license-override direct performSave path
  -- may deliberately reuse one after an uncertain outcome. What remains real is the
  -- hardening gap itself -- any caller presenting a spent key gets the old result -- and
  -- that is worth closing on a SECURITY DEFINER money path regardless of today's client.
  --
  -- Like the rest of this block, the weakness is PRE-EXISTING: the live body binds
  -- nothing either. Mason approved closing it here (2026-08-24) rather than in a
  -- follow-up migration.
  --
  -- extensions.digest, not digest: pgcrypto is installed in the `extensions` schema
  -- (read read-only 2026-08-24) and this function pins search_path to public, pg_temp,
  -- so an unqualified call would not resolve at run time.
  --
  -- The arrays are canonicalised by sorting their elements before hashing, so a resend
  -- that merely reorders the chemical or field rows is still recognised as the SAME
  -- intent. jsonb already normalises object key order, so only array order needed it.
  --
  -- The claimed totals inside p_job_payload are deliberately left IN the fingerprint
  -- even though the money is derived and they are ignored: two requests that differ
  -- there are different requests, and failing closed is the safe direction.
  --
  -- Lock ordering is unchanged by this swap. check_idempotency and
  -- check_idempotency_intent take the SAME transaction-scoped advisory lock on the same
  -- key, at the same point -- before any business write -- so save_job acquires locks in
  -- the same order it always did. (20260819232000 warns that moving save_quote or
  -- convert_quote_to_order onto the intent helper needs a fresh same-key deadlock
  -- review; save_job is not named there, and it takes no barrier or row lock ahead of
  -- this point.)
  IF p_idempotency_key IS NOT NULL THEN
    v_fingerprint := encode(
      extensions.digest(
        convert_to(
          jsonb_build_object(
            'actor_id',   v_actor,
            -- p_performed_by is fingerprinted SEPARATELY from v_actor because it is a
            -- DIFFERENT input with a different effect: it is written to jobs.created_by at
            -- the INSERT below, so it is the audit identity the row ends up carrying. Line
            -- 337 only refuses it when it is non-NULL AND disagrees with the caller, so
            -- flipping it between NULL and the authenticated actor passes that check while
            -- changing what gets recorded. Omitted from the fingerprint, a retry on the same
            -- key with a changed p_performed_by replayed the earlier receipt and silently
            -- discarded the new audit identity -- the same silent-discard shape round 9
            -- fixed for the payload, missed here because this parameter is not part of the
            -- payload. Found by the gate on 2026-08-24 (MEDIUM).
            'performed_by', p_performed_by,
            'job_id',     p_job_id,
            'job_payload', COALESCE(p_job_payload, '{}'::jsonb),
            'fields', (
              SELECT COALESCE(jsonb_agg(e ORDER BY e::text), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) e
            ),
            'chemicals', (
              SELECT COALESCE(jsonb_agg(e ORDER BY e::text), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(p_chemicals, '[]'::jsonb)) e
            )
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );

    -- Returns NULL for a first call. On a valid replay it returns a WRAPPER --
    -- {"found": true, "result": ...} -- NOT the bare result that check_idempotency
    -- returns. Returning it unwrapped would hand the browser a payload shaped nothing
    -- like a save result, and assertRpcResult would reject it. Read from the installed
    -- body on 2026-08-24, not assumed from the name.
    v_existing := check_idempotency_intent(p_idempotency_key, 'save_job', v_actor, v_fingerprint);
    IF v_existing IS NOT NULL THEN
      IF v_existing -> 'result' IS NULL
         OR jsonb_typeof(v_existing -> 'result') IS DISTINCT FROM 'object'
         OR NULLIF(v_existing -> 'result' ->> 'job_id', '') IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      RETURN v_existing -> 'result';
    END IF;
  END IF;

  v_job_date := (p_job_payload->>'job_date')::date;
  -- U3 (Codex R2 P2): the live body used a JULY season cutoff (>= 7) while the
  -- system canon is Oct 1 (CLAUDE.md; create_job_from_quote_section and
  -- allocate_payment both use >= 10). transfer_job_to_invoice passes jobs.season
  -- to compute_application_service_fee for customer-specific rates, so a
  -- Jul-Sep job stamped into next season would look up the WRONG season's rate.
  -- Use the canonical live helper.
  v_season := compute_season(v_job_date);

  -- BODY MARKER: chem_unit_invariant_v4
  -- 2026-09-04: missing and JSON-null field acreage are refused before any write.
  -- NEW direct-RPC compatibility: non-null empty acreage stores as numeric zero; UI already sends zero.
  -- ==========================================================================
  -- CHEMICAL UNIT INVARIANT. Runs BEFORE any write, so a refusal leaves the job
  -- exactly as it was. This predicate is SERVER-AUTHORED AND HAS NO SHIPPED CLIENT
  -- COUNTERPART -- see the retraction in the file header. An earlier draft of this
  -- comment claimed it mirrored chemLineBillingHazard condition for condition; that
  -- function does not exist on `main`, and the claim is retracted. Until PR #436
  -- lands there is NO on-screen warning before this refusal, which is precisely why
  -- that PR is an ordering prerequisite.
  --
  -- The acreage is the one the page uses: sumAcres(fieldRows), i.e. the sum of
  -- acres_to_treat over the fields being saved -- NOT p_job_payload.total_acres,
  -- which is caller-supplied and is exactly the kind of number this migration
  -- stops trusting.
  -- ==========================================================================
  -- JOB FIELD ACREAGE SHAPE GUARD: missing and JSON-null are invalid and
  -- diagnosed separately. Both checks precede every acres COALESCE; non-null
  -- empty acreage is newly stored as numeric zero.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f
     WHERE NOT (f ? 'acres_to_treat')
  ) THEN
    RAISE EXCEPTION
      'JOB_ACRES_NOT_FINITE: One of the fields on this job is missing the acreage key. Every field must carry a finite, non-negative acreage; an intentional blank is stored as zero.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f
     WHERE jsonb_typeof(f->'acres_to_treat') = 'null'
  ) THEN
    RAISE EXCEPTION
      'JOB_ACRES_NOT_FINITE: One of the fields on this job carries JSON null acreage. Every field must carry a finite, non-negative acreage; an intentional blank is stored as zero.';
  END IF;

  SELECT COALESCE(SUM(COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0)), 0)
    INTO v_acres
    FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f;

  -- THE ACREAGE IS NOW VALIDATED, not merely summed, and round 24 is why (HIGH,
  -- gpt-5.6-sol, 2026-08-24). Every field acreage must be a finite, non-negative number.
  --
  -- Checked PER ELEMENT rather than on the total, because a negative acreage on one field
  -- can be cancelled by a positive one on another and a sum test would never see it. The
  -- range form also excludes NaN and Infinity in a single comparison, for the reason
  -- recorded throughout this file: numeric NaN sorts ABOVE every value, so `>= 0` admits it.
  --
  -- This is the residual earlier rounds recorded and left open -- job_fields.acres_to_treat
  -- carries no CHECK anywhere in the live schema -- closed on the RPC path. It does not
  -- replace the column constraint; it stops THIS entry point storing the shape.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f
     WHERE NOT (COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0) >= 0
                AND COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0) < 'Infinity'::numeric)
  ) THEN
    RAISE EXCEPTION
      'JOB_ACRES_NOT_FINITE: One of the fields on this job carries an acreage that is negative or not a number. Every field must carry a real, non-negative number of acres to treat.';
  END IF;

  FOR v_chem IN SELECT * FROM jsonb_array_elements(COALESCE(p_chemicals, '[]'::jsonb)) LOOP
    -- F06 (2026-09-03): WHICH FIELD THE OPERATOR TYPED on this line. The client's 3-way
    -- calculator back-solves the other field either way, so a saved (rate, quantity) pair
    -- is the same row whether the operator typed the rate or the total -- and on a later
    -- acreage change the client must know which side to hold. Stored, never interpreted
    -- here: none of the refusals below read it, and the money derivation is unchanged.
    -- NULL / '' means unknown (every pre-F06 row, and rows written by the close-quote and
    -- recipe paths, which never send it); the client leaves an unknown row exactly as
    -- saved. Anything else is REFUSED rather than coerced or dropped: a mis-attributed
    -- driver makes the client silently rewrite a hand-typed total on the next acreage
    -- change, which is the exact harm the column exists to prevent. Raised before any
    -- write, like every other refusal in this loop. The idempotency fingerprint above
    -- hashes whole chemical elements, so the driver is bound into it with no change.
    v_driver := NULLIF(v_chem->>'driver', '');
    IF v_driver IS NOT NULL AND v_driver NOT IN ('rate', 'qty') THEN
      v_product_name := NULL;
      IF COALESCE(v_chem->>'product_id', '') <> '' THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      END IF;
      RAISE EXCEPTION
        'CHEM_DRIVER_INVALID: % carries a calculator driver of "%", which is neither "rate" nor "qty", so the line cannot record which field was typed. Re-enter the rate per acre or the quantity on that line and save again.',
        COALESCE(v_product_name, 'This product'), v_driver;
    END IF;
    -- QUANTITY MUST BE FINITE AND NON-NEGATIVE, and it is checked FIRST -- ahead of every
    -- skip below, including the missing-product skip. A negative or non-finite quantity is
    -- a money defect in its own right, independent of the units: it flows into
    -- safe_cents_qty at the derived-totals step whether or not the units agree, so
    -- checking it only on the units path would leave the matching-units case open.
    --
    -- It also has to precede the product_id skip specifically, because the derived-totals
    -- SELECT sums EVERY element of p_chemicals -- including the ones this loop skips. With
    -- the check placed after that skip, a row carrying no product_id and a NaN quantity
    -- bypassed it entirely and then aborted inside safe_cents_qty with a raw "cannot
    -- convert NaN to bigint" instead of the operator-facing refusal. Fail-closed either
    -- way, but the wrong message (compliance review, round 3).
    --
    -- Written as a finite RANGE test, never as a NaN test. In PostgreSQL numeric, NaN is
    -- ordered ABOVE every other value, so `NaN > 0` is TRUE, and NaN is equal to itself,
    -- so `NaN <= NaN` is TRUE. A naive positivity test therefore admits NaN, and the
    -- tolerance comparison further down admits it a second time (Codex P1, round 3).
    v_qty := COALESCE(NULLIF(v_chem->>'quantity', '')::numeric, 0);
    IF NOT (v_qty >= 0 AND v_qty < 'Infinity'::numeric) THEN
      -- The name lookup is guarded: this arm now runs for rows with no product_id, and
      -- casting an empty string to uuid would replace the business error with a cast error.
      v_product_name := NULL;
      IF COALESCE(v_chem->>'product_id', '') <> '' THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      END IF;
      RAISE EXCEPTION
        'CHEM_QUANTITY_NOT_FINITE: % has a quantity of "%", which is not a finite, non-negative number, so it cannot be priced.',
        COALESCE(v_product_name, 'This product'), COALESCE(v_chem->>'quantity', '');
    END IF;

    -- A row with no product cannot have its UNITS checked: the conversion needs
    -- products.product_form. It is not silently accepted either -- job_chemicals.product_id
    -- is NOT NULL, so such a row aborts the whole save at the INSERT below.
    -- (buildJobChemicalsPayload does NOT filter these out, so this is a real path, not a
    -- theoretical one.)
    CONTINUE WHEN COALESCE(v_chem->>'product_id', '') = '';

    v_raw_rate_unit := lower(btrim(COALESCE(v_chem->>'rate_unit', '')));

    -- (2) A rate measured per something other than an acre. 'quantity = rate x acres'
    -- cannot be derived from it, so the quantity is simply the wrong amount. Refused
    -- rather than silently treated as per-acre.
    --
    -- BOTH denominator spellings are caught. Checking only for '/' left a real hole
    -- (Codex P1): 'oz per cwt' has no slash, so it fell through to the unit comparison --
    -- and when `unit` carried the SAME text it compared EQUAL and the row was accepted,
    -- with its quantity already derived as rate x acres against a denominator that is not
    -- acres. The word form is therefore refused too. A genuine per-acre rate in either
    -- spelling ('pt/ac', 'gal per acre') is excluded first and is unaffected.
    -- The two acre spellings accept the SAME set of abbreviations, in the same order.
    -- Three asymmetries were found across two review rounds, and every one of them was a
    -- FALSE REFUSAL of a legitimate per-acre rate, which matters more here than it looks:
    -- a refusal blocks the whole job, not the line. (i) the slash form accepted 'acres'
    -- while the word form took only 'acre'; (ii) neither form saw a hyphen, so 'oz-per-cwt'
    -- fell through to the unit comparison and passed whenever `unit` carried the same
    -- text; (iii) the word form took only 'acre'/'acres' while the slash form also took
    -- 'ac' and 'a', so 'pt per ac' -- an ordinary spelling -- was refused as non-acre.
    -- Alternation is longest-first because PostgreSQL regexps are POSIX. 'per' must still
    -- appear as a whole word between separators, so a plain hyphenated unit such as
    -- 'fl-oz' is untouched.
    -- STACKED denominators, and the reason this test is written subtractively rather than
    -- as a set of exclusions. Codex found (BLOCKER, 2026-08-24) that asking "does the rate
    -- unit END in a per-acre suffix?" and stopping there accepts 'oz/cwt/ac': it does end
    -- in '/ac', so every exclusion above was satisfied, and the base derivation below then
    -- took everything before the FIRST slash and silently discarded 'cwt'. The line
    -- normalised to a plain 'oz', compared EQUAL to a stock unit of 'oz', and SAVED -- a
    -- per-hundredweight rate billed as though it were per-acre, which is exactly the money
    -- error this rule exists to stop. 'oz per cwt per acre' was the same hole one spelling
    -- away. Reproduced in the container before the fix: T24 reported refused=f.
    --
    -- So: remove ONE trailing per-acre suffix, in either spelling, and then ask whether a
    -- denominator separator SURVIVES that removal. Anything still carrying a '/' or a
    -- whole-word 'per' is measured per something that is not acres, however many
    -- denominators deep it is. This is strictly stronger than the exclusion form and
    -- refuses nothing the exclusion form accepted: every legitimate spelling reduces to a
    -- bare unit ('pt/ac' -> 'pt', 'gal-per-acre' -> 'gal'), and a hyphenated unit such as
    -- 'fl-oz' carries no separator to survive. T24 and T25 pin both stacked forms.
    -- EXACTLY ONE suffix comes off, and the IF is what makes that true. Running both
    -- regexes unconditionally strips TWO, which was a BLOCKER the exact-SHA gpt-5.6-sol
    -- gate found on 2026-08-24: 'oz per acre/ac' lost '/ac' to the first pattern and
    -- ' per acre' to the second, the probe came back a bare 'oz' with no denominator
    -- left to catch, and a rate of oz per acre PER ACRE normalised to 'oz', matched a
    -- stock unit of 'oz' and was BILLED. 'oz-per-acre/ac' was the same hole one
    -- separator away. The stacked-denominator rule the round before was written to
    -- close only holds if the strip is singular -- 'remove one, refuse whatever
    -- survives' is not the same rule as 'remove every spelling, then look'.
    -- SEPARATORS ARE CANONICALISED BEFORE THE DENOMINATOR IS CLASSIFIED, for exactly the
    -- reason the fluid-ounce rule stopped enumerating them (round 16). This test used to look
    -- for `per` bounded by whitespace or hyphens, so 'oz_per_cwt' and 'oz.per.cwt' matched
    -- nothing, survived normalisation unchanged, and -- with a stock unit carrying the same
    -- text -- reached the equality branch and billed a per-hundredweight rate as per-acre
    -- (HIGH, gpt-5.6-sol 2026-08-24). Same class of defect, same fix: fold the separators
    -- instead of listing them.
    --
    -- '/' is deliberately PRESERVED by the fold, because here it is not a separator -- it is
    -- the denominator marker the rule is looking for. Everything else that is not a letter or
    -- a digit becomes a single space, after which the existing subtractive logic runs on a
    -- form with exactly one spelling: strip ONE trailing per-acre suffix, then refuse
    -- whatever denominator SURVIVES.
    --
    -- The canonical form also subsumes the leading-`per` arm added in round 15 -- 'per acre'
    -- folds to itself and is caught by the word-boundary test below -- so that arm is gone
    -- rather than left as a second way of saying the same thing.
    v_denom_canon := btrim(regexp_replace(lower(v_raw_rate_unit), '[^a-z0-9/]+', ' ', 'g'));
    v_denom_probe := regexp_replace(v_denom_canon, '\s*/\s*(acres|acre|ac|a)\s*$', '');
    IF v_denom_probe = v_denom_canon THEN
      v_denom_probe := regexp_replace(v_denom_probe, '\s+per\s+(acres|acre|ac|a)$', '');
    END IF;
    -- The LEADING form is caught too, and it was a real bypass: both patterns above and the
    -- surviving-'per' test below require whitespace or a hyphen BEFORE 'per', so a rate unit
    -- that STARTS with the denominator -- 'per cwt', 'per acre', 'per-acre' -- matched none of
    -- them. It then survived normalisation unchanged, and a stock `unit` carrying the same text
    -- reached the equality shortcut and billed. Worse, such a rate names no unit at all, so
    -- there was nothing to bill per in the first place. Found by the exact-SHA gpt-5.6-sol gate
    -- on 2026-08-24 (HIGH), after an earlier round had added this same shape to the PRE-APPLY
    -- query but NOT to the runtime guard -- fixing the report and leaving the enforcement is
    -- the same half-fix pattern this file has now been caught in three times.
    IF v_raw_rate_unit <> ''
       AND (position('/' IN v_denom_probe) > 0
            OR v_denom_probe ~ '(^| )per( |$)') THEN
      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_RATE_DENOMINATOR_NOT_ACRES: % has a rate unit of "%", which is measured per something other than acres, so a per-acre quantity cannot be derived from it.',
        COALESCE(v_product_name, 'This product'), v_raw_rate_unit;
    END IF;

    -- The unit the QUANTITY is counted in, and the unit the money is quoted in.
    -- baseUnitOfRate: take everything before the first '/', then drop a spelled-out
    -- ' per acre'. normalize_rate_unit then canonicalises synonyms (lbs -> lb, gl -> gal).
    v_rate_base := btrim(split_part(v_raw_rate_unit, '/', 1));
    -- The per-acre STRIPPER below stays character-for-character identical to the word-form
    -- pattern used in the probe above -- what deliberately differs is only that the probe
    -- takes ONE suffix while this takes a split_part plus one strip. That is sound because
    -- anything reaching here has already been PROVED to carry at most one per-acre
    -- denominator in one spelling; a stacked or mixed form was refused above and never
    -- arrives. If the two patterns ever
    -- disagree, a rate unit can be excluded from the non-acre refusal and then NOT
    -- stripped, so it reaches normalize_rate_unit whole, comes back unrecognised, and the
    -- line is refused by the unit comparison instead -- a refusal with the wrong message.
    v_rate_base := btrim(regexp_replace(v_rate_base, '[\s-]+per[\s-]+(acres|acre|ac|a)$', ''));
    v_qty_unit  := normalize_rate_unit(v_rate_base);
    v_price_unit := normalize_rate_unit(v_chem->>'unit');

    -- Note precisely what the blank handling below does NOT cover: normalize_rate_unit
    -- returns NULL only for
    -- BLANK input; an UNRECOGNISED unit comes back as itself (its ELSE branch). So an
    -- unrecognised unit is NOT skipped here -- it flows on, field_app_priced_quantity
    -- cannot size it, and the row is REFUSED. That is deliberate (an unpriceable unit
    -- must not bill), but it also means a metric pair such as 'g/ac' against 'kg' is
    -- refused even though the conversion is arithmetically well defined, because the
    -- live size tables carry no metric entries. Widening them is a separate change.
    -- A ZERO quantity bills nothing, so there is nothing to prove or disprove and nothing
    -- that can be billed wrongly. This skip has to sit ABOVE the blank-unit refusal, not
    -- below it: with it below, a line carrying a blank unit, a price, and quantity 0 was
    -- REFUSED even though transfer_job_to_invoice bills it as safe_cents_qty(price, 0) = 0.
    -- That contradicted the exemption rule stated below, and it was reachable from the
    -- ordinary UI -- reconcileChemAutofillUnits leaves `unit` blank on its fallback path
    -- while the tier price is already filled in, so a product picked before any acreage is
    -- entered produces exactly that shape and would have blocked the WHOLE job save.
    -- Found by the security review of this very change; T20 pins it.
    -- Negative and non-finite quantities were refused outright at the top of the loop.
    --
    -- ROUND 17: the skip is no longer UNCONDITIONAL, because as an unconditional exit it was
    -- the mirror image of the equality shortcut and leaked money the other way (HIGH,
    -- gpt-5.6-sol 2026-08-24). A line with a real price, a real rate and real acreage but
    -- quantity 0 saved and billed NOTHING -- so where the equality shortcut let a caller
    -- OVER-charge, this let one UNDER-charge, and the zero propagates into the invoice.
    --
    -- Mason's rule (2026-08-24): refuse only where a customer's money is actually at stake.
    -- Three exits stay, and each is a case where zero is genuinely the right answer:
    --   * customer_supplied -- contributes 0 to both totals by definition;
    --   * no PRICE -- nothing can be under-charged. This is the exemption that keeps live
    --     JOB-2026-0001 saveable: it carries quantity 0 against a 5/ac rate over 178.31
    --     acres with a cost but price 0. Its cost still misstates margin, which is a known
    --     and accepted residual, not an oversight;
    --   * no usable rate or acreage -- nothing was EXPECTED, so zero is not a shortfall.
    --     This is the one that matters operationally: it is the ordinary-UI path T20 was
    --     written for, where a product is picked before any acreage is entered. There
    --     acres = 0, so the expected quantity is 0 too and the line is simply correct.
    --
    -- What is left is exactly the harmful shape: priced, a positive quantity was expected,
    -- and none was recorded.
    --
    -- RE-RAISED AND RE-SETTLED (Mason, 2026-08-24). A later gate round asked for the third
    -- exemption to be narrowed to "acreage is genuinely zero", so that a priced line with
    -- POSITIVE acreage and no usable rate would be refused as unverifiable. Mason declined,
    -- and the reason is operational rather than theoretical: that shape is what the screen
    -- produces MID-ENTRY. The ordinary order of work is fields first, then products --
    -- choosing the fields sets the acreage, adding a product auto-fills the tier price, and
    -- the rate is typed afterwards. Between those two moments the line is priced, has
    -- acreage, has no rate, and carries quantity 0. Refusing it does not refuse a line; it
    -- rolls back the WHOLE job save, which is the round-7 defect three separate reviews
    -- already caught on this very migration. A zero-quantity line bills zero and appears on
    -- the invoice as a zero line, so nothing is charged wrongly and the operator can see it.
    -- Recorded in docs/manual/DECISION_LOG.md; do not re-narrow this without him.
    IF v_qty = 0 THEN
      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);
      CONTINUE WHEN COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) = 0;
      v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;
      CONTINUE WHEN NOT (v_rate IS NOT NULL AND v_rate > 0 AND v_rate < 'Infinity'::numeric
                         AND v_acres > 0 AND v_acres < 'Infinity'::numeric);
      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_QUANTITY_ZERO_BUT_EXPECTED: % is quoted at % per acre over % acres, so % should have been applied, but the line records a quantity of 0 while still carrying a price. The invoice bills the quantity, so this would charge the customer nothing. Enter the quantity actually applied, or clear the rate and the price if none was used.',
        COALESCE(v_product_name, 'This product'), v_rate, v_acres, v_rate * v_acres;
    END IF;

    -- A BLANK unit on either side proves nothing -- and until Mason settled it on
    -- 2026-08-23 such a row was simply SKIPPED. That was the largest remaining hole, and
    -- the security review was right to call it out: transfer_job_to_invoice goes on to
    -- bill the line at price_per_unit_cents x quantity regardless, so an unprovable line
    -- that still BILLS is the same hazard class this whole migration exists to close, and
    -- one live row was sitting in exactly that shape.
    --
    -- So it is now REFUSED -- but only when the line actually bills. Two exemptions, both
    -- deliberate: a customer-supplied line contributes 0 to both totals, and a line with
    -- neither a cost nor a price bills nothing. Refusing either would be pure friction,
    -- because a line that cannot bill cannot bill WRONGLY. The cost side is included in
    -- the test, not just the price: total_cost_cents feeds margin, so a blank-unit line
    -- with a cost and no price is still a wrong number.
    IF v_qty_unit IS NULL OR v_price_unit IS NULL THEN
      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);
      CONTINUE WHEN COALESCE(NULLIF(v_chem->>'cost_per_unit_cents', '')::bigint, 0) = 0
                AND COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) = 0;

      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_UNIT_UNSPECIFIED: % is priced per unit but %, so the amount to bill cannot be checked. Fill in both the rate unit and the stock Unit, then re-enter the cost and price for that unit.',
        COALESCE(v_product_name, 'This product'),
        CASE WHEN v_qty_unit IS NULL AND v_raw_rate_unit <> '' THEN 'its rate unit names no unit to count the quantity in'
             WHEN v_qty_unit IS NULL AND v_price_unit IS NULL  THEN 'neither its rate unit nor its Unit is filled in'
             WHEN v_qty_unit IS NULL                           THEN 'its rate unit is blank'
             ELSE                                                   'its Unit is blank'
        END;
    END IF;

    -- (the zero-quantity skip moved ABOVE the blank-unit refusal -- see the comment there)

    -- The product's FORM is loaded BEFORE the equality shortcut, not after it. That
    -- ordering is the fix for a BLOCKER the exact-SHA gpt-5.6-sol proof gate found on
    -- 2026-08-24, and the ordering is the whole of it.
    --
    -- normalize_rate_unit collapses 'fl oz' -> 'oz' knowing nothing about the product.
    -- On a LIQUID product that alias is exactly right: the live unit_conversions table
    -- records 'oz' as "alias for fl oz", both liquid, both factor 1. On a DRY product it
    -- is wrong -- there 'oz' means a dry ounce, a WEIGHT, while 'fl oz' is a VOLUME --
    -- and field_app_priced_quantity, the authoritative converter the rest of the app
    -- bills through, agrees: its dry branch sizes 'fl oz' as NULL, i.e. not convertible,
    -- so the caller must error. This guard was collapsing the pair to oz = oz, taking the
    -- shortcut, and billing a line with NOTHING proven -- passing a shape its own
    -- converter calls unpriceable. A guard must never be more lenient than the SQL that
    -- does the billing.
    --
    -- Reachability, stated at its real size rather than inflated: no live product carries
    -- 'fl oz' on a dry form today (read read-only 2026-08-24 -- the 85 dry products use
    -- 'dry oz', 'lb', 'mg' and 'oz'). But the units compared here come from p_chemicals,
    -- NOT from the product catalog, and EXECUTE on this function is granted to
    -- authenticated -- which is the premise of this entire migration. A hand-built call
    -- reaches the shape regardless of how clean the catalog is.
    SELECT p.product_name, lower(COALESCE(p.product_form, ''))
      INTO v_product_name, v_form
      FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;

    -- On a DRY product a FLUID ounce is refused OUTRIGHT, on either side, whatever the
    -- other side says and whether or not the two sides normalise equal. The first
    -- version of this rule fired only when the normalised units were EQUAL, and that
    -- was a half-fix the gate returned as a fresh HIGH one round later: the equality
    -- shortcut is not the only way a fluid ounce reaches the money.
    --
    -- The path it missed is the CONVERSION path below, and it is worse than the one it
    -- closed. field_app_priced_quantity is called with v_qty_unit and v_price_unit --
    -- the NORMALISED units -- so 'fl oz' has already become 'oz' before the converter
    -- ever sees it. Handed the raw 'fl oz' the converter's dry branch sizes it NULL and
    -- refuses; handed 'oz' it sizes it 1 and happily converts 16:1 into pounds. So a dry
    -- product with rate 'fl oz/ac' against a stock unit of 'lb' did not take the
    -- shortcut at all -- it went through the conversion, turned a VOLUME into a WEIGHT,
    -- and derived authoritative cost and price totals from it. Normalisation erased the
    -- very distinction the converter would have refused on.
    --
    -- Hence the unconditional form. It is both simpler and strictly stronger than the
    -- equality-gated version, and it has no precondition left to get wrong: a dry
    -- product has no density in this system, so NOTHING downstream can carry a fluid
    -- ounce into a weight honestly. That includes 'fl oz' on BOTH sides -- self-
    -- consistent arithmetic on a unit the inventory and invoice sides cannot convert is
    -- not a saving grace, and an earlier test that required that shape to SAVE was
    -- wrong and is now inverted.
    --
    -- It stays gated on v_form = 'dry' and touches LIQUID lines not at all, which is the
    -- line that must not move: on a liquid product 'oz' IS 'fl oz' (the live
    -- unit_conversions table records exactly that, both factor 1) and T33 pins it. A
    -- NULL or blank product_form is treated as liquid here, matching the converter.
    -- Widening the rule beyond fluid ounces -- "the converter must agree" -- was
    -- considered and REJECTED: on a liquid product 'lbs/ac' against 'lb' normalises
    -- equal while the liquid size table carries no pound at all, so that form REFUSES an
    -- ordinary line, and one refused line blocks the WHOLE job save (performSave
    -- re-sends the entire grid). That is the round-7 defect three reviewers caught.
    --
    -- THE SPELLING TEST IS A CONCEPT TEST, NOT A LIST. The first version of this rule
    -- matched three literal strings -- 'fl oz', 'floz', 'fluid ounce' -- and the gate
    -- returned that as a fresh P1 one round later, which is the THIRD time this same
    -- rule has been caught incomplete. The escape is the PERIOD form: 'fl. oz'.
    -- normalize_rate_unit knows nothing about it (its CASE has no arm for it, so it
    -- falls through to ELSE base and hands the string BACK unchanged), so a dry line
    -- quoted 'fl. oz/ac' against a stock unit of 'fl. oz' normalises to 'fl. oz' on both
    -- sides, missed this test, hit the equality shortcut below, and derived
    -- authoritative cost and price totals from a VOLUME on a product billed by weight.
    -- That is not an exotic spelling: src/lib/blendMathValidator.ts documents in so many
    -- words that periods are insignificant and "'fl. oz' is 'fl oz'".
    --
    -- THE FOLD HAS NO CHARACTER LIST, AND THAT IS THE WHOLE POINT. Four consecutive rounds
    -- of this rule were defeated by a separator nobody had thought of yet:
    --
    --   round 12  three literal spellings          defeated by 'fl. oz'      (period)
    --   round 13  + periods and whitespace         defeated by 'fl<ZWSP>oz'  (zero-width)
    --   round 14  + zero-width and NBSP            defeated by 'fl-oz'       (ASCII hyphen)
    --   round 15  + ASCII hyphen                   defeated by 'fl<U+2010>oz' (Unicode hyphen)
    --
    -- Every one of those fixes enumerated the characters that had been NAMED, and every one
    -- was beaten by the next character along -- U+2010 and U+2011 are hyphens, U+202F is a
    -- narrow no-break space, and Unicode has plenty more where those came from. Enumeration
    -- cannot converge here, because the attacker picks the character and the list is always
    -- written afterwards.
    --
    -- So the list is gone. Everything that is not a letter or a digit is DELETED, and what
    -- remains must BE the word: 'floz', 'fluidounce'. There is no separator to smuggle in,
    -- because no separator survives -- which is why this form ends the class of bug rather
    -- than closing one more instance of it.
    --
    -- Verified on live PostgreSQL 17.6 over 31 spellings. All 19 fluid-ounce forms refuse,
    -- including every escape found in rounds 12-15 (period, ZWSP, ZWNJ, ZWJ, BOM, NBSP,
    -- U+2010, U+2011, U+202F), plus 'fl_oz' and even 'f l o z'. All 12 legitimate units pass
    -- untouched: 'oz', 'dry oz', 'dry<NBSP>oz', 'dry-oz', 'lb', 'ton', 'mg', 'gal', 'gal.',
    -- 'pt', 'ozs' -- and 'flour oz', the near-miss that a sloppier rule would eat, since it
    -- folds to 'flouroz' and the anchors require the word to be exactly fl|fluid + the unit.
    --
    -- The deletion also makes the NBSP question moot, which is worth saying because an
    -- earlier round reasoned carefully about it and that reasoning no longer applies: it does
    -- not matter whether a separator "separates", since 'dry oz' folds to 'dryoz' and simply
    -- fails the fl|fluid anchor. T41 still pins that the NBSP line saves.
    --
    -- So each side is folded to letters and digits only, and then matched as a concept:
    -- {fl|fluid} x {oz|ozs|ounce|ounces}, optional separator. 'fl. oz', 'fl.oz',
    -- 'fluid oz', 'fl ounces' and 'fl oz.' all land on the rule; a bare 'oz' does NOT,
    -- because on a dry product that is a legitimate dry ounce and refusing it would
    -- block ordinary jobs.
    --
    -- The expression is written ONCE and applied to both sides through a VALUES list
    -- rather than being spelled out twice. Two copies of a rule are two things that can
    -- drift apart, and a half-updated pair is exactly how this rule regressed before.
    IF v_form = 'dry'
       AND EXISTS (
         SELECT 1
           FROM unnest(ARRAY[v_rate_base, v_chem->>'unit']) AS raw_unit
          -- ANY DENOMINATOR IS STRIPPED FIRST, on BOTH sides. The rate side arrives already
          -- stripped (v_rate_base), but the stock side was passed in RAW -- so a dry line
          -- with rate_unit 'oz/ac' against a stock unit of 'fl oz/ac' folded to 'flozac',
          -- missed the anchored pattern, and then normalise_rate_unit collapsed BOTH sides to
          -- 'oz' anyway, so the equality branch accepted it and derived money from a volume
          -- price on a weight product (HIGH, gpt-5.6-sol 2026-08-24). The asymmetry was the
          -- whole defect: one side was being tested in a different form from the other.
          --
          -- 'fl oz/ac' still DENOTES fluid ounces -- the denominator says per what, not what.
          -- So each side is reduced to the unit it names before the concept test runs: fold
          -- separators (keeping '/' meaningful), drop everything from the first '/', drop a
          -- spelled-out 'per ...' tail, then delete every remaining non-alphanumeric.
          WHERE regexp_replace(
                  regexp_replace(
                    split_part(
                      btrim(regexp_replace(lower(COALESCE(raw_unit, '')), '[^a-z0-9/]+', ' ', 'g')),
                      '/', 1),
                    '\s+per\s+.*$', ''),
                  '[^a-z0-9]', '', 'g')
                ~ '^(fl|fluid)(oz|ozs|ounce|ounces)$'
       ) THEN
      RAISE EXCEPTION
        'CHEM_UNIT_FORM_MISMATCH: % is a DRY product, so it cannot be measured or priced in fluid ounces -- a fluid ounce measures volume and a dry product is billed by weight, so "%" against "%" cannot be converted and the amount to bill cannot be checked. Re-enter the rate and the stock Unit in the same dry unit (oz, lb or ton), then re-enter the cost and price for that unit.',
        COALESCE(v_product_name, 'This product'), v_raw_rate_unit, COALESCE(v_chem->>'unit', '');
    END IF;

    -- FAIL CLOSED ON CHARACTERS THIS FILE CANNOT INTERPRET.
    --
    -- The round-20 backstop was defeated by making the DELETION do the attacker's work
    -- (HIGH, gpt-5.6-sol 2026-08-24). `oz<U+2215>сԝт` -- a Unicode division slash followed by
    -- CYRILLIC homoglyphs for "cwt" -- folds under '[^a-z0-9]' to plain 'oz', because every
    -- non-ASCII character is DELETED. The denominator does not survive as a residue for the
    -- rule to catch; it is erased outright. 'oz' is then a perfectly recognised unit, both
    -- sides match, and a per-hundredweight rate bills as per-acre. Every previous round of
    -- this rule assumed folding leaves SOMETHING behind. Against non-ASCII it leaves nothing.
    --
    -- So the fold is no longer allowed to discard anything silently. A small, deliberately
    -- enumerated set is normalised first -- Unicode spaces become a space, zero-width
    -- characters are deleted -- and then ANY remaining character outside the supported ASCII
    -- set refuses the line. The enumeration is for CONVENIENCE and the allowlist is for
    -- SAFETY: getting the convenience list wrong can only cause a refusal, never an
    -- acceptance, which is the opposite of every separator round before this one.
    --
    -- Ordering is deliberate. This sits AFTER the fluid-ounce rule so a dry line written
    -- 'fl<U+2010>oz' still reports the specific CHEM_UNIT_FORM_MISMATCH that tells the
    -- operator what is actually wrong, rather than a generic character complaint.
    --
    -- Gated on PRICE, per Mason's 2026-08-24 rule. Every live unit is plain ASCII
    -- (read read-only 2026-08-24: Gal, Pt, oz, dry oz, fl oz, lb, qt, g, mg, ea, unit), so
    -- this refuses nothing that exists.
    IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0
       AND EXISTS (
         SELECT 1
           FROM unnest(ARRAY[v_raw_rate_unit, v_chem->>'unit']) AS raw_unit
          WHERE translate(lower(COALESCE(raw_unit, '')),
                          chr(160) || chr(8239) || chr(8203) || chr(8204) || chr(8205) || chr(65279),
                          '  ') ~ '[^a-z0-9 ./-]'
       ) THEN
      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_UNIT_UNSUPPORTED_CHARACTER: % has a unit containing a character this system cannot read ("%" against "%"). That is usually a copy-and-paste from a spreadsheet or a web page carrying a lookalike letter or symbol. Re-type both the rate unit and the stock Unit using plain letters.',
        COALESCE(v_product_name, 'This product'), v_raw_rate_unit, COALESCE(v_chem->>'unit', '');
    END IF;

    -- STRUCTURAL BACKSTOP: A PRICED LINE MUST NAME A UNIT THIS SYSTEM KNOWS.
    --
    -- This exists because the gate found a FOURTH separator bypass -- 'oz<U+2215>cwt', a
    -- Unicode DIVISION SLASH -- and patching one more character would have been the fifth
    -- round of the same losing game. The denominator canon preserves ASCII '/' and folds
    -- every other punctuation mark to a space, so a slash homoglyph became 'oz cwt': no '/'
    -- and no whole-word 'per' survived, the denominator rule saw nothing, and a
    -- PER-HUNDREDWEIGHT rate would then be billed as per-acre.
    --
    -- Enumerating slash lookalikes loses the same way the fluid-ounce list lost four times.
    -- What actually distinguishes 'oz cwt' from a legitimate 'fl oz' is not the character
    -- between the words -- it is that 'oz cwt' IS NOT A UNIT. So the rule asks that instead.
    -- Whatever remains after the per-acre suffix is stripped must be a unit the system
    -- recognises: either normalize_rate_unit maps it to a canonical unit, or it is a spelling
    -- carried in the live unit_conversions table. A denominator smuggled in behind ANY
    -- separator, present or future, leaves a residue that is not a unit -- and is refused.
    --
    -- Verified read-only on live PostgreSQL 17.6: all 12 spellings in unit_conversions match
    -- under this fold, including 'fl. oz' -> 'fl oz' and 'dry oz'; 'ton', 'kg', 'l' and 'ml'
    -- are covered by the canonical-output arm even though the conversions table has no row
    -- for them; and 'oz cwt', 'cwt', 'oz bu' and 'bu' do not match, which is the point.
    --
    -- Gated on PRICE, following Mason's 2026-08-24 rule: refuse only where a customer's money
    -- is at stake. An unrecognised unit on a line that bills nothing cannot bill wrongly. The
    -- known consequence, recorded rather than buried: a cost-only line can still carry an
    -- unrecognised rate unit and misstate MARGIN -- the same accepted residual as the
    -- zero-quantity and unverifiable-quantity rules, following from the same decision. Live
    -- JOB-2026-0001 carries rate_unit '32' with price 0 and is exempt for exactly that
    -- reason; T3 and T47 pin that it still saves.
    -- The '' arm below is NOT an exemption -- round 26 (P1, 2026-08-25). It used to be:
    -- `v_base_folded <> '' AND ...` skipped this whole check when the fold left nothing,
    -- reading an empty fold as "the blank-unit rule's territory". That was true only for a
    -- unit that was blank BEFORE folding. A punctuation-only unit -- rate_unit '.' against
    -- stock '.' -- is nonblank raw (so CHEM_UNIT_UNSPECIFIED passed it), folds to '' (so
    -- this check skipped it), survives the unsupported-character probe (periods are
    -- allowed), and the two sides then compare EQUAL -- a priced line whose unit names no
    -- measurement saved, and job completion cannot convert what it deducts. A nonblank
    -- base that folds to nothing IS the strongest form of "not a unit the system
    -- recognises", so it now takes this refusal; a raw-blank base still belongs to the
    -- blank-unit rule and its deliberate zero-quantity/customer-supplied exemptions.
    IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0 THEN
      v_base_folded := btrim(regexp_replace(lower(COALESCE(v_rate_base, '')), '[^a-z0-9]+', ' ', 'g'));
      IF (v_base_folded = '' AND btrim(COALESCE(v_rate_base, '')) <> '')
         OR (v_base_folded <> ''
             AND normalize_rate_unit(v_base_folded) NOT IN
                 ('oz', 'pt', 'qt', 'gal', 'lb', 'ton', 'g', 'kg', 'l', 'ml')
             AND NOT EXISTS (
                   SELECT 1 FROM unit_conversions uc
                    WHERE btrim(regexp_replace(lower(COALESCE(uc.unit, '')), '[^a-z0-9]+', ' ', 'g'))
                          = v_base_folded))
      THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        RAISE EXCEPTION
          'CHEM_RATE_UNIT_UNRECOGNIZED: % has a rate unit of "%", which does not name a unit this system recognises, so the amount to bill cannot be derived from it. Re-enter the rate using one of the units on the product.',
          COALESCE(v_product_name, 'This product'), v_raw_rate_unit;
      END IF;
    END IF;

    -- A STOCK UNIT MUST NAME A QUANTITY, NOT A RATE -- round 25 (HIGH, gpt-5.6-sol,
    -- 2026-08-24), and it is the denominator rule's missing half.
    --
    -- Every denominator rule in this file, through five rounds of hardening, examined
    -- `rate_unit` and nothing else. The stock `unit` was handed straight to
    -- normalize_rate_unit, whose FIRST action is to strip a trailing per-acre suffix -- so a
    -- caller-supplied stock unit of 'oz/ac' quietly became 'oz', matched a rate side that
    -- also reduced to 'oz', passed the quantity check, and derived authoritative money from
    -- a line whose stored unit is a RATE. The two sides were being held to different rules,
    -- which is the same asymmetry round 19 found in the fluid-ounce test and the same shape
    -- the file has now been caught in more than once.
    --
    -- The stock unit answers "how many of what", and 'oz/ac' is not a what -- it is a rate.
    -- On the rate side '/ac' is legitimate and gets stripped; here ANY denominator, per-acre
    -- included, is refused. The two rules differ because the two fields mean different
    -- things, and that difference is the reason this could not be fixed by reusing the rate
    -- rule verbatim.
    --
    -- Same canon as the rate probe -- fold everything that is not a letter, a digit or '/'
    -- to a space, keeping '/' because here too it is the marker rather than a separator --
    -- so the two rules cannot drift into recognising different spellings.
    --
    -- Gated on PRICE per Mason's 2026-08-24 rule, and the live blast radius is ZERO: read
    -- read-only 2026-08-24, every stock unit in the catalogue and on every job_chemicals row
    -- is a bare unit (Gal, Pt, oz, Dry oz, Lb, Qt, MG, Unit, Ea), and not one carries a
    -- slash or a 'per'.
    IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0 THEN
      v_stock_canon := btrim(regexp_replace(lower(COALESCE(v_chem->>'unit', '')),
                                            '[^a-z0-9/]+', ' ', 'g'));
      IF v_stock_canon <> ''
         AND (position('/' IN v_stock_canon) > 0
              OR v_stock_canon ~ '(^| )per( |$)') THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        RAISE EXCEPTION
          'CHEM_STOCK_UNIT_IS_A_RATE: % carries a stock Unit of "%", which is measured per something. The Unit says what the quantity counts and what the price is quoted per, so it has to name a plain unit -- put the per-acre part in the rate unit instead.',
          COALESCE(v_product_name, 'This product'), COALESCE(v_chem->>'unit', '');
      END IF;
    END IF;

    -- EQUAL UNITS ARE NOT A FREE PASS FOR THE QUANTITY. This used to be a bare
    -- `CONTINUE WHEN v_qty_unit = v_price_unit`, and the gate found the money hole that left
    -- open (HIGH, gpt-5.6-sol, 2026-08-24): matching units proved the two sides were counted
    -- in the SAME unit, and nothing at all about HOW MANY. A hand-built call sending 10 acres
    -- at 2 oz/ac with quantity 200 oz passed -- both sides 'oz' -- and the derived totals then
    -- authoritatively stored 20,000 cents instead of 2,000. The caller controlled the money
    -- directly, on the exact path this migration exists to close.
    --
    -- The rule already existed for the mismatched branch below, which refuses when the
    -- quantity is not what rate x acres reads. Applying it only when the units DIFFER was the
    -- inconsistency; the quantity reaches the totals either way.
    --
    -- No converter is called here on purpose. The units are identical, so the carried quantity
    -- IS rate x acres and a conversion would add nothing but a failure mode: an exotic-but-
    -- self-consistent unit the conversion tables do not carry ('cc' against 'cc') would size
    -- NULL and start REFUSING a line that is perfectly well formed, and one refused line
    -- blocks the whole job save. Same tolerance as the mismatched branch: quantity is stored
    -- through fmt4, so the slack is EXACTLY that storage precision and nothing more.
    --
    -- The tolerance is ABSOLUTE, and it used to be RELATIVE -- GREATEST(0.0001, |expected| *
    -- 1e-6) -- which is a money bug at scale (HIGH, gpt-5.6-sol 2026-08-24). A proportional
    -- slack means the larger the number, the more the guard lets through: at 5,000 acres and
    -- a rate of 1e9 the accepted difference is 5 million units, so at $1 a unit the check
    -- would wave a $5,000,000 discrepancy straight past. Nothing bounds rate, acreage or
    -- quantity, so "one part per million" is not a small quantity here -- it is a percentage
    -- of whatever the caller chose.
    --
    -- WHAT THE TOLERANCE IS NOW, after rounds 23 and 24 and stated once here so the block
    -- below is read against the current rule and not an earlier one: GREATEST(0.0001,
    -- LEAST(0.00005 * acres, 0.1)). Every term earns its place -- 0.0001 is the quantity's
    -- own storage precision, 0.00005 * acres is the error a 4-decimal RATE introduces when
    -- the operator drives the line by total instead of by rate, and the 0.1 ceiling is what
    -- stops that second term from being sized by caller-supplied acreage. No term scales
    -- with the number under test, and no term is unbounded.
    IF v_qty_unit = v_price_unit THEN
      v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;
      IF v_rate IS NOT NULL AND v_rate > 0 AND v_rate < 'Infinity'::numeric
         AND v_acres > 0 AND v_acres < 'Infinity'::numeric THEN
        -- THE TOLERANCE MODELS THE RATE'S OWN STORED PRECISION, and round 23 is why.
        --
        -- The app supports TWO calculation directions and does not tell the server which one
        -- the operator used for THIS check (chemCalculator.applyChemEdit tracks a `driver` of
        -- 'rate' or 'qty'; since F06 the payload sends it and the row stores it, but this
        -- check deliberately does not read it -- see the driver note at the top of the
        -- loop). Entering a RATE derives the
        -- quantity; entering a QUANTITY derives the rate as fmt4(quantity / acres) and HOLDS
        -- the typed total. The second direction cannot reproduce quantity = rate x acres,
        -- because the rate it stores has been rounded to four decimals.
        --
        -- The gate's example is an ordinary job, not an attack: 178.31 acres, operator types
        -- quantity 10, the UI stores rate 0.0561, and 0.0561 x 178.31 = 10.003191. A flat
        -- 0.0001 refuses it -- and refusing one line rolls back the WHOLE job save. That is
        -- the round-7 defect again, reached by tightening rather than by loosening, which is
        -- exactly the failure mode T51 was written to watch for and did not cover.
        --
        -- So the slack is the error the rate's own rounding can introduce and nothing more:
        -- a rate stored to 4 dp can be wrong by up to 0.00005, which over v_acres acres is
        -- 0.00005 * v_acres.
        --
        -- AND IT IS CAPPED, because round 24 caught me repeating round 18's mistake in a new
        -- shape (HIGH, gpt-5.6-sol, 2026-08-24). The round-23 message claimed acreage is
        -- "physically bounded by the field". THE SERVER DOES NOT KNOW THAT. Acreage is summed
        -- out of p_fields, which the caller writes, so an uncapped 0.00005 * v_acres is a
        -- caller-sized allowance exactly like the relative term round 18 deleted -- it just
        -- reads a different number out of the same payload. The gate's arithmetic: 1e12 acres
        -- at a rate of 1e-9 expects 1,000 units and opens a slack of 50,000,000, so a
        -- submitted quantity of 50,001,000 passes and bills every one of them.
        --
        -- LEAST(..., 0.1) is that ceiling, and a tenth of a unit is not a guess. The largest
        -- job in the live data covers 178.31 acres and needs 0.0089; the cap does not begin
        -- to bind until 2,000 acres, more than ten times the largest job ever recorded here.
        -- It is also the WHOLE exposure of this exit: whatever the caller claims its acreage
        -- to be, no quantity further than 0.1 from rate x acres is accepted.
        --
        -- A job past the knee is not stuck, and the message now says how: enter the RATE
        -- instead of the total. That is the other direction, where the app derives the
        -- quantity as fmt4(rate x acres) and lands within 0.00005 of it at ANY acreage.
        CONTINUE WHEN abs(v_qty - (v_rate * v_acres))
                      <= GREATEST(0.0001::numeric,
                                  LEAST(0.00005::numeric * v_acres, 0.1::numeric));
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        RAISE EXCEPTION
          'CHEM_QUANTITY_NOT_DERIVED: % is quoted at % per acre over % acres, which is %, but the line carries a quantity of %. The amount billed comes from the quantity, so these must agree. Re-enter the rate per acre and let the total fill itself in, or correct the quantity.',
          COALESCE(v_product_name, 'This product'), v_rate, v_acres, v_rate * v_acres, v_qty;
      END IF;
      -- ROUND 17 closed what round 15 left open here, on Mason's decision of 2026-08-24.
      --
      -- The gap mattered more than round 15 admitted: with no usable rate there is nothing to
      -- derive from, and a hand-built call chooses its own payload -- so it could defeat the
      -- whole check by simply OMITTING the rate and naming any quantity it liked. A guard a
      -- caller can switch off is not a guard.
      --
      -- Mason's rule is to refuse only where a customer's money is at stake, so the refusal
      -- is conditioned on the line carrying a PRICE. A line with no price bills the customer
      -- nothing, so an unverifiable quantity on it cannot over-charge anyone; its cost can
      -- still misstate margin, which is the same accepted residual recorded at the
      -- zero-quantity exit above.
      IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0 THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        RAISE EXCEPTION
          'CHEM_QUANTITY_UNVERIFIABLE: % is priced per unit and carries a quantity of %, but without both a rate per acre and field acreage there is nothing to check that quantity against, and the invoice bills it. Enter the rate per acre and the acres treated, or clear the price.',
          COALESCE(v_product_name, 'This product'), v_qty;
      END IF;
      CONTINUE;
    END IF;

    -- PROOF OF SAFETY, and the only one: the quantity is what rate x acres reads once
    -- carried into the unit the price is quoted in. Without a usable rate and acreage
    -- nothing is proven, so the row is refused rather than escaping.
    v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;
    -- EVERY operand is range-checked for FINITENESS, not merely for NULL or NaN. This
    -- closes the bypass Codex found (P1, round 3): with a single field carrying
    -- acres_to_treat = 'NaN', the old test `v_acres > 0` PASSED, because PostgreSQL
    -- orders numeric NaN above every other value. v_carried then came back NaN, and the
    -- tolerance line compared NaN <= GREATEST(0.0001, NaN) -- that is, NaN <= NaN, which
    -- is TRUE, since NaN is equal to itself. A mismatched line was therefore waved
    -- through AND the NaN acreage stored. A `< 'Infinity'` bound excludes NaN and
    -- Infinity in one test; a NaN test alone would still admit Infinity.
    IF v_rate IS NOT NULL AND v_rate > 0 AND v_rate < 'Infinity'::numeric
       AND v_acres > 0 AND v_acres < 'Infinity'::numeric THEN
      v_carried := field_app_priced_quantity(v_rate * v_acres, v_qty_unit, v_price_unit, v_form);
      -- quantity is stored through fmt4, so the slack is exactly that storage precision.
      -- v_carried is bounded for the same reason as its inputs: the helper can return a
      -- non-finite value, and a NaN tolerance compares TRUE against a NaN difference.
      IF v_carried IS NOT NULL
         AND v_carried > '-Infinity'::numeric
         AND v_carried < 'Infinity'::numeric
         AND abs(v_qty - v_carried)
             <= GREATEST(
                  0.0001::numeric,
                  -- The same rate-rounding slack as the equal-units branch, CARRIED THROUGH
                  -- THE CONVERTER because here the quantity lives in a different unit from
                  -- the rate. Converting 0.00005 * acres gives the error in the unit actually
                  -- being compared -- the unconverted figure would be far too generous in one
                  -- direction (oz -> gal divides by 128) and too tight in the other.
                  --
                  -- AND THE SAME ABSOLUTE CEILING, converted the same way, so the round-24
                  -- hole is closed on BOTH branches. Capping only the equal-units exit would
                  -- have left the identical caller-sized allowance one line further down: a
                  -- 1e12-acre payload whose units merely happen to differ. Converting the cap
                  -- rather than applying a flat 0.1 keeps it the SAME PHYSICAL AMOUNT on both
                  -- sides -- 0.1 gal is 12.8 oz, and the money exposure is what must match,
                  -- not the digits.
                  --
                  -- Both terms fall back to the flat 0.0001 if the converter cannot size
                  -- them, which is the strict reading, not the lax one; and LEAST of a real
                  -- conversion against that fallback is still 0.0001, so an unconvertible
                  -- cap tightens this exit rather than widening it.
                  LEAST(
                    COALESCE(
                      field_app_priced_quantity(0.00005::numeric * v_acres,
                                                v_qty_unit, v_price_unit, v_form),
                      0.0001::numeric),
                    COALESCE(
                      field_app_priced_quantity(0.1::numeric,
                                                v_qty_unit, v_price_unit, v_form),
                      0.0001::numeric))) THEN
        CONTINUE;
      END IF;
    END IF;

    -- The remedy text must not teach a quieter version of the same bug. An earlier draft
    -- said only "Set Unit to <qty_unit>" -- but changing the unit while LEAVING the
    -- per-pound cost and price in place applies a per-pound price per ounce: a 16x
    -- UNDER-bill that also silences this guard, because the units then agree. Both
    -- branches now say explicitly which numbers must be re-entered.
    RAISE EXCEPTION
      'CHEM_UNIT_MISMATCH: % is measured in % but its cost and price are quoted per %. Either set Unit to % AND re-enter the cost and price per %, or change the rate unit to %/ac AND re-enter the rate. Changing one without the other bills the wrong amount.',
      COALESCE(v_product_name, 'This product'), v_qty_unit, v_price_unit, v_qty_unit, v_qty_unit, v_price_unit;
  END LOOP;

  -- ==========================================================================
  -- (3) DERIVED MONEY TOTALS. The caller's total_cost_cents / total_price_cents are
  -- ignored outright. safe_cents_qty is an EXACT numeric multiply with ROUND half away
  -- from zero, applied PER LINE and then summed. customer_supplied product is applied
  -- but not billed, contributing 0.
  --
  -- THE PAGE AND THIS DO NOT AGREE TO THE CENT, and an earlier draft of this comment
  -- wrongly said they did. On `main`, JobDetail.tsx computes its displayed totals as
  -- Math.round(parseFloat(qty) * parseInt(cents)) -- IEEE-754 binary multiply, and
  -- Math.round is half-UP, not half-away-from-zero. Two divergences follow: float
  -- representation error (25c x 0.58 displays 14c, exact arithmetic gives 15c) and
  -- negative half-cents. From here on the SERVER value is the authoritative one and is
  -- what transfer_job_to_invoice bills, so the money is right -- but until PR #436 lands
  -- the exact-cents client path, the operator can see a figure one cent off what is
  -- stored. Per-line-then-sum ordering DOES match the page; only the arithmetic base
  -- differs. This is the second reason PR #436 is an ordering prerequisite.
  -- ==========================================================================
  SELECT
    COALESCE(SUM(
      CASE WHEN COALESCE((c->>'customer_supplied')::boolean, false) THEN 0
           ELSE safe_cents_qty(
                  COALESCE(NULLIF(c->>'cost_per_unit_cents','')::bigint, 0),
                  COALESCE(NULLIF(c->>'quantity','')::numeric, 0))
      END), 0)::bigint,
    COALESCE(SUM(
      CASE WHEN COALESCE((c->>'customer_supplied')::boolean, false) THEN 0
           ELSE safe_cents_qty(
                  COALESCE(NULLIF(c->>'price_per_unit_cents','')::bigint, 0),
                  COALESCE(NULLIF(c->>'quantity','')::numeric, 0))
      END), 0)::bigint
    INTO v_total_cost_cents, v_total_price_cents
    FROM jsonb_array_elements(COALESCE(p_chemicals, '[]'::jsonb)) c;

  IF v_is_new THEN
    INSERT INTO jobs (
      job_number, customer_id, status, job_date, scheduled_time,
      applicator_id, vehicle_id, recipe_id, application_service_id,
      notes, tags, batch_id, season,
      total_acres, total_cost_cents, total_price_cents,
      call_date, date_proposed, time_proposed, schedule_date, date_expires,
      consultant_id, loader_comment, additional_info, internal_memo,
      created_by, updated_by
    ) VALUES (
      next_job_number(),
      (p_job_payload->>'customer_id')::uuid,
      COALESCE(p_job_payload->>'status', 'scheduled'),
      v_job_date,
      CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'application_service_id' IS NOT NULL AND p_job_payload->>'application_service_id' != ''
        THEN (p_job_payload->>'application_service_id')::uuid ELSE NULL END,
      p_job_payload->>'notes',
      CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      p_job_payload->>'batch_id',
      v_season,
      -- DERIVED, not taken from the caller -- round 24, and the reason is the same one that
      -- makes the totals derived. The caller used to set `total_acres` independently of the
      -- field rows it sent, so a payload could claim a ten-acre job while sending zero
      -- billable acreage: the header read as real work, every per-acre check saw nothing to
      -- expect, and a priced line saved billing nothing. v_acres is the SUM OF THE FIELDS
      -- BEING SAVED, which is exactly what the page computes (sumAcres over acres_to_treat)
      -- and what every check above already reasons about. Live agreement verified read-only
      -- on 2026-08-24: all four jobs carry total_acres equal to their summed field acreage to
      -- the hundredth, so this changes no existing row and no ordinary save.
      v_acres,
      -- DERIVED, not taken from the caller.
      v_total_cost_cents,
      v_total_price_cents,
      NULLIF(p_job_payload->>'call_date','')::date,
      NULLIF(p_job_payload->>'date_proposed','')::date,
      NULLIF(p_job_payload->>'time_proposed','')::time,
      NULLIF(p_job_payload->>'schedule_date','')::date,
      NULLIF(p_job_payload->>'date_expires','')::date,
      CASE WHEN p_job_payload->>'consultant_id' IS NOT NULL AND p_job_payload->>'consultant_id' != ''
        THEN (p_job_payload->>'consultant_id')::uuid ELSE NULL END,
      p_job_payload->>'loader_comment',
      p_job_payload->>'additional_info',
      p_job_payload->>'internal_memo',
      p_performed_by,
      v_actor
    )
    RETURNING id INTO v_job_id;
  ELSE
    SELECT id INTO v_job_id FROM jobs WHERE id = p_job_id FOR UPDATE;
    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'Job not found: %', p_job_id;
    END IF;

    UPDATE jobs SET
      customer_id = (p_job_payload->>'customer_id')::uuid,
      job_date = v_job_date,
      scheduled_time = CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      applicator_id = CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      vehicle_id = CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      recipe_id = CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      -- U3 (Codex R3 P2): three-way — key ABSENT (stale/cached client on the old
      -- payload shape) preserves the saved service; key present-but-empty is an
      -- explicit clear; a uuid sets it. Prevents an old client's ordinary save
      -- from silently wiping a billing-impacting field.
      application_service_id = CASE
        WHEN NOT (p_job_payload ? 'application_service_id') THEN application_service_id
        WHEN p_job_payload->>'application_service_id' IS NOT NULL AND p_job_payload->>'application_service_id' != ''
          THEN (p_job_payload->>'application_service_id')::uuid
        ELSE NULL END,
      notes = p_job_payload->>'notes',
      tags = CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      batch_id = p_job_payload->>'batch_id',
      season = v_season,
      -- DERIVED on the UPDATE path too, for the same reason as the INSERT above. Deriving it
      -- on one path only would leave the whole gap open on the other -- an EDIT is how a job
      -- would most plausibly acquire a header acreage its fields do not support.
      total_acres = v_acres,
      -- DERIVED, not taken from the caller.
      total_cost_cents = v_total_cost_cents,
      total_price_cents = v_total_price_cents,
      call_date = NULLIF(p_job_payload->>'call_date','')::date,
      date_proposed = NULLIF(p_job_payload->>'date_proposed','')::date,
      time_proposed = NULLIF(p_job_payload->>'time_proposed','')::time,
      schedule_date = NULLIF(p_job_payload->>'schedule_date','')::date,
      date_expires = NULLIF(p_job_payload->>'date_expires','')::date,
      consultant_id = CASE WHEN p_job_payload->>'consultant_id' IS NOT NULL AND p_job_payload->>'consultant_id' != ''
        THEN (p_job_payload->>'consultant_id')::uuid ELSE NULL END,
      loader_comment = p_job_payload->>'loader_comment',
      additional_info = p_job_payload->>'additional_info',
      internal_memo = p_job_payload->>'internal_memo',
      updated_by = v_actor
    WHERE id = v_job_id;
  END IF;

  -- Replace fields (now incl. agronomy: planted_acres, crop, strip, pests)
  DELETE FROM job_fields WHERE job_id = v_job_id;
  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, planted_acres, crop, strip, pests, sort_order)
    VALUES (
      v_job_id,
      (v_field->>'field_id')::uuid,
      COALESCE(NULLIF(v_field->>'acres_to_treat','')::numeric, 0),
      NULLIF(v_field->>'planted_acres','')::numeric,
      v_field->>'crop',
      v_field->>'strip',
      v_field->>'pests',
      COALESCE((v_field->>'sort_order')::integer, 0)
    );
  END LOOP;

  -- Replace per-field customer shares. Each field's shares must total 100%
  -- (mirrors the field-app split invariant so section #26 can split cleanly).
  -- A share whose field_id is NOT one of the job's fields (a stale defaults
  -- response or a hand-built payload) is REJECTED — otherwise the Jobs list /
  -- the #26 split would surface a customer/field that is not on the job (Codex P2).
  DELETE FROM job_field_shares WHERE job_id = v_job_id;
  IF p_job_payload->'field_shares' IS NOT NULL THEN
    -- Reject any share pointing at a field not in p_fields.
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_job_payload->'field_shares') s
       WHERE (s->>'field_id')::uuid NOT IN (
         SELECT (f->>'field_id')::uuid FROM jsonb_array_elements(p_fields) f
       )
    ) THEN
      RAISE EXCEPTION 'SHARE_FIELD_NOT_ON_JOB';
    END IF;

    -- Validate: per field, the sum of split_pct == 100 (within rounding).
    FOR v_field_id IN
      SELECT DISTINCT (s->>'field_id')::uuid
      FROM jsonb_array_elements(p_job_payload->'field_shares') s
    LOOP
      SELECT COALESCE(SUM((s->>'split_pct')::numeric), 0)
        INTO v_share_total
        FROM jsonb_array_elements(p_job_payload->'field_shares') s
       WHERE (s->>'field_id')::uuid = v_field_id;
      IF ROUND(v_share_total, 2) <> 100 THEN
        RAISE EXCEPTION 'SHARE_NOT_100' USING DETAIL = 'Field shares must total 100%; got ' || v_share_total;
      END IF;
    END LOOP;

    FOR v_share IN SELECT * FROM jsonb_array_elements(p_job_payload->'field_shares') LOOP
      INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
      VALUES (
        v_job_id,
        (v_share->>'field_id')::uuid,
        (v_share->>'customer_id')::uuid,
        (v_share->>'split_pct')::numeric,
        COALESCE((v_share->>'is_primary')::boolean, false)
      );
    END LOOP;
  END IF;

  -- Replace chemicals (now incl. extras: diluent_rate, rei_hours, phi_days,
  -- warehouse, vendor)
  DELETE FROM job_chemicals WHERE job_id = v_job_id;
  FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals) LOOP
    INSERT INTO job_chemicals (
      job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents,
      diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied,
      sort_order, driver, price_typed
    )
    VALUES (
      v_job_id,
      (v_chem->>'product_id')::uuid,
      COALESCE((v_chem->>'quantity')::numeric, 0),
      v_chem->>'unit',
      (v_chem->>'rate_per_acre')::numeric,
      v_chem->>'rate_unit',
      COALESCE((v_chem->>'cost_per_unit_cents')::bigint, 0),
      COALESCE((v_chem->>'price_per_unit_cents')::bigint, 0),
      NULLIF(v_chem->>'diluent_rate','')::numeric,
      NULLIF(v_chem->>'rei_hours','')::integer,
      NULLIF(v_chem->>'phi_days','')::integer,
      v_chem->>'warehouse',
      v_chem->>'vendor',
      -- U4<<< customer-supplied product: applied but not drawn/deducted/billed. (#53/#54)
      COALESCE((v_chem->>'customer_supplied')::boolean, false),
      -- >>>U4
      COALESCE((v_chem->>'sort_order')::integer, 0),
      -- F06: validated at the top of the invariant loop (NULL, 'rate' or 'qty'; '' folds
      -- to NULL). The table CHECK job_chemicals_driver_chk is the second line of defence.
      NULLIF(v_chem->>'driver', ''),
      -- Mason, 2026-11-21: staff typed this price by hand; Create Invoice keeps it over a sent quote and warns.
      COALESCE((v_chem->>'price_typed')::boolean, false)
    );
  END LOOP;

  v_result := jsonb_build_object('success', true, 'job_id', v_job_id, 'is_new', v_is_new);

  -- The receipt MUST carry the binding columns, or the next replay of this very key
  -- hits check_idempotency_intent's deployment bridge -- an unbound receipt whose intent
  -- cannot be reconstructed fails closed with IDEMPOTENCY_INTENT_MISMATCH -- and a
  -- legitimate retry would be refused. Writing the row and then binding it mirrors
  -- 20260819232000 exactly. IDEMPOTENCY_RECEIPT_MISSING is not decorative: it fires if
  -- the INSERT was swallowed and no row is there to bind, which would otherwise leave a
  -- silently unbindable receipt behind.
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'save_job', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE idempotency_keys
       SET request_fingerprint = v_fingerprint,
           request_actor_id    = v_actor
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'save_job';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public._save_job_cost_step2_impl(uuid, jsonb, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._save_job_cost_step2_impl(uuid, jsonb, jsonb, jsonb, uuid, text) TO postgres;

CREATE OR REPLACE FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_invoice_id uuid;
  v_invoice_number text;
  v_chem RECORD;
  v_item_order integer := 0;
  v_field_names text[];
  v_crop_types text[];
  v_crop_type text;
  v_total_acres numeric := 0;
  v_applicator_name text;
  v_vehicle_name text;
  v_field RECORD;
  v_billing RECORD;
  v_total_cost_cents bigint := 0;
  v_conversion RECORD;
  v_total_applied numeric;
  v_share RECORD;
  v_share_total bigint := 0;
  v_has_price_override boolean := false;
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-8 (G1 per-acre fee) locals
  v_fee jsonb;
  v_fee_total bigint := 0;
  v_fee_cost bigint := 0;
  v_fee_c bigint;
  v_cost_c bigint;
  v_fee_acres numeric := 0;
  -- U8 (#99 commissions on the application channel) locals
  v_commission_split jsonb;
  v_chem_profit_cents bigint := 0;
  -- U7 (#42/#100/#50 multi-owner group) locals
  v_n_owners integer := 0;
  v_group_id uuid;
  v_owner_ids uuid[];
  v_owner_names text[];
  v_owner_acres numeric[];
  v_owner_primary boolean[];
  v_total_billable_acres numeric := 0;
  v_acre_pcts numeric[];
  v_chem_price_split bigint[];
  v_chem_cost_split bigint[];
  v_oidx integer;
  v_member_id uuid;
  v_member_ids uuid[] := '{}';
  v_anchor_id uuid;
  v_member_acres numeric;
  v_member_total bigint;
  v_member_cost bigint;
  v_member_profit_cents bigint := 0;
  v_member_field_names text[];
  -- Sent quote price (Mason, 2026-11-21): locals
  v_on date;
  v_quote_cents bigint;
  v_line_price bigint;
  v_line_sum bigint := 0;
  v_any_quoted boolean := false;
  v_bill_to uuid;
  v_warning text;
  v_price_warnings jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('crx.chicago_date_cutover', '20260905200400', true);
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- BEGIN DELTA-7 (G3 strict-actor): the role gate above is on auth.uid(), but
  -- p_performed_by was written verbatim to created_by / the activity log, so the
  -- recorded performer was forgeable. Bind the authenticated user and reject a
  -- mismatch (matches complete_job / start_job / save_field_app_invoice).
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  -- END DELTA-7

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_job_to_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.* INTO v_job FROM jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', p_job_id; END IF;
  IF v_job.status = 'invoiced' THEN RAISE EXCEPTION 'Job already invoiced'; END IF;
  IF v_job.status != 'completed' THEN RAISE EXCEPTION 'Job must be completed to invoice (status: %)', v_job.status; END IF;
  -- The date a sent quote must be valid on (KI-81's rule): the job's date, else Chicago today.
  v_on := COALESCE(v_job.job_date, (now() AT TIME ZONE 'America/Chicago')::date);

  -- U6 #91b: refuse to invoice the job if a blend ticket for the SAME job has already
  -- been billed (payment_status='billed' = a live, non-voided invoice exists for it).
  -- The blend-ticket invoice and this job invoice bill the same application, so
  -- allowing both double-bills the customer. Block, do not warn. (The
  -- trg_sync_blend_ticket_payment trigger resets billed->unbilled when that invoice
  -- is voided, so a genuine re-bill after a void is unaffected.)
  -- Codex R3 P2: test for a LIVE blend-ticket invoice directly (mirror of the
  -- opposite guard's invoices.job_id test) — payment_status can be written
  -- manually via update_blend_ticket_billing_status and drift out of sync.
  IF EXISTS (
    SELECT 1 FROM blend_tickets bt
    JOIN invoices i ON i.blend_ticket_id = bt.id
    WHERE bt.job_id = p_job_id
      AND bt.deleted_at IS NULL  -- Codex R2 P2: a soft-deleted ticket must not block forever
      AND i.status NOT IN ('voided', 'cancelled')
      AND i.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ALREADY_BILLED: a blend ticket for this job has already been billed; invoicing the job too would double-bill the customer. Void that blend-ticket invoice first if you meant to re-bill here.';
  END IF;

  FOR v_field IN
    SELECT jf.field_id, jf.acres_to_treat, f.field_name, f.crop_type AS f_crop_type
    FROM job_fields jf JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id ORDER BY f.field_name
  LOOP
    v_field_names := array_append(v_field_names, v_field.field_name);
    v_total_acres := v_total_acres + COALESCE(v_field.acres_to_treat, 0);
    IF v_field.f_crop_type IS NOT NULL THEN v_crop_types := array_append(v_crop_types, v_field.f_crop_type); END IF;
  END LOOP;

  IF v_crop_types IS NOT NULL AND array_length(v_crop_types, 1) > 0 THEN
    SELECT mode() WITHIN GROUP (ORDER BY unnest) INTO v_crop_type FROM unnest(v_crop_types);
  END IF;

  IF v_job.applicator_id IS NOT NULL THEN
    SELECT p.full_name INTO v_applicator_name FROM profiles p WHERE p.id = v_job.applicator_id;
  END IF;

  IF v_job.vehicle_id IS NOT NULL THEN
    SELECT v.vehicle_name INTO v_vehicle_name FROM vehicles v WHERE v.id = v_job.vehicle_id;
  END IF;

  -- ==========================================================================
  -- U7 (#42 / #100 / #50): MULTI-OWNER per-owner invoice GROUP.
  -- Trigger ONLY on EXPLICIT multi-owner billing: >1 distinct field_billing_defaults
  -- customer across the job's fields (the landlord/tenant setup the finding is about).
  -- A job with NO billing defaults keeps today's single-invoice behavior, even if its
  -- fields belong to different customers — no surprise change. In the group path, any
  -- field WITHOUT billing defaults falls back to the field's own customer at 100%
  -- (mirror of create_split_invoices_from_order).
  -- ==========================================================================
  SELECT count(DISTINCT fbd.customer_id) INTO v_n_owners
    FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id;

  IF COALESCE(v_n_owners, 0) > 1 THEN
    -- Scope guard: per-field $/acre overrides are not supported by the percentage/acre
    -- split. Refuse rather than silently drop an override the single-invoice path honors.
    IF EXISTS (
      SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'SPLIT_OVERRIDE_UNSUPPORTED: this multi-owner job has per-field $/acre price overrides. Percentage split billing does not support overrides — bill it as a single invoice, or price each owner in the field-application editor.';
    END IF;

    -- Validate every billed field's splits total 100 (mirror FIELD_SPLIT_NOT_100), so the
    -- owner acre shares sum to the job acres and calculate_billing_splits stays penny-exact.
    IF EXISTS (
      SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id
      GROUP BY jf.field_id HAVING sum(fbd.split_pct) < 99.99 OR sum(fbd.split_pct) > 100.01
    ) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
    END IF;

    -- Ordered owner arrays (stable ORDER BY owner_id) with each owner's BILLABLE ACRES:
    -- fbd fields contribute acres_to_treat * split_pct/100; non-fbd fields contribute
    -- their full acres to the field's own customer.
    SELECT array_agg(owner_id ORDER BY owner_id),
           array_agg(farm_name ORDER BY owner_id),
           array_agg(billable_acres ORDER BY owner_id),
           array_agg(is_primary ORDER BY owner_id)
      INTO v_owner_ids, v_owner_names, v_owner_acres, v_owner_primary
    FROM (
      SELECT owner_id,
             sum(billable_acres) AS billable_acres,
             bool_or(is_primary) AS is_primary,
             max(farm_name) AS farm_name
      FROM (
        SELECT fbd.customer_id AS owner_id,
               COALESCE(jf.acres_to_treat, 0) * fbd.split_pct / 100.0 AS billable_acres,
               COALESCE(fbd.is_primary, false) AS is_primary, c.farm_name
          FROM job_fields jf
          JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
          JOIN customers c ON c.id = fbd.customer_id
          WHERE jf.job_id = p_job_id
        UNION ALL
        SELECT COALESCE(f.customer_id, v_job.customer_id) AS owner_id,
               COALESCE(jf.acres_to_treat, 0) AS billable_acres,
               false AS is_primary, c.farm_name
          FROM job_fields jf
          JOIN fields f ON f.id = jf.field_id
          JOIN customers c ON c.id = COALESCE(f.customer_id, v_job.customer_id)
          WHERE jf.job_id = p_job_id
            AND NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
      ) parts
      GROUP BY owner_id
    ) oa;

    v_total_billable_acres := COALESCE((SELECT sum(a) FROM unnest(v_owner_acres) a), 0);
    IF v_total_billable_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_NO_ACRES: cannot split a multi-owner job with zero billable acres (job %)', v_job.job_number;
    END IF;

    -- Acre-share percentages across owners (sum to exactly 100 -> penny-exact splits).
    SELECT array_agg(a / v_total_billable_acres * 100 ORDER BY ord)
      INTO v_acre_pcts FROM unnest(v_owner_acres) WITH ORDINALITY AS u(a, ord);

    v_group_id := gen_random_uuid();

    -- Create one draft invoice per owner (empty; filled in the chemical/fee loops below).
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_acres := v_owner_acres[v_oidx];

      -- Fields this owner is billed for (informational header list).
      SELECT array_agg(DISTINCT fname ORDER BY fname) INTO v_member_field_names FROM (
        SELECT f.field_name AS fname
          FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
          JOIN fields f ON f.id = jf.field_id
          WHERE jf.job_id = p_job_id AND fbd.customer_id = v_owner_ids[v_oidx]
        UNION
        SELECT f.field_name AS fname
          FROM job_fields jf JOIN fields f ON f.id = jf.field_id
          WHERE jf.job_id = p_job_id AND f.customer_id = v_owner_ids[v_oidx]
            AND NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
      ) mf;

      v_invoice_number := next_invoice_number('field_application');
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
        field_names, crop_type, total_acres, applicator_name, vehicle_name,
        application_date, header_notes, season, created_by, job_id,
        application_service_id, invoice_group_id
      ) VALUES (
        v_invoice_number, v_owner_ids[v_oidx], 'field_application', 'draft',
        (now() AT TIME ZONE 'America/Chicago')::date, NULL::date,  -- KI-14: the due-date trigger derives it from this owner's terms
        0, 0, 0, 0,
        COALESCE(v_member_field_names, v_field_names), v_crop_type, v_member_acres, v_applicator_name, v_vehicle_name,
        v_job.job_date, v_job.notes,
        COALESCE(
          v_job.season,
          CASE WHEN extract(month FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10
               THEN extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer + 1
               ELSE extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer END
        ),
        p_performed_by, p_job_id, v_job.application_service_id, v_group_id
      ) RETURNING id INTO v_member_id;
      v_member_ids := array_append(v_member_ids, v_member_id);
    END LOOP;

    -- Chemical lines: split each chemical's agreed price/cost across owners BY acre share
    -- (penny-exact). qty / applied-acres are prorated by the same share.
    v_item_order := 0;
    FOR v_chem IN
      SELECT jc.product_id, jc.rate_per_acre,
             safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
             safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
             jc.quantity,
             jc.customer_supplied,
             p.product_name, COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size, p.epa_registration, p.product_form,
             COALESCE(NULLIF(btrim(jc.rate_unit), ''), NULLIF(btrim(jc.unit), ''), p.unit_size) AS rate_unit,
             COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size) AS stock_unit,
             jc.price_typed, jc.price_per_unit_cents
      FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
      WHERE jc.job_id = p_job_id ORDER BY p.product_name
    LOOP
      v_item_order := v_item_order + 1;
      -- customer-supplied products carry $0 price AND $0 cost (we didn't buy them).
      v_chem_price_split := calculate_billing_splits(
        CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END, v_acre_pcts);
      v_chem_cost_split := calculate_billing_splits(
        CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END, v_acre_pcts);

      FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
        v_member_acres := v_owner_acres[v_oidx];
        -- Owner's applied amount = rate x their acres (their slice of the uniform-rate
        -- application). The line quantity stays 1 (a single job-chemical line, matching
        -- the single-owner path where unit_price == extended); the real applied amount
        -- lives in total_applied / total_applied_gl_lb.
        v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_member_acres > 0
          THEN v_chem.rate_per_acre * v_member_acres ELSE NULL END;
        SELECT * INTO v_conversion
          FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
        -- Sent quote price (Mason, 2026-11-21): this owner's own sent quote on the job fields billed to them prices
        -- their share of the quantity; else their acre share of the job's price, as before.
        -- A price typed by hand on the job (Mason, 2026-11-21) is kept; the quote only warns.
        v_quote_cents := CASE WHEN v_chem.customer_supplied OR v_chem.price_typed THEN NULL ELSE _job_transfer_quote_price_cents_20270207(
          v_chem.product_id, v_chem.product_name, v_chem.unit_size, v_chem.stock_unit,
          ARRAY(SELECT jf.field_id FROM job_fields jf
                 WHERE jf.job_id = p_job_id
                   AND (EXISTS (SELECT 1 FROM field_billing_defaults fbd
                                 WHERE fbd.field_id = jf.field_id AND fbd.customer_id = v_owner_ids[v_oidx])
                        OR (NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
                            AND (SELECT COALESCE(f.customer_id, v_job.customer_id) FROM fields f WHERE f.id = jf.field_id) = v_owner_ids[v_oidx]))
                 ORDER BY jf.field_id),
          v_owner_ids[v_oidx], v_on) END;
        IF v_chem.price_typed AND NOT v_chem.customer_supplied THEN
          v_warning := _job_transfer_typed_price_warning_20270207(
            v_chem.product_id, v_chem.product_name, v_chem.unit_size, v_chem.stock_unit,
            ARRAY(SELECT jf.field_id FROM job_fields jf
                   WHERE jf.job_id = p_job_id
                     AND (EXISTS (SELECT 1 FROM field_billing_defaults fbd
                                   WHERE fbd.field_id = jf.field_id AND fbd.customer_id = v_owner_ids[v_oidx])
                          OR (NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
                              AND (SELECT COALESCE(f.customer_id, v_job.customer_id) FROM fields f WHERE f.id = jf.field_id) = v_owner_ids[v_oidx]))
                   ORDER BY jf.field_id),
            v_owner_ids[v_oidx], v_on, v_chem.price_per_unit_cents, v_owner_names[v_oidx]);
          IF v_warning IS NOT NULL THEN v_price_warnings := v_price_warnings || to_jsonb(v_warning); END IF;
        END IF;
        v_line_price := CASE WHEN v_quote_cents IS NOT NULL
          THEN safe_cents_qty(v_quote_cents, _job_transfer_qty_in_stock_unit_20270207(
                 v_chem.quantity * v_acre_pcts[v_oidx] / 100, v_chem.unit_size, v_chem.stock_unit))
          ELSE v_chem_price_split[v_oidx] END;

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
          epa_registration, product_form, is_application_fee, price_source
        ) VALUES (
          v_member_ids[v_oidx], v_chem.product_id,
          CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
          1,
          v_chem.unit_size,
          v_line_price,
          v_line_price,
          v_chem_cost_split[v_oidx],
          v_item_order, v_member_acres,
          v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
          COALESCE(v_chem.rate_unit, v_chem.unit_size),
          v_conversion.converted_value, v_conversion.converted_unit,
          v_chem.epa_registration, v_chem.product_form, false,
          CASE WHEN v_chem.customer_supplied OR v_chem.price_typed THEN 'manual' WHEN v_quote_cents IS NOT NULL THEN 'quoted' ELSE NULL END
        );
      END LOOP;
    END LOOP;

    -- Per-owner totals, per-acre application fee, header flip, and per-member commission.
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      v_member_acres := v_owner_acres[v_oidx];

      SELECT COALESCE(SUM(extended_cents), 0), COALESCE(SUM(cost_cents), 0)
        INTO v_member_total, v_member_cost
        FROM invoice_items WHERE invoice_id = v_member_id;

      -- DELTA-8 per-acre machine fee at this owner's own rate, on this owner's acres.
      IF v_job.application_service_id IS NOT NULL AND v_member_acres > 0 THEN
        v_fee := compute_application_service_fee(
                   v_job.application_service_id, v_owner_ids[v_oidx], v_member_acres, v_job.season);
        v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
        v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
        IF v_fee_c > 0 THEN
          v_item_order := v_item_order + 1;
          INSERT INTO invoice_items (
            invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
            cost_cents, sort_order, acres, rate_per_acre, rate_unit,
            is_application_fee, price_source
          ) VALUES (
            v_member_id, COALESCE(v_fee->>'service_name', 'Application'), v_member_acres, 'acre',
            ROUND(v_fee_c / v_member_acres)::bigint, v_fee_c,
            v_cost_c, v_item_order, v_member_acres,
            ROUND(v_fee_c / v_member_acres)::bigint, 'acre',
            true, 'tier'
          );
          v_member_total := v_member_total + v_fee_c;
          v_member_cost  := v_member_cost + v_cost_c;
        END IF;
      END IF;

      UPDATE invoices SET total_amount_cents = v_member_total, total_cost_cents = v_member_cost
        WHERE id = v_member_id;

      -- one invoice_shares row (100% of this member -> itself) so statements/year-end read it.
      INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
      VALUES (v_member_id, v_owner_ids[v_oidx], v_owner_names[v_oidx], 100.0, v_member_acres, v_member_total,
              COALESCE(v_owner_primary[v_oidx], false), v_oidx);

      -- DELTA-4: draft -> unposted now that the member is fully built.
      UPDATE invoices SET status = 'unposted' WHERE id = v_member_id;
    END LOOP;

    -- Commission split resolution (mirror of the single-owner path: snapshot on the job,
    -- else the parent quote's split, else the customer default for pre-U8 jobs).
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Anchor = the primary owner's member (else the first). jobs.invoice_id is a scalar,
    -- so it points at the anchor; siblings are found via invoices.invoice_group_id / job_id.
    -- v_member_ids[i] corresponds to v_owner_ids[i] / v_owner_primary[i] (same build order).
    v_anchor_id := v_member_ids[1];
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      IF COALESCE(v_owner_primary[v_oidx], false) THEN
        v_anchor_id := v_member_ids[v_oidx];
        EXIT;
      END IF;
    END LOOP;

    UPDATE jobs SET status = 'invoiced', invoice_id = v_anchor_id,
      commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
    WHERE id = p_job_id;
    UPDATE application_records SET invoice_id = v_anchor_id WHERE source_type = 'job' AND source_id = p_job_id;

    -- Per-member commission: on THAT member's chemical-line profit (product lines only,
    -- excludes the per-acre fee). Sum across members == the whole job's chemical profit.
    FOR v_oidx IN 1 .. array_length(v_member_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
        INTO v_member_profit_cents
      FROM invoice_items ii
      WHERE ii.invoice_id = v_member_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      PERFORM _insert_commissions_for_job(
        p_job_id, v_member_id, v_owner_ids[v_oidx],
        v_member_profit_cents::numeric / 100.0,
        v_commission_split,
        (now() AT TIME ZONE 'America/Chicago')::date
      );

      -- Per-member creation audit row (mirror of the single path's invoice_created row).
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_user_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_member_id, auth.uid(),
        (SELECT role FROM profiles WHERE id = auth.uid()),
        jsonb_build_object(
          'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_member_id),
          'job_id', p_job_id,
          'customer_id', v_owner_ids[v_oidx],
          'invoice_group_id', v_group_id,
          'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_member_id)
        ),
        (SELECT total_amount_cents FROM invoices WHERE id = v_member_id),
        'Split invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_member_id) ||
          ' created from job ' || v_job.job_number || ' (per-owner group)'
      );
    END LOOP;

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('job_invoiced',
      'Job ' || v_job.job_number || ' transferred to a ' || array_length(v_member_ids, 1) ||
        '-owner split invoice group',
      COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

    v_result := jsonb_build_object(
      'success', true, 'job_id', p_job_id,
      'invoice_id', v_anchor_id,
      'invoice_ids', to_jsonb(v_member_ids),
      'invoice_group_id', v_group_id,
      'invoice_count', array_length(v_member_ids, 1),
      'split', true,
      'price_warnings', v_price_warnings
    );

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
    END IF;

    RETURN v_result;
  END IF;
  -- ================= end multi-owner group path =================

  -- Fail-safe for legacy single-owner defaults that predate the deferred table guard.
  -- Match the multi-owner FIELD_SPLIT_NOT_100 validation before creating any invoice rows.
  IF EXISTS (
    SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id
    GROUP BY jf.field_id HAVING sum(fbd.split_pct) < 99.99 OR sum(fbd.split_pct) > 100.01
  ) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
  END IF;

  -- OVERNIGHT FIX (Run 2 cycle 6 — invoice-number canonicalization, Codex-confirmed MEDIUM):
  -- use the shared next_invoice_number() — the SAME invoice_number_seq, 'invoice_number:INV:<year>'
  -- advisory lock, and setval self-heal that every other invoice creator AND the
  -- invoices.invoice_number column default use. The previous inline
  -- `pg_advisory_xact_lock(hashtext('invoice_number'))` + MAX(regexp_replace(...))+1 scan took a
  -- DIFFERENT advisory-lock key, so it did not serialize against other INV creators (two callers
  -- could compute the same number -> 23505 on the UNIQUE index invoices_invoice_number_key,
  -- aborting the transfer) and it never advanced invoice_number_seq.
  v_invoice_number := next_invoice_number('field_application');

  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
    field_names, crop_type, total_acres, applicator_name, vehicle_name,
    application_date, header_notes, season, created_by, job_id,
    application_service_id
  ) VALUES (
    -- insert as 'draft' (DELTA-1) — trg_invoice_draft_insert rejects non-draft,
    -- non-credit_memo inserts; DELTA-4 flips to 'unposted' once fully built.
    v_invoice_number, v_job.customer_id, 'field_application', 'draft',
    (now() AT TIME ZONE 'America/Chicago')::date, NULL::date,  -- KI-14: the due-date trigger derives it from this owner's terms
    COALESCE(v_job.total_price_cents, 0), 0, 0, 0,
    v_field_names, v_crop_type, v_total_acres, v_applicator_name, v_vehicle_name,
    v_job.job_date, v_job.notes,
    -- N2-7 #109<<< stamp the JOB's season, not the season-of-now. An invoice cut in a
    -- later season for a prior-season job must file under the job's season (reports/
    -- year-end read invoices.season). invoices.season is NOT NULL and jobs.season is
    -- nullable, so COALESCE back to the ORIGINAL CURRENT_DATE-based expression when the
    -- job has no season — never stamp NULL, and legacy null-season jobs behave exactly
    -- as before this migration.
    COALESCE(
      v_job.season,
      CASE WHEN extract(month FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10
           THEN extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer + 1
           ELSE extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer END
    ),
    -- >>>N2-7 #109
    p_performed_by, p_job_id, v_job.application_service_id
  ) RETURNING id INTO v_invoice_id;

  FOR v_chem IN
    SELECT jc.product_id, jc.rate_per_acre,
           safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
           safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
           jc.quantity,
           jc.customer_supplied,
           p.product_name, COALESCE(NULLIF(btrim(jc.unit), ''), p.unit_size) AS unit_size, p.epa_registration, p.product_form,
           COALESCE(NULLIF(btrim(jc.rate_unit), ''), NULLIF(btrim(jc.unit), ''), p.unit_size) AS rate_unit,
           COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size) AS stock_unit,
           jc.price_typed, jc.price_per_unit_cents
    FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id ORDER BY p.product_name
  LOOP
    v_item_order := v_item_order + 1;
    -- U4<<< a grower-supplied product costs us nothing (we didn't buy it) — keep
    -- it OUT of the invoice cost so margin isn't understated. (#53/#54)
    v_total_cost_cents := v_total_cost_cents + CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END;
    -- >>>U4
    v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres ELSE NULL END;
    -- DELTA-6: call convert_to_gl_lb unconditionally so v_conversion always receives a
    -- tuple structure (the helper returns one row even for NULL inputs); an unrated line
    -- yields (NULL, NULL) without leaving v_conversion unassigned.
    SELECT * INTO v_conversion
      FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    -- Sent quote price (Mason, 2026-11-21): the paying grower's own sent quote on the job's fields prices the line;
    -- else the job line's price, as before. The paying grower is the one billing-default customer of the job's
    -- fields when there is one (that grower's share pays the whole job), else the job's customer.
    IF v_bill_to IS NULL THEN
      v_bill_to := COALESCE((SELECT min(fbd.customer_id::text)::uuid FROM job_fields jf
                               JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
                              WHERE jf.job_id = p_job_id), v_job.customer_id);
    END IF;
    -- A price typed by hand on the job (Mason, 2026-11-21) is kept; the quote only warns.
    v_quote_cents := CASE WHEN v_chem.customer_supplied OR v_chem.price_typed THEN NULL ELSE _job_transfer_quote_price_cents_20270207(
      v_chem.product_id, v_chem.product_name, v_chem.unit_size, v_chem.stock_unit,
      ARRAY(SELECT jf.field_id FROM job_fields jf WHERE jf.job_id = p_job_id ORDER BY jf.field_id),
      v_bill_to, v_on) END;
    IF v_chem.price_typed AND NOT v_chem.customer_supplied THEN
      v_warning := _job_transfer_typed_price_warning_20270207(
        v_chem.product_id, v_chem.product_name, v_chem.unit_size, v_chem.stock_unit,
        ARRAY(SELECT jf.field_id FROM job_fields jf WHERE jf.job_id = p_job_id ORDER BY jf.field_id),
        v_bill_to, v_on, v_chem.price_per_unit_cents, NULL);
      IF v_warning IS NOT NULL THEN v_price_warnings := v_price_warnings || to_jsonb(v_warning); END IF;
    END IF;
    v_line_price := CASE WHEN v_chem.customer_supplied THEN 0
                         WHEN v_quote_cents IS NOT NULL THEN safe_cents_qty(v_quote_cents,
                           _job_transfer_qty_in_stock_unit_20270207(v_chem.quantity, v_chem.unit_size, v_chem.stock_unit))
                         ELSE COALESCE(v_chem.chem_price, 0) END;
    v_line_sum := v_line_sum + v_line_price;
    v_any_quoted := v_any_quoted OR v_quote_cents IS NOT NULL;
    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
      cost_cents, sort_order, acres, rate_per_acre, rate_unit,
      total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
      epa_registration, product_form, is_application_fee, price_source
    ) VALUES (
      v_invoice_id, v_chem.product_id,
      -- U4<<< customer-supplied: keep the line (legal/application record) but at $0
      -- with a labeled description; force cost + price to 0. price_source='manual'
      -- pins the $0 (Codex R5 P1: a product-backed $0 line without it would be
      -- re-priced by tier when the unposted invoice is edited + re-saved). (#53/#54)
      CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
      1,
      v_chem.unit_size,
      v_line_price,
      v_line_price,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END,
      -- >>>U4
      v_item_order, v_total_acres,
      v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit_size),
      v_conversion.converted_value, v_conversion.converted_unit,
      v_chem.epa_registration, v_chem.product_form, false,
      CASE WHEN v_chem.customer_supplied OR v_chem.price_typed THEN 'manual' WHEN v_quote_cents IS NOT NULL THEN 'quoted' ELSE NULL END
    );
  END LOOP;

  -- Sent quote price (Mason, 2026-11-21): when a quote priced any line, the invoice bills the sum of its lines
  -- (the stored job total was figured at the old prices); else the job total, as before.
  UPDATE invoices SET total_cost_cents = v_total_cost_cents,
         total_amount_cents = CASE WHEN v_any_quoted THEN v_line_sum ELSE total_amount_cents END
   WHERE id = v_invoice_id;

  IF EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id) THEN
    SELECT EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL) INTO v_has_price_override;
    FOR v_share IN
      SELECT fbd.customer_id, c.farm_name,
        CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
          THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
          ELSE avg(fbd.split_pct) END AS avg_split_pct,
        sum(COALESCE(jf.acres_to_treat, 0)) *
          CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
            THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
            ELSE avg(fbd.split_pct) END / 100.0 AS share_acres,
        bool_or(fbd.is_primary) AS is_primary,
        CASE WHEN count(DISTINCT fbd.price_override_cents) = 1 AND min(fbd.price_override_cents) IS NOT NULL
          THEN min(fbd.price_override_cents) ELSE NULL END AS price_override_cents,
        max(fbd.pricing_note) AS pricing_note,
        row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name) AS sort_ord
      FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      JOIN customers c ON c.id = fbd.customer_id WHERE jf.job_id = p_job_id
      GROUP BY fbd.customer_id, c.farm_name
    LOOP
      DECLARE v_amount bigint; v_ppa bigint;
      BEGIN
        IF v_share.price_override_cents IS NOT NULL THEN
          v_amount := safe_cents_qty(v_share.price_override_cents, v_share.share_acres);
          v_ppa := v_share.price_override_cents;
        ELSE
          v_amount := ROUND((CASE WHEN v_any_quoted THEN v_line_sum ELSE COALESCE(v_job.total_price_cents, 0) END) * v_share.avg_split_pct / 100.0)::bigint;
          v_ppa := NULL;
        END IF;
        INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents, pricing_note)
        VALUES (v_invoice_id, v_share.customer_id, v_share.farm_name, v_share.avg_split_pct, v_share.share_acres, v_amount, v_share.is_primary, v_share.sort_ord, v_ppa, v_share.pricing_note);
        v_share_total := v_share_total + v_amount;
      END;
    END LOOP;
    -- OVERNIGHT FIX (Run 2 cycle 2, finding #3 — penny-drift): reconcile the header to the share
    -- sum for BOTH the override AND the percentage-split path (was override-only). Independent
    -- per-customer ROUND(total_price_cents * pct/100) can drift ±1c on odd-cent splits, so without
    -- this the percentage-split header stayed at total_price_cents while invoice_shares summed a cent
    -- off — and get_customer_year_end_summary / get_detailed_statement_data read invoice_shares.amount_cents,
    -- so statements wouldn't tie. v_share_total is the exact sum of the shares; DELTA-8 then adds the
    -- per-acre fee to both shares and header, preserving the tie. The single-customer ELSE branch
    -- already inserts header = its one share, so it ties without this.
    UPDATE invoices SET total_amount_cents = v_share_total WHERE id = v_invoice_id;
  ELSE
    INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
    SELECT v_invoice_id, v_job.customer_id, c.farm_name, 100.0, v_total_acres, CASE WHEN v_any_quoted THEN v_line_sum ELSE COALESCE(v_job.total_price_cents, 0) END, true, 1
    FROM customers c WHERE c.id = v_job.customer_id;
  END IF;

  -- DELTA-8 (G1 per-acre application fee, PER-CUSTOMER rate): now that invoice_shares exist,
  -- charge each billed customer the per-acre machine fee at that customer's own rate; add each
  -- customer's fee to their share, emit one is_application_fee line, fold into the header.
  IF v_job.application_service_id IS NOT NULL AND v_total_acres > 0 THEN
    FOR v_share IN
      SELECT id, customer_id, COALESCE(acres, 0) AS acres, price_per_acre_cents
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    LOOP
      -- A grower on a price_override (all-inclusive $/acre) does NOT also pay the per-acre
      -- machine fee, or they'd be double-charged (mirrors save_field_app_invoice).
      IF v_share.price_per_acre_cents IS NOT NULL THEN CONTINUE; END IF;
      v_fee := compute_application_service_fee(
                 v_job.application_service_id, v_share.customer_id, v_share.acres, v_job.season);
      v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
      v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
      v_fee_total := v_fee_total + v_fee_c;
      v_fee_cost  := v_fee_cost  + v_cost_c;
      v_fee_acres := v_fee_acres + v_share.acres;
      IF v_fee_c <> 0 THEN
        UPDATE invoice_shares SET amount_cents = amount_cents + v_fee_c WHERE id = v_share.id;
      END IF;
    END LOOP;

    IF v_fee_total > 0 AND v_fee_acres > 0 THEN
      v_item_order := v_item_order + 1;
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, COALESCE(v_fee->>'service_name', 'Application'), v_fee_acres, 'acre',
        ROUND(v_fee_total / v_fee_acres)::bigint, v_fee_total,
        v_fee_cost, v_item_order, v_fee_acres,
        ROUND(v_fee_total / v_fee_acres)::bigint, 'acre',
        true, 'tier'
      );
      UPDATE invoices SET
        total_amount_cents = COALESCE(total_amount_cents, 0) + v_fee_total,
        total_cost_cents   = total_cost_cents + v_fee_cost
      WHERE id = v_invoice_id;
    END IF;
  END IF;
  -- END DELTA-8

  -- U8<<< (#99): resolve the commission split. New jobs carry a creation-time
  -- snapshot (quote-born: the quote's split via create_job_from_quote_section;
  -- direct: the customer default via trg_jobs_snapshot_commission_split), so this
  -- fallback only fires for PRE-U8 jobs. Order-channel parity (Codex R3 P1): a
  -- quote-born job uses the parent quote's split and ONLY that — convert_quote_to_order
  -- passes only v_quote.commission_split, so a NULL quote split pays no commission,
  -- never the customer default. A pre-U8 direct job uses the customer default, like
  -- a direct order. Codex R2 P2: the resolved fallback is PERSISTED onto the job in
  -- the same UPDATE that flips it to 'invoiced', so attribution locks at first use.
  v_commission_split := v_job.commission_split;
  IF v_commission_split IS NULL THEN
    IF v_job.quote_id IS NOT NULL THEN
      SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
    ELSE
      SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
    END IF;
  END IF;
  -- >>>U8

  UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_id,
    -- U8 (Codex R2 P2 + R4 P1): persist the resolution — even a nothing-anywhere
    -- result locks as the empty sentinel so re-invoices never re-read live sources.
    commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
  WHERE id = p_job_id;
  UPDATE application_records SET invoice_id = v_invoice_id WHERE source_type = 'job' AND source_id = p_job_id;

  -- DELTA-4: invoice was inserted as 'draft'; flip to 'unposted' now that items, shares and
  -- totals are final. draft -> unposted is allowed by _enforce_invoice_status_transition.
  UPDATE invoices SET status = 'unposted' WHERE id = v_invoice_id;

  -- U8<<< (#99): mint the application-channel commissions — chemical-line profit only.
  -- Mirror of the order channel (convert_quote_to_order → _insert_commissions_for_order).
  -- Profit basis: the chemical lines just written to THIS invoice. The per-acre machine
  -- fee (is_application_fee=true, product_id NULL) is excluded per the owner rule, and
  -- customer-supplied lines carry $0 price AND $0 cost so they contribute exactly 0.
  -- invoice_items money is bigint CENTS; commissions are numeric DOLLARS → /100.0.
  -- The helper no-ops on a NULL/splits-less split and validates a present one
  -- (COMMISSION_SPLIT_INVALID aborts, matching the order-conversion behavior).
  -- Pending amounts stay in sync with later unposted-invoice edits via the
  -- recompute in the item-rewrite path (Codex R2 P1), mirroring update_order_items.
  SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
    INTO v_chem_profit_cents
  FROM invoice_items ii
  WHERE ii.invoice_id = v_invoice_id
    AND COALESCE(ii.is_application_fee, false) = false
    AND ii.product_id IS NOT NULL;

  PERFORM _insert_commissions_for_job(
    p_job_id, v_invoice_id, v_job.customer_id,
    v_chem_profit_cents::numeric / 100.0,
    v_commission_split,
    (now() AT TIME ZONE 'America/Chicago')::date
  );
  -- >>>U8

  -- DELTA-5: log to activity_feed (performed_by NOT NULL: COALESCE to auth.uid()).
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('job_invoiced',
    'Job ' || v_job.job_number || ' transferred to invoice ' || v_invoice_number,
    COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

  -- OVERNIGHT FIX (finding #3): write the canonical 'invoice_created' financial_audit_log row
  -- the other six invoice creators write, so the append-only money ledger records creation
  -- provenance for job-built invoices too. Read the FINAL header total back (DELTA-8 may have
  -- adjusted it). Shape mirrors save_field_app_invoice's invoice_created row.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id, auth.uid(),
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'job_id', p_job_id,
      'customer_id', v_job.customer_id,
      'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id)
    ),
    (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id),
    'Invoice ' || v_invoice_number || ' created from job ' || v_job.job_number
  );

  v_result := jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number,
                                 'price_warnings', v_price_warnings);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(uuid, uuid, text)
  TO postgres;

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)'::regprocedure
                    AND p.prosecdef AND p.proowner = 'postgres'::regrole
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                    AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[])
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = 'public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure
                       AND p.prosecdef AND p.proowner = 'postgres'::regrole
                       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                       AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[])
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid IN ('public._job_transfer_quote_price_cents_20270207(uuid,text,text,text,uuid[],uuid,date)'::regprocedure,
                                 'public._job_transfer_typed_price_warning_20270207(uuid,text,text,text,uuid[],uuid,date,bigint,text)'::regprocedure,
                                 'public._job_transfer_qty_in_stock_unit_20270207(numeric,text,text)'::regprocedure)
                   AND a.privilege_type = 'EXECUTE' AND a.grantee <> 'postgres'::regrole)
     OR NOT has_column_privilege('authenticated', 'public.job_chemicals', 'price_typed', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.job_chemicals', 'price_typed', 'REFERENCES')
     OR has_column_privilege('authenticated', 'public.job_chemicals', 'price_typed', 'INSERT')
     OR has_column_privilege('authenticated', 'public.job_chemicals', 'price_typed', 'UPDATE')
     OR has_column_privilege('anon', 'public.job_chemicals', 'price_typed', 'SELECT')
     OR has_column_privilege('anon', 'public.job_chemicals', 'price_typed', 'UPDATE') THEN
    RAISE EXCEPTION 'JOB_QUOTE_PRICE_POSTFLIGHT: owner, settings or grants are not as reviewed';
  END IF;
END;
$postflight$;
