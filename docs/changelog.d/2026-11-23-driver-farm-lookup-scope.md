## 2026-11-23 - Release #2388 Sol HIGH 1: drivers see farm contacts only for their own deliveries

- Migration `20270228150000_driver_farm_lookup_scope.sql`: the driver farm lookup (`get_driver_customers`) gave any active driver the phone, email and addresses of any farm, even a driver shut out of both driver pages. Now a driver must still have the Deliveries or My Route page, and gets a farm only when it is on one of their own deliveries that is still open, scheduled from yesterday on (the same window drivers' farm read always had), or completed since yesterday (so a just-finished overdue stop keeps its receipt email). Mason chose to fix this before release (2026-11-23).
- The driver screens are unchanged: they only ask for farms on the driver's own deliveries. No data changes. Rollback: a new migration re-emitting the earlier body (reopens the leak).
- Proof: `node scripts/smoke/prove-driver-farm-lookup-scope-real-schema.mjs` (`DRIVER_FARM_LOOKUP_SCOPE_PROOF_PASS`, local Docker).
- Not verified: the staging database (applied by the staging DB job after merge).
