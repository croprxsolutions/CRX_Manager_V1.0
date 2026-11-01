# CRX clean-rebuild schema baseline

This directory is the supported way to initialize a **new** Supabase project at
the production schema high-water recorded in `manifest.json`. The older files in
`supabase/migrations/` remain the immutable audit trail, but they are not a safe
from-zero rebuild path: some historical files intentionally bind to production
data or to byte-exact function bodies that include legacy line endings.

The baseline contains no CRX business rows. It contains schema, grants, RLS
policies, functions, triggers, Storage bucket definitions, and a compact
version/name migration ledger. `npm run test:schema-baseline` checks every
artifact hash, count, high-water, empty-ledger guard, and credential scan.
The public schema dump is stored as `*_public_schema.sql.br` using Brotli. Its
manifest entry binds both the compressed artifact and the exact decompressed SQL
bytes. The decoded dump intentionally retains mixed line endings embedded in a
small set of legacy function bodies, so content-bound guards remain identical on
every operating system.

## Restore a new project

Use a platform-initialized Supabase PostgreSQL 17 project. Apply these files in
the exact `manifest.json.restore_order` sequence with a fail-fast SQL client:

1. `*_extensions.sql`
2. `*_public_schema.sql.br`, streamed through the repository decoder
3. `*_acl_lockdown.sql`
4. `*_platform_overlay.sql`
5. `*_cron_jobs.sql`
6. `*_migration_history.sql`

For step 2, run the decoder from the repository root and pipe its binary-safe
stdout directly to the fail-fast SQL client:

