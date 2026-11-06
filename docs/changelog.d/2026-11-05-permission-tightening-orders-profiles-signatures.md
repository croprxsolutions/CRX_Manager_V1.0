## 2026-11-05 — Order status only through the server; profiles and old signature files locked down

- New migration `20261116100000_permission_tightening.sql` (not yet applied; record in
  `docs/reference/migrations.d/`). Mason's decisions of 5 Nov, about 10:30 PM Central.
- KI-101 grant item: signed-in users (admins included) can no longer set an order's status with a direct
  database update, nor create an order with a status already set. Delivery completion, cancel, void and pricing still set it through their server functions.
  The order page's direct status write, which no button could reach (the page offers only Cancel, which uses
  `cancel_order`), is removed.
- KI-07: signed-in and anonymous users lose TRUNCATE and TRIGGER on `profiles`. The PostGIS `search_path`
  exception for the field-map functions is now written down in `docs/workflows/RLS_SECURITY_GUIDE.md` (16 live
  functions: the 12 KI-07 named plus four internal helpers); no function changed.
- KI-26: the four older signature-file rules for `signatures/<delivery id>.png` (deliveries completed before
  2026-10-23): nobody signed in can write, replace or delete those files any more, and reading one needs it to
  be the delivery's recorded signature. Same people can read as before. Today's per-attempt signature rules are
  unchanged.
- KI-17 moved to the accepted list (Mason 2026-11-05): the linkage is not used for money; the invoice side asks
  staff to pick.
- Proof: `scripts/smoke/prove-permission-tightening-real-schema.mjs` on a throwaway copy of the real schema.
