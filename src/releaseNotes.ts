// Written by the release bot (.github/scripts/release-flow.mjs) for each release. Don't edit by hand.
export interface ReleaseNotes {
  version: string;
  date: string;
  items: string[];
}

export const releaseNotes: ReleaseNotes = {
  "version": "0.2.0",
  "date": "2026-11-24",
  "items": [
    "Unpost works on an invoice whose payments were all voided. The voided payment stays in Payment History.",
    "None yet (the screen change ships in the follow-up PR).",
    "None yet (the screen change ships in the follow-up PR).",
    "When a product's unit can't be changed because of its history, the message now says whether it is stock movements, an active hold, or both."
  ]
};
