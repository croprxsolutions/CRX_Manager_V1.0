## 2026-11-04 — Blend tickets go through application records only (KI-93)

- New migration `20261107050000_blend_tickets_application_records_only.sql` (record in `docs/reference/migrations.d/`).
  One blend ticket could take its products out of stock twice: through its application record and again when an
  order made from or linked to the ticket was delivered. Mason chose to keep only the application-record path:
  "Create order from ticket", "Link to order" and "Unlink" now refuse (`BLEND_TICKET_ORDERS_DISABLED`), and a table
  guard refuses any ticket-to-order link from any writer. Bill a ticket with a direct invoice, as before.
- The blend ticket screen no longer shows Create Order, Link to Order, the suggested-order link or Unlink, and the
  order screen no longer lists linked blend tickets (none can exist).
- The `create_blend_ticket` live smoke chain now checks the refusals instead of building linked tickets, gets its
  billing-status proof from a direct invoice, and its three invoice posts set `posted_at`.
- Proof: `node scripts/smoke/prove-blend-tickets-application-records-only-real-schema.mjs`.
- Live read 2026-11-04: 0 blend tickets and 0 ticket-to-order links, so nothing is migrated.
- New known issues KI-101 (voiding a delivery reopens a cancelled order) and KI-102 (void order then void delivery
  restocks twice), logged only.
