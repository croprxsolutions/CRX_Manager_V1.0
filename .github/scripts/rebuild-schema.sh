#!/usr/bin/env bash
# Rebuild the database schema from this repo on a THROWAWAY local Supabase: the baseline, the reference
# rows the baseline can't carry, then every post-baseline migration in stamp order (one-shot data
# migrations recorded, never run). Same steps as Taha's local-supabase/rebuild.sh, without users or seed
# data. The schema check (db-apply.mjs schema) then compares this database with staging.
# Usage: rebuild-schema.sh <work dir>   (prints REBUILT_DB_URL=... last; refuses anything but 127.0.0.1)
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
W="$(cd "${1:?usage: rebuild-schema.sh <work dir>}" && pwd)"
SB=(npx --yes supabase@2.122.0)
PORT="${REBUILD_PORT_BASE:-54320}"   # local runs pick a free range; CI keeps the defaults

mkdir -p "$W/supabase"
cat > "$W/supabase/config.toml" <<EOF
project_id = "crx-rebuild"
[api]
port = $((PORT + 1))
[db]
port = $((PORT + 2))
shadow_port = $((PORT + 0))
major_version = 17
[db.pooler]
port = $((PORT + 9))
[studio]
enabled = false
port = $((PORT + 3))
[inbucket]
enabled = false
port = $((PORT + 4))
[analytics]
enabled = false
port = $((PORT + 7))
[realtime]
enabled = false
[edge_runtime]
enabled = false
EOF
(cd "$W" && "${SB[@]}" start -x imgproxy,postgres-meta,vector,supavisor >/dev/null)
DB="$(cd "$W" && "${SB[@]}" status -o env | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
case "$DB" in postgresql://postgres:postgres@127.0.0.1:*) ;; *) echo "::error::rebuild: refusing database URL '$DB'"; exit 1 ;; esac
psqlq() { psql "$DB" -X -q -v ON_ERROR_STOP=1 "$@"; }

B="$REPO/supabase/baselines"
HW="$(node -p "require('$B/manifest.json').migrations_high_water")"
psqlq -f "$B/${HW}_extensions.sql"
(cd "$REPO" && node scripts/decompress-schema-baseline.mjs) | psqlq
psqlq -f "$B/${HW}_acl_lockdown.sql"
psqlq -f "$B/${HW}_platform_overlay.sql"
psqlq -f "$B/${HW}_cron_jobs.sql" >/dev/null
psqlq -c "CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY, statements text[], name text);"
psqlq -f "$B/${HW}_migration_history.sql"
python3 -I "$REPO/.github/scripts/rebuild/reference-data.py" "$REPO" "$W/reference-data.sql" >/dev/null
psqlq -f "$W/reference-data.sql"

ONESHOTS=" $(node -p "Object.keys(require('$B/one-shot-migrations.json').one_shot).join(' ')") "
n=0
for f in $(ls "$REPO"/supabase/migrations/*.sql | sort); do
  b="$(basename "$f" .sql)"; v="${b%%_*}"
  [[ "$b" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || continue
  [[ "$v" > "$HW" ]] || continue
  if [[ "$ONESHOTS" == *" $b "* ]]; then   # data migration bound to live rows: record only, at its place
    psqlq -c "INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('$v','$b');"; continue
  fi
  if [ "$b" = "20260817120000_carry_allocated_line_cents_through_lifecycle" ]; then
    # Live stores _close_undelivered_order_remainder_20260718 with CRLF; the baseline dump is LF.
    node "$REPO/.github/scripts/rebuild/crlf-shim.mjs" "$REPO/supabase/migrations/20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql" "$W/crlf-shim.sql"
    psqlq --single-transaction -f "$W/crlf-shim.sql"
  fi
  if [ "$b" = "20261104150000_product_forms_seed_each" ]; then
    # Live stores validate_product_units() with CRLF too (its preflight pins it); the baseline dump is LF.
    psqlq -c "DO \$\$ BEGIN EXECUTE replace(pg_get_functiondef('public.validate_product_units()'::regprocedure), E'\n', E'\r\n'); END \$\$;"
  fi
  ok=0
  for try in 1 2 3 4 5; do   # DRAW_DOWN_CUTOVER_NOT_QUIET: wait out background service transactions
    if psql "$DB" -X -q --single-transaction -v ON_ERROR_STOP=1 -f "$f" >"$W/last.log" 2>&1; then ok=1; break; fi
    grep -q NOT_QUIET "$W/last.log" || break; sleep 2
  done
  [ $ok = 1 ] || { echo "::error::rebuild failed at $b"; grep -E 'ERROR|CONTEXT' "$W/last.log" | head -20; exit 1; }
  psqlq -c "INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('$v','$b');"
  n=$((n + 1))
done
echo "rebuilt from baseline $HW + $n migrations"
echo "REBUILT_DB_URL=$DB"
