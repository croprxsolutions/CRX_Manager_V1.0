**LOCAL CANDIDATE — NOT APPLIED.** `20270309080000_dispatch_location_notices.sql` (SQL sha256: `ec7cb8c7a3c577fa4b477d33d6cb2cf2708dc7d7c4809510fe2b1bb0ed29b526`) adds an office dispatch operation that sends location notices using the saved assignment and the signed-in dispatcher.

The Wizard sends one incoming notice per applicator and job. The Board uses the saved assignment to notify the incoming or outgoing applicator on a real change. The existing operations stay available during rollout. An exact retry uses their existing receipt and sends no new notice.

The registered local Docker smoke chain passed with invented records. It verified office and field role boundaries, recipient and sender records, both orders of concurrent dispatch and assignee deactivation, and a saved dispatch when its notice failed.

Roll back the dependent app first, then retire the new operation and its private writer in a reviewed migration.
