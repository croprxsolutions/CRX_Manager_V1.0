## 2026-11-20 — KI-81 field: a quote price bills only on the field the grower was sent it for

- Fixes the final-round Sol HIGH on release #1990 (`20270129140000:160`). A quote line moved to another field after sending, with no resend, priced the new field at the old field's sent price. The lookups match the line's current section, and the sent-price lock compares line, product and price, not field.
- New migration `20270129170000_ki81_quote_line_sent_field.sql`. It adds a private helper that reads the line's field from the newest sent version, and re-emits `_field_app_sent_quote_price_cents` and `create_invoice_from_blend_ticket` with one check each: a moved line refuses with `QUOTE_RESEND_REQUIRED` ("was moved to another field after the quote was sent"). A typed price still saves.
- Proof: a local synthetic DB, with staging migrations up to `20270129160000` applied inside one rolled-back transaction.
  - Before the fix, a line sent on field G and moved to F bills the quoted price on F, on both the single save and the blend ticket.
  - After it, both refuse. A typed price still saves, and a line moved back to its sent field still bills quoted.
  - All 28 KI-81 unit scenarios are unchanged.
  - The postflight passes, and a second apply stops at the preflight.
- Not verified: staging (the staging database job applies it on merge) and concurrency.
