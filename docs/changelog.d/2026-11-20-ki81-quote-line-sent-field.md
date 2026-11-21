## 2026-11-20 — KI-81 field: a quote price bills only on the field the grower was sent it for

- Fixes the final-round Sol HIGH on release #1990 (`20270129140000:160`). A quote line moved to another field after sending, with no resend, priced the new field at the old field's sent price. The lookups match the line's current section, and the sent-price lock compares line, product and price, not field.
- New migration `20270129180000_ki81_quote_line_sent_field.sql`. It adds a private helper that reads the line's field from the newest sent version, and re-emits `_field_app_sent_quote_price_cents` and `create_invoice_from_blend_ticket` with these checks, each refusing with `QUOTE_RESEND_REQUIRED`:
  - a moved line ("was moved to another field after the quote was sent");
  - a sent line for a billed field that is no longer there with that product (moved, removed or swapped), so the field doesn't silently drop to list price;
  - a product quoted on only some of the billed fields;
  - a blend ticket billing the owner on a field other than the job quote's, or whose job quote lost a sent line for that field.

  A typed price still saves.
- Proof: a local synthetic DB, with staging migrations up to `20270129160000` applied inside one rolled-back transaction.
  - Before the fix, a line sent on field G and moved to F bills the quoted price on F, on both the single save and the blend ticket.
  - After it, both refuse. A typed price still saves, and a line moved back to its sent field still bills quoted.
  - The moved-off line (M5), the partly quoted line (M6), the blend ticket on another field (M7), a swapped product (M8) and a blend job quote that lost its moved line (M9) bill wrong before the fix and refuse after it. All 28 KI-81 unit scenarios are unchanged.
  - The postflight passes, and a second apply stops at the preflight.
- Round 4 (Luna/Sol): the blend invoice now bills an active application service whose optional column is NULL. Proof: R1, where the fee line was missing before and is billed after. It also locks the ticket's growers' quotes in one id-ordered pass (no deadlock), stops on a job relinked mid-save, replays a concurrent retry's receipt, refuses a NULL review status, blocks double billing through another ticket on the same job, and binds the $0 approval to the growers getting $0. The helper also holds drafts and stops on a non-finite price or an unreadable sent version.
- Round 6: a billed blend ticket can't move to another job (new trigger; proof R7), a live invoice the job points at blocks double billing, and a malformed sent entry stops (R8).
- Not verified: staging (the staging database job applies it on merge) and concurrency.
