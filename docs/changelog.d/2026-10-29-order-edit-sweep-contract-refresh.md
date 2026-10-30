## 2026-10-29 - Order-edit sweep verification refresh

Refresh the production sweep contracts for the previously applied five-argument order-edit function. Review confirmed that its shared guard still enforces authentication, actor identity, and active office roles before replay or mutation.

Role-wrapper exceptions now support exact function and dependency contracts without inventing an actor-parameter field. Missing or changed definitions, owners, or effective grants keep the finding visible; actor exceptions still require the exact suspect parameter. Regression checks cover matching contracts and missing or altered dependencies.

A real six-query live schema refresh records the two already-applied migrations and the existing `orders.row_version` column. No schema was changed by this refresh. The invoice-first trigger is classified as private transaction-owned infrastructure in the RPC inventory. The disposable invoice proof also exercises the existing invoice-type protections through the actual application role and save RPC.

Validation: all 29 live sweep predicates adjudicated successfully; 680 matcher assertions passed; the affected RPC contract suite passed all 97 tests; the full invoice replay passed, including split billing, returns, quick delivery, and concurrent writes. Independent security review and a focused Luna review found no remaining verifier defects. The earlier Luna invoice-type concern was refuted against the existing application grants and RPC behavior, with executable regression coverage. These are preparation results, not a claim of live deployment.
