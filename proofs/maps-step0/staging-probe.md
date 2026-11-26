# First live Google Maps checks

The protected staging probe is `https://staging.croprxsolutions.app/api/maps-step0` once this candidate is deployed from the staging branch. It requires the existing Vercel staging protection. The function refuses production, generic previews and other hosts. The response is private and noncacheable, with a browser policy scoped to this route and two Google hosts. The rest of the app serves the existing policy.

On Nov. 26, 2026, Google Cloud project `crx-maps-staging` showed **staging live maps**, restricted to Map Tiles API, and **staging prints**, restricted to Maps Static API. Both allow the exact staging website. Vercel showed `CRX_STEP0_GOOGLE_MAP_TILES_KEY` and `CRX_STEP0_GOOGLE_STATIC_MAPS_KEY` saved as secrets for the custom staging environment only. No separate Places key was present. The 2D tile limit was 5,000 per day and 6,000 per minute. Static Maps showed 500 signed and 25,000 unsigned requests per day. No limits were changed.

1. Open the protected URL in a new browser tab and choose **Check Google Tiles**. The synthetic test performs one session request. On session success it requests and decodes one tile. Record statuses, any Google reason code, decoded dimensions and the time. A provider rejection of the website restriction triggers the design's stop rule and server-route cost review.
2. Choose **Check Static Maps** to make one unsigned request at size 640 × 640 and scale 2. Record HTTP status, image dimensions, and browser visibility of the warning header. An image decode alone cannot establish that this is a usable map. PDF embedding of a real Google response and warning/error discrimination remain separate checks.

The probe reports status codes, counts and image sizes. Its diagnostics omit provider URLs, credentials and session contents. The provided staging URL remains unverified until deployment. Live drawing recovery, provider credits, Places, and the installed work-phone test remain open.

Local access and policy checks run via `node --test proofs/maps-step0/staging-probe.test.mjs`. The existing local Chrome drawing tests are in the separate [key-free proof](https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/2594).
