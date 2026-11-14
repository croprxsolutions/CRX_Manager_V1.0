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

-- A brand save locks its product row, then reads the switch, then writes. Take products first (EXCLUSIVE: plain
-- reads go on; row locks and writes wait), so a save already past its switch read finishes before the check below,
-- and a new one waits for commit and then reads the switch as on. Then hold brand and membership writes until
-- commit, so no brand row can land on a grouped size between the check and the switch turning on.
LOCK TABLE public.products IN EXCLUSIVE MODE;
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
  -- Each function below is pinned by one fingerprint over everything Postgres keeps for it: body, definer flag,
  -- settings, grants, owner, volatility, kind, parallel/strict/leakproof flags, return type, language and arguments
  -- (read from live 2026-11-09). Opening the switch changes how the first six behave; the seventh is the admin read
  -- the screen uses to show Approve.
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.approve_product_parent_groups(uuid,bigint,jsonb,text)', 'daaec83f30d36513458c68dbd878b698'),
      ('public._approve_product_parent_group(public.product_parent_proposals,jsonb,boolean)', 'e04e50d6cc7fd49d23a8ed49ac239824'),
      ('public._move_group_brands(uuid,uuid[],jsonb,boolean,text)', 'e1d262ff287ce94915c5c75c521b6b99'),
      ('public.upsert_parent_brand(uuid,uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)', 'd73d43d0c36502ac702ab22e000d64ab'),
      ('public.upsert_product_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,text)', '19d1c4ecb68f7814d1a8c1bd37faf480'),
      ('public.get_product_brands(uuid)', 'de0838a868f736ea3dc70f353d1a798b'),
      ('public.get_product_grouping_open()', '54f36617de3868b333ab68462a8e2f37')
    ) AS pin(fn, h)
    WHERE (SELECT md5(concat_ws('|', md5(replace(p.prosrc, chr(13), '')), p.prosecdef, array_to_string(p.proconfig, ','),
               array_to_string(p.proacl, ','), p.proowner::regrole::text, p.provolatile, p.prokind, p.proparallel, p.proisstrict,
               p.proleakproof, p.proretset, p.prorettype::regtype::text, l.lanname, pg_get_function_identity_arguments(p.oid)))
             FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = to_regprocedure(pin.fn)) IS DISTINCT FROM pin.h
  ) THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: a function this switch opens changed since review; re-review it first';
  END IF;
  -- Exactly one version of each of those seven, so a call cannot reach an unreviewed overload.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('approve_product_parent_groups',
        '_approve_product_parent_group', '_move_group_brands', 'upsert_parent_brand', 'upsert_product_brand', 'get_product_brands',
        'get_product_grouping_open')) <> 7 THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: expected exactly one version of each function this switch opens';
  END IF;
  -- The helpers they reach (every _product_parent_* and _product_name_* function except the switch), in one combined
  -- fingerprint over the 19, so a changed, added or dropped helper refuses too.
  IF (SELECT md5(string_agg(f, ',' ORDER BY f)) FROM (SELECT md5(concat_ws('|', md5(replace(p.prosrc, chr(13), '')), p.prosecdef, array_to_string(p.proconfig, ','),
               array_to_string(p.proacl, ','), p.proowner::regrole::text, p.provolatile, p.prokind, p.proparallel, p.proisstrict,
               p.proleakproof, p.proretset, p.prorettype::regtype::text, l.lanname, pg_get_function_identity_arguments(p.oid))) AS f
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_product_(parent|name)_'
         AND p.proname <> '_product_parent_grouping_open') fp) IS DISTINCT FROM '3319eacd47a9ce80f2bee09edba4389e' THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: a grouping helper changed since review; re-review it first';
  END IF;
  IF public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: grouping is already switched on';
  END IF;
  -- The switch being replaced must be the reviewed one (20261123120000's plain SELECT false, owner-only), so no
  -- extra condition it might carry is dropped silently.
  IF (SELECT md5(concat_ws('|', md5(replace(p.prosrc, chr(13), '')), p.prosecdef, array_to_string(p.proconfig, ','),
               array_to_string(p.proacl, ','), p.proowner::regrole::text, p.provolatile, p.prokind, p.proparallel, p.proisstrict,
               p.proleakproof, p.proretset, p.prorettype::regtype::text, l.lanname, pg_get_function_identity_arguments(p.oid)))
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public._product_parent_grouping_open()'::regprocedure)
       IS DISTINCT FROM 'ed2b79633591824552c294e4944dd12a' THEN
    RAISE EXCEPTION 'PRODUCT_GROUPING_SWITCH_ON_PREFLIGHT: the switch changed since review; re-review it first';
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
