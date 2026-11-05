## 2026-11-05 — Saving a field that does not exist now fails instead of reporting success (KI-31)

- New migration `20261107140000_save_field_refuses_missing_field.sql` (record in `docs/reference/migrations.d/`).
  `save_field` now raises `FIELD_NOT_FOUND` when the id it is asked to update matches no field. Nothing is written:
  no activity row, no billing defaults, no idempotency receipt. Creating a field, the actor binding, the role gate,
  replay and grants are unchanged.
- The rollback smoke `scripts/smoke/smoke-save-field-actor-binding.sql` gains a missing-id step, and
  `scripts/smoke/prove-save-field-actor-binding.mjs` now applies the new migration on top of `20260729222311`.
  Without the new migration that step fails ("reported success for a missing field id"); with it the proof passes.
