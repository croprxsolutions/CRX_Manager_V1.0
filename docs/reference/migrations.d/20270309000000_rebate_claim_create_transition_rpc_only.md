**LOCAL CANDIDATE — NOT APPLIED.** `20270309000000_rebate_claim_create_transition_rpc_only.sql` (SQL sha256: `65e0794ed1cc807d7d486fb4b4c19b1bf3e5c2ea318de746c28c996cda66ad44`) makes the existing guarded functions the browser entry points for claim creation and status changes. It preserves office reads and admin claim deletion.

The local proof covers company-wide sales rep reads, pending creation and replay, field-role refusal, admin-only transitions and refusal of direct claim writes. The repository test pins the migration and existing app callers; it also checks that later migrations do not grant those table privileges back to browser roles.

Existing browser clients already use the checked create and transition functions. No coordinated frontend release is needed for this database candidate. If a rollback is needed, restore the prior claim creation and update rules through a reviewed compensating migration. Keep the existing browser maintenance restrictions.
