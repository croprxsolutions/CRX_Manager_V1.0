## 2026-11-26 — Retire the old browser send for standard delivery assignments

**Severity:** LOW. **Area:** Notifications. **Status:** OPEN.
**Owner:** Claude, at the rollout handoff from Mason.

After the database save sends the standard assignment notice, the browser can still try to send a duplicate. The temporary bridge handles older supported builds. After the database migration is in place, deploy the follow-up that removes the browser send. Then confirm old supported browser builds have moved off that path before removing the bridge in a reviewed migration.

Release order: if #2643's migration is held off a release or rolled back, hold off or roll back #2687 (the screen change that removes the browser send) first. Otherwise production would have neither the browser send nor the database send.
