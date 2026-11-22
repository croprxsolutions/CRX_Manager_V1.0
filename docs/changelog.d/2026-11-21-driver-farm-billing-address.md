## 2026-11-21 - #2018: the driver's farm lookup returns the billing and shipping addresses separately (database part)

- Migration `20270207120000_driver_farm_billing_address.sql`: `get_driver_customers(uuid[])` also returns each farm's `billing_address` and `shipping_address`. When the office leaves a delivery on "Use billing address", the office screens navigate to the billing address; the driver screens will now use the same one instead of the shipping address (Sol round 5 on #2165; Mason chose "Fix address first"). Nothing else changes: same callers, same refusals, nothing financial.
- No data changes. The current app ignores the new keys; the #2165 screens switch to them after this is on the staging database. Rollback: a new migration re-emitting the earlier body.
- Proof: `node scripts/smoke/prove-driver-farm-billing-address-real-schema.mjs` (`DRIVER_FARM_BILLING_ADDRESS_PROOF_PASS`, local Docker).
- Not verified: the staging database (applied by the staging DB job after merge).
