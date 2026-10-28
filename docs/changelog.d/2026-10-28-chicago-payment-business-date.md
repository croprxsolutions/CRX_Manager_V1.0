## 2026-10-28 - Chicago payment business-date fix for draft review

- Local candidate `20261028175551_chicago_payment_business_date.sql` makes an omitted payment date use America/Chicago after the replay lookup. Explicit dates and old v1 retries remain supported; other changed arguments still reject.
- Both payment screens already omit the date. Offline replay forwards stored parameters. No frontend, allocation math, quote/order/rebate numbering, grants, or permission changes were needed.
- Added `node scripts/smoke/prove-chicago-payment-date.mjs`, using a network-disabled disposable PostgreSQL container and the checked-in real schema baseline. It runs the exact candidate with the real clock, then controlled copies for winter/summer, DST, evening/year rollover, explicit dates, retry, closed-period, and role cases. The pre-fix year-end probe must fail.
- Lint, typecheck, build, and 166 existing focused payment/RPC/offline tests passed. Evidence and release limitations: `docs/audits/2026-10-28-chicago-payment-date.md`.
- Draft-only review under Mason's updated instruction. Not merged; no live migration applied or deployment performed. No production data/settings were changed.

Follow-up: Mason subsequently included the current payment/prepay season defect. See `2026-10-28-chicago-payment-season.md`; the migration's current content and hash are recorded there and in the updated evidence/history records.
