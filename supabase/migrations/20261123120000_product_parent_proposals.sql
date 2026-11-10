-- idempotency-body-check: exempt
-- (Every new writer checks its retry key through PAR-1's _product_parent_replay, which calls check_idempotency
--  and refuses a different caller or request, and saves its receipt with save_idempotency last, in the same
--  transaction. The re-issued upsert_product_brand keeps its own intent-bound check_idempotency_intent sequence.)
--
-- PAR-2 (Stage 2 build sheet §5.1): group existing products into parents, only through an approved proposal.
--
-- New tables (RLS on, no write grant for any role; writes only through the functions below):
--   * product_parent_proposals: one row per build; proposal_version counts builds; one 'open' at a time
--     (a new build supersedes it). Admin reads.
--   * product_parent_proposal_groups: one proposed group per row: suggested name, form, EPA number, identity basis
--     (epa_number or owner_confirmed), members (allow-listed fields only: no cost, price or stock), conflicts,
--     flags, group_fingerprint (md5 of the members, brands included), status (proposed, approved, rejected,
--     held) and the decision. Admin reads.
--   * product_parent_brands: a parent's brand list (active or retired; retired is final), with the legacy
--     product_brands IDs each one replaced. Partial unique index on (parent_id, lower(brand_name)) WHERE active.
--     Active-user reads.
--   * product_parent_brand_events: append-only log of every parent-brand change. Active-user reads.
--   * product_parent_brand_sources: maps every moved legacy brand row to exactly one parent brand, with its last
--     version. Active-user reads.
-- New functions (SECURITY DEFINER, search_path public, pg_temp; writers admin-only with a retry key, authorized
-- before the replay lookup):
--   build_product_parent_proposal, approve_product_parent_groups, hold_product_parent_group,
--   reject_product_parent_group, upsert_parent_brand, get_product_brands (any active user).
-- Re-issued: upsert_product_brand takes the product-row lock approval takes, then, once the switch is on, refuses
--   a grouped size with PRODUCT_BRANDS_BELONG_TO_PARENT (nothing written). Ungrouped sizes behave exactly as before.
-- Grouping rules: build sheet §5.1. Grouped only when the base name (size, pack and container words removed),
-- form and, for seed or each, stock unit match, and no two members carry different EPA numbers. A strength token
-- like "4L" or "4G" is never removed; names that differ only by one are held. Same EPA number under different base names
-- is a flag, never a merge. Some members with the EPA number and some blank: held until the blanks are filled.
-- Approval copies the chosen category, use timings and rates onto every member through PAR-1's
-- _copy_parent_to_size (under a pass; one 'created' parent event per group). It never writes EPA numbers or label
-- facts. While rates are locked, a group that would change a member's rate is refused whole.
-- The grouping switch (_product_parent_grouping_open) ships OFF: until the PAR-2 screens that read
-- get_product_brands are live, approval and parent-brand edits are refused with PRODUCT_PARENT_GROUPING_NOT_OPEN,
-- every size's brands stay its own list (read and written exactly as before, grouped by PAR-1 or not), and
-- building, holding and rejecting proposals change no product. The screens PR's migration turns it on.
-- No existing row, grant or policy changes. No group is approved by this migration; live data steps are Mason's.
--
-- Rollback (a reviewed migration; the proof runs exactly this block, then re-issues upsert_product_brand from
-- 20261022086500_product_brands.sql). Every active parent brand is projected onto every member size's legacy list;
-- a legacy row that would block it (same name, mapped to a retired variant) is archived whole first, and renamed
-- aside when the size keeps its own mapped row (an active brand renamed after the move). Any other mapped row on a
-- grouped size (a retired brand, or a brand of a parent the size has since moved away from) is archived whole and
-- marked not currently sourced, so the size shows as current exactly the brands it showed before the rollback.
-- Ungrouped sizes are untouched. The new tables stay as history.
-- ROLLBACK-SQL-BEGIN
-- CREATE TABLE public.product_brand_rollback_archive (
--   id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
--   legacy_brand_id uuid NOT NULL REFERENCES public.product_brands(id) ON DELETE RESTRICT,
--   legacy_row jsonb NOT NULL,
--   parent_brand_id uuid REFERENCES public.product_parent_brands(id) ON DELETE RESTRICT,
--   replaced_by_parent_brand_id uuid REFERENCES public.product_parent_brands(id) ON DELETE RESTRICT,
--   reason text NOT NULL,
--   archived_at timestamptz NOT NULL DEFAULT now()
-- );
-- ALTER TABLE public.product_brand_rollback_archive OWNER TO postgres;
-- ALTER TABLE public.product_brand_rollback_archive ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY product_brand_rollback_archive_select ON public.product_brand_rollback_archive
--   FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
-- REVOKE ALL ON TABLE public.product_brand_rollback_archive FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
-- REVOKE ALL ON SEQUENCE public.product_brand_rollback_archive_id_seq FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
-- GRANT SELECT ON TABLE public.product_brand_rollback_archive TO authenticated;
-- DO $rollback$
-- DECLARE
--   r record;
--   v_legacy public.product_brands%ROWTYPE;
--   v_block public.product_brands%ROWTYPE;
--   v_archive_id bigint;
--   v_claimed uuid;
-- BEGIN
--   CREATE TEMP TABLE rollback_claimed (id uuid PRIMARY KEY) ON COMMIT DROP;
--   -- Mapped rows of active brands step aside first, so renamed or swapped names cannot collide mid-way.
--   CREATE TEMP TABLE rollback_brand_names ON COMMIT DROP AS
--     SELECT b.id, b.brand_name FROM public.product_brands b
--       JOIN public.product_parent_brand_sources s ON s.legacy_brand_id = b.id
--       JOIN public.product_parent_brands pb ON pb.id = s.parent_brand_id AND pb.status = 'active'
--       JOIN public.product_parent_members m ON m.parent_id = pb.parent_id AND m.product_id = b.product_id;
--   UPDATE public.product_brands b SET brand_name = '~rollback ' || b.id::text
--     FROM public.product_parent_brand_sources s
--     JOIN public.product_parent_brands pb ON pb.id = s.parent_brand_id AND pb.status = 'active'
--     JOIN public.product_parent_members m ON m.parent_id = pb.parent_id
--    WHERE s.legacy_brand_id = b.id AND b.product_id = m.product_id;
--   FOR r IN SELECT pb.*, m.product_id AS size_id FROM public.product_parent_brands pb
--              JOIN public.product_parent_members m ON m.parent_id = pb.parent_id
--             WHERE pb.status = 'active' ORDER BY pb.id, m.product_id LOOP
--     SELECT b.* INTO v_legacy FROM public.product_brands b JOIN public.product_parent_brand_sources s ON s.legacy_brand_id = b.id
--      WHERE s.parent_brand_id = r.id AND b.product_id = r.size_id;
--     IF NOT FOUND THEN
--       SELECT b.* INTO v_legacy FROM public.product_brands b
--        WHERE b.product_id = r.size_id AND lower(b.brand_name) = lower(r.brand_name);
--       -- A same-name row on this size (e.g. a retired variant) is archived whole, then becomes this brand's row:
--       -- v_legacy now holds it, so the step below overwrites it in place and never inserts a second same-name row.
--       IF FOUND THEN
--         INSERT INTO public.product_brand_rollback_archive (legacy_brand_id, legacy_row, parent_brand_id, replaced_by_parent_brand_id, reason)
--         VALUES (v_legacy.id, to_jsonb(v_legacy), (SELECT s.parent_brand_id FROM public.product_parent_brand_sources s WHERE s.legacy_brand_id = v_legacy.id),
--                 r.id, 'same name as the parent''s active brand; replaced by it at rollback');
--       END IF;
--     ELSE
--       -- The size keeps its own mapped row; another row there with the target name is archived and renamed aside.
--       SELECT b.* INTO v_block FROM public.product_brands b
--        WHERE b.product_id = r.size_id AND lower(b.brand_name) = lower(r.brand_name) AND b.id <> v_legacy.id;
--       IF FOUND THEN
--         INSERT INTO public.product_brand_rollback_archive (legacy_brand_id, legacy_row, parent_brand_id, replaced_by_parent_brand_id, reason)
--         VALUES (v_block.id, to_jsonb(v_block), (SELECT s.parent_brand_id FROM public.product_parent_brand_sources s WHERE s.legacy_brand_id = v_block.id),
--                 r.id, 'same name as a renamed active brand; renamed aside at rollback')
--         RETURNING id INTO v_archive_id;
--         -- Bounded to the 200-character limit; the archive row keeps the full original name.
--         UPDATE public.product_brands SET brand_name = left(v_block.brand_name, 200 - char_length(' (archived ' || v_archive_id || ')'))
--                                                   || ' (archived ' || v_archive_id || ')',
--           row_version = row_version + 1
--         WHERE id = v_block.id;
--       END IF;
--     END IF;
--     IF v_legacy.id IS NOT NULL AND v_legacy.product_id = r.size_id THEN
--       UPDATE public.product_brands SET brand_name = r.brand_name, epa_registration = r.epa_registration,
--         manufacturer = r.manufacturer, is_currently_sourced = r.is_currently_sourced, is_rup = r.is_rup,
--         signal_word = r.signal_word, row_version = row_version + 1, updated_by = r.updated_by
--       WHERE id = v_legacy.id;
--       v_claimed := v_legacy.id;
--     ELSE
--       INSERT INTO public.product_brands (product_id, brand_name, epa_registration, manufacturer, is_currently_sourced,
--         is_rup, signal_word, created_by, updated_by)
--       VALUES (r.size_id, r.brand_name, r.epa_registration, r.manufacturer, r.is_currently_sourced, r.is_rup,
--         r.signal_word, r.created_by, r.updated_by)
--       RETURNING id INTO v_claimed;
--     END IF;
--     INSERT INTO rollback_claimed VALUES (v_claimed) ON CONFLICT DO NOTHING;
--     v_legacy := NULL;
--   END LOOP;
--   -- A mapped row on a grouped size that no active brand of its current parent claimed (a retired brand, or a
--   -- brand of the parent it moved away from) was not a current brand of that size: archived whole, then not sourced.
--   FOR v_block IN SELECT b.* FROM public.product_brands b
--                   JOIN public.product_parent_brand_sources s ON s.legacy_brand_id = b.id
--                  WHERE b.is_currently_sourced
--                    AND EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = b.product_id)
--                    AND NOT EXISTS (SELECT 1 FROM rollback_claimed c WHERE c.id = b.id)
--                  ORDER BY b.id LOOP
--     INSERT INTO public.product_brand_rollback_archive (legacy_brand_id, legacy_row, parent_brand_id, replaced_by_parent_brand_id, reason)
--     -- A stepped-aside row is archived under its original name, not the temporary one.
--     VALUES (v_block.id, to_jsonb(v_block) || COALESCE((SELECT jsonb_build_object('brand_name', n.brand_name)
--                                                           FROM rollback_brand_names n WHERE n.id = v_block.id), '{}'::jsonb),
--             (SELECT s.parent_brand_id FROM public.product_parent_brand_sources s WHERE s.legacy_brand_id = v_block.id),
--             NULL, 'not a current brand of this size''s parent (retired, or the size moved); marked not sourced at rollback');
--     UPDATE public.product_brands SET is_currently_sourced = false, row_version = row_version + 1 WHERE id = v_block.id;
--   END LOOP;
--   -- A stepped-aside row no active brand claimed gets its own name back (a collision aborts the whole rollback).
--   UPDATE public.product_brands b SET brand_name = n.brand_name FROM rollback_brand_names n
--    WHERE b.id = n.id AND b.brand_name = '~rollback ' || b.id::text;
-- END;
-- $rollback$;
-- DROP FUNCTION public.get_product_brands(uuid);
-- DROP FUNCTION public.upsert_parent_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text);
-- DROP FUNCTION public.hold_product_parent_group(uuid, bigint, text, text, text);
-- DROP FUNCTION public.reject_product_parent_group(uuid, bigint, text, text, text);
-- DROP FUNCTION public._decide_product_parent_group(uuid, bigint, text, text, text);
-- DROP FUNCTION public.approve_product_parent_groups(uuid, bigint, jsonb, text);
-- DROP FUNCTION public._approve_product_parent_group(public.product_parent_proposals, jsonb, boolean);
-- DROP FUNCTION public._move_group_brands(uuid, uuid[], jsonb, boolean, text);
-- DROP FUNCTION public.build_product_parent_proposal(text);
-- DROP FUNCTION public._close_product_parent_proposal_if_done(uuid);
-- DROP FUNCTION public._product_parent_group_shape(uuid[]);
-- DROP FUNCTION public._product_parent_group_members(uuid[]);
-- DROP FUNCTION public._product_parent_suggested_role(text, text, boolean);
-- DROP FUNCTION public._product_parent_loose_key(text);
-- DROP FUNCTION public._product_parent_base_name(text);
-- DROP FUNCTION public._parent_brand_event(uuid, uuid, text, text, jsonb, jsonb);
-- DROP FUNCTION public._product_parent_grouping_open();
-- ROLLBACK-SQL-END

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF to_regclass('public.product_parent_proposals') IS NOT NULL
     OR to_regclass('public.product_parent_proposal_groups') IS NOT NULL
     OR to_regclass('public.product_parent_brands') IS NOT NULL
     OR to_regclass('public.product_parent_brand_events') IS NOT NULL
     OR to_regclass('public.product_parent_brand_sources') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_PROPOSALS_ALREADY_EXIST';
  END IF;
  IF to_regclass('public.product_parents') IS NULL OR to_regclass('public.product_parent_members') IS NULL
     OR to_regclass('public.product_brands') IS NULL OR to_regclass('public.product_rate_lock') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL OR to_regprocedure('public.is_active_profile()') IS NULL
     OR to_regprocedure('public.check_idempotency(text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regprocedure('public.update_updated_at()') IS NULL
     OR to_regprocedure('public._product_parent_size_role(jsonb)') IS NULL
     OR to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL
     OR to_regprocedure('public._replay_fingerprint_20261015(jsonb)') IS NULL
     OR to_regprocedure('public._bind_replay_receipt_20261015(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_PROPOSALS_DEPENDENCY_MISSING';
  END IF;
  -- A size grouped by PAR-1 with its own legacy brand rows would lose them from view (its brands become the
  -- parent's list, and no proposal ever reaches a grouped size), so those rows must be settled first.
  IF EXISTS (SELECT 1 FROM public.product_brands b JOIN public.product_parent_members m ON m.product_id = b.product_id) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_PROPOSALS_GROUPED_SIZE_HAS_BRANDS: settle those brand rows first';
  END IF;
  -- The PAR-1 steps this file calls, and the brand writer it re-issues, as installed when this was written.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.upsert_product_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,text)'::regprocedure)
       IS DISTINCT FROM '16a6d86bb6d935cdce42f9fa618a22d0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._copy_parent_to_size(uuid,uuid,bigint,boolean,boolean,boolean)'::regprocedure)
       IS DISTINCT FROM 'e2121d5ec1d23dbb4127fa8eac20c33f'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_parent_event(bigint,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure)
       IS DISTINCT FROM 'f9cdd05460b53838405f326029eff849'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_parent_replay(text,text,text)'::regprocedure)
       IS DISTINCT FROM '62880d61a470c2eeca02de7bc11c76be'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_parent_require_admin()'::regprocedure)
       IS DISTINCT FROM '52853e42f9bebeca498fa2d937f2649a'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._next_product_parent_event_id()'::regprocedure)
       IS DISTINCT FROM 'e05d05958ecb8934e2b5246908cc6d6b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_parent_timings(jsonb,text)'::regprocedure)
       IS DISTINCT FROM '24ed3546103cc1922be1a977037c6d25'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_parent_reason(text,text,boolean)'::regprocedure)
       IS DISTINCT FROM '6ce7a37dd233c9d5c489ad2222d8b340'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._normalize_epa_registration(text)'::regprocedure)
       IS DISTINCT FROM '965c285e9b86c89bdb20263a6526fb98'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_parent_values(public.product_parents)'::regprocedure)
       IS DISTINCT FROM '3cd7b71272a9192350fc4e132c4a9a12'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public._product_size_values(uuid)'::regprocedure)
       IS DISTINCT FROM 'bf2293f12cb00ecc0e2b30891981c433' THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_PARENT_PROPOSALS_HELPERS_CHANGED: re-base this on the installed bodies';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.product_parent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_version bigint NOT NULL UNIQUE CHECK (proposal_version >= 1),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'superseded', 'closed')),
  built_by uuid NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_parent_proposals OWNER TO postgres;
