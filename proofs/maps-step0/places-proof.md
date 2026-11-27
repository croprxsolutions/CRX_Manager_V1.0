# Places API staging proof

Open `https://staging.croprxsolutions.app/api/maps-step0?places=1` after its staging deployment. First confirm the exact signed-out URL redirects to Vercel sign-in. Then verify the signed-in response has one Content Security Policy allowing browser requests to `places.googleapis.com`.

Choose **Check Google Places** once. It uses a public landmark and sends one autocomplete request. It sends one minimal details request only if it receives a usable place ID. A pass requires HTTP 200 for both, details for the same prediction, and a finite location. Record status, safe provider reason codes, counts and date. Keep keys, full request data, session tokens and provider payloads out of the proof record. If Google rejects website restrictions, stop this client API path and record the provider result before evaluating another approach.

The separate staging secret is `CRX_STEP0_GOOGLE_PLACES_KEY`. Google Cloud showed 175,000 autocomplete requests and 125,000 details requests per day, with per-minute limits of 12,000 and 600 respectively. This diagnostic makes a bounded request pair from one page. The existing project quotas and budget are managed separately. Record public Places disclosures and verify the installed app search behavior before the shared integration proceeds. Remove this diagnostic and its staging binding at Step 0 cleanup.
