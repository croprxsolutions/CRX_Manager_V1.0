-- idempotency-body-check: exempt
-- (Every re-issued writer keeps its retry key check through PAR-1's _product_parent_replay, which calls
--  check_idempotency and refuses a different caller or request, and saves its receipt with save_idempotency last,
--  in the same transaction. Nothing about the retry handling changes.)
--
-- PAR-2 review fixes (Taha's review of PR #1555, review 5802185149). Must be live BEFORE the PAR-2 screens PR turns
-- the grouping switch (_product_parent_grouping_open) on. Live had 0 parents, 0 parent brands and 0 proposals on
-- 2026-11-06, so no existing row changes.
--
-- 1. Base name (_product_parent_base_name, re-issued): different strengths never share a base name.
--    * A pack count ("2 x", "4/") is removed only when a size with a unit follows it, so "UAN 28/0/0" and
--      "Starter 6/24/6" keep their analysis and "Goldstart (80/20)" its ratio.
--    * A size is removed only when no "/" follows it, so "Imidacloprid 2 lb/gal" keeps its concentration.
--    * Grams are no longer removed: "Talstar 2 G" and "0.2 G" (also live's "Aztec 4.67 G", "Counter 20 G") are
--      strengths. A gram-sized package name only groups less, never wrongly.
--    Measured on live 2026-11-06 (604 products): 15 base names change, every one by keeping a strength or ratio.
-- 2. Build (build_product_parent_proposal, re-issued), three new holds, a flag and a list:
--    * size_numbers_differ (held): the sizes' names, less each one's recorded container size, carry different
--      numbers or units (a number by value, with the word written right after it), so the base name lost a
--      strength or analysis however it was written ("2 lb./gal", "2 lb ai/gal" vs "2 oz ai/gal"). A number counts
--      as the container size only when it is the last number written with a unit word and that word is the
--      product's own unit (container unit, else stock unit), so "2 lb ai/gal" on a 2 gal jug and "2 gal
--      concentrate per 10 gal" stay strengths (Mason, 2026-11-06: match the unit word; when unsure, hold). Sizes
--      whose names carry the same numbers and units are not held, with or without a recorded container size.
--      Accepted limit (Mason, 2026-11-06): a strength written exactly as the container size ("2 lb ai" on a
--      2 lb bag) cannot be told from the size by its name; every group still needs an admin's approval, and
--      different strengths almost always carry different EPA numbers, which are never grouped together.
--    * epa_has_parent (flag): an active parent already has the group's EPA number. Held when that parent's form
--      and base name are the group's too (a second parent for the same product); otherwise it stays a flag, as
--      the build sheet's same-EPA-different-name rule says (Gen Liberty / Gen Liberty: Higher Quality).
--    * rejected_before (flag): an earlier proposal rejected a group with exactly these sizes. When none of them
--      changed (same group fingerprint) the rejection is carried, with its reason, who and when; otherwise the
--      group is proposed again with the earlier rejection in its reason.
--    The result adds rejected_count and duplicate_parents: active parents that already share an EPA number (or
--    both have none), form and base name, so a duplicate made by hand or by two admins at once is shown to be
--    fixed. A group with no EPA number is held the same way when an active parent with no EPA number has its
--    form and base name.
-- 3. Approval (approve_product_parent_groups, re-issued): after the member locks, each group in turn is refused
--    PRODUCT_PARENT_EPA_HAS_PARENT when an active parent has its EPA number (or both have none), form and base
--    name, by the group's name or the name submitted for it; checked per group, so a parent made earlier in the
--    same batch counts (a parent made after the build, or two matching groups in one call). Duplicates are warned, not blocked on the table (Mason, 2026-11-06): a rare one is visible in the
--    next build and reversible (move its sizes, deactivate it).
-- 4. Moving a size (PAR-1; _product_size_move_refusal and move_product_size, re-issued):
--    * refused PRODUCT_PARENT_BRANDS_DIFFER when the two parents' active brand lists differ (name, EPA number,
--      manufacturer, sourced, RUP, signal word), so a move never changes a size's brands silently. The preview
--      calls the same refusal, so it shows it too.
--    * a parent left with no sizes is made inactive as before, and now its active brands are retired, each with
--      a 'retired' brand event. The receipt adds from_parent_brands_retired.
--    * a REPEATABLE READ or SERIALIZABLE transaction is refused (PRODUCT_PARENT_READ_COMMITTED_REQUIRED): its
--      old snapshot would hide a row committed while it waited. The app's calls are READ COMMITTED.
-- Two new private helpers: _product_parent_identity_name (the base name without the " (EPA ...)", " (form)" and
-- " #n" suffixes approval adds to keep names unique; every second-parent check compares it) and
-- _product_name_strength_tokens (the numbers check above).
-- Same signatures, owners and grants for every re-issued function (CREATE OR REPLACE keeps them; the postflight
-- checks). No table, row, grant or policy changes. The switch stays off.
--
-- Rollback: re-issue _product_parent_base_name, build_product_parent_proposal and approve_product_parent_groups
-- from 20261123120000_product_parent_proposals.sql, and _product_size_move_refusal and move_product_size from
-- 20261110150000_product_parent_stock_units.sql, then DROP FUNCTION public._product_parent_identity_name(text) and
-- public._product_name_strength_tokens(text, numeric, text). Brands retired by an emptying move stay retired (retired
-- is final; their events record it).

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_parent_base_name(text)'::regprocedure) IS DISTINCT FROM 'a3fbf24aeb7c63ef3595121045bec5a6'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.build_product_parent_proposal(text)'::regprocedure) IS DISTINCT FROM '3b3431538e9b27d9368a3169cfeaa992'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.approve_product_parent_groups(uuid,bigint,jsonb,text)'::regprocedure) IS DISTINCT FROM '2e2dc773cacc2d0fcc6cd335a6555697'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_size_move_refusal(uuid,uuid)'::regprocedure) IS DISTINCT FROM 'e48d50e9cc61855fbd7d9bcd4e471387'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)'::regprocedure) IS DISTINCT FROM 'e869af2cf434eab03057f0e69766c259' THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_HELPERS_CHANGED: re-base this on the installed bodies';
  END IF;
  IF to_regprocedure('public._parent_brand_event(uuid,uuid,text,text,jsonb,jsonb)') IS NULL
     OR to_regclass('public.product_parent_brands') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_DEPENDENCY_MISSING';
  END IF;
  -- Approval does not re-run the build's holds, so no proposal built by the old rules may stay open (live: no
  -- proposals, 2026-11-06). The build's own lock keeps one from opening until this commits.
  PERFORM pg_advisory_xact_lock(hashtext('crx.product_parent_proposal.build'));
  IF EXISTS (SELECT 1 FROM public.product_parent_proposals WHERE status = 'open') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_OPEN_PROPOSAL: an open proposal was built by the old rules; mark it superseded first';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Base name
