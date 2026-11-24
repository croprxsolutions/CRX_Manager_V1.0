-- Field marker types and applicator writes follow the existing marker read scope.
-- Stored entrance numbers do not move when an entrance is deleted.

ALTER TABLE public.field_obstacles
  DROP CONSTRAINT field_obstacles_kind_check,
  ADD CONSTRAINT field_obstacles_kind_check CHECK (kind IN (
    'oil_well', 'windmill', 'tower', 'tree_line', 'power_line', 'waterway', 'other',
    'field_entrance', 'washout', 'pole', 'garden', 'well', 'pivot', 'sensitive_crop', 'gate'
  )),
  ADD COLUMN entrance_number integer,
  ADD CONSTRAINT field_obstacles_entrance_number_check CHECK (
    CASE WHEN kind = 'field_entrance'
      THEN entrance_number IS NOT NULL AND entrance_number > 0
      ELSE entrance_number IS NULL
    END
  ),
  ADD CONSTRAINT field_obstacles_entrance_number_unique UNIQUE (field_id, entrance_number);

CREATE TABLE public.field_entrance_counters (
  field_id uuid PRIMARY KEY REFERENCES public.fields(id) ON DELETE CASCADE,
  last_number integer NOT NULL CHECK (last_number > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.field_entrance_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY field_entrance_counters_private ON public.field_entrance_counters
  AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
REVOKE ALL ON public.field_entrance_counters FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER set_field_entrance_counters_updated_at
  BEFORE UPDATE ON public.field_entrance_counters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER POLICY field_obstacles_insert ON public.field_obstacles
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND (
      (SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
      OR ((SELECT public.is_applicator()) AND public._can_see_field(field_id))
    )
  );

ALTER POLICY field_obstacles_update ON public.field_obstacles
  USING (
    (SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
    OR ((SELECT public.is_applicator()) AND created_by = (SELECT auth.uid()) AND public._can_see_field(field_id))
  )
  WITH CHECK (
    (SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
    OR ((SELECT public.is_applicator()) AND created_by = (SELECT auth.uid()) AND public._can_see_field(field_id))
  );

ALTER POLICY field_obstacles_delete ON public.field_obstacles
  USING (
    (SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
    OR ((SELECT public.is_applicator()) AND created_by = (SELECT auth.uid()) AND public._can_see_field(field_id))
  );

-- Owner privileges are needed only to maintain the private counter. Check the
-- actual caller before touching it because BEFORE triggers precede RLS checks.
CREATE FUNCTION public.set_field_marker_write_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_point jsonb;
  v_coordinates jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := v_actor;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
  ELSE
    IF ROW(NEW.id, NEW.field_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.field_id, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'FIELD_MARKER_IDENTITY_IMMUTABLE' USING ERRCODE = '22023';
    END IF;
    NEW.updated_at := greatest(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  END IF;

  IF TG_OP = 'INSERT' OR NEW.point_geojson IS DISTINCT FROM OLD.point_geojson THEN
    v_point := NEW.point_geojson;
    v_coordinates := v_point -> 'coordinates';
    IF v_point ->> 'type' IS DISTINCT FROM 'Point'
       OR jsonb_typeof(v_coordinates) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'FIELD_MARKER_POINT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_coordinates) <> 2
       OR jsonb_typeof(v_coordinates -> 0) IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_coordinates -> 1) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'FIELD_MARKER_POINT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF (v_coordinates ->> 0)::numeric NOT BETWEEN -180 AND 180
       OR (v_coordinates ->> 1)::numeric NOT BETWEEN -90 AND 90 THEN
      RAISE EXCEPTION 'FIELD_MARKER_POINT_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF char_length(NEW.label) > 500 AND public.is_applicator()
     AND (TG_OP = 'INSERT' OR NEW.label IS DISTINCT FROM OLD.label) THEN
    RAISE EXCEPTION 'FIELD_MARKER_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  IF NEW.kind <> 'field_entrance' THEN
    NEW.entrance_number := NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD.kind = 'field_entrance' THEN
    NEW.entrance_number := OLD.entrance_number;
  ELSE
    IF NOT (
      public.is_admin() OR public.is_sales_rep()
      OR (
        public.is_applicator() AND NEW.created_by IS NOT DISTINCT FROM v_actor
        AND public._can_see_field(NEW.field_id)
      )
    ) THEN
      RAISE EXCEPTION 'FIELD_MARKER_ACCESS_REQUIRED' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.field_entrance_counters AS c (field_id, last_number)
    VALUES (NEW.field_id, 1)
    ON CONFLICT (field_id) DO UPDATE SET last_number = c.last_number + 1
    RETURNING last_number INTO NEW.entrance_number;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_field_marker_write_metadata() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER set_field_obstacles_updated_at ON public.field_obstacles;
CREATE TRIGGER set_field_marker_write_metadata
  BEFORE INSERT OR UPDATE ON public.field_obstacles
  FOR EACH ROW EXECUTE FUNCTION public.set_field_marker_write_metadata();

-- A single snapshot distinguishes an empty authorized field from an RLS-hidden field.
CREATE FUNCTION public.get_field_marker_read(p_field_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT CASE WHEN (
    (SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
    OR ((SELECT public.is_applicator()) AND public._can_see_field(p_field_id))
  ) AND EXISTS (SELECT 1 FROM public.fields WHERE id = p_field_id)
  THEN (
    SELECT jsonb_build_object(
      'available', true,
      'count', count(*),
      'markers', coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.created_at, m.id), '[]'::jsonb)
    )
    FROM (
      SELECT id, field_id, kind, label, point_geojson, created_by, created_at, updated_at, entrance_number
      FROM public.field_obstacles
      WHERE field_id = p_field_id
    ) AS m
  )
  ELSE jsonb_build_object('available', false)
  END;
$function$;

REVOKE ALL ON FUNCTION public.get_field_marker_read(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_field_marker_read(uuid) TO authenticated;
