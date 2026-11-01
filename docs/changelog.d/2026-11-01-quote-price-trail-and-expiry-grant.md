## 2026-11-01 — Price trail rows are tied to the last send; the browser no longer writes a quote's expiry

- From the 2026-11-01 review of PR #1234.
- New migration `20261101100000_quote_price_trail_and_expiry_grant.sql` (row 1012 placeholder, NOT
  APPLIED; needs Mason's approval of this file because it revokes a grant):
  - `quote_price_changes.sent_version` names the sent version each change followed.
    `_assert_quote_prices_as_sent` accepts a changed price only from rows since the last send, and a
    price above the sent price only with a tick since that send, at that price or higher.
  - The browser loses direct INSERT and UPDATE on `quotes.expires_at`. Only `save_quote`, the send and
    `duplicate_quote` write it, and all three run as the definer.
  - Corrects stale comments in the save implementation and the check.
- New sweep `quote-price-lock-boundary`: the check's shape, reviewed body and four callers;
  `quote_price_changes` browser read-only with RLS on, named only by the two reviewed functions;
  and the browser's write grant on `quotes.expires_at`. The sweep suite is now 30 predicates.
- `allowlist.json`: the `save_quote` exception's private implementation pin moves with the re-emit.
