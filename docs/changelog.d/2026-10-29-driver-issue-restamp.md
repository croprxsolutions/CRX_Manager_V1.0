## 2026-10-29 — Driver-issue notice migration re-stamped (PR #1178)

- Brought PR #1178 up to date with main. Its migration is renamed from
  `20261028185038_driver_delivery_issue_notifications` to
  `20261029160100_driver_delivery_issue_notifications` so it sorts after
  `20261028185500_order_edit_and_number_concurrency` (already live). It does not
  depend on PR #1174.
- Review hardening before landing: the notice function is now owned by `postgres`,
  its execute grant is also revoked from `service_role`, the driver's explanation is
  cut at 2,000 characters in the notice, and a postflight check fails the migration
  if the function or deferred trigger is not as intended.
- Migration-history row 1003 is reserved for it; the draft-only live-check notes
  in CURRENT_STATE and KNOWN_ISSUES give way to main's newer ones.
- Refreshed the KI-18 freshness note after read-only production checks confirmed
  quote, order, rebate-claim, and blend-ticket year generators still use
  `current_date`; the live ledger's latest entry is now recorded there.
