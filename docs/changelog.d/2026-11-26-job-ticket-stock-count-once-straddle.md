## 2026-11-26 — Count once also covers a ticket or job posted before the change

- Luna review, round 1: a blend ticket filed (or a job completed) before migration
  `20270311100000_job_ticket_stock_count_once.sql`, with its other half posted after, would still have taken
  the product twice.
- Now older stock lines are found the way they always were (a job's by its job, a ticket's by the application
  record named in its note), so such a pair also takes the product out once.