CREATE TRIGGER set_product_parent_proposals_updated_at
  BEFORE UPDATE ON public.product_parent_proposals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE UNIQUE INDEX product_parent_proposals_one_open ON public.product_parent_proposals ((true)) WHERE status = 'open';
COMMENT ON TABLE public.product_parent_proposals IS
  'PAR-2: one row per proposal build; one open at a time. Written only by the proposal functions.';

CREATE TABLE public.product_parent_proposal_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES public.product_parent_proposals(id) ON DELETE RESTRICT,
  suggested_name text NOT NULL,
  product_form text,
  generic_epa_registration text,
  identity_basis text CHECK (identity_basis IS NULL OR identity_basis IN ('epa_number', 'owner_confirmed')),
  members jsonb NOT NULL,
  conflicts jsonb NOT NULL DEFAULT '{}'::jsonb,
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  group_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'held')),
  parent_id uuid REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  decided_by uuid,
  decided_at timestamptz,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'approved') = (parent_id IS NOT NULL)),
  CHECK (status <> 'proposed' OR identity_basis IS NOT NULL)
);
ALTER TABLE public.product_parent_proposal_groups OWNER TO postgres;
CREATE TRIGGER set_product_parent_proposal_groups_updated_at
  BEFORE UPDATE ON public.product_parent_proposal_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE INDEX product_parent_proposal_groups_proposal_idx ON public.product_parent_proposal_groups (proposal_id);
COMMENT ON TABLE public.product_parent_proposal_groups IS
  'PAR-2: one proposed group per row. members holds allow-listed fields only (no cost, price or stock).';

