# Places API staging proof

Open `https://staging.croprxsolutions.app/api/maps-step0?places=1` after its staging deployment. First confirm the exact signed-out URL redirects to Vercel sign-in. Then verify the signed-in response has one Content Security Policy allowing browser requests to `places.googleapis.com`.

Before running, confirm that the bound browser key is restricted by Google Cloud to Places API (New) and the exact staging referrer `https://staging.croprxsolutions.app/*`. The protected page sends that restricted key to the browser for the direct request. On Nov. 26, 2026, project `crx-maps-staging` showed both restrictions on **CRX Step 0 staging Places**. Vercel showed `CRX_STEP0_GOOGLE_PLACES_KEY` as a Secret for custom staging only.

Choose **Check Google Places** once. Each page load can send one autocomplete for a public landmark and one minimal details request if it receives a usable place ID. A pass requires HTTP 200 for both, details for the same prediction, and a finite location. Record status, safe provider reason codes, counts and date. Keep keys, full request data, session tokens and provider payloads out of the proof record. If Google rejects website restrictions, stop this client API path and record the provider result before evaluating another approach.

On Nov. 26, 2026, Google Cloud showed 175,000 autocomplete requests and 125,000 details requests per day in `crx-maps-staging`, with per-minute limits of 12,000 and 600 respectively. The existing [project budget and monitoring](./staging-probe.md) apply independently of the page's request limit. Record public Places disclosures and verify the installed app search behavior before the shared integration proceeds.

- [ ] **Owner: Maps Step 0 Codex verification task.** At Step 0 cleanup, submit removal of the Places handler, its imported diagnostic and tests to the staging lander. Retire its staging binding after removal.
