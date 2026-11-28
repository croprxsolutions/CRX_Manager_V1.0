-- idempotency-body-check: exempt
-- (data-only: no function, policy or schema change, so there is no RPC to carry an idempotency key)
-- ============================================================================================================
-- MOA-1 group load top-up (build sheet docs/plans/2026-11-12-product-MOA1-BUILD-SHEET.md, section 3.6).
--
-- 20270205150000_ingredient_modes_of_action_load carries the list Mason approved on 2026-11-18. The live EPA batch
-- fill (2026-11-21) then added 12 ingredients that list does not name. This writes their groups: the 12 rows below,
-- which Mason approved on 2026-11-24 ("Yes, approve the 12"). Every CAS is the live ingredient's own.
-- A read-only dry run on live (2026-11-24, 145 active ingredients) matched all 12 by CAS, with no conflict.
--
-- The rules and SQL are the reviewed load's, unchanged except: its own temp table names (moa1t_*, so the load's
-- #2193 prerequisite guard, keyed on moa1_list with its 123 rows, does not mistake this file for the load), the row
-- count (12), the approval date and the refusal prefixes (MOA_TOPUP_*). In short:
-- * Match: the CAS decides whenever both sides carry one; the name (name_key) counts only when one side has no CAS
--   and exactly one active ingredient has that name.
-- * Skipped and reported, never guessed: an ingredient the list would give two groups, one whose name is listed
--   while its CAS says another chemical, and an acid with a linked form whose list an admin emptied.
-- * Never touched: a retired ingredient; one that has or ever had a group row; a salt or ester whose linked acid
--   already has groups or gets them here.
-- * One 'updated' event per filled ingredient (before [], after the new list), attributed to Mason, who approved
--   the list. A second run finds every matched ingredient filled and writes nothing.
-- * Runs after the main load (stamp order). No row here shares a CAS or name with its list. Run first, it would
--   fill a salt here whose linked acid only the main load fills, so both would carry the same code (no live
--   ingredient has an acid link today, 2026-11-24).
-- * Locks: only the ingredient-list advisory lock every ingredient, chemistry and group writer takes first.
-- Reports (NOTICE): rows written, ingredients filled, kept, skipped, list rows matching no ingredient, and
-- active ingredients showing no group.
--
-- Rollback: retire the rows this wrote that nobody has touched since: source_note ending 'MOA-1 top-up list,
-- approved by Mason 2026-11-24', created_by = the approver ID below and row_version = 1, through
-- set_active_ingredient_modes per ingredient, or one reviewed migration; events stay. Nothing else is written.
-- ORDERING: after 20270108100000_ingredient_modes_of_action and every older migration.
-- ============================================================================================================

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.active_ingredient_modes_of_action') IS NULL OR to_regclass('public.active_ingredients') IS NULL
     OR to_regclass('public.active_ingredient_events') IS NULL OR to_regclass('public.product_parent_ingredients') IS NULL
     OR to_regprocedure('public._ingredient_mode_list(uuid)') IS NULL THEN
    RAISE EXCEPTION 'MOA_TOPUP_PREFLIGHT: MOA-1 part 1 (20270108100000) is not applied';
  END IF;
END
$preflight$;

DO $load$
DECLARE
  -- Mason's admin profile; he approved this list (2026-11-24). Records who approved it, not a permission check.
  v_actor constant uuid := '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';
  v_reason constant text := 'MOA-1 group load top-up: published HRAC/IRAC lists, approved by Mason 2026-11-24';
  v_rows int;
  v_filled int;
  v_kept int;
  v_skipped text;
  v_unmatched text;
  v_without int;
