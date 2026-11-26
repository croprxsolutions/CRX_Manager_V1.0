**LOCAL CANDIDATE — NOT APPLIED.** `20270308150000_watchdog_mutations_rpc_only.sql` (SQL sha256: `d6e257b749a079255ae5660b55bfd4a8156ce5e613dc4b3647ae78a6ff296dd9`) routes browser writes to Watchdog flags and dismissals through the existing guarded operations. Existing flag history and service-role privileges are preserved.

The Watchdog screen, job banner and Office Cockpit already use these database functions. On a started local walkthrough, `node scripts/local-app/watchdog-role-proof.mjs` tests office detection, dismissal attribution and replay, field-role refusal and direct-write grants. It rolls back its invented fixtures.

The older write policies remain in place without browser write grants. If the existing managed operations fail after apply, use a reviewed compensating migration to restore only the prior Watchdog table grants needed for rollback. Keep the existing restrictions on browser table maintenance.
