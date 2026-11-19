## 2026-11-18 — Security batch: KI-121, KI-122, KI-123, KI-124

- **KI-121:** the last active admin can no longer stop being an admin by a role change (deactivation was already
  refused), and two admins removing each other at the same moment cannot both succeed. Settings shows "You cannot
  remove or deactivate the only active admin". A payout-only profile can no longer be given another role, or another profile turned into one.
- **KI-122:** both admin password-reset paths share one helper that refuses unless the target user loads, writes the
  server's own activity record naming the admin before the password changes (no record, no reset), and records a
  failed reset. Signed-in users can no longer write those server records themselves. Live Auth already ends the user's existing sign-ins on such a reset; a session token already issued still works until it expires (about an hour). Edge Functions not deployed:
  that needs Mason's approval.
- **KI-123:** the signed-out role loses every read and sequence right on app tables, and new tables no longer grant it
  any. Row security already blocked those reads; this removes the second layer's gap.
- **KI-124:** five end-to-end test files read the database address and public key from the test environment instead of
  hard-coded copies.

Migration `20270127130000_security_batch_ki121_ki123` (record in `docs/reference/migrations.d/`). Contract:
`docs/plans/2026-11-18-security-batch-ki121-124-CONTRACT.md`. This PR targets `staging`.
