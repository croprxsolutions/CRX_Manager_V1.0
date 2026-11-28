## 2026-11-26 — Proof bound to the load: deferred review notes

**Severity:** MED. **Area:** deliveries (Field Mode, Delivery Detail, Mark Delivered; delivery completion in the database). **Status:** ACCEPTED.
**Owner:** unassigned. **Tracked:** #2614 (Sol round 15 comment 7201742912, Taha's review 7202519900), #2671 (Sol comment 7199973688).

"Proof bound to the load" (#2557, #2614, #2671) makes a signature, a signed-ticket photo or a
drop-location photo count only for the products and amounts it was taken for. The reviews left
these notes open on purpose. None lets a wrong completion through; the worst case is an extra
signature or photo, or a confusing screen.

From #2614 (the screens), Sol round 15. Mason: "Skip the minors".
1. MED: if the screen reloads the lines while the customer is mid-stroke on the signature, the
   stroke can be lost or need redoing. Narrow timing window.
2. MED: if the camera is open in Mark Delivered while the lines reload, the photo can be taken
   against the old lines and then refused as stale. Narrow timing window.
3. MED: after an office re-save that recreates the delivery's rows, partial amounts the driver
   typed are restored by row id, so they can fall back to full. The reloaded quantity screen
   shows the amounts before new proof is taken.
4. MED: an office re-save that changes nothing but the row ids is treated as a change, so the
   driver gets one extra signature. Stricter than the database, never a wrong completion.
5. MED: the saved `lines_seen` entries are not type-checked on the screen. No screen writes
   another shape, and the database refuses one.
6. LOW: the proof summary shows amounts without units.
7. LOW: a customer can sign a delivery with nothing on it; Submit then refuses it with the
   nothing-delivered message.

From #2671 (proof required), Sol at 93935f28f.
8. MED: the migration's preflight does not check that #2562 (tiny amounts count as 0,
   `20270309180000`) is applied. It is on staging and sorts first; only rolling #2562 back alone
   would reopen this, and its rollback record says to reverse #2671 first.
9. MED: a line matched as 0 against 0.005 can leave an empty Main Warehouse stock row holding 0
   before the line is recorded as 0. That loop is #2324's and unchanged; no stock moves.
10. LOW: a matching drop-location photo is compared to the load twice. No effect on the result.
