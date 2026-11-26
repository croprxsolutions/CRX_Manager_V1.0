# Vehicle register access

Active admins need the full vehicle register. Job and loader workflows need identifiers, names, vehicle type and capacity. Historical views must still show assigned vehicles. The existing Reports permission controls access to aircraft logbooks. The owner decision on registration in job pickers is pending.

1. Add a read-only admin register. The base table keeps its existing row and column access. A separate reviewed migration can remove the register before the app depends on it.
2. Move the admin screens to the register and project only fields used by current workflows. Verify job and loader selection, historical vehicles, application records, application services and aircraft reports. Keep the existing app compatible until this frontend deploys.
3. After callers move and the registration decision is recorded, narrow base access in a separate migration. Prove allowed operational and historical use and refusal of protected fields with invented data for all staff roles. Roll back with a reviewed restoration of the former grants.

Step 1 uses a security-barrier view owned by postgres so it can keep the direct administrator access after base grants narrow. An automated security advisor may flag owner-run views. Verify the preflight base policy, view owner and barrier, active-admin predicate, SELECT-only grant, and inactivity and field-role denials with the local proof before treating a report on this specific view as expected. Review any difference from those properties as a finding.
