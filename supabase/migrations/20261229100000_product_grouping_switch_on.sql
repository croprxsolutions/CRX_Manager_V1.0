-- Written 2026-11-09. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261229100000_product_grouping_switch_on.md. Re-read the live ledger before applying.
--
-- WHY (Mason, 2026-11-09: "Yes, switch it on"): PAR-2's data step (DATA-9) groups the existing product sizes under
--   parent products, Mason approving each batch on the Group Products screen. The screen and every grouping writer
--   are live, but approval and parent-brand edits are refused (PRODUCT_PARENT_GROUPING_NOT_OPEN) while the switch
--   _product_parent_grouping_open() returns false. 20261123120000 shipped it off until the screens that read
--   get_product_brands were deployed; they were (PR #1602, merged 2026-11-07), and Taha's four "before the switch
--   is turned on" items from PR #1555 were settled by 20261201110000 (applied live).
--
-- WHAT: replaces the switch body "SELECT false" with "SELECT true". Nothing else: same signature, language,
--   volatility, search_path, owner and grants (owner-only EXECUTE).
--
-- EFFECT once applied: approve_product_parent_groups and upsert_parent_brand stop refusing with
--   PRODUCT_PARENT_GROUPING_NOT_OPEN, and get_product_grouping_open() reads true, so the screen shows Approve. No row
--   changes here: a product is grouped only when an admin approves a group on the screen. Approval never changes a
--   product ID, unit, price, cost, stock or any old record, and refuses a live rate change while the rate lock is on.
--   Also, for a grouped size, get_product_brands returns the parent's brand list and upsert_product_brand refuses
--   (PRODUCT_BRANDS_BELONG_TO_PARENT).
--
-- NOT CHANGED: every table, row, grant and other function.
--
-- ROLLBACK (its own reviewed migration): the same CREATE OR REPLACE with "SELECT false". Groups approved while open
--   stay grouped (closing the switch only stops new approvals and parent-brand edits).
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

-- Hold brand and membership writes until commit, so no brand row can land on a grouped size between the check
-- below and the switch turning on.
LOCK TABLE public.product_brands, public.product_parent_members IN SHARE MODE;

DO $preflight$
BEGIN
  IF to_regprocedure('public._product_parent_grouping_open()') IS NULL
     OR to_regprocedure('public.get_product_grouping_open()') IS NULL
     OR to_regprocedure('public.approve_product_parent_groups(uuid,bigint,jsonb,text)') IS NULL
     -- 20261201110000 (Taha's pre-switch items) and 20261203110000 (brand save names its size) are live.
     OR to_regprocedure('public._product_name_strength_tokens(text,numeric,text)') IS NULL
     OR to_regprocedure('public._product_parent_identity_name(text)') IS NULL
     OR to_regprocedure('public.upsert_parent_brand(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: a grouping function this depends on is missing';
  END IF;
  -- Opening the switch changes how these six behave (and the seventh, the admin read the screen uses, reports it); refuse unless their installed bodies are the reviewed ones
  -- (body, definer flag, search_path and grants in one fingerprint each, read from live 2026-11-09).
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.approve_product_parent_groups(uuid,bigint,jsonb,text)', 'f0600cffde222b1ecfe9d79c36d5678c'),
      ('public._approve_product_parent_group(public.product_parent_proposals,jsonb,boolean)', '4b2d8cd1cc64e02dc9844eb72bbc5d92'),
      ('public._move_group_brands(uuid,uuid[],jsonb,boolean,text)', 'd3e2543d4adc2ead0868bada9970718c'),
      ('public.upsert_parent_brand(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)', '8b193d80a067363ab140eb3fa991101f'),
      ('public.upsert_product_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,text)', 'ed6fa5ec7589e8df6a5dea65f8003e9c'),
      ('public.get_product_brands(uuid)', 'c65bda6cfffc5de51db079f0b328682a'),
      ('public.get_product_grouping_open()', 'e786cb35c8e1f7f894adbc6c1da76442')
    ) AS pin(fn, h)
    WHERE (SELECT md5(concat_ws('|', md5(replace(p.prosrc, chr(13), '')), p.prosecdef, array_to_string(p.proconfig, ','), array_to_string(p.proacl, ','))) FROM pg_proc p WHERE p.oid = to_regprocedure(pin.fn)) IS DISTINCT FROM pin.h
  ) THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: a function this switch opens changed since review; re-review it first';
  END IF;
  -- The helpers those six reach (every _product_parent_* and _product_name_* function except the switch): one
  -- fingerprint over their 19 bodies (read from live 2026-11-09), so a changed, added or dropped helper refuses too.
  IF (SELECT md5(string_agg(f, ',' ORDER BY f)) FROM (SELECT md5(concat_ws('|', md5(replace(p.prosrc, chr(13), '')), p.prosecdef, array_to_string(p.proconfig, ','), array_to_string(p.proacl, ','))) AS f
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_product_(parent|name)_'
         AND p.proname <> '_product_parent_grouping_open') fp) IS DISTINCT FROM '3a5d098b9fe8ce1a88c48405ca084784' THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: a grouping helper changed since review; re-review it first';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname IN ('upsert_parent_brand', 'approve_product_parent_groups')
        AND pronamespace = 'public'::regnamespace) <> 2 THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: expected exactly one upsert_parent_brand and one approve_product_parent_groups';
  END IF;
  IF public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: grouping is already switched on';
  END IF;
  -- The rule 20261123120000 set for this step: a size grouped while the switch was off must not keep its own
  -- legacy brand rows, because once open its brands are read from the parent's list.
  IF EXISTS (SELECT 1 FROM public.product_brands b JOIN public.product_parent_members m ON m.product_id = b.product_id) THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: a grouped size has its own brand rows; settle them first';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._product_parent_grouping_open() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT true;
$function$;
ALTER FUNCTION public._product_parent_grouping_open() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_grouping_open() FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF NOT public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_POSTFLIGHT: the switch did not turn on';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public._product_parent_grouping_open()'::regprocedure
       AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef AND p.provolatile = 's'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']
       AND array_to_string(p.proacl, ',') = 'postgres=X/postgres'
  ) THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_POSTFLIGHT: the switch is not owner-only with its original settings';
  END IF;
END
$postflight$;
