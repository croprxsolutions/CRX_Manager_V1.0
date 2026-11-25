**LOCAL CANDIDATE — NOT APPLIED.** #2579 (2026-11-25): `20270307230000_parent_epa_correction_refuses_open_work.sql` (SQL sha256: `4f2ab2b81b5fb3df4c755ed141516eef174bab8cb88123aff139a23d52e13ce7`). Contract: `docs/plans/2026-11-25-par1-epa-refuse-open-work-CONTRACT.md` (Astra cold challenge settled there). Applying it is a live change and needs Mason's explicit yes.

What it does (no rows written): re-emits `_product_parent_identity_after` from the `20270307180000` body with one added check, last in the EPA-change branch: `PRODUCT_PARENT_EPA_OPEN_WORK` while any size of the parent has a job (not deleted) scheduled, in progress, or completed with no invoice; a blend ticket (not deleted, not rejected) unbilled or with no application record; or an invoice (not deleted) in draft or unposted. Lists up to 10, then "and N more". Preview and save both call it. Same signature, owner, volatility, `search_path`, no grants.

Preflight (`PARENT_EPA_OPEN_WORK_PREFLIGHT` / `_NOT_IN_TRANSACTION`): one transaction; the helper is the `20270307180000` body (md5 `b97145311af25c6ac873f78aa44bf2ac`, owner `postgres`, not SECURITY DEFINER, volatile, `search_path=public, pg_temp`); a second apply stops here. Postflight (`PARENT_EPA_OPEN_WORK_POSTFLIGHT`): body md5 `65122659f39618bb2b9d5603c375dabc`, same attributes, ACL exactly `{postgres=X/postgres}`.

Ordering: right after `20270307180000_parent_epa_correction_on`, in the same release, so the correction is never switched on in production without this rule. Re-run the open-work query read-only before applying.

Rollback (its own reviewed migration): switch the correction off (`_product_parent_epa_correction_enabled()` as `SELECT false`, `20270307180000`'s rollback). Never re-emit the `20270307180000` helper while the switch is on.

Proof: `node scripts/smoke/prove-parent-epa-open-work-real-schema.mjs` (`PARENT_EPA_OPEN_WORK_PROOF_PASS`).
