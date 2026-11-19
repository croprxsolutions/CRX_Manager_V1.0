## 2026-11-19 — v0.1.0: live apply evidence in three billing migration records

- The release apply review (#1990 issuecomment-7023441015) asked for a live condition to be checked before three of Taha's billing migrations apply. All three were read on live, read-only, on 2026-11-19, and none is present. The evidence is now in each record:
  - `20270109100100`: live `invoice_items_charge_type_check` is `freight, application_fee, service, other`, matching the preflight.
  - `20270109100400`: there are 0 posted, overdue or paid credit memos.
  - `20270117120000`: there are 0 standing-discount audit rows, and the rate table doesn't exist on live yet.
- Docs only. No SQL file changed, so the staging ledger hashes are unchanged.