-- ---------------------------------------------------------------------------------------------

-- The name with size, pack and container words removed (build sheet §5.1). A size is removed only when written
-- as a number, an optional space and a unit word from the list, standing apart from the name and not followed by
-- "/" ("2 lb/gal" is a concentration). A pack count is removed only right before such a size ("2 x 2.5 gal",
-- "4/1 gal"), so "28/0/0" and "6/24/6" stay. Grams are never removed ("2 G", "4.67 G" are strengths). Strength and
-- quality words ("4L", "4G", "Higher Quality", "Ester", "safened", percentages, "#") are never removed.
CREATE OR REPLACE FUNCTION public._product_parent_base_name(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    COALESCE(p_name, ''),
    -- pack count right before a size: "2 x 2.5 gal", "4/1 gal"
    '(^|[^[:alnum:].])[0-9]+[[:space:]]*[x/][[:space:]]*(?=([0-9]+(\.[0-9]+)?|\.[0-9]+)[[:space:]]?(fl[[:space:]]?oz|gallons?|gals?|gl|quarts?|qts?|pints?|pts?|oz|pounds?|lbs?|kg|ml|liters?|litres?|tons?)\.?(?![[:alnum:]]|[[:space:]]*/))',
    '\1', 'gi'),
    -- a size: number, optional space, unit word, not followed by a letter, a digit or a "/" (spaces allowed before it)
    '(^|[^[:alnum:].])([0-9]+(\.[0-9]+)?|\.[0-9]+)[[:space:]]?(fl[[:space:]]?oz|gallons?|gals?|gl|quarts?|qts?|pints?|pts?|oz|pounds?|lbs?|kg|ml|liters?|litres?|tons?)\.?(?![[:alnum:]]|[[:space:]]*/)',
    '\1', 'gi'),
    -- pack counts and container words
    '\m([0-9]+[[:space:]]?-?[[:space:]]?(pks?|packs?|ct|counts?)|jugs?|cases?|bulk|totes?|bags?|box|boxes)\M', '', 'gi'),
    -- brackets left empty
    '[(\[][^[:alnum:]]*[)\]]', ' ', 'g'),
    '[[:space:]]+', ' ', 'g'), ' -,/:;');
$function$;

