import { randomBytes } from 'node:crypto';

const STAGING_HOST = 'staging.croprxsolutions.app';
const KEY_FORMAT = /^AIza[A-Za-z0-9_-]{35}$/;

function installProbe(config) {
  const status = document.querySelector('#status');

  function setStatus(value) {
    status.textContent = JSON.stringify(value, null, 2);
  }

  async function providerFetch(url, options = {}) {
    return fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(12000) });
  }

  async function googleError(response) {
    const payload = await response.json().catch(() => null);
    const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
    const candidates = [payload?.error?.status, ...details.map((detail) => detail?.reason)];
    return candidates.filter((value) => typeof value === 'string' && /^[A-Z_]{3,64}$/.test(value));
  }

  async function dimensions(response) {
    const blob = await response.blob();
    const image = await createImageBitmap(blob);
    const result = { width: image.width, height: image.height, bytes: blob.size };
    image.close();
    return result;
  }

  async function checkTiles() {
    if (!config.tilesKey) return { state: 'staging key binding missing' };
    const sessionUrl = new URL('https://tile.googleapis.com/v1/createSession');
    sessionUrl.searchParams.set('key', config.tilesKey);
    const response = await providerFetch(sessionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapType: 'satellite', layerTypes: ['layerRoadmap'], overlay: false, language: 'en-US', region: 'US' }),
    });
    if (!response.ok) return { sessionStatus: response.status, reasons: await googleError(response), tileRequests: 0 };
    const { session } = await response.json();
    if (typeof session !== 'string' || !session) return { sessionStatus: response.status, state: 'unexpected session response', tileRequests: 0 };
    const tileUrl = new URL('https://tile.googleapis.com/v1/2dtiles/12/989/1535');
    tileUrl.searchParams.set('key', config.tilesKey);
    tileUrl.searchParams.set('session', session);
    const tile = await providerFetch(tileUrl);
    return {
      sessionStatus: response.status,
      tileStatus: tile.status,
      tileRequests: 1,
      ...(tile.ok ? { decodedImage: await dimensions(tile) } : { reasons: await googleError(tile) }),
    };
  }

  async function checkStatic() {
    if (!config.staticKey) return { state: 'staging key binding missing' };
    const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
    for (const [key, value] of Object.entries({ center: '41,-93', zoom: '13', size: '640x640', scale: '2', maptype: 'satellite', key: config.staticKey })) {
      url.searchParams.set(key, value);
    }
    const response = await providerFetch(url);
    const result = { status: response.status, imageRequests: 1, contentType: response.headers.get('content-type') };
    if (!response.ok || !result.contentType?.startsWith('image/')) return result;
    return {
      ...result,
      visibleWarningHeader: response.headers.has('x-staticmap-api-warning'),
      decodedImage: await dimensions(response),
    };
  }

  for (const [id, check] of Object.entries({ tiles: checkTiles, static: checkStatic })) {
    document.querySelector('#' + id).addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus({ check: id, state: 'running' });
      try {
        setStatus({ check: id, ...await check() });
      } catch (error) {
        setStatus({ check: id, state: error.name === 'TimeoutError' ? 'timed out' : 'browser fetch or image decode failed' });
      } finally {
        button.disabled = false;
      }
    });
  }
}

export default function handler(request, response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (
    request.headers.host !== STAGING_HOST ||
    process.env.VERCEL_TARGET_ENV !== 'staging' ||
    process.env.VERCEL_GIT_COMMIT_REF !== 'staging'
  ) {
    return response.status(404).end();
  }
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).end();
  }

  const nonce = randomBytes(18).toString('base64');
  const tilesKey = process.env.CRX_STEP0_GOOGLE_MAP_TILES_KEY ?? '';
  const staticKey = process.env.CRX_STEP0_GOOGLE_STATIC_MAPS_KEY ?? '';
  const config = JSON.stringify({
    tilesKey: KEY_FORMAT.test(tilesKey) ? tilesKey : null,
    staticKey: KEY_FORMAT.test(staticKey) ? staticKey : null,
  });
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "'",
    'connect-src https://tile.googleapis.com https://maps.googleapis.com',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  return response.status(200).send(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>CRX staging Maps checks</title><main><h1>CRX staging Maps checks</h1>' +
    '<button id="tiles" type="button">Check Google Tiles</button> ' +
    '<button id="static" type="button">Check Static Maps</button>' +
    '<pre id="status" role="status" aria-live="polite">Choose a check.</pre></main>' +
    '<script nonce="' + nonce + '">(' + installProbe.toString() + ')(' + config + ')</script></html>',
  );
}
