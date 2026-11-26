# Role access behavior contract

Base: origin/staging 6fddd0d82882b6b384504a7790d170f8c701745d. Local audit evidence and owner decisions are in the November 25 role-check report. Test only on loopback Docker with invented data.

## First delivery

The cold review on November 25 confirmed that Watchdog, Crop Programs and Receiving can ship independently. Only these three changes enter the first PR. Watchdog revokes direct browser INSERT, UPDATE, DELETE, TRUNCATE and TRIGGER grants on flags and dismissals. It keeps the existing read rules, office RPCs and service-role grants. The migration keeps existing records, and a compensating grant migration is the rollback if the verified RPC paths fail. Reopening the old grants also reopens direct writes.

Crop Programs keeps the database's admin-only template writes. Receiving keeps the database's admin-only receipt reversal. Sales reps keep authorized reads and exports. Browser controls and confirmation dialogs follow the current session role, and the database remains authoritative if a server-side role changes before the browser learns of it.

## Later delivery

Mason confirmed on November 25 that sales reps may see claims for every customer, matching the existing office-wide claim read policy. He also confirmed that notification changes keep the current effective recipients, including driver flows. Previously refused cross-staff driver notifications do not become newly delivered under this contract.

- Rebates. First close direct claim inserts for browser users and preserve the normal creation RPC, including its existing pending-state defaults and replay. Preserve existing optional links and safe replays. The claim starts pending and administrators retain the review before any payment. Keep admin program management and claim transitions. The office-only program policy was restored by migration `20260727231652` after the earlier active-staff policy. Both driver and applicator returned zero seeded program and claim rows in the audit.
- Settings. Prove the complete list of browser and server readers per key and role, including the rate guardrail, sales tax and fuel surcharge. An existing safety or money value must survive the narrowing on each real caller. A genuinely absent allowed row retains the current default. Keep existing rows and writes. Compensating policy migration for rollback.
- Notifications. Preserve dispatch, delivery, quotes/orders, receiving, task and system notices through existing trusted emitters or server-owned events. Use the authoritative workflow transaction or its stable event identity for recipient, content, sender and deduplication. Keep Taha-owned screens outside this tranche unless coordinated through the project workflow. Introduce compatible support, move clients, prove legacy-path absence or enforce the supported app version, then restrict direct inserts.
- Vehicles. Preserve job pickers, historical assigned vehicles, worksheets, application records and reports, application services, applied records, field invoices and mix summaries. Admin retains full register, registration and notes. Introduce a scoped operational read, migrate each direct and embedded reader, prove legacy-path absence or enforce the supported app version, then remove broad access. Use current role and assignment to scope inactive vehicles. Keep old clients compatible through database-first delivery.

The Watchdog restriction works with the existing frontend. The rebate and button work uses existing database operations. Notification and Vehicle changes that require database support ship that support in a separate, compatible staging PR before app dependencies. Later compatibility revocations wait for the replacement workflow. Codex opens and proves PRs. Claude owns merge and staging verification after handoff.

## Proof cases

- As admin and sales rep, run Watchdog and dismiss seeded flags using the existing path. A retry returns the same outcome and the saved actor matches the signed-in person. Driver and applicator are refused. Direct writes are denied for browser roles. Existing flags remain readable.
- As sales rep, open Rebates and create one invented claim, including a replay. Clicking a program name cannot open the admin dialog, and the program save handler checks the role. Admin still manages claims and programs. Rep transitions, direct privileged writes, and field-role route and database access are refused.
- As sales rep, open Crop Programs and Receiving. All template management and receipt reversal controls are absent, including role changes while a dialog is open. Allowed receipt exports still work. Admin retains the two workflows.
- Verify an allowed and denied settings key per role, compatible browser reads and absent-key fallback, and the admin Settings save.
- For every supported notification path, verify recipient, sender, event and message from authoritative state, retry without accidental duplicate, and refusal of unauthorized or stand-alone requests.
- Verify current and historical vehicle workflows, allowed role and record scope, refusal of restricted data and writes, and retained admin access.
