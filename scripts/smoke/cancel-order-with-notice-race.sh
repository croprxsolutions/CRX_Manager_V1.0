#!/bin/sh
# Run inside the guarded local Docker database container. The caller seeds the two orders.
set -eu
first_admin="$1"
second_admin="$2"
distinct_order="$3"
same_order="$4"
eligibility_order="$5"
tag="$6"
psqlq() { psql -U supabase_admin -d postgres -XqAt -v ON_ERROR_STOP=1 "$@"; }
scratch=$(mktemp -d)
trap 'rm -f "$scratch/first" "$scratch/second"; rmdir "$scratch"' EXIT

prove_pair() {
  mode="$1"
  order_id="$2"
  second_actor="$3"
  first_key="$tag-$mode-first"
  second_key="$4"
  first="cancel-proof-$tag-$mode-a"
  second="cancel-proof-$tag-$mode-b"
  first_action="SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '$first_admin';
    SELECT public.cancel_order_with_notice('$order_id', NULL, '$first_key');"
  if [ "$mode" = eligibility ]; then
    first_action="SELECT id FROM public.orders WHERE id = '$order_id' FOR UPDATE;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '$first_admin';
      SELECT public.admin_update_profile('$second_admin', new_is_active => false, p_idempotency_key => '$tag-deactivate');"
  fi

  PGAPPNAME="$first" psqlq >"$scratch/first" <<SQL &
BEGIN;
$first_action
RESET ROLE;
DO \$wait\$
DECLARE deadline timestamptz := clock_timestamp() + interval '20 seconds';
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '$second'
      AND pg_backend_pid() = ANY(pg_blocking_pids(pid)));
    IF clock_timestamp() >= deadline THEN RAISE EXCEPTION 'Second cancellation did not block'; END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END;
\$wait\$;
COMMIT;
SQL
  pid_first=$!
  ready=false
  for attempt in $(seq 1 40); do
    if [ "$(psqlq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='$first' AND wait_event='PgSleep'")" = 1 ]; then
      ready=true
      break
    fi
    sleep 0.15
  done
  if [ "$ready" != true ]; then wait "$pid_first"; return 1; fi

  PGAPPNAME="$second" psqlq >"$scratch/second" <<SQL &
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '$second_actor';
SELECT public.cancel_order_with_notice('$order_id', NULL, '$second_key');
COMMIT;
SQL
  pid_second=$!
  wait "$pid_first"
  wait "$pid_second"

  first_response=$(cat "$scratch/first")
  second_response=$(cat "$scratch/second")
  if [ "$mode" = eligibility ]; then
    first_response="$second_response"
    test "$(psqlq -c "SELECT NOT is_active AND NOT EXISTS (SELECT 1 FROM public.notifications
      WHERE related_entity_id = '$order_id' AND notification_type = 'order_status' AND user_id = '$second_admin')
      FROM public.profiles WHERE id = '$second_admin';")" = t
  fi
  test "$(psqlq -c "SELECT '$first_response'::jsonb->'success' = 'true'::jsonb
    AND (SELECT status = 'cancelled' FROM public.orders WHERE id = '$order_id')
    AND (SELECT count(*) FROM public.notifications WHERE notification_type = 'order_status' AND related_entity_id = '$order_id')
      = (SELECT count(*) FROM public.profiles WHERE role = 'admin' AND is_active)
    AND NOT EXISTS (SELECT 1 FROM public.notifications WHERE notification_type = 'order_status'
      AND related_entity_id = '$order_id' AND created_by IS DISTINCT FROM '$first_admin');")" = t
  if [ "$mode" = same ]; then
    test "$first_response" = "$second_response"
  elif [ "$mode" = distinct ]; then
    test "$(psqlq -c "SELECT NOT ('$second_response'::jsonb ? 'success') AND '$second_response'::jsonb->>'status' = 'cancelled';")" = t
  fi
  printf 'LOCAL_CANCEL_RACE_%s_PASS\n' "$mode"
}

prove_pair distinct "$distinct_order" "$second_admin" "$tag-distinct-second"
prove_pair same "$same_order" "$first_admin" "$tag-same-first"
prove_pair eligibility "$eligibility_order" "$first_admin" "$tag-eligibility"