CREATE TABLE public.product_parent_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  brand_name text NOT NULL CHECK (btrim(brand_name) <> '' AND brand_name = btrim(brand_name) AND char_length(brand_name) <= 200),
  epa_registration text CHECK (
    epa_registration IS NULL OR epa_registration ~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$'),
  manufacturer text CHECK (manufacturer IS NULL
    OR (btrim(manufacturer) <> '' AND manufacturer = btrim(manufacturer) AND char_length(manufacturer) <= 200)),
  is_currently_sourced boolean NOT NULL DEFAULT true,
  is_rup boolean,
  signal_word text CHECK (signal_word IS NULL OR signal_word IN ('Danger', 'Warning', 'Caution')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  legacy_brand_ids uuid[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_parent_brands OWNER TO postgres;
CREATE UNIQUE INDEX product_parent_brands_active_name ON public.product_parent_brands (parent_id, lower(brand_name))
  WHERE status = 'active';
CREATE INDEX product_parent_brands_created_by_idx ON public.product_parent_brands (created_by);
CREATE INDEX product_parent_brands_updated_by_idx ON public.product_parent_brands (updated_by);
CREATE TRIGGER set_product_parent_brands_updated_at
  BEFORE UPDATE ON public.product_parent_brands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
COMMENT ON TABLE public.product_parent_brands IS
  'PAR-2: a parent''s brand list (one per formulation). Retired rows are kept, never shown or offered. Written only by approval and upsert_parent_brand.';

CREATE TABLE public.product_parent_brand_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_brand_id uuid NOT NULL REFERENCES public.product_parent_brands(id) ON DELETE RESTRICT,
  parent_id uuid NOT NULL REFERENCES public.product_parents(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'retired')),
  reason text,
  before_values jsonb,
  after_values jsonb NOT NULL,
  changed_by uuid NOT NULL,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_parent_brand_events OWNER TO postgres;
CREATE INDEX product_parent_brand_events_brand_idx ON public.product_parent_brand_events (parent_brand_id, changed_at DESC, id DESC);
CREATE INDEX product_parent_brand_events_parent_idx ON public.product_parent_brand_events (parent_id);
COMMENT ON TABLE public.product_parent_brand_events IS 'PAR-2: append-only log of parent-brand changes.';

CREATE TABLE public.product_parent_brand_sources (
  legacy_brand_id uuid PRIMARY KEY REFERENCES public.product_brands(id) ON DELETE RESTRICT,
  parent_brand_id uuid NOT NULL REFERENCES public.product_parent_brands(id) ON DELETE RESTRICT,
  legacy_row_version integer NOT NULL,
  mapped_at timestamptz NOT NULL DEFAULT now(),
  mapped_by uuid NOT NULL
);
ALTER TABLE public.product_parent_brand_sources OWNER TO postgres;
CREATE INDEX product_parent_brand_sources_parent_brand_idx ON public.product_parent_brand_sources (parent_brand_id);
COMMENT ON TABLE public.product_parent_brand_sources IS
  'PAR-2: every legacy product_brands row moved to a parent, mapped to exactly one parent brand, with its last version.';

ALTER TABLE public.product_parent_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_proposal_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_brand_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_parent_brand_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_parent_proposals_admin_select ON public.product_parent_proposals
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
CREATE POLICY product_parent_proposal_groups_admin_select ON public.product_parent_proposal_groups
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
CREATE POLICY product_parent_brands_select ON public.product_parent_brands
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_parent_brand_events_select ON public.product_parent_brand_events
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
CREATE POLICY product_parent_brand_sources_select ON public.product_parent_brand_sources
  FOR SELECT TO authenticated USING ((SELECT public.is_active_profile()));
REVOKE ALL ON TABLE public.product_parent_proposals, public.product_parent_proposal_groups, public.product_parent_brands,
  public.product_parent_brand_events, public.product_parent_brand_sources FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON SEQUENCE public.product_parent_brand_events_id_seq FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_parent_proposals, public.product_parent_proposal_groups, public.product_parent_brands,
  public.product_parent_brand_events, public.product_parent_brand_sources TO authenticated;

CREATE FUNCTION public.refuse_product_parent_brand_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'PRODUCT_PARENT_BRAND_EVENTS_ARE_APPEND_ONLY';
END;
$function$;
ALTER FUNCTION public.refuse_product_parent_brand_event_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_product_parent_brand_event_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER product_parent_brand_events_append_only
  BEFORE UPDATE OR DELETE ON public.product_parent_brand_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_product_parent_brand_event_mutation();
CREATE TRIGGER product_parent_brand_events_no_truncate
  BEFORE TRUNCATE ON public.product_parent_brand_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_product_parent_brand_event_mutation();

-- ---------------------------------------------------------------------------------------------
-- Grouping switch (private: no API-role EXECUTE)
-- ---------------------------------------------------------------------------------------------

-- Off until the PAR-2 screens that read get_product_brands are deployed (build sheet 5.2, section 8 order 5), so
-- no size's brands move to a list today's product screen cannot show or edit. The screens PR's migration turns it
-- on by replacing this body with "SELECT true", after settling any brand rows a PAR-1 grouped size gained while
-- it was off (the check this file's preflight runs). A tab still running the old bundle after that deploy reads
-- product_brands directly and can show a size's pre-grouping list until it reloads; it cannot write it (the legacy
-- writer refuses grouped sizes once open), so the screens PR, not this file, owns that reload prompt.
CREATE FUNCTION public._product_parent_grouping_open() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $function$
  SELECT false;
$function$;
ALTER FUNCTION public._product_parent_grouping_open() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_grouping_open() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Grouping helpers (private: no API-role EXECUTE)
-- ---------------------------------------------------------------------------------------------

-- The name with size, pack and container words removed (build sheet §5.1). A size is removed only when written
-- as a number, an optional space and a unit word from the list, standing apart from the name; grams only with the
-- space ("500 g"), since "4G" is a strength. Strength and quality words ("4L", "4G", "Higher Quality", "Ester",
-- "safened", percentages, "#") are never removed.
CREATE FUNCTION public._product_parent_base_name(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    COALESCE(p_name, ''),
    -- pack count before a size: "2 x 2.5 gal", "4/1 gal"
    '(^|[^[:alnum:].])[0-9]+[[:space:]]*[x/][[:space:]]*(?=[0-9.])', '\1', 'gi'),
    -- a size: number, optional space, unit word
    '(^|[^[:alnum:].])([0-9]+(\.[0-9]+)?|\.[0-9]+)([[:space:]]?(fl[[:space:]]?oz|gallons?|gals?|gl|quarts?|qts?|pints?|pts?|oz|pounds?|lbs?|kg|ml|liters?|litres?|tons?)|[[:space:]]g)\.?(?![[:alnum:]])',
    '\1', 'gi'),
    -- pack counts and container words
    '\m([0-9]+[[:space:]]?-?[[:space:]]?(pks?|packs?|ct|counts?)|jugs?|cases?|bulk|totes?|bags?|box|boxes)\M', '', 'gi'),
    -- brackets left empty
    '[(\[][^[:alnum:]]*[)\]]', ' ', 'g'),
    '[[:space:]]+', ' ', 'g'), ' -,/:;');
$function$;
ALTER FUNCTION public._product_parent_base_name(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_base_name(text) FROM PUBLIC, anon, authenticated, service_role;

-- The base name with bare strength-or-volume tokens ("4L", "2.5 L", "4G") dropped: two different base names with the
-- same loose key differ only by such a token, so they are held, never grouped or split on a guess.
CREATE FUNCTION public._product_parent_loose_key(p_base text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT btrim(regexp_replace(regexp_replace(lower(COALESCE(p_base, '')),
    '\m[0-9]+(\.[0-9]+)?[[:space:]]?[lg]\M', '', 'g'), '[[:space:]]+', ' ', 'g'), ' -,/:;');
$function$;
ALTER FUNCTION public._product_parent_loose_key(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_loose_key(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._product_parent_suggested_role(p_name text, p_container_type text, p_full_tote boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $function$
  SELECT CASE WHEN COALESCE(p_name, '') ~* '\mbulk\M' OR COALESCE(p_container_type, '') ~* 'bulk' THEN 'bulk'
              WHEN COALESCE(p_name, '') ~* '\mtotes?\M' OR COALESCE(p_container_type, '') ~* 'tote'
                   OR COALESCE(p_full_tote, false) THEN 'fixed_tote'
              ELSE 'package' END;
$function$;
ALTER FUNCTION public._product_parent_suggested_role(text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_suggested_role(text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- The allow-listed member view a proposal stores and approval recomputes (no cost, price or stock), ordered by
-- product ID, each with its complete brand list. The group fingerprint is md5 of this text.
CREATE FUNCTION public._product_parent_group_members(p_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id', p.id, 'product_name', p.product_name, 'sku', p.sku, 'product_form', p.product_form,
    'container_size', trim_scale(p.container_size)::text, 'container_unit', p.container_unit,
    'inventory_unit', p.inventory_unit, 'is_active', p.is_active, 'category', p.category,
    'use_timings', to_jsonb(p.use_timings), 'rate_per_acre', trim_scale(p.rate_per_acre)::text,
    'rate_unit', NULLIF(btrim(p.rate_unit), ''), 'suggested_rate', NULLIF(btrim(p.suggested_rate), ''),
    'epa_registration', p.epa_registration, 'manufacturer', p.manufacturer,
    'suggested_size_role', public._product_parent_suggested_role(p.product_name, p.container_type, p.is_full_tote_only),
    'brands', (SELECT COALESCE(jsonb_agg(jsonb_build_object('brand_id', b.id, 'row_version', b.row_version,
                 'brand_name', b.brand_name, 'epa_registration', b.epa_registration, 'manufacturer', b.manufacturer,
                 'is_currently_sourced', b.is_currently_sourced, 'is_rup', b.is_rup, 'signal_word', b.signal_word)
                 ORDER BY lower(b.brand_name), b.id), '[]'::jsonb)
               FROM public.product_brands b WHERE b.product_id = p.id)
  ) ORDER BY p.id), '[]'::jsonb)
  FROM public.products p WHERE p.id = ANY(p_ids);
$function$;
ALTER FUNCTION public._product_parent_group_members(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_group_members(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- members, fingerprint, conflicts (every copied field where members disagree, with the distinct values) and the
-- flags that need no other group (manufacturer_differs, inactive_member, two_bulk_candidates, tote_without_bulk,
-- brand_lists_differ). A seed or each rate is in the stock unit, so its rate unit is not compared.
CREATE FUNCTION public._product_parent_group_shape(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_members jsonb := public._product_parent_group_members(p_ids);
  v_conflicts jsonb := '{}'::jsonb;
  v_flags text[] := '{}';
  v_vals jsonb;
BEGIN
  SELECT jsonb_agg(DISTINCT m->'category') INTO v_vals FROM jsonb_array_elements(v_members) m;
  IF jsonb_array_length(v_vals) > 1 THEN v_conflicts := v_conflicts || jsonb_build_object('category', v_vals); END IF;
  SELECT jsonb_agg(DISTINCT m->'use_timings') INTO v_vals FROM jsonb_array_elements(v_members) m;
  IF jsonb_array_length(v_vals) > 1 THEN v_conflicts := v_conflicts || jsonb_build_object('use_timings', v_vals); END IF;
  SELECT jsonb_agg(DISTINCT jsonb_build_object('rate_per_acre', m->'rate_per_acre',
           'rate_unit', CASE WHEN m->>'product_form' IN ('seed', 'each') THEN 'null'::jsonb ELSE m->'rate_unit' END,
           'suggested_rate', m->'suggested_rate')) INTO v_vals
    FROM jsonb_array_elements(v_members) m;
  IF jsonb_array_length(v_vals) > 1 THEN v_conflicts := v_conflicts || jsonb_build_object('rates', v_vals); END IF;

  IF (SELECT count(DISTINCT COALESCE(lower(btrim(m->>'manufacturer')), '')) FROM jsonb_array_elements(v_members) m) > 1 THEN
    v_flags := v_flags || 'manufacturer_differs'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_members) m WHERE NOT (m->>'is_active')::boolean) THEN
    v_flags := v_flags || 'inactive_member'::text;
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_members) m WHERE m->>'suggested_size_role' = 'bulk') > 1 THEN
    v_flags := v_flags || 'two_bulk_candidates'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_members) m WHERE m->>'suggested_size_role' = 'fixed_tote')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_members) m WHERE m->>'suggested_size_role' = 'bulk') THEN
    v_flags := v_flags || 'tote_without_bulk'::text;
  END IF;
  -- Lists agree only when every member has the same brand names with the same facts.
  IF (SELECT count(DISTINCT (SELECT COALESCE(jsonb_agg(b - 'brand_id' - 'row_version' ORDER BY lower(b->>'brand_name'), b::text), '[]'::jsonb)
                             FROM jsonb_array_elements(m->'brands') b))
        FROM jsonb_array_elements(v_members) m) > 1 THEN
    v_flags := v_flags || 'brand_lists_differ'::text;
  END IF;
  RETURN jsonb_build_object('members', v_members, 'fingerprint', md5(v_members::text),
                            'conflicts', v_conflicts, 'flags', to_jsonb(v_flags));