```bash
node scripts/decompress-schema-baseline.mjs | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

The decoder refuses to emit SQL unless both the compressed and decompressed
manifest hashes match.

The first artifact creates the production-specific `metabase_ro` NOLOGIN role
when it is absent, before the decoded schema restores grants to that role. Run
the restore as the project owner so role creation is permitted. Every artifact
must use `ON_ERROR_STOP=1`; do not continue from a partially restored project.

Step 3 is the ACL lockdown, and it is a security control, not bookkeeping. A
schema dump can only `GRANT`. A new Supabase project ships `ALTER DEFAULT
PRIVILEGES` that hand `anon` — the unauthenticated role — full CRUD on every table
and `EXECUTE` on every function `postgres` creates, and `REVOKE ... FROM PUBLIC`
does **not** strip a role-specific grant. Restoring the schema alone therefore
leaves `anon` holding privileges production revoked, and leaves default privileges
that would re-grant them to every future migration. The lockdown revokes the
Supabase-managed roles down to nothing, re-applies production's exact grants, and
restores production's default privileges.

Those grants include **column-level** ones, and they are not optional. `REVOKE ALL ON
ALL TABLES` strips column privileges along with table ones, so the reset removes them
and only the capture puts them back. Production gives `authenticated` no table-level
`INSERT` or `UPDATE` on `public.products`; 27 column grants are its entire write path,
and a baseline that omits them restores a project where nobody can edit a Product.
Granting the table instead would fix the app and widen access in the same stroke — do
not do that. The `column_acl` fingerprint exists to catch exactly this.

The lockdown ends with two guards.
`BASELINE_ACL_ANON_OVER_GRANTED` fires if `anon` still holds anything beyond
`SELECT`/`MAINTAIN` on a table — counting privileges granted to `PUBLIC`, because
`anon` inherits those. `BASELINE_ACL_ANON_EXECUTE_DRIFTED` fires if `anon` holds
`EXECUTE` on anything other than the exact set of functions captured. Functions
cannot be guarded the way tables are: production legitimately grants `anon`
`EXECUTE` on part of the schema — that is the PostgREST `/rpc/` surface — so
"`anon` holds no `EXECUTE`" would reject live's own state. The guard therefore
embeds the captured function identities and compares the **set**, in both
directions, folding `PUBLIC`-granted `EXECUTE` in because `anon` inherits it. A
count would not do: a refreshed capture that swapped one RPC for a different,
more sensitive one leaves the total untouched while moving what an
unauthenticated caller can reach. Restoring the public
schema alone leaves `anon` holding `EXECUTE` on **all 527** non-extension public
functions; the lockdown cuts that to the **95** production grants. Extension-owned
functions are excluded throughout: they belong to `supabase_admin`, the project
owner cannot revoke them, and the baseline does not manage them. The lockdown is
idempotent and safe to re-run.

The platform overlay restores the CRX-owned `auth.users` profile trigger, all
CRX Storage policies, and bucket configuration after the public functions and
tables they reference exist. It is **not** re-appliable, and says so: it drops only
the policy names live holds today, so applying it over an older baseline's policies
would leave those retired names in force, and policies are OR'ed — a retired
unscoped policy surviving beside its scoped replacement silently widens access. A
second apply raises `BASELINE_PLATFORM_RESTORE_REQUIRES_ABSENT_BUCKETS`. The
history restore refuses a non-empty
`supabase_migrations.schema_migrations` table; never clear a real ledger merely
to make it run.
The cron restore similarly refuses any existing job with one of the eight CRX
job names, then verifies each schedule and command exactly.

After the restore, do **not** select pending migrations by filename timestamp
alone. Supabase assigns its own ledger version when a migration is applied through
the Management API, so filename timestamps and ledger versions are not in 1:1
correspondence across this repository's history. Generate the exact post-baseline
list from both version and captured name:

```bash
node scripts/list-post-baseline-migrations.mjs
```

The selector also reads `supabase/baselines/one-shot-migrations.json`. Migrations
registered there rewrote a production-specific row population and are withheld
from the normal replay plan; each withheld filename and reason is printed to
stderr so the omission is never silent. `--include-one-shot` is an explicit
escape hatch only for a target whose population has been independently proven
to match the population originally approved. A normal data restore already
contains those corrected values and must not replay the rewrite.

Each withheld migration is still recorded in the target's ledger, without being
run, at its place in the order. The push below does that with `supabase migration
repair <version> --status applied`, which changes only migration history, not
business rows. The order matters in both directions: `20260807215532` refuses a
ledger holding anything newer than itself, and `20261010120000` refuses to run
until `20261007150200_release_reservations_of_deleted_spring_orders` is in the
ledger under that whole name. So do not run the `--one-shot-repair-plan` commands
on their own against a restore. They record everything at once, and from the
repository they store the short name.

Do not execute the emitted files directly with `psql`: that changes the schema
without recording the migrations in `supabase_migrations.schema_migrations`.
Instead, build an isolated Supabase CLI workdir and push through it. Run this from
the repository root, in bash, with `psql` on the path. Put the password in
`PGPASSWORD`, not in `DATABASE_URL`, so it stays out of the process list. It is proven
with `supabase --version` 2.109.1 forwarding to a `supabase-go` binary at 2.106.0 (the
CLI is those two programs, and `SUPABASE_GO_BINARY` can point at the second). It stops
by itself on production, on a ledger that is not this baseline's, and if a dry run
differs from the approved list.
`LOCAL_DB_PORT` is for a local container only; leave it unset for a hosted project.

```bash
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to the restored target}"
: "${PGPASSWORD:?set PGPASSWORD; keep the password out of DATABASE_URL}"
case "${DATABASE_URL,,}" in
  *rhyzpcqhnizqbxphqdkr*) echo "This is production. Stopping." >&2; exit 1 ;;
  *://*:*@*) echo "The password belongs in PGPASSWORD. Stopping." >&2; exit 1 ;;
esac
push_dir="$(mktemp -d)"
trap 'rm -rf "$push_dir"' EXIT
migrations_dir="$push_dir/supabase/migrations"
mkdir -p "$migrations_dir"

