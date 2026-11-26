**LOCAL CANDIDATE — NOT APPLIED.** `20270309040000_admin_vehicle_register_reads.sql` (SQL sha256: `d11c2a2baeb78369725aedaf6a17eb330ab6440be554ebf45f2a1343ba227f56`) adds a read-only register for active administrators. The current vehicle management and workflow reads remain compatible while clients move to the new read path.

No records are modified. If a rollback is needed before the app adopts the new read path, use a reviewed compensating migration to remove the view.

The view uses postgres ownership and a security barrier. Authenticated users have SELECT only and the active-admin filter limits rows. On a started local walkthrough, run scripts/local-app/vehicle-register-proof.mjs with Node to verify the access matrix using transaction-only invented fixtures.
