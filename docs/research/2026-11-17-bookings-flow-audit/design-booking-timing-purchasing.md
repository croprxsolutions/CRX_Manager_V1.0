# Design: Booking timing, confidence and purchasing (agreed with Mason 2026-11-17)

Background: `README.md` in this folder (audit findings B1–B6, C1–C7, F1–F2).

## Goal
Every sent booking tells purchasing what is needed, how sure it is, and when, so product is bought close to when it is used and not over-ordered. Bookings change a lot in season; the design must tolerate that.

## Mason's decisions
- D1: Timing is picked by the rep **per booking section**: Pre-plant, In season or Late summer. The month range for each timing is set once in Settings (e.g. Late summer = Jul–Aug).
- D2: Each booking section has a **confidence**: Firm, Likely or Maybe. Purchasing sees "Firm" and "Firm + Likely" separately. Maybe is shown but never drives buying.
- D3: Only **Firm** sections set aside stock (an inventory hold).
- D4: The purchasing view shows, per product and window: Firm need, Firm+Likely need, stock, POs arriving before the window, a **running total carried month to month**, and "Order X by [date]" (window start minus a lead time set once). Staff create POs themselves.
- D5: When a section's window has passed with product still undelivered or unsprayed, it **stays counted and held** and lands on a **past-window list**. The rep chooses: move to a later window, switch the product, or close short.
- D6 (from audit Q3): an order that would take stock set aside for another grower's booking gets a **warning naming the grower and booking, and is allowed**.
- D7 (from audit Q4): a spray job completed by an applicator **creates a draft invoice**, as office completions do today.

## Behaviour
**Step 1 (booking side, quote screen):**
- Each section gets two picks: Timing and Confidence.
- A booking counts once it is **sent**. Drafts do not count.
- Firm sections hold product until it is delivered, sprayed or the booking is closed. The current 14-days-after-Needed-By expiry is removed.
- The "Planned program" switch is retired; "Maybe" covers uncommitted growers. Any sent booking can schedule spray jobs.
- When product is drawn onto a Partial Order or converted, it keeps its section's timing for forecasting.
- Existing open bookings without timing or confidence are flagged "needs timing", not dropped.
- Rep revisions in season (rates, acres, products) update holds and forecast immediately.

**Step 2 (Inventory → Forecast):** the purchasing view described in D4.

## Out of scope (this version)
Auto-drafting POs, learning from last season's usage, prepay and price lock (a separate brainstorm).

## Risk
Changes how stock is reserved. Each step gets the full Sol review. Money is untouched.