END;
$function$;
ALTER FUNCTION public._product_parent_group_shape(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._product_parent_group_shape(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._close_product_parent_proposal_if_done(p_proposal_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  UPDATE public.product_parent_proposals SET status = 'closed'
   WHERE id = p_proposal_id AND status = 'open'
     AND NOT EXISTS (SELECT 1 FROM public.product_parent_proposal_groups g
                      WHERE g.proposal_id = p_proposal_id AND g.status = 'proposed');
$function$;
ALTER FUNCTION public._close_product_parent_proposal_if_done(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._close_product_parent_proposal_if_done(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._parent_brand_event(p_brand_id uuid, p_parent_id uuid, p_type text, p_reason text,
  p_before jsonb, p_after jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  INSERT INTO public.product_parent_brand_events (parent_brand_id, parent_id, event_type, reason, before_values,
    after_values, changed_by, changed_by_name)
  VALUES (p_brand_id, p_parent_id, p_type, p_reason, p_before, p_after, auth.uid(),
    (SELECT full_name FROM public.profiles WHERE id = auth.uid()));
$function$;
ALTER FUNCTION public._parent_brand_event(uuid, uuid, text, text, jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._parent_brand_event(uuid, uuid, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Build a proposal
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.build_product_parent_proposal(p_idempotency_key text DEFAULT NULL)
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
    v_basis := CASE WHEN v_g.epa IS NULL THEN 'owner_confirmed' ELSE 'epa_number' END;
    IF v_g.shared_epa THEN v_flags := v_flags || '["same_epa_different_name"]'::jsonb; END IF;
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
    END IF;
    IF v_status = 'held' THEN v_basis := NULL; v_held := v_held + 1; END IF;

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
      identity_basis, members, conflicts, flags, group_fingerprint, status, reason, decided_at)
    VALUES (v_proposal.id, v_name, v_g.form, v_g.epa, v_basis, v_shape->'members', v_shape->'conflicts', v_flags,
      v_shape->>'fingerprint', v_status, v_reason, CASE WHEN v_status = 'held' THEN now() END);
    v_count := v_count + 1;
  END LOOP;
  -- A build with nothing left to decide (no groups, or every one held) is closed, never left open.
  PERFORM public._close_product_parent_proposal_if_done(v_proposal.id);

  v_result := jsonb_build_object('proposal_id', v_proposal.id, 'proposal_version', v_proposal.proposal_version,
    'group_count', v_count, 'held_count', v_held);
  PERFORM public.save_idempotency(p_idempotency_key, 'build_product_parent_proposal',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.build_product_parent_proposal(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.build_product_parent_proposal(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.build_product_parent_proposal(text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Approve
-- ---------------------------------------------------------------------------------------------

-- Moves one approved group's legacy brands to its new parent. Every legacy row maps to exactly one parent brand;
-- rows with identical facts share one. Per brand name: kept (the default when every member's list agrees) makes
-- the chosen source row's variant active; every other variant, and every variant of a name left out, is retired.
CREATE FUNCTION public._move_group_brands(p_parent_id uuid, p_ids uuid[], p_picks jsonb, p_differ boolean, p_parent_name text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_name text;
  v_pick jsonb;
  v_keep boolean;
  v_source uuid;
  v_var record;
  v_brand public.product_parent_brands%ROWTYPE;
BEGIN
  IF p_picks IS NOT NULL AND (jsonb_typeof(p_picks) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_each(p_picks) e
                   WHERE jsonb_typeof(e.value) <> 'object'
                      OR NOT EXISTS (SELECT 1 FROM public.product_brands b WHERE b.product_id = ANY(p_ids)
                                        AND lower(b.brand_name) = e.key))) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_BRANDS_INVALID: brands are picked by lower-case brand name for "%"', p_parent_name;
  END IF;
  FOR v_name IN SELECT DISTINCT lower(b.brand_name) FROM public.product_brands b WHERE b.product_id = ANY(p_ids) ORDER BY 1 LOOP
    v_pick := p_picks->v_name;
    IF p_differ AND v_pick IS NULL THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_BRANDS_PICK_REQUIRED: the sizes of "%" list different brands; pick the parent''s list (brand %)',
        p_parent_name, v_name;
    END IF;
    IF v_pick IS NOT NULL AND (jsonb_typeof(v_pick->'keep') IS DISTINCT FROM 'boolean'
         OR (v_pick ? 'source_brand_id' AND jsonb_typeof(v_pick->'source_brand_id') NOT IN ('string', 'null'))) THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_BRANDS_INVALID: each brand pick has keep (true or false) and, when kept, source_brand_id';
    END IF;
    v_keep := COALESCE((v_pick->>'keep')::boolean, true);
    v_source := NULL;
    IF v_keep THEN
      v_source := NULLIF(v_pick->>'source_brand_id', '')::uuid;
      IF v_source IS NULL THEN
        IF (SELECT count(DISTINCT jsonb_build_array(b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced,
                    b.is_rup, b.signal_word)) FROM public.product_brands b
             WHERE b.product_id = ANY(p_ids) AND lower(b.brand_name) = v_name) > 1 THEN
          RAISE EXCEPTION 'PRODUCT_PARENT_BRANDS_PICK_REQUIRED: brand % differs between the sizes of "%"; pick the one to keep',
            v_name, p_parent_name;
        END IF;
        SELECT b.id INTO v_source FROM public.product_brands b
         WHERE b.product_id = ANY(p_ids) AND lower(b.brand_name) = v_name ORDER BY b.id LIMIT 1;
      ELSIF NOT EXISTS (SELECT 1 FROM public.product_brands b WHERE b.id = v_source AND b.product_id = ANY(p_ids)
                                                            AND lower(b.brand_name) = v_name) THEN
        RAISE EXCEPTION 'PRODUCT_PARENT_BRANDS_INVALID: brand % of "%" has no such source row', v_name, p_parent_name;
      END IF;
    END IF;
    FOR v_var IN
      SELECT b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced, b.is_rup, b.signal_word,
             array_agg(b.id ORDER BY b.id) AS ids, max(b.row_version) AS max_version,
             bool_or(b.id = v_source) AS chosen
        FROM public.product_brands b
       WHERE b.product_id = ANY(p_ids) AND lower(b.brand_name) = v_name
       GROUP BY b.brand_name, b.epa_registration, b.manufacturer, b.is_currently_sourced, b.is_rup, b.signal_word
       ORDER BY (array_agg(b.id ORDER BY b.id))[1]
    LOOP
      INSERT INTO public.product_parent_brands (parent_id, brand_name, epa_registration, manufacturer, is_currently_sourced,
        is_rup, signal_word, row_version, status, legacy_brand_ids, created_by, updated_by)
      VALUES (p_parent_id, v_var.brand_name, v_var.epa_registration, v_var.manufacturer, v_var.is_currently_sourced,
        v_var.is_rup, v_var.signal_word, v_var.max_version + 1, CASE WHEN v_var.chosen THEN 'active' ELSE 'retired' END,
        v_var.ids, auth.uid(), auth.uid())
      RETURNING * INTO v_brand;
      INSERT INTO public.product_parent_brand_sources (legacy_brand_id, parent_brand_id, legacy_row_version, mapped_by)
      SELECT b.id, v_brand.id, b.row_version, auth.uid() FROM public.product_brands b WHERE b.id = ANY(v_var.ids);
      PERFORM public._parent_brand_event(v_brand.id, p_parent_id, CASE WHEN v_var.chosen THEN 'created' ELSE 'retired' END,
        CASE WHEN v_var.chosen THEN 'moved from the sizes at grouping'
             ELSE 'moved from the sizes at grouping; not on the parent''s list' END,
        NULL, to_jsonb(v_brand));
    END LOOP;
  END LOOP;
END;
$function$;
ALTER FUNCTION public._move_group_brands(uuid, uuid[], jsonb, boolean, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._move_group_brands(uuid, uuid[], jsonb, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

-- One group of an approval: the member rows are already locked by the caller.
CREATE FUNCTION public._approve_product_parent_group(p_proposal public.product_parent_proposals, p_entry jsonb, p_locked boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_group public.product_parent_proposal_groups%ROWTYPE;
  v_ids uuid[];
  v_shape jsonb;
  v_first jsonb;
  v_choices jsonb := COALESCE(p_entry->'choices', '{}'::jsonb);
  v_roles jsonb := COALESCE(p_entry->'size_roles', '{}'::jsonb);
  v_totes jsonb := COALESCE(p_entry->'totes', '{}'::jsonb);
  v_prices jsonb := COALESCE(p_entry->'prices', '{}'::jsonb);
  v_name text := btrim(p_entry->>'name');
  v_category text;
  v_timings jsonb;
  v_rates jsonb;
  v_field text;
  v_parent public.product_parents%ROWTYPE;
  v_m jsonb;
  v_pid uuid;
  v_role text;
  v_bulk uuid;
  v_tote jsonb;
  v_event bigint;
  v_copy jsonb;
  v_affected jsonb := '[]'::jsonb;
  v_changes boolean;
  v_tier text;
  v_expected jsonb;
  v_product record;
BEGIN
  SELECT * INTO v_group FROM public.product_parent_proposal_groups
   WHERE id = (p_entry->>'group_id')::uuid AND proposal_id = p_proposal.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_GROUP_NOT_FOUND: that group is not in this proposal'; END IF;
  IF v_group.status <> 'proposed' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_GROUP_NOT_PROPOSED: group "%" is %', v_group.suggested_name, v_group.status;
  END IF;
  v_ids := ARRAY(SELECT (m->>'product_id')::uuid FROM jsonb_array_elements(v_group.members) m ORDER BY 1);
  -- Recompute from the locked rows: anything that changed since the download refuses the whole call.
  v_shape := public._product_parent_group_shape(v_ids);
  IF (p_entry->>'group_fingerprint') IS DISTINCT FROM v_group.group_fingerprint
     OR (v_shape->>'fingerprint') IS DISTINCT FROM v_group.group_fingerprint
     OR EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = ANY(v_ids))
     -- The grouping rule itself, re-checked on the locked rows: one base name, form, stock unit and EPA number.
     OR (SELECT count(DISTINCT jsonb_build_array(lower(public._product_parent_base_name(m->>'product_name')), m->>'product_form',
                  CASE WHEN m->>'product_form' IN ('seed', 'each') THEN lower(btrim(COALESCE(m->>'inventory_unit', ''))) ELSE '' END))
           FROM jsonb_array_elements(v_shape->'members') m) <> 1
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_shape->'members') m
                 WHERE m->>'product_form' IS DISTINCT FROM v_group.product_form
                    OR public._normalize_epa_registration(m->>'epa_registration') IS DISTINCT FROM v_group.generic_epa_registration) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_GROUP_CHANGED: a size in "%" changed since the proposal was built; build a new proposal',
      v_group.suggested_name;
  END IF;
  IF v_group.identity_basis = 'owner_confirmed' AND (p_entry->'owner_confirmed') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_OWNER_CONFIRMATION_REQUIRED: no size of "%" has an EPA number; confirm they are the same product',
      v_group.suggested_name;
  END IF;
  IF v_name IS NULL OR v_name = '' THEN RAISE EXCEPTION 'PRODUCT_PARENT_NAME_REQUIRED: name the parent'; END IF;
  IF jsonb_typeof(v_choices) <> 'object' OR jsonb_typeof(v_roles) <> 'object' OR jsonb_typeof(v_totes) <> 'object'
     OR jsonb_typeof(v_prices) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_choices) k WHERE NOT (v_shape->'conflicts' ? k))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_roles) k WHERE NOT (k = ANY(v_ids::text[])))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_totes) k WHERE NOT (k = ANY(v_ids::text[])))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_prices) k WHERE NOT (k = ANY(v_ids::text[]))) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_APPROVAL_INVALID: choices name only fields in conflict; size roles, totes and prices name only sizes of "%"',
      v_group.suggested_name;
  END IF;

  -- Every conflict needs a chosen value that some member holds.
  FOR v_field IN SELECT jsonb_object_keys(v_shape->'conflicts') LOOP
    -- Exact match (jsonb @> would accept part of a timing list or of a rate).
    IF NOT (v_choices ? v_field)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_shape->'conflicts'->v_field) v WHERE v = v_choices->v_field) THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_CONFLICT_PICK_REQUIRED: the sizes of "%" disagree on %; pick one size''s value',
        v_group.suggested_name, replace(v_field, '_', ' ');
    END IF;
  END LOOP;
  v_first := v_shape->'members'->0;
  v_category := CASE WHEN v_choices ? 'category' THEN v_choices->>'category' ELSE v_first->>'category' END;
  IF NULLIF(btrim(v_category), '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.product_categories c WHERE c.name = v_category AND c.is_active) THEN
    RAISE EXCEPTION 'PRODUCT_CATEGORY_RETIRED: choose an active category for "%"', v_name;
  END IF;
  v_timings := CASE WHEN v_choices ? 'use_timings' THEN v_choices->'use_timings' ELSE v_first->'use_timings' END;
  v_rates := CASE WHEN v_choices ? 'rates' THEN v_choices->'rates'
                  ELSE jsonb_build_object('rate_per_acre', v_first->'rate_per_acre',
                         'rate_unit', CASE WHEN v_group.product_form IN ('seed', 'each') THEN 'null'::jsonb ELSE v_first->'rate_unit' END,
                         'suggested_rate', v_first->'suggested_rate') END;

  -- While rates are locked, a group that changes any member's rate waits for a correction or a logged unlock.
  IF p_locked AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = ANY(v_ids)
       AND (p.rate_per_acre IS DISTINCT FROM (v_rates->>'rate_per_acre')::numeric
            OR NULLIF(btrim(p.suggested_rate), '') IS DISTINCT FROM (v_rates->>'suggested_rate')
            OR NULLIF(btrim(p.rate_unit), '') IS DISTINCT FROM
               CASE WHEN p.product_form IN ('seed', 'each') THEN NULLIF(btrim(p.inventory_unit), '') ELSE v_rates->>'rate_unit' END)) THEN
    RAISE EXCEPTION 'PRODUCT_RATES_LOCKED: rates are locked and grouping "%" would change a size''s rate; correct the rates first or group it after an unlock',
      v_group.suggested_name USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.product_parents (name, product_form, generic_epa_registration, category, use_timings,
    rate_per_acre, rate_unit, suggested_rate, created_by, updated_by)
  VALUES (v_name, v_group.product_form,
    CASE WHEN v_group.identity_basis = 'epa_number' THEN v_group.generic_epa_registration END,
    v_category, public._product_parent_timings(v_timings, v_category),
    (v_rates->>'rate_per_acre')::numeric,
    CASE WHEN v_group.product_form IN ('seed', 'each') THEN NULL ELSE v_rates->>'rate_unit' END,
    v_rates->>'suggested_rate', auth.uid(), auth.uid())
  RETURNING * INTO v_parent;

  -- Size roles (default: the suggestion), then tote answers.
  FOR v_m IN SELECT m FROM jsonb_array_elements(v_shape->'members') m LOOP
    v_pid := (v_m->>'product_id')::uuid;
    v_role := public._product_parent_size_role(jsonb_build_object('size_role',
      COALESCE(v_roles->(v_pid::text), v_m->'suggested_size_role')));
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by)
    VALUES (v_pid, v_parent.id, v_role, auth.uid());
  END LOOP;
  IF (SELECT count(*) FROM public.product_parent_members WHERE parent_id = v_parent.id AND size_role = 'bulk') > 1 THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_TWO_BULK: "%" can have one bulk size', v_name;
  END IF;
  SELECT product_id INTO v_bulk FROM public.product_parent_members WHERE parent_id = v_parent.id AND size_role = 'bulk';
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_totes) k
              WHERE NOT EXISTS (SELECT 1 FROM public.product_parent_members m
                                 WHERE m.product_id = k::uuid AND m.parent_id = v_parent.id AND m.size_role = 'fixed_tote')) THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_APPROVAL_INVALID: tote answers name only the tote sizes of "%"', v_name;
  END IF;
  FOR v_pid IN SELECT product_id FROM public.product_parent_members WHERE parent_id = v_parent.id AND size_role = 'fixed_tote'
                ORDER BY product_id LOOP
    v_tote := v_totes->(v_pid::text);
    IF v_tote IS NULL OR jsonb_typeof(v_tote) <> 'object' OR jsonb_typeof(v_tote->'shop_filled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_TOTE_ANSWER_REQUIRED: say whether each tote of "%" is shop-filled', v_name;
    END IF;
    -- Approval only records the answer (build sheet 5.3, DATA-12). Fill-time rules stay with fill_tote_from_bulk:
    -- a tote stocked in a volume is refused there until its stock unit is corrected through the reviewed unit
    -- process (build sheet section 6), so recording "shop-filled" here never fills anything by itself.
    IF (v_tote->>'shop_filled')::boolean THEN
      IF v_bulk IS NULL OR (v_tote->>'fill_source_product_id') IS DISTINCT FROM v_bulk::text THEN
        RAISE EXCEPTION 'PRODUCT_PARENT_FILL_SOURCE_INVALID: a shop-filled tote of "%" is filled from its own bulk size', v_name;
      END IF;
      IF v_category IS NULL OR v_category NOT ILIKE '%fertilizer%' THEN
        RAISE EXCEPTION 'PRODUCT_PARENT_TOTE_NOT_FERTILIZER: only fertilizer totes are shop-filled; mark the tote of "%" vendor-filled', v_name;
      END IF;
      UPDATE public.product_parent_members SET fill_source_product_id = v_bulk, updated_at = now() WHERE product_id = v_pid;
    ELSIF jsonb_typeof(v_tote->'fill_source_product_id') IS DISTINCT FROM 'null' AND v_tote ? 'fill_source_product_id' THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_APPROVAL_INVALID: a vendor-filled tote has no fill source';
    END IF;
  END LOOP;

  -- Copy the parent's values onto every size; each size's per-acre prices must be what the approval showed
  -- (the entry's prices for a size whose rates change, otherwise unchanged).
  v_event := public._next_product_parent_event_id();
  FOREACH v_pid IN ARRAY v_ids LOOP
    SELECT p.rate_per_acre, NULLIF(btrim(p.rate_unit), '') AS rate_unit, NULLIF(btrim(p.suggested_rate), '') AS suggested_rate,
           p.product_form, NULLIF(btrim(p.inventory_unit), '') AS inventory_unit
      INTO v_product FROM public.products p WHERE p.id = v_pid;
    v_changes := v_product.rate_per_acre IS DISTINCT FROM v_parent.rate_per_acre
      OR v_product.suggested_rate IS DISTINCT FROM v_parent.suggested_rate
      OR v_product.rate_unit IS DISTINCT FROM CASE WHEN v_product.product_form IN ('seed', 'each')
                                                  THEN v_product.inventory_unit ELSE v_parent.rate_unit END;
    v_expected := v_prices->(v_pid::text);
    IF v_changes AND (v_expected IS NULL OR jsonb_typeof(v_expected) <> 'object') THEN
      RAISE EXCEPTION 'PRODUCT_PARENT_PRICES_REQUIRED: grouping "%" changes the rates of a size; send its previewed per-acre prices', v_name;
    END IF;
    v_copy := public._copy_parent_to_size(v_parent.id, v_pid, v_event, true, false, false);
    FOREACH v_tier IN ARRAY ARRAY['tier1_price_per_acre', 'tier2_price_per_acre', 'tier3_price_per_acre'] LOOP
      IF (v_copy->'after'->>v_tier)::numeric IS DISTINCT FROM
         (CASE WHEN v_expected IS NULL THEN (v_copy->'before'->>v_tier)::numeric ELSE (v_expected->>v_tier)::numeric END)
         OR (v_expected IS NOT NULL AND NOT (v_expected ? v_tier)) THEN
        RAISE EXCEPTION 'PRODUCT_RATE_PREVIEW_CHANGED: the per-acre prices changed since the preview; preview again: %',
          v_copy->'after'->>'product_name' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    v_affected := v_affected || v_copy;
  END LOOP;
  PERFORM public._product_parent_event(v_event, v_parent.id, 'created',
    format('Grouped from proposal %s', p_proposal.proposal_version),
    CASE v_group.identity_basis WHEN 'epa_number' THEN 'Same EPA number ' || v_group.generic_epa_registration
                                ELSE 'Owner confirmed the same product' END,
    NULL, public._product_parent_values(v_parent), v_affected);

  -- From here the parent list is the brand list (get_product_brands). Legacy rows stay untouched for the rollback.
  -- The current screen still lists legacy rows, so no group is approved until the PAR-2 screens that read
  -- get_product_brands are deployed (build sheet 5.2 and section 8, order 5); live had 0 legacy brand rows
  -- and 0 grouped sizes on 2026-11-06, and brand entry is held until grouping (section 9).
  PERFORM public._move_group_brands(v_parent.id, v_ids, p_entry->'brands',
    (v_shape->'flags') ? 'brand_lists_differ', v_name);

  UPDATE public.product_parent_proposal_groups SET status = 'approved', parent_id = v_parent.id,
    decided_by = auth.uid(), decided_at = now()
  WHERE id = v_group.id;
  RETURN jsonb_build_object('group_id', v_group.id, 'parent_id', v_parent.id, 'parent_version', v_parent.parent_version,
    'event_id', v_event);
EXCEPTION WHEN unique_violation THEN
  IF SQLERRM LIKE '%product_parents_active_name_unique%' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_NAME_TAKEN: another parent is named "%"', v_name;
  END IF;
  IF SQLERRM LIKE '%product_parent_members_one_bulk%' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_TWO_BULK: "%" can have one bulk size', v_name;
  END IF;
  RAISE;
END;
$function$;
ALTER FUNCTION public._approve_product_parent_group(public.product_parent_proposals, jsonb, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._approve_product_parent_group(public.product_parent_proposals, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.approve_product_parent_groups(p_proposal_id uuid, p_proposal_version bigint, p_groups jsonb,
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
    v_done := v_done || public._approve_product_parent_group(v_proposal, v_entry, COALESCE(v_locked, true));
  END LOOP;
  PERFORM public._close_product_parent_proposal_if_done(p_proposal_id);

  v_result := jsonb_build_object('proposal_id', p_proposal_id, 'proposal_version', p_proposal_version, 'groups', v_done);
  PERFORM public.save_idempotency(p_idempotency_key, 'approve_product_parent_groups',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.approve_product_parent_groups(uuid, bigint, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.approve_product_parent_groups(uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_product_parent_groups(uuid, bigint, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Hold / reject
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._decide_product_parent_group(p_group_id uuid, p_expected_proposal_version bigint,
  p_group_fingerprint text, p_reason text, p_status text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_reason text := public._product_parent_reason(p_reason, 'reason', true);
  v_group public.product_parent_proposal_groups%ROWTYPE;
  v_proposal public.product_parent_proposals%ROWTYPE;
  v_ids uuid[];
BEGIN
  SELECT * INTO v_proposal FROM public.product_parent_proposals
   WHERE id = (SELECT proposal_id FROM public.product_parent_proposal_groups WHERE id = p_group_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_GROUP_NOT_FOUND: that group is not in a proposal'; END IF;
  IF v_proposal.status <> 'open' OR v_proposal.proposal_version IS DISTINCT FROM p_expected_proposal_version THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_PROPOSAL_STALE: this proposal is no longer the open one; reload it';
  END IF;
  SELECT * INTO v_group FROM public.product_parent_proposal_groups WHERE id = p_group_id FOR UPDATE;
  IF v_group.status <> 'proposed' THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_GROUP_NOT_PROPOSED: group "%" is %', v_group.suggested_name, v_group.status;
  END IF;
  v_ids := ARRAY(SELECT (m->>'product_id')::uuid FROM jsonb_array_elements(v_group.members) m ORDER BY 1);
  PERFORM 1 FROM public.products WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;
  IF p_group_fingerprint IS DISTINCT FROM v_group.group_fingerprint
     OR (public._product_parent_group_shape(v_ids)->>'fingerprint') IS DISTINCT FROM v_group.group_fingerprint THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_GROUP_CHANGED: a size in "%" changed since the proposal was built; build a new proposal',
      v_group.suggested_name;
  END IF;
  UPDATE public.product_parent_proposal_groups SET status = p_status, reason = v_reason,
    decided_by = auth.uid(), decided_at = now()
  WHERE id = p_group_id;
  PERFORM public._close_product_parent_proposal_if_done(v_proposal.id);
  RETURN jsonb_build_object('group_id', p_group_id, 'status', p_status, 'proposal_version', v_proposal.proposal_version);
END;
$function$;
ALTER FUNCTION public._decide_product_parent_group(uuid, bigint, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._decide_product_parent_group(uuid, bigint, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hold_product_parent_group(p_group_id uuid, p_expected_proposal_version bigint,
  p_group_fingerprint text, p_reason text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'group_id', p_group_id, 'version', p_expected_proposal_version,
    'fingerprint', p_group_fingerprint, 'reason', p_reason)::text);
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'hold_product_parent_group', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_result := public._decide_product_parent_group(p_group_id, p_expected_proposal_version, p_group_fingerprint, p_reason, 'held');
  PERFORM public.save_idempotency(p_idempotency_key, 'hold_product_parent_group',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.hold_product_parent_group(uuid, bigint, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hold_product_parent_group(uuid, bigint, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hold_product_parent_group(uuid, bigint, text, text, text) TO authenticated;

CREATE FUNCTION public.reject_product_parent_group(p_group_id uuid, p_expected_proposal_version bigint,
  p_group_fingerprint text, p_reason text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'group_id', p_group_id, 'version', p_expected_proposal_version,
    'fingerprint', p_group_fingerprint, 'reason', p_reason)::text);
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'reject_product_parent_group', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  v_result := public._decide_product_parent_group(p_group_id, p_expected_proposal_version, p_group_fingerprint, p_reason, 'rejected');
  PERFORM public.save_idempotency(p_idempotency_key, 'reject_product_parent_group',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.reject_product_parent_group(uuid, bigint, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_product_parent_group(uuid, bigint, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_product_parent_group(uuid, bigint, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Parent brands
-- ---------------------------------------------------------------------------------------------

-- Add or edit one brand on a parent's list (same rules as upsert_product_brand), or retire one with a reason.
-- Retired is final. Takes every member row's lock in ID order before it reads or writes a brand.
CREATE FUNCTION public.upsert_parent_brand(p_parent_id uuid, p_brand_name text, p_epa_registration text,
  p_manufacturer text, p_is_currently_sourced boolean, p_is_rup boolean, p_signal_word text,
  p_brand_id uuid DEFAULT NULL, p_expected_row_version integer DEFAULT NULL, p_retire boolean DEFAULT false,
  p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text := md5(jsonb_build_object('actor_id', auth.uid(), 'parent_id', p_parent_id, 'brand_id', p_brand_id,
    'brand_name', p_brand_name, 'epa_registration', p_epa_registration, 'manufacturer', p_manufacturer,
    'is_currently_sourced', p_is_currently_sourced, 'is_rup', p_is_rup, 'signal_word', p_signal_word,
    'expected_row_version', p_expected_row_version, 'retire', p_retire, 'reason', p_reason)::text);
  v_brand_name text := btrim(p_brand_name);
  v_epa text := NULLIF(btrim(p_epa_registration), '');
  v_manufacturer text := NULLIF(btrim(p_manufacturer), '');
  v_reason text;
  v_existing jsonb;
  v_old public.product_parent_brands%ROWTYPE;
  v_saved public.product_parent_brands%ROWTYPE;
  v_parent_active boolean;
  v_result jsonb;
BEGIN
  v_existing := public._product_parent_replay(p_idempotency_key, 'upsert_parent_brand', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF NOT public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'PRODUCT_PARENT_GROUPING_NOT_OPEN: parent brand lists open when the new product screens are live'
      USING ERRCODE = '55000';
  END IF;
  IF v_brand_name IS NULL OR v_brand_name = '' THEN
    RAISE EXCEPTION 'BRAND_NAME_REQUIRED: enter the brand name' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_brand_name) > 200 OR char_length(v_manufacturer) > 200 THEN
    RAISE EXCEPTION 'BRAND_TEXT_TOO_LONG: brand and manufacturer names are limited to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF v_epa IS NOT NULL AND v_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_INVALID: % is not an EPA registration number (like 524-475 or 100-1234-5905)', v_epa
      USING ERRCODE = '22023';
  END IF;
  IF p_is_currently_sourced IS NULL THEN RAISE EXCEPTION 'CURRENTLY_SOURCED_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_signal_word IS NOT NULL AND p_signal_word NOT IN ('Danger', 'Warning', 'Caution') THEN
    RAISE EXCEPTION 'SIGNAL_WORD_INVALID: %', p_signal_word USING ERRCODE = '22023';
  END IF;
  IF p_brand_id IS NULL AND (p_expected_row_version IS NOT NULL OR COALESCE(p_retire, false)) THEN
    RAISE EXCEPTION 'ROW_VERSION_UNEXPECTED: a new brand has no version yet and cannot be retired' USING ERRCODE = '22023';
  END IF;
  IF p_brand_id IS NOT NULL AND p_expected_row_version IS NULL THEN
    RAISE EXCEPTION 'ROW_VERSION_REQUIRED: an edit must name the version it read' USING ERRCODE = '22023';
  END IF;
  v_reason := public._product_parent_reason(p_reason, 'reason', COALESCE(p_retire, false));

  SELECT is_active INTO v_parent_active FROM public.product_parents WHERE id = p_parent_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_PARENT_NOT_FOUND'; END IF;
  IF NOT v_parent_active THEN RAISE EXCEPTION 'PRODUCT_PARENT_INACTIVE: reactivate this product before changing its brands'; END IF;
  PERFORM 1 FROM public.products p WHERE p.id IN (SELECT m.product_id FROM public.product_parent_members m
                                                   WHERE m.parent_id = p_parent_id)
   ORDER BY p.id FOR NO KEY UPDATE;

  IF p_brand_id IS NULL THEN
    BEGIN
      INSERT INTO public.product_parent_brands (parent_id, brand_name, epa_registration, manufacturer,
        is_currently_sourced, is_rup, signal_word, created_by, updated_by)
      VALUES (p_parent_id, v_brand_name, v_epa, v_manufacturer, p_is_currently_sourced, p_is_rup, p_signal_word,
        v_actor, v_actor)
      RETURNING * INTO v_saved;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'BRAND_NAME_TAKEN: this product already lists a brand named %', v_brand_name USING ERRCODE = '23505';
    END;
    PERFORM public._parent_brand_event(v_saved.id, p_parent_id, 'created', v_reason, NULL, to_jsonb(v_saved));
  ELSE
    SELECT * INTO v_old FROM public.product_parent_brands WHERE id = p_brand_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BRAND_NOT_FOUND: %', p_brand_id USING ERRCODE = 'P0002'; END IF;
    IF v_old.parent_id IS DISTINCT FROM p_parent_id THEN
      RAISE EXCEPTION 'BRAND_PRODUCT_MISMATCH: brand % belongs to another product', p_brand_id USING ERRCODE = '22023';
    END IF;
    IF v_old.status = 'retired' THEN
      RAISE EXCEPTION 'BRAND_RETIRED: this brand was retired and cannot be changed' USING ERRCODE = '22023';
    END IF;
    IF v_old.row_version IS DISTINCT FROM p_expected_row_version THEN
      RAISE EXCEPTION 'BRAND_CHANGED: someone else changed this brand; reload and try again'
        USING ERRCODE = '40001', DETAIL = format('expected version %s, found %s', p_expected_row_version, v_old.row_version);
    END IF;
    BEGIN
      UPDATE public.product_parent_brands SET brand_name = v_brand_name, epa_registration = v_epa,
        manufacturer = v_manufacturer, is_currently_sourced = p_is_currently_sourced, is_rup = p_is_rup,
        signal_word = p_signal_word, row_version = v_old.row_version + 1,
        status = CASE WHEN COALESCE(p_retire, false) THEN 'retired' ELSE 'active' END, updated_by = v_actor
      WHERE id = p_brand_id
      RETURNING * INTO v_saved;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'BRAND_NAME_TAKEN: this product already lists a brand named %', v_brand_name USING ERRCODE = '23505';
    END;
    PERFORM public._parent_brand_event(v_saved.id, p_parent_id,
      CASE WHEN COALESCE(p_retire, false) THEN 'retired' ELSE 'updated' END, v_reason, to_jsonb(v_old), to_jsonb(v_saved));
  END IF;

  v_result := to_jsonb(v_saved);
  PERFORM public.save_idempotency(p_idempotency_key, 'upsert_parent_brand',
    jsonb_build_object('actor_id', auth.uid(), 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.upsert_parent_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_parent_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_parent_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, boolean, text, text)
  TO authenticated;

-- Once the switch is on, a grouped size's brands are its parent's active list; any other size's are its own.
CREATE FUNCTION public.get_product_brands(p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_parent public.product_parents%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_active_profile() THEN RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501'; END IF;
  SELECT pp.* INTO v_parent FROM public.product_parent_members m JOIN public.product_parents pp ON pp.id = m.parent_id
   WHERE m.product_id = p_product_id;
  IF FOUND AND public._product_parent_grouping_open() THEN
    RETURN jsonb_build_object('source', 'parent', 'product_id', p_product_id, 'parent_id', v_parent.id,
      'parent_name', v_parent.name,
      'brands', (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY lower(b.brand_name), b.id), '[]'::jsonb)
                   FROM public.product_parent_brands b WHERE b.parent_id = v_parent.id AND b.status = 'active'));
  END IF;
  RETURN jsonb_build_object('source', 'product', 'product_id', p_product_id, 'parent_id', NULL, 'parent_name', NULL,
    'brands', (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY lower(b.brand_name), b.id), '[]'::jsonb)
                 FROM public.product_brands b WHERE b.product_id = p_product_id));
END;
$function$;
ALTER FUNCTION public.get_product_brands(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_product_brands(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_product_brands(uuid) TO authenticated;

-- Re-issued from 20261022086500 with one change: after the receipt lookup it takes the product-row lock approval
-- takes, and, once the switch is on, refuses a grouped size with the reload message (nothing written). Ungrouped
-- sizes, and every size while the switch is off, are unchanged.
CREATE OR REPLACE FUNCTION public.upsert_product_brand(
  p_product_id uuid,
  p_brand_name text,
  p_epa_registration text,
  p_manufacturer text,
  p_is_currently_sourced boolean,
  p_is_rup boolean,
  p_signal_word text,
  p_brand_id uuid DEFAULT NULL,
  p_expected_row_version integer DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_brand_name text := btrim(p_brand_name);
  v_epa text := NULLIF(btrim(p_epa_registration), '');
  v_manufacturer text := NULLIF(btrim(p_manufacturer), '');
  v_fingerprint text;
  v_replay jsonb;
  v_existing public.product_brands%ROWTYPE;
  v_saved public.product_brands%ROWTYPE;
  v_result jsonb;
  v_parent_name text;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: upsert_product_brand requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  -- Authorize before the receipt lookup, so a demoted or deactivated admin gets neither a replay
  -- nor a refusal that carries the saved result.
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only an admin can change a product''s brands' USING ERRCODE = '42501';
  END IF;

  -- Input checks that never change between attempts run before the receipt lookup, so a bad input
  -- gets its own message rather than an intent mismatch.
  IF v_brand_name IS NULL OR v_brand_name = '' THEN
    RAISE EXCEPTION 'BRAND_NAME_REQUIRED: enter the brand name' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_brand_name) > 200 OR char_length(v_manufacturer) > 200 THEN
    RAISE EXCEPTION 'BRAND_TEXT_TOO_LONG: brand and manufacturer names are limited to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF v_epa IS NOT NULL AND v_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_INVALID: % is not an EPA registration number (like 524-475 or 100-1234-5905)', v_epa
      USING ERRCODE = '22023';
  END IF;
  IF p_is_currently_sourced IS NULL THEN
    RAISE EXCEPTION 'CURRENTLY_SOURCED_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_signal_word IS NOT NULL AND p_signal_word NOT IN ('Danger', 'Warning', 'Caution') THEN
    RAISE EXCEPTION 'SIGNAL_WORD_INVALID: %', p_signal_word USING ERRCODE = '22023';
  END IF;
  IF p_brand_id IS NULL AND p_expected_row_version IS NOT NULL THEN
    RAISE EXCEPTION 'ROW_VERSION_UNEXPECTED: a new brand has no version yet' USING ERRCODE = '22023';
  END IF;
  IF p_brand_id IS NOT NULL AND p_expected_row_version IS NULL THEN
    RAISE EXCEPTION 'ROW_VERSION_REQUIRED: an edit must name the version it read' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'brand_id', p_brand_id,
    'brand_name', p_brand_name,
    'epa_registration', p_epa_registration,
    'manufacturer', p_manufacturer,
    'is_currently_sourced', p_is_currently_sourced,
    'is_rup', p_is_rup,
    'signal_word', p_signal_word,
    'expected_row_version', p_expected_row_version
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'upsert_product_brand', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- PAR-2: the same product-row lock grouping takes, then (switch on) a grouped size's brands belong to its parent.
  -- An edit's brand row decides the size, so a mismatched p_product_id cannot dodge the refusal.
  PERFORM 1 FROM public.products
   WHERE id IN (p_product_id, (SELECT b.product_id FROM public.product_brands b WHERE b.id = p_brand_id))
   ORDER BY id FOR NO KEY UPDATE;
  SELECT pp.name INTO v_parent_name FROM public.product_parent_members m
    JOIN public.product_parents pp ON pp.id = m.parent_id
   WHERE m.product_id IN (p_product_id, (SELECT b.product_id FROM public.product_brands b WHERE b.id = p_brand_id))
   ORDER BY m.product_id LIMIT 1;
  IF v_parent_name IS NOT NULL AND public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'PRODUCT_BRANDS_BELONG_TO_PARENT: this product''s brands are kept on parent "%"; reload the app', v_parent_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_brand_id IS NULL THEN
    -- The foreign key also enforces this; checking first gives a plain message.
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', p_product_id USING ERRCODE = 'P0002';
    END IF;
    BEGIN
      INSERT INTO public.product_brands (
        product_id, brand_name, epa_registration, manufacturer, is_currently_sourced,
        is_rup, signal_word, created_by, updated_by
      ) VALUES (
        p_product_id, v_brand_name, v_epa, v_manufacturer, p_is_currently_sourced,
        p_is_rup, p_signal_word, v_actor, v_actor
      )
      RETURNING * INTO v_saved;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'BRAND_NAME_TAKEN: this product already lists a brand named %', v_brand_name
        USING ERRCODE = '23505';
    END;
  ELSE
    SELECT * INTO v_existing FROM public.product_brands WHERE id = p_brand_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BRAND_NOT_FOUND: %', p_brand_id USING ERRCODE = 'P0002';
    END IF;
    -- A brand never moves to another product: its EPA number and later delivery records belong to this one.
    IF v_existing.product_id IS DISTINCT FROM p_product_id THEN
      RAISE EXCEPTION 'BRAND_PRODUCT_MISMATCH: brand % belongs to another product', p_brand_id USING ERRCODE = '22023';
    END IF;
    IF v_existing.row_version IS DISTINCT FROM p_expected_row_version THEN
      RAISE EXCEPTION 'BRAND_CHANGED: someone else changed this brand; reload and try again'
        USING ERRCODE = '40001',
              DETAIL = format('expected version %s, found %s', p_expected_row_version, v_existing.row_version);
    END IF;
    BEGIN
      UPDATE public.product_brands
         SET brand_name = v_brand_name,
             epa_registration = v_epa,
             manufacturer = v_manufacturer,
             is_currently_sourced = p_is_currently_sourced,
             is_rup = p_is_rup,
             signal_word = p_signal_word,
             row_version = v_existing.row_version + 1,
             updated_by = v_actor
       WHERE id = p_brand_id
      RETURNING * INTO v_saved;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'BRAND_NAME_TAKEN: this product already lists a brand named %', v_brand_name
        USING ERRCODE = '23505';
    END;
  END IF;

  v_result := to_jsonb(v_saved);
  PERFORM public.save_idempotency(p_idempotency_key, 'upsert_product_brand', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'upsert_product_brand', v_fingerprint);
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) TO authenticated;
COMMENT ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) IS
  'Admin-only add or edit of a product brand (product_brands) for an ungrouped size; once grouping is open, a grouped size is refused with PRODUCT_BRANDS_BELONG_TO_PARENT (its brands are on the parent, upsert_parent_brand). Retry key required and bound to caller + request; an edit must pass the row_version it read. Never deletes; retire with p_is_currently_sourced = false.';

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------

DO $postflight$
DECLARE
  v_t text;
  v_sig text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['product_parent_proposals', 'product_parent_proposal_groups', 'product_parent_brands',
                             'product_parent_brand_events', 'product_parent_brand_sources'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass)
       OR (SELECT relowner FROM pg_class WHERE oid = ('public.' || v_t)::regclass) <> 'postgres'::regrole
       OR has_table_privilege('authenticated', 'public.' || v_t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       OR NOT has_table_privilege('authenticated', 'public.' || v_t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || v_t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_table_privilege('service_role', 'public.' || v_t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro')
           AND has_table_privilege('metabase_ro', 'public.' || v_t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) THEN
      RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_PROPOSALS_TABLE_ACCESS: %', v_t;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY[
    'public.build_product_parent_proposal(text)',
    'public.approve_product_parent_groups(uuid,bigint,jsonb,text)',
    'public.hold_product_parent_group(uuid,bigint,text,text,text)',
    'public.reject_product_parent_group(uuid,bigint,text,text,text)',
    'public.upsert_parent_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,boolean,text,text)',
    'public.get_product_brands(uuid)',
    'public.upsert_product_brand(uuid,text,text,text,boolean,boolean,text,uuid,integer,text)'] LOOP
    IF (SELECT array_agg(DISTINCT grantee::regrole::text ORDER BY grantee::regrole::text)
          FROM pg_proc p, aclexplode(p.proacl) WHERE p.oid = v_sig::regprocedure AND privilege_type = 'EXECUTE')
       IS DISTINCT FROM ARRAY['authenticated', 'postgres']
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_sig::regprocedure)
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_sig::regprocedure) IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_PROPOSALS_FUNCTION: %', v_sig;
    END IF;
    IF (SELECT proowner FROM pg_proc WHERE oid = v_sig::regprocedure) <> 'postgres'::regrole THEN
      RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_PROPOSALS_OWNER: %', v_sig;
    END IF;
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY[
    'public._product_parent_base_name(text)', 'public._product_parent_loose_key(text)',
    'public._product_parent_suggested_role(text,text,boolean)', 'public._product_parent_group_members(uuid[])',
    'public._product_parent_group_shape(uuid[])', 'public._close_product_parent_proposal_if_done(uuid)',
    'public._parent_brand_event(uuid,uuid,text,text,jsonb,jsonb)',
    'public._move_group_brands(uuid,uuid[],jsonb,boolean,text)',
    'public._approve_product_parent_group(public.product_parent_proposals,jsonb,boolean)',
    'public._decide_product_parent_group(uuid,bigint,text,text,text)',
    'public.refuse_product_parent_brand_event_mutation()', 'public._product_parent_grouping_open()'] LOOP
    IF (SELECT array_agg(DISTINCT grantee::regrole::text ORDER BY grantee::regrole::text)
          FROM pg_proc p, aclexplode(p.proacl) WHERE p.oid = v_sig::regprocedure AND privilege_type = 'EXECUTE')
       IS DISTINCT FROM ARRAY['postgres']
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_sig::regprocedure) IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_PROPOSALS_HELPER: %', v_sig;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE oid IN (SELECT oid FROM pg_proc WHERE proname = 'upsert_product_brand'
        AND pronamespace = 'public'::regnamespace)) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_PROPOSALS_BRAND_WRITER_OVERLOAD';
  END IF;
  IF public._product_parent_grouping_open() THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRODUCT_PARENT_PROPOSALS_SWITCH_ON: grouping must ship off';
  END IF;
END;
$postflight$;
