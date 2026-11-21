import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageLoadFallback, workboxOptions } from './workbox';

const pageRoute = () => workboxOptions.runtimeCaching?.find((r) => r.handler === 'NetworkFirst');

describe('service worker page loads (network, then the precached shell)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('no longer answers page loads from the precached index.html first', () => {
    // null, not left out: vite-plugin-pwa puts back its 'index.html' default when the option is missing, and that
    // NavigationRoute is registered before runtimeCaching, so it would answer every page load (seen in a build).
    expect(workboxOptions.navigateFallback).toBeNull();
  });

  it('sends page loads to the network, with a 4 s timeout, never caches pages, and falls back to the shell', () => {
    const route = pageRoute();
    expect(route).toBeDefined();
    const match = route!.urlPattern as (o: { request: { mode: string } }) => boolean;
    expect(match({ request: { mode: 'navigate' } })).toBe(true);
    expect(match({ request: { mode: 'cors' } })).toBe(false);
    expect(route!.options?.networkTimeoutSeconds).toBe(4);
    // No page cache: a cached page could come from a newer build than the precached files and point at chunks the
    // worker doesn't have. Timeouts and errors always end on the precached shell, which matches the precached files.
    const plugin = route!.options?.plugins?.[0];
    expect(plugin?.cachedResponseWillBeUsed).toBe(pageLoadFallback);
    expect(plugin?.handlerDidError).toBe(pageLoadFallback);
  });

  it('never writes a page into its cache', async () => {
    const plugin = pageRoute()!.options!.plugins![0];
    const willUpdate = plugin.cacheWillUpdate as unknown as () => Promise<unknown>;
    await expect(willUpdate()).resolves.toBeNull();
  });

  it('keeps precaching the app shell, so offline still opens', () => {
    expect(workboxOptions.globPatterns).toContain('**/*.{js,css,html,svg,png,woff2}');
    expect(workboxOptions.cleanupOutdatedCaches).toBe(true);
  });

  it('offline with no cached page, falls back to the precached index.html', async () => {
    const shell = new Response('<!doctype html><div id="root"></div>', { status: 200 });
    const match = vi.fn().mockResolvedValue(shell);
    vi.stubGlobal('caches', { match });
    await expect(pageLoadFallback()).resolves.toBe(shell);
    expect(match).toHaveBeenCalledWith('/index.html', { ignoreSearch: true });
  });

  it('with no precached shell either, fails like a network error', async () => {
    vi.stubGlobal('caches', { match: vi.fn().mockResolvedValue(undefined) });
    const res = await pageLoadFallback();
    expect(res.type).toBe('error');
  });
});
