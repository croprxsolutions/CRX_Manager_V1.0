## 2026-11-02 - Old "set service cost" database function retired

Migration `20261103090000_retire_admin_set_application_service_cost` drops `admin_set_application_service_cost`, which no screen has called since admins began saving a service's cost through `admin_save_application_service` (`20260729035923`). This closes the last open item of KI-02 / To-Do 11.3 (cost and margin are admin-only).

Proof: live catalog and ledger read only before apply (one version, no dependents, no trigger, no other function names it); typecheck and the touched tests pass locally. Not yet applied live.
