## 2026-10-29 — A booking can only be "accepted" when it has an order

- Mason, 2026-10-27: yes to a database safeguard against "accepted with no order" (KI-12). New
  migration `20261029090000_quote_accepted_requires_order.sql` (row 1002 placeholder, NOT APPLIED)
  adds one deferred constraint trigger on `quotes`: when a quote becomes `accepted`, the database
  checks at commit that an order exists for it, and otherwise refuses with
  `QUOTE_ACCEPTED_WITHOUT_ORDER`.
- Unchanged: Convert to Order and the final Partial Order both create the order in the same
  transaction, so they work as before; Un-accept; every existing function, policy and grant. Quotes
  already accepted are not re-checked (KI-12's Q-2026-2059 stays for Mason to decide).
- Proof (local replay of main `79803bc1`, synthetic data): booking scenario S15b ("save a booking as
  accepted directly") went from allowed to refused, and every other booking scenario gives the same
  result as main. With real commits: a direct status change to accepted is refused at commit and the
  booking stays "sent"; Convert ends accepted with 1 order; drawing the whole booking ends accepted
  with 1 order. Static test: `src/lib/quoteAcceptedRequiresOrderMigration.test.ts`.
