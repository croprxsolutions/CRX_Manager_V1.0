## 2026-11-10 - Prod spot-check: Sentry reporting fix and live re-check of the manual

Sentry: `src/lib/sentry.ts` titles Supabase error objects with their own message and drops browser network
failures that the ignore list could not see; Group Products reports its error as-is. New entries: KI-115
("[object Object]" reports elsewhere) and KI-116 (`/products/group` on Product Detail).

Evidence for the 2026-11-10 "Last verified" stamps (read-only, about 6:30-6:45 AM Central):

- Live ledger (`supabase_migrations.schema_migrations`). A ledger version is the UTC time a migration was
  applied; a migration file's stamp is when it was written, so the two differ. Newest ledger version
  `20261110061547` (applied 2026-11-10 06:15 UTC) is migration file `20261229160000_convert_to_gl_lb_dry_oz`.
  Every migration file stamped `20261110` (the date that made the freshness check due today) was applied
  2026-11-05, ledger versions `20261105203216` to `20261105225320`. Migration files applied after ledger version
  `20261109123130` (the 2026-11-09 stamp): `20261221100000`, `20261222100000`, `20261222110000`,
  `20261229100000`, `20261229110000`, `20261229120000`, `20261229150000`, `20261229160000`.
- KI-25 corrected: PR #1649 merged 2026-11-09; `close_delivery_receipt` is live but no screen on `main` calls it.
- KI-114: RT-2's converter is live with PR #1706 still open; its remap `20261229170000` is not in the ledger.
- Edge Functions (`list_edge_functions`): all nine ACTIVE; versions recorded in CURRENT_STATE. Each last update
  matches a recorded deploy except `process-blend-ticket` on 2026-11-08 7:37 PM, now recorded. Its live v31 was
  downloaded with `supabase functions download` and its five files match `origin/main` apart from line endings.
