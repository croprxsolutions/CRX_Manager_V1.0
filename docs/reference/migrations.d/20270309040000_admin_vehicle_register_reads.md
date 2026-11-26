**LOCAL CANDIDATE — NOT APPLIED.** `20270309040000_admin_vehicle_register_reads.sql` (SQL sha256: `c04f1134ba2b3ac06e02eda59744af932d818b03e68c696f0474252e629548c9`) adds a read-only register for active administrators. The current vehicle management and workflow reads remain compatible while clients move to the new read path.

No records are modified. If a rollback is needed before the app adopts the new read path, use a reviewed compensating migration to remove the view.
