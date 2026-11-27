#!/bin/sh
# Run only inside the guarded local Docker database container.
set -eu
actor="$1"
farm="$2"
product="$3"
tag="$4"
for id in "$actor" "$farm" "$product"; do
  case "$id" in ''|*[!a-f0-9-]*) exit 2;; esac
  test "${#id}" -eq 36 || exit 2
done
test "$tag" = "local-credit-race-$farm" || exit 2
# Refuse anywhere but a container, and drop libpq overrides so psql can only reach the local socket.
test -f /.dockerenv || exit 2
unset PGHOST PGHOSTADDR PGPORT PGSERVICE PGSERVICEFILE PGDATABASE PGUSER PGOPTIONS
psqlq() { psql -U supabase_admin -d postgres -XqAt -v ON_ERROR_STOP=1 "$@"; }
scratch=$(mktemp -d)
trap 'rm -f "$scratch/first" "$scratch/second"; rmdir "$scratch"' EXIT
items="jsonb_build_array(jsonb_build_object('product_id','$product','product_name','Invented Race Product','quantity',1,'price_per_unit',30,'unit_size','Gal'))"

prove_pair() {
  mode="$1"
  first_call="$2"
  second_call="$3"
  first="credit-proof-$farm-$mode-a"
  second="credit-proof-$farm-$mode-b"
  PGAPPNAME="$first" psqlq >"$scratch/first" <<SQL &
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '$actor';
SELECT $first_call;
RESET ROLE;
DO \$wait\$
DECLARE deadline timestamptz := clock_timestamp() + interval '20 seconds';
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '$second'
      AND pg_backend_pid() = ANY(pg_blocking_pids(pid)));
    IF clock_timestamp() >= deadline THEN RAISE EXCEPTION 'Second credit request did not wait'; END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END;
\$wait\$;
COMMIT;
SQL
  first_pid=$!
  ready=false
  for attempt in $(seq 1 40); do
    if [ "$(psqlq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='$first' AND wait_event='PgSleep'")" = 1 ]; then
      ready=true
      break
    fi
    sleep 0.15
  done
  if [ "$ready" != true ]; then wait "$first_pid"; return 1; fi
  PGAPPNAME="$second" psqlq >"$scratch/second" <<SQL &
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '$actor';
SELECT $second_call;
COMMIT;
SQL
  second_pid=$!
  wait "$first_pid"
  wait "$second_pid"
  test "$(cat "$scratch/first")" = "$(cat "$scratch/second")"
}

new_save="public.create_direct_order_with_credit_notice('$farm',current_date,'Invented checked race',NULL,$items,'$actor','$tag-new',NULL)"
old_save="public.create_direct_order('$farm',current_date,'Invented legacy race',NULL,$items,'$actor','$tag-old',NULL)"
new_replay="public.create_direct_order_with_credit_notice('$farm',current_date,'Invented legacy race',NULL,$items,'$actor','$tag-old',NULL)"
notice="public.send_direct_order_credit_notice('$tag-new')"

prove_pair save "$new_save" "$new_save"
test "$(psqlq -c "SELECT count(*) FROM public.orders WHERE customer_id='$farm'")" = 1
printf 'LOCAL_CREDIT_RACE_SAVE_PASS\n'

prove_pair legacy "$old_save" "$new_replay"
test "$(psqlq -c "SELECT NOT (result ? '_direct_order_credit_notice') FROM public.idempotency_keys WHERE idempotency_key='$tag-old' AND operation='create_direct_order'")" = t
test "$(psqlq -c "SELECT count(*) FROM public.orders WHERE customer_id='$farm'")" = 2
printf 'LOCAL_CREDIT_RACE_LEGACY_PASS\n'

prove_pair notice "$notice" "$notice"
test "$(psqlq -c "SELECT
  (SELECT count(*) FROM public.notifications WHERE notification_type='credit_limit_exceeded' AND related_entity_id='$farm' AND created_by='$actor')
    = (SELECT count(*) FROM public.profiles WHERE role='admin' AND is_active)
  AND (SELECT count(DISTINCT user_id) FROM public.notifications WHERE notification_type='credit_limit_exceeded' AND related_entity_id='$farm' AND created_by='$actor')
    = (SELECT count(*) FROM public.profiles WHERE role='admin' AND is_active)
  AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.notification_type='credit_limit_exceeded' AND n.related_entity_id='$farm' AND n.created_by='$actor'
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=n.user_id AND p.role='admin' AND p.is_active))
  AND (SELECT result #>> '{_direct_order_credit_notice,handled}' = 'true' FROM public.idempotency_keys WHERE idempotency_key='$tag-new' AND operation='create_direct_order');")" = t
printf 'LOCAL_CREDIT_RACE_NOTICE_PASS\n'
