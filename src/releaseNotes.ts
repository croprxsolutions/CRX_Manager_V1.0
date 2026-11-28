// Written by the release bot (.github/scripts/release-flow.mjs) for each release. Don't edit by hand.
export interface ReleaseNotes {
  version: string;
  date: string;
  items: string[];
}

export const releaseNotes: ReleaseNotes = {
  "version": "0.2.0",
  "date": "2026-11-28",
  "items": [
    "Inventory Cost shows which barn each stock row is in and counts each product once; its date boxes are replaced by \"Stock as of when this report loaded\". Sales Reports and Program Tracker filters are read out by name to screen readers.",
    "An old copy of the app, or a queued completion, that sends a signature or photo without the list of products is refused with a message that this copy of CRX is out of date: tap Reload on the new-version notice (or close and reopen CRX), then take the proof again. The codes stay `DELIVERY_LOAD_CHANGED`, `PAPER_TICKET_LOAD_CHANGED` and `LEFT_AT_SITE_LOAD_CHANGED` (Taha's review). Drivers on the new screens (#2614) see no change.",
    "The bookkeeper on Record Payments.",
    "If the products or amounts on a delivery change after the customer signed or a ticket or drop-location photo was taken, the app asks for a new signature or photo instead of reusing the old one. If the office changed the delivery while the driver was on the stop, the products reload before anything is sent.",
    "None (a delivered amount under 0.01 next to real amounts now counts as zero instead of billing a fraction of a cent).",
    "Record Payments is faster from the keyboard, keeps its totals on screen, has a Pay full balance button and warns before you lose typed amounts; the A/R screens share one customer box.",
    "Select All on statements picks only the customers you can see, the send button shows how many will be emailed, and a Last emailed column shows when each customer last got a statement.",
    "Once M4 is switched on, a discounted sale's commission is worked out on the profit after the discount when its invoice is posted, never on sales tax.",
    "The bookkeeper and office staff on Chemical Invoices and Field Invoices.",
    "The Today page's overdue list includes chemical invoices, Payment History can be filtered by date, Month-End checklist lines link to what needs fixing, and aging buckets have the same names everywhere, statements included.",
    "Reps and office staff on quotes, orders, dashboards and Getting Started.",
    "Nothing. Developer tooling only.",
    "Drivers on the My Route stop screen. The office sees the reported issue in the same place as issues reported from delivery detail.",
    "Drivers on My Route, the stop screen and delivery detail. Customers get a cleaner signature on the receipt PDF.",
    "Office staff and admins, in the left menu and phone drawer.",
    "Applicators only, on My Day, only while a completion is waiting offline.",
    "Applicators pick wind direction with a tap, get the number pad for weather, and can reuse today's last weather; the office sees a warning on Deliveries when a scheduled delivery has no driver.",
    "Drivers see the address with Call and Navigate buttons, a one-tap signer name, Next Stop goes to the next stop, a \"Done today\" list, clearer no-signal wording and easier-to-read notes.",
    "On a phone, the bottom bar now shows the buttons for your job: drivers get My Route and Deliveries, applicators get My Day, My Jobs and Record Book, reps get Today, Quotes and Customers.",
    "On the office delivery edit form, picking **Unassigned** for the driver now actually removes the driver. Before, the save quietly kept the old driver.",
    "The form tells the database which driver it showed when it opened. If someone changed the driver since, nothing is saved, a plain message explains why, and the form closes and reloads the delivery so the next edit shows the current driver.",
    "A started delivery cannot be unassigned. That option is greyed out, and the database refuses it anyway.",
    "Keeping the driver, or picking another driver, works as before. A \"Take Delivery\" done while the form was open is not undone by the save.",
    "While a save is running, Save, Cancel and the driver list are locked. If the reply is unclear, the form unlocks and Save can safely retry (it reuses the same request key).",
    "Unpost works on an invoice whose payments were all voided. The voided payment stays in Payment History.",
    "None yet (the screen change ships in the follow-up PR).",
    "None yet (the screen change ships in the follow-up PR).",
    "When a product's unit can't be changed because of its history, the message now says whether it is stock movements, an active hold, or both."
  ]
};
