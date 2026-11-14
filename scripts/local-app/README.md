# The private test copy of the app (WP-PM-0)

A private copy of CRX Manager on this computer, so an agent can sign in, save and reload on invented
data. It has its own database, login, data and file services in Docker. Nothing here can reach
production, and nothing outside this computer can reach it. The rules are in the mission's WP-PM-0 row
(`docs/plans/2026-10-28-product-master-loop-MISSION.md`, section 5).

## Commands

### Chemical sales gauntlet (separate test copy)

Use `node scripts/local-app/sales.mjs rebuild`, then `node scripts/local-app/sales.mjs test` for the
chemical-sales browser journey. This is a separate Docker project (`crx-sales-gauntlet`) with its own
volumes and fixed loopback ports: app 5209, API 54821, database gateway 54822. The launcher does not
touch the shared `crx-local-app` stack. An older checkout without this launcher refuses rather than
interpreting a new option as a rebuild of the default copy. Unknown command options also refuse.

Its ignored settings, generated one-origin gateway config, build manifest and browser artifacts live
under `scripts/local-app/.state/sales-gauntlet/`. The settings contain three invented logins: admin,
sales rep and another sales rep. Default test-copy settings and its one-user check are unchanged.
Never put these generated files or credentials in a PR. The browser profile runs only
`chemical-sales.spec.ts`; the default suite excludes it. Marking a quote sent records its version;
this isolated copy sends no actual email. Stop the task-owned copy afterwards with
`node scripts/local-app/sales.mjs stop`.

The Supabase 2.109.1 installation needs both release executables, `supabase` and `supabase-go`.
A shim reporting 2.109.1 beside an older Go executable is insufficient. Put the complete official
release folder first on this task's PATH, or set `SUPABASE_GO_BINARY` to its matching companion;
the runner rejects a mismatched override. Before the invoice-brand migration, rebuild initializes
the empty registration catalog through the real generated-admin seed workflow. No numbered business
product is present at that point; business fixtures are seeded after all migrations finish.

Historical migration provers are separate from this latest-schema browser proof: passing a historical
candidate's before/after checks alone does not establish that today's sales workflow passes.

Run these from the root of a checkout. They need Docker running, `npm ci` done and Supabase CLI 2.109.1,
the version these steps are proven on.

| Command | What it does |
|---|---|
| `node scripts/local-app/app.mjs rebuild` | Erases the test copy and builds it again from this checkout (about a minute). |
| `node scripts/local-app/app.mjs start` | Starts it at `http://127.0.0.1:5199`. |
| `node scripts/local-app/app.mjs test` | Runs the browser proof: sign in, save a test product, reload, localhost only. |
| `node scripts/local-app/app.mjs status` | Says what is running and which commit and migrations it was built from. |
| `node scripts/local-app/app.mjs seed` | Puts the invented data back without erasing anything. |
| `node scripts/local-app/app.mjs stop` | Stops it and keeps its data. |
| `node scripts/local-app/app.mjs frontend --port 5201` | Runs this checkout's screens on a second port beside the shared copy. Ctrl+C stops it. |
| `node --test scripts/local-app/target.test.mjs` | Runs the refusal tests. Port 5199 must be free. |

Sign in with `LOCAL_TEST_EMAIL` and `LOCAL_TEST_PASSWORD` from `scripts/local-app/.state/local.env`.
That folder is generated, git-ignored and holds local keys only. Never copy it into a PR or a report.

There is one test copy per computer, and the last `rebuild` owns it. `start`, `seed` and `test` refuse a
checkout whose migrations differ from the test database. Before a package's decisive proof,
rebuild from that package's branch and copy the commit and migration count from `status` into the PROOF
line. `.state/build.json` holds the full migration list.

### A second copy of the screens on another port

When another session is using `127.0.0.1:5199`, check your branch's screens with
`node scripts/local-app/app.mjs frontend --port 5201`. Any port from 1024 to 65535 works except 5199, 54721
and 54722, or the sales copy's reserved 5209, 54821 and 54822. It uses the same test database and test user, and listens on `127.0.0.1` only. It runs every check
the other commands run, the 5199 check included. The browser calls `/_sb` on that same port and the frontend
passes the call on to the gateway, so the gateway still lets in only pages from 5199. Live updates do not
pass through, which changes nothing because the test copy has none.

