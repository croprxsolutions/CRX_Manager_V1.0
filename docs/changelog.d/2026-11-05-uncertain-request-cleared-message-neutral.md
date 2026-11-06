## 2026-11-05 — Cleared-request refusal no longer says "an admin" (KI-27 leftovers)

- New migration `20261111120000_uncertain_request_cleared_message_neutral.sql` (record in `docs/reference/migrations.d/`).
  Since any staff member can clear their own stuck request (`20261110120000`), the database refusal of a later save
  of a cleared request now reads "belongs to a request that was cleared after it got stuck" instead of "an admin
  cleared". Only that text changes; the `IDEMPOTENCY_REQUEST_RETIRED` prefix that the browser and the smoke chain
  match on stays. The postflight also checks `retire_uncertain_request` is not executable by `service_role` or
  `metabase_ro` (live had neither on 2026-11-05).
- Smoke chain `smoke-uncertain-request-clear-check.sql` pins the new guard body and checks the new wording.
- `ClearExpiredIntentButton.test.tsx`: the sales rep, driver and applicator cases now use a request key carrying
  their own user id and click through the clear, instead of an admin-shaped key.