BEGIN
  -- The actor columns carry no foreign key (20270108100000, 20261209100000), so a database without this profile
  -- (staging, a rebuild) still records the approver's ID. Where the ID exists it must be an admin, never someone else.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND role IS DISTINCT FROM 'admin') THEN
    RAISE EXCEPTION 'MOA_TOPUP_ACTOR: profile % is not an admin here; this top-up list was approved by Mason', v_actor;
  END IF;

  -- Every ingredient, chemistry and group writer takes this lock first: nothing changes under the load.
  PERFORM pg_advisory_xact_lock(hashtext('crx.active_ingredients'));

  CREATE TEMP TABLE moa1t_list (name text NOT NULL, cas text, scheme text NOT NULL, group_code text NOT NULL,
                               source_note text NOT NULL) ON COMMIT DROP;
  INSERT INTO moa1t_list (name, cas, scheme, group_code, source_note) VALUES
    ('2,4-D, 2-ethylhexyl ester', '1928-43-4', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of 2,4-D; same mode of action as 2,4-D. MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Chlorpyrifos', '2921-88-2', 'IRAC', '1B', 'IRAC 1B: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Dicamba, dimethylamine salt', '2300-66-5', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Dicamba; same mode of action as Dicamba. MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Glyphosate, potassium salt', '70901-12-1', 'HRAC', '9', 'HRAC 9: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Glyphosate; same mode of action as Glyphosate. MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Halosulfuron-methyl', '100784-20-1', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Imazamox', '114311-32-9', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Imazethapyr, ammonium salt', '101917-66-2', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Imazethapyr; same mode of action as Imazethapyr. MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('MCPP-P, DMA salt', '66423-09-4', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Mecoprop-P; same mode of action as Mecoprop-P. MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Metolachlor', '51218-45-2', 'HRAC', '15', 'HRAC 15: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Paraquat dichloride', '1910-42-5', 'HRAC', '22', 'HRAC 22: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Paraquat; same mode of action as Paraquat. MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Sodium acifluorfen', '62476-59-9', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Acifluorfen; same mode of action as Acifluorfen. MOA-1 top-up list, approved by Mason 2026-11-24'),
    ('Trifluralin', '1582-09-8', 'HRAC', '3', 'HRAC 3: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 top-up list, approved by Mason 2026-11-24');

  IF (SELECT count(*) FROM moa1t_list) <> 12 THEN
    RAISE EXCEPTION 'MOA_TOPUP_LIST: expected 12 group rows, found %', (SELECT count(*) FROM moa1t_list);
  END IF;

  -- Active ingredients with their name key and whether that name is unique among active ingredients.
  CREATE TEMP TABLE moa1t_ing ON COMMIT DROP AS
  SELECT a.id, a.name, a.name_key, NULLIF(btrim(a.cas), '') AS cas, a.canonical_ingredient_id,
         count(*) OVER (PARTITION BY a.name_key) = 1 AS name_unique
    FROM public.active_ingredients a WHERE a.status = 'active';

  CREATE TEMP TABLE moa1t_match ON COMMIT DROP AS
  SELECT DISTINCT i.id AS ingredient_id, l.name AS list_name, l.scheme, l.group_code, l.source_note
    FROM moa1t_list l
    JOIN moa1t_ing i
      ON (l.cas IS NOT NULL AND i.cas = l.cas)
      OR (i.name_key = lower(regexp_replace(btrim(l.name), '\s+', ' ', 'g'))
          AND (l.cas IS NULL OR i.cas IS NULL) AND i.name_unique);

  CREATE TEMP TABLE moa1t_conflict ON COMMIT DROP AS
  SELECT ingredient_id FROM moa1t_match GROUP BY ingredient_id HAVING count(DISTINCT scheme || ' ' || group_code) > 1
  UNION
  SELECT i.id FROM moa1t_list l
    JOIN moa1t_ing i ON i.name_key = lower(regexp_replace(btrim(l.name), '\s+', ' ', 'g'))
   WHERE l.cas IS NOT NULL AND i.cas IS NOT NULL AND i.cas <> l.cas
  UNION
  SELECT f.canonical_ingredient_id FROM moa1t_ing f
   WHERE f.canonical_ingredient_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o WHERE o.ingredient_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o
                      WHERE o.ingredient_id = f.id AND o.status = 'active');

  -- Matched, not skipped, never had a group row.
  CREATE TEMP TABLE moa1t_candidate ON COMMIT DROP AS
  SELECT DISTINCT m.ingredient_id FROM moa1t_match m
   WHERE m.ingredient_id NOT IN (SELECT ingredient_id FROM moa1t_conflict)
     AND NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o WHERE o.ingredient_id = m.ingredient_id);
  -- Less a form whose linked acid has groups, or gets them now: it shows the acid's and gets no copy of its own.
  CREATE TEMP TABLE moa1t_fill ON COMMIT DROP AS
  SELECT c.ingredient_id FROM moa1t_candidate c JOIN moa1t_ing i ON i.id = c.ingredient_id
   WHERE i.canonical_ingredient_id IS NULL
      OR (i.canonical_ingredient_id NOT IN (SELECT ingredient_id FROM moa1t_candidate)
          AND NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o
                           WHERE o.ingredient_id = i.canonical_ingredient_id AND o.status = 'active'));

  -- One row per ingredient, scheme and code. When two list rows agree (cyfluthrin and beta-cyfluthrin share a
  -- CAS), the note of the row named like the ingredient wins, else the first by name.
  INSERT INTO public.active_ingredient_modes_of_action (ingredient_id, scheme, group_code, source_note, created_by, updated_by)
  SELECT DISTINCT ON (m.ingredient_id, m.scheme, m.group_code)
         m.ingredient_id, m.scheme, m.group_code, m.source_note, v_actor, v_actor
    FROM moa1t_match m
    JOIN moa1t_ing i ON i.id = m.ingredient_id
   WHERE m.ingredient_id IN (SELECT ingredient_id FROM moa1t_fill)
   ORDER BY m.ingredient_id, m.scheme, m.group_code,
            (i.name_key = lower(regexp_replace(btrim(m.list_name), '\s+', ' ', 'g'))) DESC, m.list_name;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.active_ingredient_events (ingredient_id, event_type, reason, evidence, before_values, after_values, changed_by)
  SELECT f.ingredient_id, 'updated', v_reason, NULL, jsonb_build_object('modes_of_action', '[]'::jsonb),
         jsonb_build_object('modes_of_action', public._ingredient_mode_list(f.ingredient_id)), v_actor
    FROM moa1t_fill f;
  GET DIAGNOSTICS v_filled = ROW_COUNT;

  -- Postcondition: every filled ingredient holds exactly the codes the list gives it, and nothing else.
  IF EXISTS (SELECT 1 FROM moa1t_fill f
              WHERE (SELECT array_agg(DISTINCT m.scheme || ' ' || m.group_code ORDER BY m.scheme || ' ' || m.group_code)
                       FROM moa1t_match m WHERE m.ingredient_id = f.ingredient_id)
                    IS DISTINCT FROM
                    (SELECT array_agg(o.scheme || ' ' || o.group_code ORDER BY o.scheme || ' ' || o.group_code)
                       FROM public.active_ingredient_modes_of_action o
                      WHERE o.ingredient_id = f.ingredient_id AND o.status = 'active')) THEN
    RAISE EXCEPTION 'MOA_TOPUP_POSTCONDITION: a filled ingredient does not hold exactly its listed groups';
  END IF;

  SELECT count(DISTINCT m.ingredient_id) INTO v_kept FROM moa1t_match m
   WHERE m.ingredient_id NOT IN (SELECT ingredient_id FROM moa1t_fill)
     AND m.ingredient_id NOT IN (SELECT ingredient_id FROM moa1t_conflict);
  SELECT string_agg(DISTINCT i.name, '; ') INTO v_skipped
    FROM moa1t_conflict c JOIN moa1t_ing i ON i.id = c.ingredient_id;
  SELECT string_agg(l.name, '; ' ORDER BY l.name) INTO v_unmatched
    FROM moa1t_list l WHERE NOT EXISTS (SELECT 1 FROM moa1t_match m WHERE m.list_name = l.name);
  SELECT count(*) INTO v_without FROM moa1t_ing i
   WHERE NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o
                      WHERE o.status = 'active' AND (o.ingredient_id = i.id OR o.ingredient_id = i.canonical_ingredient_id));

  RAISE NOTICE 'MOA_TOPUP: % group rows written on % ingredients; % matched ingredients kept as they were', v_rows, v_filled, v_kept;
  RAISE NOTICE 'MOA_TOPUP: skipped (list disagrees, CAS says another chemical, or a linked form was emptied): %', COALESCE(v_skipped, 'none');
  RAISE NOTICE 'MOA_TOPUP: list rows matching no active ingredient: %', COALESCE(v_unmatched, 'none');
  RAISE NOTICE 'MOA_TOPUP: active ingredients showing no group: %', v_without;
END
$load$;