It needs the settings file of the checkout that owns the test database. If your checkout has no
`scripts/local-app/.state/local.env`, copy that one file from the owning checkout's `scripts/local-app/.state/`.
The owner is the checkout whose `rebuild` ran last, usually the newest `local.env`. **Do not run `rebuild` to
get one:** that erases the shared test database under everyone else. The copy stays git-ignored, so keep it
out of PRs and reports like the original. The second copy shows this checkout's screens against the owner's
database, so it proves nothing about migrations this checkout adds.

## What keeps it away from production

- **Every command checks first.** It refuses a shell holding a live address or credential, saved settings
  that point anywhere but the fixed `127.0.0.1` ports or keys this test copy did not sign, a Docker on
  another machine, a frontend on port 5199 that is not wired to this test copy, a stack of the same name
  from somewhere else, and a gateway published beyond loopback. `target.mjs` holds the checks.
- **The frontend serves this checkout and nothing else.** Inside it, keys, `.env` files, `.state`, backups,
  the memory folder and every `.claude` folder return 403. The `.claude` rule is tied to this checkout's own
  path, so a checkout that lives under `.claude/worktrees/` still works and its parent's `.claude` stays out
  of reach because it is outside the checkout.
- **Commands pass on no credentials.** Child programs get a short list of variables, not the whole shell.
- **The frontend never reads a checkout's `.env`.** It sets the Supabase address and key itself, and sets
  the Mapbox and Sentry values empty.
- **The services have no way out.** They sit on a Docker network with no route off it. Only the gateway has
  a second network, which publishes only to `127.0.0.1`, and each start removes its default route.
  `rebuild` proves both are sealed before it restores anything.
- **The browser cannot leave.** The Playwright config sends everything but `127.0.0.1` to a dead proxy, IP
  addresses included, and the test fails if any request tries. It is separate from the staging config,
  which is unchanged.

We do not use `supabase start`, because it publishes its ports on every network address.

## How a rebuild follows the supported path

It runs the steps in `supabase/baselines/README.md`: the full `restore_order`,
`scripts/decompress-schema-baseline.mjs`, then the `scripts/list-post-baseline-migrations.mjs` list pushed
from a filtered workdir. It never pushes unfiltered. The push stops unless the CLI's dry run matches that
list exactly. Trying that path for real needed these additions, all in the throwaway workdir:

- **No `supabase init`.** CLI 2.109.1 writes a `[local_smtp]` block and then refuses to parse it, so the
  workdir gets a small `config.toml` instead. Its `[db]` port is what lets the CLI skip TLS.
- **Empty stand-ins for the ledger.** The CLI stops on any ledger row that has no file.
- **Each file gets one transaction,** as a live apply does. Some files assume it.
- **Files keep the name live's ledger uses,** because later migrations look for it. The CLI stores what
  follows the version, so a workdir file is named `<version>_<whole file name>`.
- **The baseline is decoded with `--with-live-rows`,** as the real-schema proofs do, so a migration whose
  postcondition needs a live row (KI-85's active Main Warehouse) replays. Never use that flag for a real restore.
- **One-shot data fixes are recorded, never run.** They target live rows and this database has no other
  business rows. Each is recorded at its place in the order, because later migrations check for it and earlier ones
  check that nothing newer exists.
- **One function gets its live line endings** before `20260817120000`, the same fix the real-schema proofs
  use.
- **The login, data and storage services pause during the push,** because some migrations refuse to run
  beside another open transaction.

## What it does not cover

- **No Edge Functions and no live updates.** Email, label lookup, document reading and the like fail, and
  screens wait for no live updates. All of those attempts stay on localhost.
- **No maps and no web fonts.** The Mapbox token is empty and the Google Fonts links are removed, so the page
  uses fallback fonts. List anything visual as owed on the Vercel preview.
- **Other outside sites.** Weather, land-survey and street-map lookups are blocked in the Playwright run. In
  a normal browser they can still go out, carrying only invented locations. None of them is production.
- **Invented data only.** It does not stand in for how a change behaves on real rows.
