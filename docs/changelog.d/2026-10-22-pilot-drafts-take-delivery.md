## 2026-10-22 — Pilot procedure drafts: admins can Take Delivery to complete paper deliveries

- `docs/plans/2026-10-22-pilot-launch-procedures-draft.md` said only the assigned driver can complete
  a paper-ticket delivery. An admin or sales rep can press **Take Delivery** on the delivery's page to
  become its driver and then complete it (`canTakeDelivery` in `src/pages/DeliveryDetail.tsx`). The
  emergency-brake and outage steps now say so. After a database restore, while CRX is closed to staff,
  the person running the recovery completes the paper deliveries this way.
- Follow-up to PR #1041, which merged before this correction from its last Codex GitHub App review
  could land. Documentation only.
