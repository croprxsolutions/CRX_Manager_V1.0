## 2026-11-10 - Environment banner and tab title on staging and local builds

Staging now shows an amber "STAGING · test data only" strip at the top of every page (login included),
and local builds a blue "LOCAL" strip. A thin line of the same colour stays at the top edge while
scrolling, and the browser tab title starts with "STAGING · " or "LOCAL · ". Production shows nothing.

One build-time variable drives it: `VITE_APP_ENV` (`staging` on the Vercel staging environment;
the Vite dev server counts as local; unset or `production` is production). `src/lib/appEnv.ts`
reads it, `src/components/ui/EnvBanner.tsx` draws it from `RootLayout`, and `src/main.tsx` sets the
title prefix. `.env.example` and `.env.staging.example` list the variable. The strip scrolls with the
page on purpose, so the sticky top bar and the pages' sticky offsets don't move; the cost is that
staging and local pages scroll by the strip's ~20px even when short. The words "test data only" appear
only when the build's database is positively the staging project or a local one; otherwise the strip
says "check which database this uses". A misspelt `VITE_APP_ENV` shows the staging strip rather than
nothing, and a build pointed at the staging database is staging even if the variable is missing. It is a
plain label, not a live region, so screen readers don't announce it on every load.

Tests: `src/lib/appEnv.test.ts`, `src/components/ui/EnvBanner.test.tsx`. Part of the staging-first
release flow (Taha, 2026-11-10).
