## 2026-11-26 — Vehicle register rollout and advisory verification

**Severity:** MED. **Area:** Vehicles. **Status:** PARTIAL.
**Owner:** Mason for the registration scope decision. Claude for the rollout after Mason hands it over.

The database support gives active admins a dedicated vehicle register. Existing access to vehicle registration and notes on the base table continues while client and report readers move. The job-picker registration decision is pending. Before changing the base table rules, verify the current and historical job, loader and report paths and verify that supported clients have moved.

If the database security advisor reports an owner-run view for `public.admin_vehicle_register`, verify the exact migration and view owner, security barrier, active-admin predicate and grants. The browser should have only SELECT and inactive, field and external roles should see zero rows. Treat any discrepancy as a security finding. This migration leaves the advisor and its exception lists in effect.
