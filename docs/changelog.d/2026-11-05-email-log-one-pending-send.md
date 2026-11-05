## 2026-11-05 — email log: one unconfirmed send per email (database-first, not yet applied)

- New migration `20261110110000_email_log_one_pending_send.sql` adds `email_log.send_lock_key` and a unique rule allowing one `pending` row per email (type + record + customer). It closes the last double-send gap in the #1302 follow-ups: two clicks in the same instant with different retry keys. The send-email change that fills the column follows in its own PR, after this is live.
