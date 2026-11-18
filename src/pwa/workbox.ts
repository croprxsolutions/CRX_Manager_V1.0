import type { VitePWAOptions } from 'vite-plugin-pwa';

/** The worker's cache storage, typed here without the DOM lib (vite.config.ts loads this file in Node too). */
type ShellCache = { match(request: string, options: { ignoreSearch: boolean }): Promise<Response | undefined> };

/**
 * Fallback for a page load that failed or took over 4 s: the precached app shell, which always matches the precached
 * JS and CSS. Runs inside the service worker, so it must not use anything outside its own body (workbox-build copies
 * the function's source into sw.js).
 */
export async function pageLoadFallback(): Promise<Response> {
  const { caches } = globalThis as unknown as { caches: ShellCache };
  return (await caches.match('/index.html', { ignoreSearch: true })) ?? Response.error();
}

/**
 * Service worker caching (vite-plugin-pwa generateSW). Page loads go to the network, so an online browser always
 * gets the live index.html with today's headers (CSP) and chunk names. A worker left in charge after a deploy can no
 * longer block sign-in ("Failed to fetch", 11 and 16 Nov) or point at deleted chunks. Offline, or after 4 s on a
 * weak signal, the precached shell opens instead, as before.
 */
export const workboxOptions: NonNullable<Partial<VitePWAOptions>['workbox']> = {
  globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
  // Aggressively clean up old caches — critical for Safari iOS
  cleanupOutdatedCaches: true,
  // clientsClaim and skipWaiting stay off: with registerType 'prompt' they would activate the new worker and
  // reload pages on mobile. The UpdatePrompt component handles activation when the user consents.
  // Don't precache sw-doctor.js so it always loads from network
  globIgnores: ['**/sw-doctor.js'],
  // No navigation fallback: it answered every page load from the precached index.html, headers and all. null, not
  // left out: vite-plugin-pwa puts back an 'index.html' default when the option is missing.
  navigateFallback: null,
  runtimeCaching: [
    {
      urlPattern: ({ request }) => request.mode === 'navigate',
      // NetworkFirst only because generateSW allows networkTimeoutSeconds with no other handler. Pages are never
      // cached (cacheWillUpdate), and every cache lookup answers with the precached shell, so a timeout or a
      // network error always ends on the shell that matches the precached files (see pageLoadFallback).
      handler: 'NetworkFirst',
      options: {
        cacheName: 'crx-pages',
        networkTimeoutSeconds: 4,
        plugins: [{
          cacheWillUpdate: async () => null,
          cachedResponseWillBeUsed: pageLoadFallback,
          handlerDidError: pageLoadFallback,
        }],
      },
    },
  ],
  // No runtimeCaching for Google Fonts: a service-worker fetch is checked
  // against the CSP connect-src, which does not list the font hosts, so
  // those rules blocked the fonts. The browser loads them directly instead
  // (allowed by style-src / font-src) and caches them over HTTP.
};