# Not `supabase init`: it writes a [local_smtp] block that push then refuses to parse.
printf 'project_id = "crx-post-baseline-push"\n' > "$push_dir/supabase/config.toml"
if [ -n "${LOCAL_DB_PORT:-}" ]; then
  printf '\n[db]\nport = %s\n' "$LOCAL_DB_PORT" >> "$push_dir/supabase/config.toml"
fi

# The CLI stops on a ledger row with no file, so each gets an empty stand-in.
psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c 'SELECT version FROM supabase_migrations.schema_migrations' | tr -d '\r' |
while IFS= read -r version; do
  : > "$migrations_dir/${version}_in_baseline_ledger.sql"
done

# The baseline holds this body with LF; 20260817120000 pins the CRLF text live held.
cat > "$push_dir/crlf_body.sql" <<'SQL'
DO $crlf$ BEGIN
  EXECUTE replace(pg_get_functiondef(
    'public._close_undelivered_order_remainder_20260718(uuid,uuid)'::regprocedure),
    chr(10), chr(13) || chr(10));
END $crlf$;
SQL

# The name holds the whole stem, because that is what live's ledger stores and what
# later migrations look for. `git show` gives the committed bytes on any operating
# system. Live ran each file in one transaction and the CLI does not, so add it here.
stage_file() {
  local body="$push_dir/body.sql" target="$migrations_dir/${1:0:14}_$1.sql"
  {
    if [ "${1:0:14}" = 20260817120000 ]; then cat "$push_dir/crlf_body.sql"; fi
    git show "HEAD:supabase/migrations/$1.sql"
  } > "$body"
  if grep -qiE '^[[:space:]]*(BEGIN|START[[:space:]]+TRANSACTION)[[:space:]]*;' "$body"; then
    cp "$body" "$target"
  else
    { printf 'BEGIN;\n'; cat "$body"; printf '\n;COMMIT;\n'; } > "$target"
  fi
}

pending=""
push_pending() {
  local db_push=(--workdir "$push_dir" db push --db-url "$DATABASE_URL" --include-all)
  local planned
  supabase "${db_push[@]}" --dry-run > "$push_dir/dry_run.txt" 2>&1 ||
    { cat "$push_dir/dry_run.txt" >&2; exit 1; }
  planned="$(grep -oE '[0-9]{14}_[^[:space:]]+\.sql' "$push_dir/dry_run.txt" || true)"
  if [ "$planned" != "$pending" ]; then
    echo "The dry run differs from the approved list. Nothing was pushed." >&2
    exit 1
  fi
  if [ -n "$pending" ]; then supabase "${db_push[@]}" --yes; fi
  pending=""
}

{
  node scripts/list-post-baseline-migrations.mjs | sed 's#.*/##; s/\.sql$/ push/'
  node -p "Object.keys(require('./supabase/baselines/one-shot-migrations.json').one_shot).join('\n')" |
    sed 's/$/ record/'
} | LC_ALL=C sort > "$push_dir/plan.txt"

# Up to the high-water the ledger must equal the baseline's. Past it, it may hold only this
# plan's rows, each filed under its own version. Any other history is not this restore.
high_water="$(node -p "require('./supabase/baselines/manifest.json').migrations_high_water")"
awk -F'\t' '/^COPY /{on=1; next} /^\\\.$/{on=0} on{print $1 "\t" $2}' \
  "supabase/baselines/${high_water}_migration_history.sql" | tr -d '\r' |
  LC_ALL=C sort > "$push_dir/baseline_ledger.txt"
psql "$DATABASE_URL" -X -At -F $'\t' -v ON_ERROR_STOP=1 \
  -c "SELECT version, name FROM supabase_migrations.schema_migrations WHERE version <= '$high_water'" |
  tr -d '\r' | LC_ALL=C sort | cmp -s - "$push_dir/baseline_ledger.txt" ||
  { echo "The ledger is not this baseline's. Stopping." >&2; exit 1; }
psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT CASE WHEN left(name, 14) = version THEN name ELSE version || ' ' || name END
      FROM supabase_migrations.schema_migrations WHERE version > '$high_water'" | tr -d '\r' |
