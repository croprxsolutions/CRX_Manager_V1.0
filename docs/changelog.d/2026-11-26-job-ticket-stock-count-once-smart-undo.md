## 2026-11-26 — Smart undo of a ticket counted with its job (Sol round 2)

- Mason, 2026-11-26: "Yes, smart undo".
- `20270312120000_job_ticket_stock_count_once.sql` (not applied): `reverse_application_record` no longer refuses a blend
  ticket counted with its completed job. It puts back the ticket's stock, then keeps on the job's books whatever the
  job still needs, so a ticket filed against the wrong job can be undone and re-filed without stock being taken twice.
  Extra another ticket took because of the undone one stays out and is flagged for office review.
