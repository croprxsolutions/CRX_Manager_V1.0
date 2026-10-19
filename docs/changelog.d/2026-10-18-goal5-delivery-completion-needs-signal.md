## 2026-10-18 — Goal 5: completing a delivery needs a signal, with a paper-ticket fallback

Mason decided on 2026-10-15 that a delivery is completed only with a connection. This change makes
every delivery completion path follow that rule. It is an app-only change: no migration, and
`complete_delivery` is untouched.

- **New `src/lib/connectivity.ts`.** `hasSignal()` checks the phone's offline flag and then makes one
  tiny database read, so farm Wi-Fi with no internet behind it also counts as no signal. Any HTTP
  answer counts as signal; a dropped request (no automatic retries) or one still unanswered after
  6 seconds does not.
- **Delivery page (`DeliveryDetail.tsx`) and field stop (`FieldStop.tsx`).** The "Save Offline" path is
  removed. Without signal, Complete shows "No signal. This delivery was NOT completed and nothing was
  saved…" and changes nothing. The offline notices now say a delivery can only be completed with
  signal.
- **Deliveries list (`Deliveries.tsx`).** Mark Delivered / Mark Complete checks for signal before the
  start step and again between start and complete. If signal drops between them, the driver is told
  the delivery is now In Progress but not completed, with no stock taken and nothing billed. The
  remaining instant between the two server calls is recorded in `docs/manual/KNOWN_ISSUES.md`;
  Mason chose to ship with it and close it later with one combined server call.
- **Paper-ticket fallback (new `src/lib/paperTicket.ts`).** On the delivery page's driver layout and
  the field stop, "Customer signed a paper ticket (no signal at the site)" replaces the on-screen
  signature with a required photo of the signed ticket. The photo is an ordinary delivery photo
  captioned "Signed paper delivery ticket"; the signer's name is still required, no signature
  image is saved, and the customer receipt is always sent when the customer has an email on file.
  The driver also enters the "Delivered on" date from the ticket (today by default, never in the
  future); a past date is sent as the completion time, so the delivery and its invoice land on the
  day the delivery really happened, not the day it was entered.
  The Deliveries list dialog sends paper-ticket deliveries to the delivery page. The ticket photo
  is required only when the driver ticks the paper-ticket box. Ticket photos do not count toward
  the 10-photo limit (they have their own limit of 2), and on the field stop a saved ticket photo
  stays on screen even if the photo list fails to reload. Moving to another stop clears the photo
  list first, so one stop's ticket photo can never satisfy the next stop's check.
- **Photo upload no longer resets edited quantities.** On the delivery page, a photo upload used to
  reload the whole delivery, putting short quantities back to full. It now refreshes only the
  photos, so taking the ticket photo after marking items short can't record a full delivery.
- **A failed receipt email is no longer silent.** If the customer receipt email cannot be sent after
  a delivery completes (for example, signal drops in between), the delivery page and the field stop
  now tell the driver and point to the office's Email Confirmation button. A guaranteed retry needs
  a server-side email queue and is recorded as open in the Goal 5 plan.
- **Pre-existing bug fixed.** On the delivery page's driver layout, Complete Delivery opened a
  confirmation box that was never drawn, so a driver's tap did nothing. Both layouts now share it.
- **Not changed.** Completions already queued offline before this ships still sync, or go to Offline
  Work Review (`src/lib/offlineSync.ts` keeps its `complete_delivery` handler). Field-application job
  completion (`FieldView.tsx`, `complete_job`) still queues offline; Goal 5 covers deliveries only.

**Proof.** Browser preview of the real pages against a local test database (no live data), with
signal cut off in the page: on the delivery page (office and driver layouts), the field stop and the
Deliveries list, Complete was refused with the message above, the test server received no
`confirm_delivery` or `complete_delivery` call, the delivery's status was unchanged and the offline
queue stayed empty. Wi-Fi-without-internet was refused the same way. With signal back, each completed
with exactly one `complete_delivery` call. The list's signal-drop-between-steps case left the delivery
In Progress with only `confirm_delivery` received, then completed on retry. Supporting tests:
`src/lib/connectivity.test.ts`. Not yet tried on a real phone in airplane mode.
