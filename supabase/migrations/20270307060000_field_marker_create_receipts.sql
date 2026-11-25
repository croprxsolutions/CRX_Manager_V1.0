-- Keep a pin's create identity after deletion so an uncertain save cannot restore it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE public.field_marker_create_receipts (
  id uuid PRIMARY KEY,
  field_id uuid NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_field_marker_create_receipts_field_id
  ON public.field_marker_create_receipts(field_id);

ALTER TABLE public.field_marker_create_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.field_marker_create_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.field_marker_create_receipts TO authenticated;

CREATE POLICY field_marker_create_receipts_select_own
  ON public.field_marker_create_receipts FOR SELECT TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    AND (
      (SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
      OR ((SELECT public.is_applicator()) AND public._can_see_field(field_id))
    )
  );

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.field_marker_create_receipts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- The existing BEFORE trigger binds the author to auth.uid(), which the INSERT policy checks.
-- Only this trigger needs the ability to claim new IDs in the receipt table.
CREATE FUNCTION public.record_field_marker_create_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.field_marker_create_receipts (id, field_id, created_by)
    VALUES (NEW.id, NEW.field_id, NEW.created_by)
    ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    -- Receipt details are available only through the authorized result read.
    RAISE unique_violation USING
      MESSAGE = 'duplicate key value violates unique constraint "field_obstacles_pkey"',
      SCHEMA = 'public',
      TABLE = 'field_obstacles',
      CONSTRAINT = 'field_obstacles_pkey';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_field_marker_create_receipt() FROM PUBLIC, anon, authenticated, service_role;

-- CREATE TRIGGER locks out pin writers until the existing identities are copied.
CREATE TRIGGER record_field_marker_create_receipt
  AFTER INSERT ON public.field_obstacles
  FOR EACH ROW EXECUTE FUNCTION public.record_field_marker_create_receipt();

INSERT INTO public.field_marker_create_receipts (id, field_id, created_by, created_at, updated_at)
  SELECT id, field_id, created_by, created_at, created_at
  FROM public.field_obstacles;

-- Check both receipt and current pin in the same snapshot.
CREATE FUNCTION public.get_field_marker_create_result(p_field_id uuid, p_marker_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object('state', CASE
    WHEN (
      ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep())
        OR ((SELECT public.is_applicator()) AND public._can_see_field(p_field_id)))
      AND EXISTS (SELECT 1 FROM public.fields WHERE id = p_field_id)
    ) IS NOT TRUE THEN 'unavailable'
    WHEN NOT EXISTS (
      SELECT 1 FROM public.field_marker_create_receipts
      WHERE id = p_marker_id AND field_id = p_field_id AND created_by = (SELECT auth.uid())
    ) THEN 'missing'
    WHEN EXISTS (
      SELECT 1 FROM public.field_obstacles
      WHERE id = p_marker_id AND field_id = p_field_id AND created_by = (SELECT auth.uid())
    ) THEN 'saved'
    ELSE 'removed'
  END);
$function$;

REVOKE ALL ON FUNCTION public.get_field_marker_create_result(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_field_marker_create_result(uuid, uuid) TO authenticated;