-- What makes two parents one product, by name: the base name, lower case, without the suffixes approval itself
-- adds to keep names unique (" (EPA 600-1)", " (liquid)", " (no form)", then " #2"). Used by every
-- second-parent check, so a renamed-for-uniqueness parent is still recognized.
CREATE FUNCTION public._product_parent_identity_name(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT lower(btrim(regexp_replace(public._product_parent_base_name(p_name),
    '([[:space:]]*\((EPA [A-Z0-9-]+|liquid|dry|seed|each|no form)\))+([[:space:]]+#[0-9]+)?$', '', 'i')));
$function$;
ALTER FUNCTION public._product_parent_identity_name(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_identity_name(text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Every number in a size's name, by value with the word written right after it ("2 lb", "2 oz", "28"), in the
-- order written, less the size: the last number written with a unit word, removed only when it equals the recorded
-- container size and its unit word is the product's own unit (p_unit: "Gal", "Dry oz"; "2 gal" is a 2 Gal jug,
-- "2 lb" never is). Otherwise nothing is removed and the group is held, never merged. Sizes of one product differ only in that number, so two members whose
-- lists differ carry a strength or analysis the base name lost ("2 lb./gal 2.5 gal" vs "4 lb./gal 30 gal"),
-- however it is written. Order is kept so a strength and a pack count cannot trade places ("2 lb./gal 4 x 2 gal"
-- vs "4 lb./gal 2 x 4 gal"). A different pack count also holds the group: names group less, never wrongly.
CREATE FUNCTION public._product_name_strength_tokens(p_name text, p_size numeric, p_unit text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  WITH units(w, c) AS (VALUES ('gal', 'gal'), ('gals', 'gal'), ('gallon', 'gal'), ('gallons', 'gal'), ('gl', 'gal'),
      ('ga', 'gal'), ('qt', 'qt'), ('qts', 'qt'), ('quart', 'qt'), ('quarts', 'qt'), ('pt', 'pt'), ('pts', 'pt'),
      ('pint', 'pt'), ('pints', 'pt'), ('oz', 'oz'), ('fl', 'oz'), ('lb', 'lb'), ('lbs', 'lb'), ('pound', 'lb'),
      ('pounds', 'lb'), ('kg', 'kg'), ('ml', 'ml'), ('l', 'l'), ('liter', 'l'), ('liters', 'l'), ('litre', 'l'),
      ('litres', 'l'), ('ton', 'ton'), ('tons', 'ton')
  ), n AS (
    SELECT x.m[1]::numeric AS v, lower(x.m[2]) AS u, x.i
      FROM regexp_matches(COALESCE(p_name, ''), '([0-9]+(?:\.[0-9]+)?|\.[0-9]+)[[:space:]]?([[:alpha:]]*)', 'g')
           WITH ORDINALITY AS x(m, i)
  )
  SELECT COALESCE(array_agg(btrim(trim_scale(v)::text || ' ' || u) ORDER BY i), '{}')
    FROM n WHERE i IS DISTINCT FROM (
      SELECT l.i FROM (SELECT n.i, n.v, units.c FROM n JOIN units ON units.w = n.u ORDER BY n.i DESC LIMIT 1) l
       WHERE l.v = p_size
         AND l.c = (SELECT c FROM units WHERE w = lower(regexp_replace(btrim(p_unit), '^(dry|fl)[[:space:]]*', '', 'i'))));
$function$;
ALTER FUNCTION public._product_name_strength_tokens(text, numeric, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_name_strength_tokens(text, numeric, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- ---------------------------------------------------------------------------------------------
-- 2. Build a proposal
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.build_product_parent_proposal(p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'op', 'build_product_parent_proposal')::text);
  v_existing jsonb;
  v_proposal public.product_parent_proposals%ROWTYPE;
  v_g record;
  v_shape jsonb;
  v_flags jsonb;
  v_status text;
  v_basis text;
  v_reason text;
  v_name text;
  v_taken text[] := ARRAY(SELECT lower(name) FROM public.product_parents WHERE is_active);
  v_n integer;
  v_count integer := 0;
  v_held integer := 0;
  v_rejected integer := 0;
  v_numbers_differ boolean;
  v_epa_parent text;
  v_epa_same_name boolean;
  v_prior record;
  v_decided_by uuid;
  v_decided_at timestamptz;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'build_product_parent_proposal', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  -- One build at a time; a new build supersedes the open proposal.
  PERFORM pg_advisory_xact_lock(hashtext('crx.product_parent_proposal.build'));
  PERFORM 1 FROM public.product_parent_proposals WHERE status = 'open' FOR UPDATE;
  -- Hold the candidate sizes still, so each group's decision and its stored snapshot read the same values.
  PERFORM 1 FROM public.products p
   WHERE NOT EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = p.id)
   ORDER BY p.id FOR SHARE;
  UPDATE public.product_parent_proposals SET status = 'superseded' WHERE status = 'open';
  INSERT INTO public.product_parent_proposals (proposal_version, built_by)
  VALUES (COALESCE((SELECT max(proposal_version) FROM public.product_parent_proposals), 0) + 1, v_actor)
  RETURNING * INTO v_proposal;

  FOR v_g IN
    WITH c AS (
      SELECT p.id, p.product_form AS form, public._product_parent_base_name(p.product_name) AS base,
             public._normalize_epa_registration(p.epa_registration) AS epa,
             CASE WHEN p.product_form IN ('seed', 'each') THEN lower(btrim(COALESCE(p.inventory_unit, ''))) ELSE '' END AS unit_key
        FROM public.products p
       WHERE NOT EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = p.id)
    ), k AS (
      SELECT c.*, lower(c.base) || '|' || COALESCE(c.form, '') || '|' || c.unit_key AS gkey,
             public._product_parent_loose_key(c.base) || '|' || COALESCE(c.form, '') || '|' || c.unit_key AS lkey
        FROM c
    ), keys AS (
      SELECT gkey, count(DISTINCT epa) AS n_epa FROM k GROUP BY gkey
    ), grp AS (
      -- Several EPA numbers under one name: one group per number, the blanks on their own.
      SELECT k.gkey, k.lkey, k.form, keys.n_epa,
             CASE WHEN keys.n_epa >= 2 THEN COALESCE(k.epa, '') ELSE '' END AS sub,
             array_agg(k.id ORDER BY k.id) AS ids,
             (array_agg(k.base ORDER BY k.id))[1] AS base,
             max(k.epa) AS epa, bool_or(k.epa IS NULL) AS has_blank
        FROM k JOIN keys ON keys.gkey = k.gkey
       GROUP BY k.gkey, k.lkey, k.form, keys.n_epa, CASE WHEN keys.n_epa >= 2 THEN COALESCE(k.epa, '') ELSE '' END
    )
    SELECT grp.*,
           (SELECT count(DISTINCT g2.gkey) FROM grp g2 WHERE g2.lkey = grp.lkey) > 1 AS ambiguous,
           grp.epa IS NOT NULL AND EXISTS (SELECT 1 FROM grp g3 WHERE g3.epa = grp.epa AND g3.gkey <> grp.gkey) AS shared_epa
      FROM grp
     ORDER BY grp.gkey, grp.sub
  LOOP
    v_shape := public._product_parent_group_shape(v_g.ids);
    v_flags := v_shape->'flags';
    v_status := 'proposed';
    v_reason := NULL;
    v_decided_by := NULL;
    v_decided_at := NULL;
    v_basis := CASE WHEN v_g.epa IS NULL THEN 'owner_confirmed' ELSE 'epa_number' END;
    -- Sizes whose names carry different numbers besides their own container size: a strength or analysis.
    v_numbers_differ := (SELECT count(DISTINCT public._product_name_strength_tokens(p.product_name, p.container_size,
                                                 COALESCE(p.container_unit, p.inventory_unit)))
                           FROM public.products p WHERE p.id = ANY(v_g.ids)) > 1;
    -- An active parent already carries this EPA number (made by PAR-1, or approved from an earlier proposal).
    SELECT string_agg(pp.name, ', ' ORDER BY pp.name),
           bool_or(pp.product_form IS NOT DISTINCT FROM v_g.form
                   AND public._product_parent_identity_name(pp.name) = public._product_parent_identity_name(v_g.base))
      INTO v_epa_parent, v_epa_same_name
      FROM public.product_parents pp
     WHERE pp.is_active AND pp.generic_epa_registration IS NOT DISTINCT FROM v_g.epa
       -- No EPA number: only a parent with this form and name is the same product.
       AND (v_g.epa IS NOT NULL OR (pp.product_form IS NOT DISTINCT FROM v_g.form
            AND public._product_parent_identity_name(pp.name) = public._product_parent_identity_name(v_g.base)));
    IF v_g.shared_epa THEN v_flags := v_flags || '["same_epa_different_name"]'::jsonb; END IF;
    IF v_epa_parent IS NOT NULL THEN v_flags := v_flags || '["epa_has_parent"]'::jsonb; END IF;
    IF v_basis = 'owner_confirmed' THEN v_flags := v_flags || '["owner_confirmation_needed"]'::jsonb; END IF;
    IF v_g.form IS NULL THEN
      v_status := 'held'; v_reason := 'set the product form first';
      v_flags := v_flags || '["form_missing"]'::jsonb;
    ELSIF v_g.base = '' THEN
      v_status := 'held'; v_reason := 'the name is only a size; rename it first';
      v_flags := v_flags || '["name_missing"]'::jsonb;
    ELSIF v_g.has_blank AND (v_g.epa IS NOT NULL OR v_g.n_epa >= 1) THEN
      v_status := 'held'; v_reason := 'fill the missing EPA numbers first';
      v_flags := v_flags || '["fill_missing_epa"]'::jsonb;
    ELSIF v_g.epa IS NOT NULL AND (v_g.epa !~ '^[A-Z0-9-]+$' OR length(v_g.epa) > 40) THEN
      v_status := 'held'; v_reason := 'the EPA number is not in a readable form; correct it first';
      v_flags := v_flags || '["epa_unreadable"]'::jsonb;
    ELSIF v_g.ambiguous THEN
      v_status := 'held'; v_reason := 'names differ only by a strength or volume token such as "4L"; review by hand';
      v_flags := v_flags || '["ambiguous_strength_token"]'::jsonb;
    ELSIF v_numbers_differ THEN
      v_status := 'held'; v_reason := 'sizes in this group carry different numbers in their names besides their container size (a strength or analysis); review by hand';
      v_flags := v_flags || '["size_numbers_differ"]'::jsonb;
    ELSIF v_epa_same_name THEN
      v_status := 'held';
      v_reason := format('parent "%s" already has EPA number %s, this form and this name; a second parent is never made for one product', v_epa_parent, COALESCE(v_g.epa, 'none'));
    END IF;

    -- An earlier rejection of exactly these sizes: carried while none of them changed, otherwise noted.
    SELECT g.reason, g.decided_by, g.decided_at, g.group_fingerprint INTO v_prior
      FROM public.product_parent_proposal_groups g JOIN public.product_parent_proposals pp ON pp.id = g.proposal_id
     WHERE g.proposal_id <> v_proposal.id AND g.status = 'rejected'
       AND ARRAY(SELECT (m->>'product_id')::uuid FROM jsonb_array_elements(g.members) m ORDER BY 1) = v_g.ids
     ORDER BY pp.proposal_version DESC LIMIT 1;
    IF FOUND THEN
      v_flags := v_flags || '["rejected_before"]'::jsonb;
      IF v_status = 'proposed' AND v_prior.group_fingerprint = v_shape->>'fingerprint' THEN
        v_status := 'rejected'; v_reason := v_prior.reason;
        v_decided_by := v_prior.decided_by; v_decided_at := v_prior.decided_at;
        v_rejected := v_rejected + 1;
      ELSIF v_status = 'proposed' THEN
        v_reason := format('rejected on %s (%s); a size changed since, so it is proposed again',
          to_char(v_prior.decided_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD'), v_prior.reason);
      ELSE
        v_reason := format('%s; rejected on %s (%s)', v_reason,
          to_char(v_prior.decided_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD'), v_prior.reason);
      END IF;
    END IF;
    IF v_status = 'held' THEN v_basis := NULL; v_held := v_held + 1; v_decided_at := now(); END IF;

    -- Parent names are unique among active parents: add the EPA number or form when the base name is taken.
    v_name := CASE WHEN v_g.base = '' THEN '(no name)' ELSE v_g.base END;
    IF lower(v_name) = ANY(v_taken) THEN
      v_name := v_name || ' (' || COALESCE('EPA ' || v_g.epa, v_g.form, 'no form') || ')';
    END IF;
    IF lower(v_name) = ANY(v_taken) THEN
      v_name := v_name || ' (' || COALESCE(v_g.form, 'no form') || ')';
    END IF;
    -- Still taken (two groups share base, EPA and form): number it until it is free.
    v_n := 2;
    WHILE lower(v_name) = ANY(v_taken) LOOP
      v_name := regexp_replace(v_name, ' #[0-9]+$', '') || ' #' || v_n;
      v_n := v_n + 1;
    END LOOP;
    v_taken := v_taken || lower(v_name);

    INSERT INTO public.product_parent_proposal_groups (proposal_id, suggested_name, product_form, generic_epa_registration,
      identity_basis, members, conflicts, flags, group_fingerprint, status, reason, decided_by, decided_at)
    VALUES (v_proposal.id, v_name, v_g.form, v_g.epa, v_basis, v_shape->'members', v_shape->'conflicts', v_flags,
      v_shape->>'fingerprint', v_status, v_reason, v_decided_by, v_decided_at);
    v_count := v_count + 1;
  END LOOP;
  -- A build with nothing left to decide (no groups, or every one held or rejected) is closed, never left open.
  PERFORM public._close_product_parent_proposal_if_done(v_proposal.id);

  v_result := jsonb_build_object('proposal_id', v_proposal.id, 'proposal_version', v_proposal.proposal_version,
    'group_count', v_count, 'held_count', v_held, 'rejected_count', v_rejected,
    -- Active parents that already duplicate one another (made by hand, or by two admins at once): shown to fix.
    'duplicate_parents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('generic_epa_registration', d.epa, 'product_form', d.form, 'names', d.names)
                       ORDER BY d.epa, d.form)
        FROM (SELECT pp.generic_epa_registration AS epa, pp.product_form AS form,
                     jsonb_agg(pp.name ORDER BY pp.name) AS names
                FROM public.product_parents pp
               WHERE pp.is_active
               GROUP BY pp.generic_epa_registration, pp.product_form, public._product_parent_identity_name(pp.name)
              HAVING count(*) > 1) d), '[]'::jsonb));
  PERFORM public.save_idempotency(p_idempotency_key, 'build_product_parent_proposal',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 3. Approve
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_product_parent_groups(p_proposal_id uuid, p_proposal_version bigint, p_groups jsonb,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'proposal_id', p_proposal_id,
    'proposal_version', p_proposal_version, 'groups', p_groups)::text);
  v_existing jsonb;
  v_proposal public.product_parent_proposals%ROWTYPE;
  v_locked boolean;
  v_entry jsonb;
  v_done jsonb := '[]'::jsonb;
  v_result jsonb;
  v_clash record;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'approve_product_parent_groups', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF NOT public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_GROUPING_NOT_OPEN: grouping opens when the new product screens are live'
      USING ERRCODE = '55000';
  END IF;
  IF p_groups IS NULL OR jsonb_typeof(p_groups) <> 'array' OR jsonb_array_length(p_groups) = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_groups) e
                 WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'group_id') IS DISTINCT FROM 'string'
                    -- Canonical lower-case form only, so "each group once" compares the same ids the lookup casts.
                    OR e->>'group_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    OR jsonb_typeof(e->'name') IS DISTINCT FROM 'string'
                    OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k
                                WHERE k NOT IN ('group_id', 'group_fingerprint', 'name', 'choices', 'owner_confirmed',
                                                'size_roles', 'totes', 'brands', 'prices')))
     OR (SELECT count(DISTINCT e->>'group_id') FROM jsonb_array_elements(p_groups) e) <> jsonb_array_length(p_groups) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_APPROVAL_INVALID: send each group once with group_id, group_fingerprint, name, choices, owner_confirmed, size_roles, totes, brands and prices';
  END IF;

  SELECT * INTO v_proposal FROM public.product_parent_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND OR v_proposal.status <> 'open' OR v_proposal.proposal_version IS DISTINCT FROM p_proposal_version THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_PROPOSAL_STALE: this proposal is no longer the open one; reload it';
  END IF;
  -- Every member row of every group, in product-ID order, before anything is read or written: the brand writers
  -- take the same row locks, so no brand change can slip between the check and the move.
  PERFORM 1 FROM public.products p
   WHERE p.id IN (SELECT (m->>'product_id')::uuid FROM public.product_parent_proposal_groups g,
                         jsonb_array_elements(g.members) m
                   WHERE g.proposal_id = p_proposal_id
                     AND g.id IN (SELECT (e->>'group_id')::uuid FROM jsonb_array_elements(p_groups) e))
   ORDER BY p.id FOR UPDATE;
  SELECT is_locked INTO v_locked FROM public.product_rate_lock WHERE id FOR SHARE;
  FOR v_entry IN SELECT e FROM jsonb_array_elements(p_groups) e ORDER BY e->>'group_id' LOOP
    -- A parent with this EPA number (or none), form and base name, by the group's name or the submitted one, made
    -- since the build or earlier in this call: never a second parent for one product. (The group's stored members
    -- are re-checked against the locked rows before anything is written.)
    SELECT pp.name, g.generic_epa_registration AS epa INTO v_clash
      FROM public.product_parent_proposal_groups g
      JOIN public.product_parents pp ON pp.is_active AND pp.generic_epa_registration IS NOT DISTINCT FROM g.generic_epa_registration
     WHERE g.proposal_id = p_proposal_id AND g.id = (v_entry->>'group_id')::uuid
       AND pp.product_form IS NOT DISTINCT FROM g.product_form
       AND public._product_parent_identity_name(pp.name)
           IN (public._product_parent_identity_name(g.members->0->>'product_name'),
               public._product_parent_identity_name(v_entry->>'name'))
     ORDER BY pp.name LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_EPA_HAS_PARENT: parent "%" already has EPA number % and this name; build a new proposal',
        v_clash.name, COALESCE(v_clash.epa, 'none');
    END IF;
    v_done := v_done || public._approve_product_parent_group(v_proposal, v_entry, COALESCE(v_locked, true));
  END LOOP;
  PERFORM public._close_product_parent_proposal_if_done(p_proposal_id);

  v_result := jsonb_build_object('proposal_id', p_proposal_id, 'proposal_version', p_proposal_version, 'groups', v_done);
  PERFORM public.save_idempotency(p_idempotency_key, 'approve_product_parent_groups',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. Moving a size (PAR-1)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._product_size_move_refusal(p_product_id uuid, p_to_parent_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_member public.product_parent_members%ROWTYPE;
  v_to public.product_parents%ROWTYPE;
  v_size record;
BEGIN
  SELECT * INTO v_member FROM public.product_parent_members WHERE product_id = p_product_id;
  IF NOT FOUND THEN RETURN 'PRODUCT_PARENT_NOT_GROUPED: this size has no parent'; END IF;
  SELECT * INTO v_to FROM public.product_parents WHERE id = p_to_parent_id;
  IF NOT FOUND THEN RETURN 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  IF v_member.parent_id = p_to_parent_id THEN RETURN 'PRODUCT_PARENT_SAME: the size already belongs to this parent'; END IF;
  IF NOT v_to.is_active THEN RETURN format('PRODUCT_PARENT_INACTIVE: "%s" is inactive', v_to.name); END IF;
  SELECT p.product_form, p.epa_registration, p.rate_per_acre, p.rate_unit, p.suggested_rate, p.inventory_unit
    INTO v_size FROM public.products p WHERE p.id = p_product_id;
  IF v_size.product_form IS DISTINCT FROM v_to.product_form THEN
    RETURN format('PRODUCT_PARENT_FORM_MISMATCH: every size of "%s" is %s', v_to.name, v_to.product_form);
  END IF;
  IF public._normalize_epa_registration(v_size.epa_registration) IS DISTINCT FROM v_to.generic_epa_registration
     AND public._normalize_epa_registration(v_size.epa_registration) IS NOT NULL THEN
    RETURN format('PRODUCT_PARENT_EPA_MISMATCH: "%s" has %s', v_to.name,
      COALESCE('EPA number ' || v_to.generic_epa_registration, 'no EPA number; set it on the parent first'));
  END IF;
  IF public._product_parent_unit_refusal(v_to, v_size.inventory_unit, p_product_id) IS NOT NULL THEN
    RETURN public._product_parent_unit_refusal(v_to, v_size.inventory_unit, p_product_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_parent_members t WHERE t.fill_source_product_id = p_product_id) THEN
    RETURN 'PRODUCT_PARENT_FILL_SOURCE_IN_USE: a tote is filled from this bulk size; change the tote''s fill source first';
  END IF;
  IF v_member.fill_source_product_id IS NOT NULL THEN
    RETURN 'PRODUCT_PARENT_FILL_SOURCE_STAYS: this tote is filled from its parent''s bulk size; clear its fill source first';
  END IF;
  IF v_member.size_role = 'bulk' AND EXISTS (SELECT 1 FROM public.product_parent_members b
                                              WHERE b.parent_id = p_to_parent_id AND b.size_role = 'bulk') THEN
    RETURN format('PRODUCT_PARENT_ONE_BULK: "%s" already has a bulk size', v_to.name);
  END IF;
  IF COALESCE((SELECT is_locked FROM public.product_rate_lock WHERE id), true)
     AND (v_size.rate_per_acre IS DISTINCT FROM v_to.rate_per_acre
          OR NULLIF(btrim(v_size.suggested_rate), '') IS DISTINCT FROM v_to.suggested_rate
          OR (v_size.product_form NOT IN ('seed', 'each') AND NULLIF(v_size.rate_unit, '') IS DISTINCT FROM v_to.rate_unit)) THEN
    RETURN 'PRODUCT_RATES_LOCKED: the move would change this size''s live rate; correct its rate to match the parent first, or unlock rates';
  END IF;
  -- A grouped size's brands are its parent's list, so a move must not change them silently.
  IF (SELECT COALESCE(jsonb_agg(jsonb_build_array(b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced,
                b.is_rup, b.signal_word) ORDER BY lower(b.brand_name), b.brand_name), '[]'::jsonb)
        FROM public.product_parent_brands b WHERE b.parent_id = v_member.parent_id AND b.status = 'active')
     IS DISTINCT FROM
     (SELECT COALESCE(jsonb_agg(jsonb_build_array(b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced,
                b.is_rup, b.signal_word) ORDER BY lower(b.brand_name), b.brand_name), '[]'::jsonb)
        FROM public.product_parent_brands b WHERE b.parent_id = p_to_parent_id AND b.status = 'active') THEN
    RETURN format('PRODUCT_PARENT_BRANDS_DIFFER: "%s" and "%s" list different brands; make their brand lists match before moving a size',
      (SELECT name FROM public.product_parents WHERE id = v_member.parent_id), v_to.name);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.move_product_size(p_product_id uuid, p_to_parent_id uuid, p_expected_from_version bigint,
  p_expected_to_version bigint, p_expected_size_fingerprint text, p_reason text, p_evidence text,
  p_expected_prices jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_receipt jsonb;
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'product_id', p_product_id, 'to_parent_id', p_to_parent_id,
    'from_version', p_expected_from_version, 'to_version', p_expected_to_version,
    'size_fingerprint', p_expected_size_fingerprint, 'reason', btrim(p_reason), 'evidence', btrim(p_evidence),
    'expected_prices', p_expected_prices)::text);
  v_tier text;
  v_existing jsonb;
  v_reason text;
  v_evidence text;
  v_from uuid;
  v_refusal text;
  v_event bigint;
  v_copy jsonb;
  v_to_version bigint;
  v_from_left integer;
  v_brand public.product_parent_brands%ROWTYPE;
  v_retired public.product_parent_brands%ROWTYPE;
  v_retired_count integer := 0;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'move_product_size', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', true);
  v_evidence := public._product_parent_reason(p_evidence, 'evidence', true);
  IF p_expected_prices IS NULL OR jsonb_typeof(p_expected_prices) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_INVALID: send the preview''s prices';
  END IF;
  SELECT parent_id INTO v_from FROM public.product_parent_members WHERE product_id = p_product_id;
  IF v_from IS NULL THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_GROUPED: this size has no parent'; END IF;
  -- Both parents in ID order, then the size. (upsert_parent_brand takes its parent FOR SHARE first, so no brand
  -- edit on either parent can slip between the brand-list check below and the move.) The check reads after the
  -- locks, so it needs a fresh snapshot per statement: a whole-transaction snapshot is refused.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_READ_COMMITTED_REQUIRED: parents are written only in READ COMMITTED transactions'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM public.product_parents WHERE id IN (v_from, p_to_parent_id) ORDER BY id FOR UPDATE;
  IF (SELECT parent_version FROM public.product_parents WHERE id = v_from) IS DISTINCT FROM p_expected_from_version
     OR (SELECT parent_version FROM public.product_parents WHERE id = p_to_parent_id) IS DISTINCT FROM p_expected_to_version
     OR (SELECT parent_id FROM public.product_parent_members WHERE product_id = p_product_id) IS DISTINCT FROM v_from THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_STALE: a parent changed since the preview; preview again';
  END IF;
  PERFORM 1 FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF public._product_size_fingerprint(p_product_id) IS DISTINCT FROM p_expected_size_fingerprint THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_SIZE_STALE: the size changed since the preview; preview again';
  END IF;
  v_refusal := public._product_size_move_refusal(p_product_id, p_to_parent_id);
  IF v_refusal IS NOT NULL THEN RAISE EXCEPTION '%', v_refusal; END IF;

  UPDATE public.product_parent_members SET parent_id = p_to_parent_id, updated_at = now() WHERE product_id = p_product_id;
  UPDATE public.product_parents SET parent_version = parent_version + 1, updated_by = v_actor, updated_at = now()
   WHERE id IN (v_from, p_to_parent_id);
  SELECT count(*) INTO v_from_left FROM public.product_parent_members WHERE parent_id = v_from;
  -- A parent left with no sizes is kept, inactive, and its brands are retired (each logged), so no brand stays
  -- active on a parent no size reads.
  IF v_from_left = 0 THEN
    UPDATE public.product_parents SET is_active = false WHERE id = v_from;
    FOR v_brand IN SELECT * FROM public.product_parent_brands WHERE parent_id = v_from AND status = 'active'
                    ORDER BY id FOR UPDATE LOOP
      -- updated_at is set by the table's trigger set_product_parent_brands_updated_at.
      UPDATE public.product_parent_brands SET status = 'retired', row_version = row_version + 1, updated_by = v_actor
       WHERE id = v_brand.id RETURNING * INTO v_retired;
      PERFORM public._parent_brand_event(v_brand.id, v_from, 'retired',
        'the parent has no sizes left after its last size moved: ' || v_reason, to_jsonb(v_brand), to_jsonb(v_retired));
      v_retired_count := v_retired_count + 1;
    END LOOP;
  END IF;
  v_event := public._next_product_parent_event_id();
  -- The refusal above leaves a size with no EPA number or one whose normalized number is the parent's; either way
  -- it stores the parent's normalized spelling, as an added size does.
  v_copy := public._copy_parent_to_size(p_to_parent_id, p_product_id, v_event, true, false,
    (SELECT pp.generic_epa_registration IS NOT NULL FROM public.product_parents pp WHERE pp.id = p_to_parent_id));
  -- A unit conversion changed since the preview moves the prices but no version or fingerprint.
  FOREACH v_tier IN ARRAY ARRAY['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'] LOOP
    IF NOT (p_expected_prices ? v_tier) OR (v_copy->'after'->v_tier) IS DISTINCT FROM (p_expected_prices->v_tier) THEN
      RAISE EXCEPTION 'PRODUCT_RATE_PREVIEW_CHANGED: the per-acre prices changed since the preview; preview again: %',
        v_copy->'after'->>'product_name' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  PERFORM public._product_parent_event(v_event, p_to_parent_id, 'size_moved', v_reason, v_evidence,
    jsonb_build_object('from_parent_id', v_from), jsonb_build_object('to_parent_id', p_to_parent_id), jsonb_build_array(v_copy));
  -- The old parent's log records the move too.
  PERFORM public._product_parent_event(NULL, v_from, 'size_moved', v_reason, v_evidence,
    jsonb_build_object('from_parent_id', v_from, 'product_id', p_product_id, 'is_active', true),
    jsonb_build_object('to_parent_id', p_to_parent_id, 'is_active', v_from_left > 0),
    jsonb_build_array(v_copy));
  SELECT parent_version INTO v_to_version FROM public.product_parents WHERE id = p_to_parent_id;
  v_receipt := jsonb_build_object('product_id', p_product_id, 'from_parent_id', v_from, 'to_parent_id', p_to_parent_id,
      'to_parent_version', v_to_version, 'from_parent_inactive', v_from_left = 0,
      'from_parent_brands_retired', v_retired_count, 'event_id', v_event, 'size', v_copy);
  PERFORM public.save_idempotency(p_idempotency_key, 'move_product_size',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_receipt));
  RETURN v_receipt;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------

