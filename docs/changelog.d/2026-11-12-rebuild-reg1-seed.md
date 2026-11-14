## 2026-11-12 - Schema rebuild marks the REG-1 seed as run

`20270106110000_invoice_brands_rup` (Brand PR B-1b) refuses to run until the one-time REG-1 registration seed has been run. The seed is an admin step on the EPA registration setup page, not a migration. It was run on live before the apply, and on staging on 12 Nov (test data: 0 registrations, nothing to pick, 6 lines captured). The staging schema check's throwaway rebuild had never run it, so it stopped at that file.

`.github/scripts/rebuild-schema.sh` now writes the seed's marker row (`epa_registration_seed_run`) into the throwaway database just before that migration, the same way it already shims live-only quirks. Staging and live are untouched.

**Tested:** a local rebuild on spare ports went through the baseline and all 287 migrations.
