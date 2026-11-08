## 2026-11-07 — REG-1 step 1: where EPA registrations will live (database, applied live 2026-11-08)

- `20261210100000_epa_registrations.sql`: adds the place to keep one record per EPA registration
  number (the facts printed on that label, restricted-use as Yes / No / Not reviewed) and its change
  log. Nothing is filled in yet and nothing in the app changes: the registration tools say "not set
  up yet" until the later step that fills them in, together with the guards and the sale capture.
- New label drafts now also record, privately, what they were checked against, so the later draft
  commit can tell when a product or its label changed since the draft was made.
- Proof: `scripts/smoke/prove-epa-registrations-real-schema.mjs`.
