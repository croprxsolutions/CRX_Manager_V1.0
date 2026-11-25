**LOCAL CANDIDATE — NOT APPLIED.** `20270305150000_reject_liquid_density_draft.sql` (SQL sha256: `189d483bef8d000a6ccddfc127be0118ccac21c093fe5f55d3540e1c711e316e`). A different active admin rejects a pinned liquid weight draft with a reason while any approved weight stays in use.

Adds `reject_liquid_density_draft(p_parent_id, p_draft_id, p_expected_version, p_reason, p_idempotency_key)`. A signed-in active admin other than the draft author can close the exact waiting draft, with a required reason. The operation binds the retry receipt to the actor and request. It holds the parent then the density state lock, checks the version and draft ID, archives the draft, increments the density version and appends a `draft_rejected` event. An exact retry returns the saved receipt without another event.

The rejection keeps any existing approval and every previously saved ticket or loader snapshot. The event constraint preserves all earlier event types. Current pages keep reading the existing event history and have no write calls to this RPC. A later card change will expose rejection, and the final enforcement migration will close the older liquid write paths together.

## Verification

Run `node scripts/smoke/prove-reject-liquid-density-draft-real-schema.mjs` against a disposable Docker database. After an authorized staging merge, verify the staging Database run. The screen batch supplies staging proof from the card.

## Rollback

If this action needs to be retired, ship a forward migration revoking its execute grant. Leave the expanded event check and all recorded rejection history in place. A rejected value can be entered as a new draft through the normal workflow.
