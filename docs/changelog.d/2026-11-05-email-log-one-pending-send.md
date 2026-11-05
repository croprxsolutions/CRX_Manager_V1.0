## 2026-11-05 — email log: one unconfirmed send per email (database-first, not yet applied)

- New migration `20261110110000_email_log_one_pending_send.sql` adds `email_log.send_lock_key` and a unique rule allowing one `pending` row per email (type + record + customer). On its own it changes nothing: the live send-email leaves the column empty, and empty rows are not locked. The gap (two clicks in the same instant with different retry keys both sending) closes only when the follow-up send-email change, in its own PR after this is live, starts filling the column.
