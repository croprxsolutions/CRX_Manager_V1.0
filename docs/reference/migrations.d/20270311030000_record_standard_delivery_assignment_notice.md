**LOCAL CANDIDATE — NOT APPLIED.** `20270311030000_record_standard_delivery_assignment_notice.sql` (SQL sha256: `1483534e38846b84c245df20c83211528e1ecad1030a328c6c162137cb8edba2`) records the standard delivery's existing assignment notice when a new delivery saves. It retains the stored recipient and caller, and supports older browser sessions without duplicate notices.

This is database support for the later client transition. The compatibility bridge matches the standard new-delivery title and type only. Edit, reassignment and follow-up notices keep their existing workflows. Before rollback after a client transition, restore the compatible client sender, then restore the prior delivery creation function and remove the compatibility trigger through a reviewed migration.

Local invented-data proof passed the full container-only batch 4c replay chain, including a saved assignment and repeat, an old browser's duplicate, another office sender, and a deliberately failed notice with the delivery and a failure record both preserved. Do not run the chain on shared databases.

During the client transition, an old tab can still send after a server notice fails. In that case a failure record can remain for a notice the browser ultimately delivered. The release owner removes the compatibility trigger after the app no longer sends this notice and supported cached clients have moved off the old sender.

Repeat the database proof on a running local walkthrough with node scripts/local-app/delivery-assignment-notice-proof.mjs. It applies this exact candidate in a rollback-only transaction, checks unsafe transaction, wrapper, sender and repeat-apply states, and requires the new assignment tests in the full delivery replay chain to have run.

The local walkthrough is the execution target for the notice-chain extension. Shared-database smoke runs are unsafe here because delivery numbers use sequences. CI checks the source boundary and migration contracts.
