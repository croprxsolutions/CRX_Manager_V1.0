**LOCAL CANDIDATE — NOT APPLIED.** `20270309110000_receiving_damage_notices_from_receipts.sql` (SQL sha256: `ca963d910729e5fd524d3c3874b6a5ddc54fcaf969ca4b29fb4c0a359d4bdb1a`) builds interactive receiving damage notices from saved receipts.

The current purchase-order and Quick Receive callers keep their existing function signature. Active admins remain the recipients, and app users can still mark notices read.

The local walkthrough confirmed that both screens send notices from saved receipts. The local database proof exercised a multi-order batch, both legacy references, role refusals, a send failure, and reversal before retry. The Quick Receive fix also works with the previous database version.

Roll back in a new migration by restoring the previous function and policies and the prior notification update grant.
