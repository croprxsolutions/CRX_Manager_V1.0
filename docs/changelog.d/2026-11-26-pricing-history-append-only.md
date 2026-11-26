## 2026-11-26 — Preserve product cost and sent-quote price history

- The database migration makes product cost changes and sent-quote price changes append-only. Existing pricing paths can still add entries. It blocks hard deletion of a quote or pricing change set when that deletion would change its recorded history.
