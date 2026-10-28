## 2026-10-28 - Align payment and prepay seasons with Chicago midnight

- Mason expanded the parked row 6.7 change to fix its previously deferred season issue, retaining no merge, live apply or deployment authority.
- The still-unapplied payment migration now captures one America/Chicago business date after replay. Both the default payment date and current payment/prepay season use that date, so September 30 evening cannot advance early to the next season.
- Explicit payment dates remain unchanged. Backdating still puts new prepay credit in the current business season, and retries crossing October 1 keep the original date, season and result.
- Scope limit: shared `current_season()` still uses UTC `CURRENT_DATE`. Other workflows that call it can default to the next season during the roughly five-hour September 30 Chicago evening window while this corrected payment/prepay path remains in the current Chicago season.
- Expanded the disposable PostgreSQL proof with a failing UTC-season mutant, 15 boundary cases across three timezones, payment/prepay season and cent checks, explicit backdating, and season-crossing retry. All controlled expiry clocks, including the insert trigger, use the simulated clock locally.
- Updated evidence and the unapplied migration hash in the same change. No production data or grants were changed. Draft publication is authorized; required release gates remain pending, with no merge/live apply/deploy authority.
- Verification passed: full disposable PostgreSQL proof, lint/typecheck/build, all 166 focused tests, and SQL audit (0 violations). Independent scoped reviewers found no findings. Adversarial `gpt-6-luna` at `xhigh` returned `LUNA_REVIEW: CLEAN` for the current migration/proof.