DO $postflight$
DECLARE
  v_sig text;
  v_pair text[];
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.build_product_parent_proposal(text)',
    'public.approve_product_parent_groups(uuid,bigint,jsonb,text)',
    'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)'] LOOP
    IF (SELECT array_agg(DISTINCT grantee::regrole::text ORDER BY grantee::regrole::text)
          FROM pg_proc p, aclexplode(p.proacl) WHERE p.oid = v_sig::regprocedure AND privilege_type = 'EXECUTE')
       IS DISTINCT FROM ARRAY['authenticated', 'postgres']
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_sig::regprocedure)
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_sig::regprocedure) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR (SELECT proowner FROM pg_proc WHERE oid = v_sig::regprocedure) <> 'postgres'::regrole THEN
      RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_FUNCTION: %', v_sig;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY['public._product_parent_base_name(text)', 'public._product_size_move_refusal(uuid,uuid)',
                               'public._product_parent_identity_name(text)', 'public._product_name_strength_tokens(text,numeric,text)'] LOOP
    IF (SELECT array_agg(DISTINCT grantee::regrole::text ORDER BY grantee::regrole::text)
          FROM pg_proc p, aclexplode(p.proacl) WHERE p.oid = v_sig::regprocedure AND privilege_type = 'EXECUTE')
       IS DISTINCT FROM ARRAY['postgres']
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_sig::regprocedure) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR (SELECT proowner FROM pg_proc WHERE oid = v_sig::regprocedure) <> 'postgres'::regrole THEN
      RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_HELPER: %', v_sig;
    END IF;
  END LOOP;
  -- Taha's pairs never share a base name; a plain size still comes off.
  FOREACH v_pair SLICE 1 IN ARRAY ARRAY[['UAN 28/0/0 Tote', 'UAN 32/0/0 Tote'], ['Imidacloprid 2 lb/gal', 'Imidacloprid 4 lb/gal'],
                                         ['Talstar 2 G', 'Talstar 0.2 G'], ['Starter 6/24/6', 'Starter 3/24/6']] LOOP
    IF lower(public._product_parent_base_name(v_pair[1])) = lower(public._product_parent_base_name(v_pair[2])) THEN
      RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_BASE_NAME: % / %', v_pair[1], v_pair[2];
    END IF;
  END LOOP;
  IF public._product_parent_identity_name('Base (EPA 600-1) (liquid) #2') <> public._product_parent_identity_name('Base 2.5 gal') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_IDENTITY_NAME: approval''s name suffixes are not ignored';
  END IF;
  -- Numbers other than the size's own container size are compared by value, so 1 and 1.0 match; only a number
  -- written with the product's own unit is taken as its size.
  IF public._product_name_strength_tokens('Imidacloprid 2 lb/gal 2.5 gal', 2.5, 'Gal') <> ARRAY['2 lb']
     OR public._product_name_strength_tokens('Rho 1.0 gal', 1, 'Gal') <> '{}'::text[]
     OR public._product_name_strength_tokens('Imida 2 lb ai/gal', 2, 'Gal') <> ARRAY['2 lb']
     OR public._product_name_strength_tokens('Blend 2 gal concentrate per 10 gal', 2, 'Gal')
        = public._product_name_strength_tokens('Blend 4 gal concentrate per 10 gal', 4, 'Gal')
     OR public._product_name_strength_tokens('Mix 2 lb./gal 4 x 2 gal', 2, 'Gal')
        = public._product_name_strength_tokens('Mix 4 lb./gal 2 x 4 gal', 4, 'Gal')
     OR public._product_name_strength_tokens('Lam 2 lb ai/gal 2.5 gal', 2.5, 'Gal')
        = public._product_name_strength_tokens('Lam 2 oz ai/gal 2.5 gal', 2.5, 'Gal') THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_STRENGTH: name numbers are not compared by value';
  END IF;
  IF public._product_parent_base_name('Rho 2 x 2.5 gal') <> 'Rho' THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_BASE_NAME: sizes no longer removed';
  END IF;
  IF public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_REVIEW_FIXES_SWITCH_ON: grouping stays off until the screens PR';
  END IF;
END;
$postflight$;
