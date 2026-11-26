**LOCAL CANDIDATE — NOT APPLIED.** `20270309040000_admin_vehicle_register_reads.sql` (SQL sha256: `dfb7dafe1fbd1eb0026956983f149fd8ac43f1d0b356fc5341e331f55ebf678e`) adds a read-only register for active administrators. The base table still allows all existing active-profile reads, including registration and notes, while clients move. Release phases and verification are in docs/plans/2026-11-26-vehicle-register-access-CONTRACT.md.

No records are modified. If a rollback is needed before the app adopts the new read path, use a reviewed compensating migration to remove the view.

The view uses postgres ownership and a security barrier. Authenticated users have SELECT only and the active-admin filter limits rows. On a started local walkthrough, run scripts/local-app/vehicle-register-proof.mjs with Node to verify the access matrix using transaction-only invented fixtures.

The exact migration and the local proof passed with a six-profile role matrix. The active admin read the invented active and retired vehicles. Sales rep, driver, applicator, external recipient and inactive admin saw none. Browser roles could not update the register and an anonymous read was refused.