while IFS= read -r name; do
  cut -d' ' -f1 "$push_dir/plan.txt" | grep -qxF -- "$name" ||
    { echo "Unexpected ledger row: $name. Stopping." >&2; exit 1; }
done

while read -r stem action <&3; do
  version="${stem:0:14}"
  # Already in the ledger: a rerun after a failure carries on from here.
  if [ -e "$migrations_dir/${version}_in_baseline_ledger.sql" ]; then continue; fi
  if [ "$action" = push ]; then
    stage_file "$stem"
    pending="${pending:+$pending$'\n'}${version}_$stem.sql"
  else
    push_pending
    : > "$migrations_dir/${version}_$stem.sql"
    supabase --workdir "$push_dir" migration repair "$version" --status applied \
      --db-url "$DATABASE_URL"
  fi
done 3< "$push_dir/plan.txt"
push_pending

supabase --workdir "$push_dir" migration list --db-url "$DATABASE_URL"
```

The temporary workdir is mandatory: never run an unfiltered `supabase db push`
from the CRX repository against a restored baseline. If it stops partway, every
file that finished is already in the ledger, so fix the cause and run the same
block again. Check the `migration list` output, regenerate
`.claude/schema-registry.json` from that database, and run the normal schema/live
tests and DB invariant sweeps.

The table says what each target needs. Only the right-hand column has been run; no
part of this has run on a hosted project.

| What the block does | Real disaster recovery | Empty local test copy |
| --- | --- | --- |
| Hand-written `config.toml`, no `supabase init` | Yes | Yes |
| `[db]` port from `LOCAL_DB_PORT` | No. A hosted project uses TLS. | Yes. It is how the CLI skips TLS. |
| Empty stand-ins for ledger rows | Yes | Yes |
| One transaction per file | Yes | Yes |
| `<version>_<whole file name>` naming | Yes | Yes |
| One-shots recorded in order | Yes, then prove them (below) | Yes. No business rows, so nothing to prove. |
| CRLF function body | Yes. The gap is in the baseline itself. | Yes |

Two things sit outside the block and differ by target:

- **A quiet database.** `20260816120000` and `20260914101300` refuse to run beside
  another open transaction. On the local test copy, stop the login, data and storage
  services first (`scripts/local-app/app.mjs` does). On a hosted project those
  services cannot be stopped from here, so keep the app and every other client off
  the project. If either file raises its `_NOT_QUIET` error, wait for that
  transaction to end and run the block again.
- **The data proof.** A real restore must load business data after this push, because
  the backup fits the final schema, not the baseline's, and the migrations must not
  edit restored rows. That means each one-shot is recorded before its correction can
  be seen. Until the proof below passes, those ledger rows are a claim, not a fact, so
  keep the target closed, including after an interrupted run. Before allowing writes,
  prove the restored data contains every registered correction. If it does not, the
  restore has failed: do not open it. The registry says what each correction was, but
  no written check exists yet for each one, and the test copy has no business rows, so
  this order has only been run on an empty database.

## Data recovery

This is a schema baseline, not a business-data backup. For disaster recovery,
restore the separately protected Supabase data backup using the official
backup/restore procedure, then run row-count and financial/inventory invariant
checks before allowing writes. Do not load production data into an ordinary
development or preview project.

## Refreshing the baseline

Refresh only from reviewed live introspection after the migration ledger has
settled. **Never edit an applied migration to make a fresh rebuild pass.**

All capture is read-only against production. Capture into a scratch work
directory, then assemble; keeping the two steps apart is what makes the assembly
deterministic and reviewable.

1. **Public schema** — raw `pg_dump --schema=public --schema-only
   --quote-all-identifiers --no-owner`, normalized by
   `scripts/build-schema-baseline-public.mjs` into `public_schema.sql`. Do not use
   `supabase db dump` here: it post-processes the dump and strips `--` comment
   lines out of function bodies, which silently changes the source of every
   function that carries an inline comment.
2. **ACL lockdown** — `psql -At -f scripts/schema-baseline-acl.sql` against live,
   piped to `scripts/build-schema-baseline-acl.mjs`. That SQL emits one `GRANT`
   per (object, grantee) plus production's `ALTER DEFAULT PRIVILEGES`, in a
   deterministic order, for `anon`, `authenticated`, `service_role`,
   `metabase_ro`, and `PUBLIC`. Table, column, routine, and default-privilege
   grants are each split by `is_grantable` so a `WITH GRANT OPTION` is reproduced
   rather than flattened into a plain grant. Production holds none today, so this
   changes no output — which is the point: the capture must not be the reason a
   future one is lost.
3. **Platform overlay, bucket snapshot, and compact ledger** — as before, via
   `scripts/build-schema-baseline-platform.mjs` and
   `scripts/build-schema-baseline-history.mjs`.
4. **Fingerprints** — `psql -At -F'=' -f scripts/schema-baseline-fingerprints.sql`
   against the **restored baseline**, into `baseline_fingerprints.txt`. The manifest
   binds this file's own SHA-256, so redefining what "matches production" means fails
   the gate. Capture these from the restore rather than from live: the two agree only
   while no migration has applied since the artifacts were dumped, and the moment one
   has, a capture taken from live records digests that no object in the published
   baseline actually has. That is not a hypothetical — it happened during this refresh,
   when `quote_and_rate_reads_office_only` applied to production between the capture and
   the proof and moved `relations_and_acl` and `policy_contracts` out from under it.

Then prove it. Restore the artifacts in `restore_order` into a throwaway
PostgreSQL 17 container (`public.ecr.aws/supabase/postgres`), and require **all
thirteen fingerprints to match the manifest**, not just the counts — then replay
every post-baseline migration onto that restore and require all thirteen to match
**live**. The second half is the claim disaster recovery actually rests on: baseline
plus ledger reproduces production. Comparing a bare restore to live is a weaker
statement that happens to hold only while nothing has applied since the dump, so it
passes for the wrong reason on a quiet night and fails on a busy one.

Three of the thirteen exist because the obvious eight missed real drift: `column_acl`
covers production's column-level grants, which `relations_and_acl` cannot see because
it records only table-level `relacl`; `view_definitions` covers each view's query and
`reloptions`, without which a view could lose `security_invoker` and start running with
owner privileges while every other digest stayed identical; and `default_acl` covers
`pg_default_acl`, which no ACL digest can reach because a default privilege is a
standing instruction about the *next* object rather than a grant on any existing one.
That one is not theoretical here — this project's `public` schema carries the stock
Supabase rule handing `anon` `EXECUTE` on every function `postgres` creates, which is
the exact mechanism the ACL lockdown exists to contain.

Six of the thirteen also carry fields the obvious definition omits, all for one
reason — a catalog's rendered text describes what an object *is*, not whether it is
*in force*:

| Digest | Extra fields | What is otherwise invisible |
| --- | --- | --- |
| `columns` | `attidentity`, `attgenerated` | identity/generated semantics live in `pg_attribute`, not in type/not-null/default |
| `indexes` | `indisvalid` | a failed `CREATE INDEX CONCURRENTLY` renders the same definition and enforces no UNIQUE constraint |
| `relations_and_acl` | `relforcerowsecurity`, `relpersistence`, plus `storage.objects` in scope | RLS enabled without FORCE still lets the owner bypass every policy; an `UNLOGGED` table loses its rows on crash; and PostgreSQL keeps a table's policies whether or not RLS is switched on, so `storage.objects` with RLS off leaves all 27 Storage policies present and `policy_contracts` byte-identical while every read falls through to the table grants |
| `triggers` | `tgenabled` | a disabled or `REPLICA`-mode trigger describes itself identically and fires for nothing |
| `function_security` | `pg_get_function_arguments`, `pg_get_function_result`, `prokind`, `proisstrict`, `proleakproof`, `lanname` | the identity form drops argument defaults and never mentions the result type; strictness, `CALL`-vs-`SELECT`, and leakproofness (which lets the planner push a function below an RLS predicate) are all out-of-body behavior; and a function's language is not in its body, so the same `prosrc` accepted as PL/pgSQL instead of SQL moves neither function digest and raises `syntax error at or near "SELECT"` the first time anything calls it |
| `cron_contracts` | `active`, `username` | a deactivated job, or one running as a different role, has the same schedule and command |

Also require the history
file's second application to raise `BASELINE_HISTORY_RESTORE_REQUIRES_EMPTY_LEDGER`,
the cron file's second application to raise
`BASELINE_CRON_RESTORE_REQUIRES_ABSENT_JOBS`, the platform overlay's second
application to raise `BASELINE_PLATFORM_RESTORE_REQUIRES_ABSENT_BUCKETS`, the ACL
lockdown to re-apply cleanly, and any post-baseline migration to replay onto the
result. Eight of the required proofs are **negative** tests, because a positive match
cannot show that a guard would have noticed anything. On the restored database:

1. Swap one captured `anon` `EXECUTE` grant for a different function and confirm
   `BASELINE_ACL_ANON_EXECUTE_DRIFTED` still raises. Revoke it from `PUBLIC` as well as
   from `anon`, or the effective set is unchanged and the swap is not really a swap.
2. Flip an identity column from `GENERATED ALWAYS` to `GENERATED BY DEFAULT` and confirm
   `columns` moves. Use `SET GENERATED`, not a `DROP IDENTITY`: dropping it also destroys
   the implicit sequence, which `relations_and_acl` already catches, so it would not be
   testing `columns` at all.
3. Change one RPC argument default and confirm `function_security` moves.
4. Disable one trigger and confirm `triggers` moves.
5. Re-create one function with the same body and grants but a different result type, and
   confirm `function_security` moves.
6. `ALTER TABLE storage.objects DISABLE ROW LEVEL SECURITY` and confirm
   `relations_and_acl` moves. Check that the policies are still all there while it is
   off — that is the whole point, and it is why `policy_contracts` alone cannot stand in
   for this.
7. Change one `pg_default_acl` entry and confirm `default_acl` moves, and that it is the
   only one of the thirteen that does.
8. Re-create one SQL function as `plpgsql` with byte-identical source and grants, and
   confirm `function_security` moves while `function_canonical_source` does not. Live
   `prosrc` here is CRLF-wrapped, so re-create it with an `E'...'` literal carrying the
   original `\r\n`; a naive dollar-quoted body is a different string and moves the source
   digest for the wrong reason. Creating it needs `SET check_function_bodies = off`.

Each of those leaves the naive form of its check untouched — the count stays at 95, and
the pre-fix `columns`, `triggers`, `relations_and_acl`, and `function_security`
definitions returned byte-identical digests across the drifts aimed at them — so a
refresh that recorded only the positive match would have proven nothing. Record each as a
`true` flag in `disposable_restore_proof`.
`verify-schema-baseline.mjs` holds a hard-coded list of the required flags and
fails if any is missing or not `true` — it does not iterate whatever keys happen to
be present, because a proof that simply omitted the checks it failed would
otherwise pass. A half-finished refresh cannot be published as if it were proven.

Finally run `node scripts/assemble-schema-baseline.mjs <work-dir> <high-water>`,
delete the superseded artifacts, and run `npm run test:schema-baseline`.

A note on the container: the stock `supabase/postgres` image ships whatever
GoTrue/storage schema it was cut at, which is not the version live runs. Drop its
`auth` and `storage` schemas and replace them with live-introspected DDL before
restoring, or the overlay will fail on columns the image's `auth.users` does not
have. In that image `postgres` is not a superuser — `supabase_admin` is — so the
platform prerequisites are applied as `supabase_admin -d postgres` and everything
else as `postgres`.
