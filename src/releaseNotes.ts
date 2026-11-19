// Written by the release bot (.github/scripts/release-flow.mjs) for each release. Don't edit by hand.
export interface ReleaseNotes {
  version: string;
  date: string;
  items: string[];
}

export const releaseNotes: ReleaseNotes = {
  "version": "0.1.0",
  "date": "2026-11-19",
  "items": [
    "Invoices now bill the price that was on the quote you sent; if a quote changed since you sent it, the invoice asks you to resend it or type the price.",
    "After a deploy, one reload gets the new version and sign-in keeps working. Offline and weak-signal loading work as before.",
    "None (CI only).",
    "Invoice price boxes take normal typing, and a bad price shows a short note under the box instead of a pop-up.",
    "Invoice and payer amounts now match to the cent before and after saving.",
    "Nothing changes on staging. On live, the sales tax and standing discount controls are hidden until commission ships.",
    "Printed and emailed invoices match the quote style and show how the total adds up.",
    "Invoices are easier to find and post, and billing details are shown on the delivery, driver and customer pages.",
    "The invoice page shows what you owe and how it adds up, and one clear next step.",
    "The sale page shows one money summary, invoices by payer and a clearer Who pays card.",
    "Quote previews and PDFs look like the approved design, and bulk import walks you through three steps.",
    "The quote builder is laid out in clear sections, and nothing you typed is removed without asking.",
    "The quotes list is easier to scan, with clear status colours, a filter chip and a bulk bar.",
    "nothing. Docs only, with no app, database or Edge Function change.",
    "nothing; agent tooling only.",
    "None (staging only).",
    "None (team Slack only).",
    "None (staging only).",
    "After each release, a short \"What's new\" dialog listing the release's user-facing changes, shown once.",
    "None (the What's new dialog is PR 5).",
    "None on production. Staging shows the amber strip."
  ]
};
