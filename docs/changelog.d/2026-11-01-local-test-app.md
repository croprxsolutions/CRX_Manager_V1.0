## 2026-11-01 - Private test copy of the app (WP-PM-0)

Agents can now sign in, save and reload on a private copy of CRX Manager on this computer, using
invented data. `scripts/local-app/` holds it; its README has the commands and rules.

- It runs its own database, login, data and file services in Docker, published only on `127.0.0.1`. The
  services have no network route off Docker. `supabase start` was not used because it publishes on every
  network address.
- A rebuild takes about a minute and follows the supported path in `supabase/baselines/README.md`. Trying
  that path for real needed several additions in the throwaway workdir, which the local-app README lists.
- Every command checks its target first. It refuses a production address, an inherited live credential, and
  an unknown running frontend. `scripts/local-app/target.test.mjs` proves each refusal for each command.
- It has its own Playwright config, which can only reach this computer. The staging config is unchanged.
- No migration, no change to the app, and no live database access.
