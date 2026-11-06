## 2026-11-06 — Bill Split screens: line overrides, the freeze, and the payer table (billing plan M2)

- Order page, Bill Split card: says who gets any share left over ("the other 60% stays with..."), and the next share starts at what's left. It locks with a plain message once a delivery is complete. On an order split by field, it says the field split bills instead.
- New "By line" list on the card: a line can name its own payers, such as a farmer paying 100% and the landlord 0%. A line with none follows the card.
- Invoice page and printed PDF: a Bill Split invoice shows every payer of the sale with their share and total, on by default in the print dialog, with links between the invoices on the page. Old Print labels each payer by their real invoice number. It's read from the invoices themselves, so a freight charge on one payer shows straight away.
- Needs `20261125110000` live first (#1524). The email PDF comes from the shared Edge Function module, so emailed invoices show the table once `send-email` is deployed.
- Not here: each payer's invoice listing the whole sale's lines. That's the Chem Man PDF layout (M10).
- Completing a delivery names the payers' draft invoices, and warns when the split couldn't be drafted. A field split's invoices don't show the payer table.
