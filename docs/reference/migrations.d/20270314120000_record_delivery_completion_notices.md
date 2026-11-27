**LOCAL CANDIDATE — NOT APPLIED.** `20270314120000_record_delivery_completion_notices.sql` (SQL sha256: `49a479b27cf1d0df3508947ee39053aa5357ae305993bb6e06caecd0ec682243`) registers a saved interactive delivery completion for its checked follow-up sender. The existing completion-history sequence supplies the durable identity. The original signed-in actor and receipt must still be authorized to send.

The ordinary completion response, legacy arguments, proof-of-load inputs and offline recovery remain compatible.

Old screens continue their current sends. The database comes before the separate screen cutover. Roll back the screens first and keep the database entry points available to cached clients. Do not remove recorded notices or completion receipts.

The local proof invokes both completion operations and the checked sender with invented users and deliveries, then checks simultaneous requests using independent database sessions. Run `node --experimental-strip-types scripts/smoke/prove-delivery-completion-notice-concurrency-local.mjs` only against this checkout's sealed local walkthrough.
