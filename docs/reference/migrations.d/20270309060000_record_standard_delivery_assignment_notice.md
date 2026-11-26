**LOCAL CANDIDATE — NOT APPLIED.** `20270309060000_record_standard_delivery_assignment_notice.sql` (SQL sha256: `cae97049ef9c48b287842fa8e23e37f9dbecad7012430a3ed792251fb7679145`) records the standard delivery's existing assignment notice when a new delivery saves. It retains the stored recipient and caller, and supports older browser sessions without duplicate notices.

This is database support for the later client transition. The compatibility bridge matches the standard new-delivery title and type only. Edit, reassignment and follow-up notices keep their existing workflows. Before rollback after a client transition, restore the compatible client sender, then restore the prior delivery creation function and remove the compatibility trigger through a reviewed migration.

Local invented-data proof passed the full container-only batch 4c replay chain, including a saved assignment and repeat, an old browser's duplicate, another office sender, and a deliberately failed notice with the delivery and a failure record both preserved. Do not run the chain on shared databases.

During the client transition, an old tab can still send after a server notice fails. In that case a failure record can remain for a notice the browser ultimately delivered. The release owner removes the compatibility trigger after the app no longer sends this notice and supported cached clients have moved off the old sender.

Repeat the database proof on a running local walkthrough with node scripts/local-app/delivery-assignment-notice-proof.mjs. It applies this exact candidate in a rollback-only transaction, checks all three refusal paths, and requires the new assignment tests in the full delivery replay chain to have run.
