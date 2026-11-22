## 2026-11-21 — Rate review warns when a draft's parent rate changed since it was derived (#1722 item 4)

- New migration `20270206100000_rate_review_parent_changed_warning.sql` (not applied live; record in `docs/reference/migrations.d/`).
- Approving a derived draft rate whose parent product's rate (number and unit, or label text) changed after the draft was made still approves (Mason, 2026-11-21: warn but allow). The preview row, the saved result and the `approved` history event now say what the draft came from and what the parent says now ("none" when cleared). Manual rows never warn.
- No new function, grant or data change. Live 2026-11-21: 705 rates, all approved, 0 drafts, so nothing shows until a new draft exists.
- RT-1 build sheet now states the real 1e9 rate cap (#1722 item 3).
- Proof: `node scripts/smoke/prove-rate-review-parent-changed-real-schema.mjs`; screen tests in `RateReviewWorkbookModal.test.tsx`. Not yet verified on staging.
