**LOCAL CANDIDATE — NOT APPLIED.** `20270314120000_record_delivery_completion_notices.sql` (SQL sha256: `b3a404ade53b42b0283c67d309036971650f10c1f790896147a001efe9208c41`) registers a saved interactive delivery completion for its checked follow-up sender. The existing completion-history sequence supplies the durable identity. The original signed-in actor and receipt must still be authorized to send.

The ordinary completion response, legacy arguments, proof-of-load inputs and offline recovery remain compatible.

Old screens continue their current sends. The database comes before the separate screen cutover. Roll back the screens first and keep the database entry points available to cached clients. Do not remove recorded notices or completion receipts.

The local proof invokes both completion operations and the checked sender with invented users and deliveries, then checks simultaneous requests using independent database sessions. Run `node --experimental-strip-types scripts/smoke/prove-delivery-completion-notice-concurrency-local.mjs` only against this checkout's sealed local walkthrough.

The original app's Delivery Detail compatibility test uses `delivery-completion-legacy.spec.ts` in the local walkthrough. To rehearse the database-side rollback with cached clients, the local browser test temporarily installs `scripts/smoke/delivery-completion-notice-disable.sql` in a transaction. It retains both completion signatures and existing notice records. The cached screen still saves the delivery and records the alert failure for review. The test restores the active sender afterward.
