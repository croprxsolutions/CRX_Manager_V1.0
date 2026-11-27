function installPlacesCheck(key) {
  const button = document.querySelector('#places');
  const output = document.querySelector('#status');

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    const result = { autocompleteRequests: 0, detailRequests: 0 };
    const report = (state) => { output.textContent = JSON.stringify({ ...result, state }, null, 2); };
    if (!key) return report('staging key binding missing');
    report('running');

    async function request(url, fieldMask, body) {
      const headers = { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask };
      if (body) headers['Content-Type'] = 'application/json';
      return fetch(url, {
        method: body ? 'POST' : 'GET',
        headers,
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
    }

    async function reasons(response) {
      const payload = await response.json().catch(() => null);
      const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
      return [payload?.error?.status, ...details.map((detail) => detail?.reason)]
        .filter((value) => typeof value === 'string' && /^[A-Z_]{3,64}$/.test(value));
    }

    try {
      const base = 'https://places.googleapis.com/v1/places';
      const sessionToken = crypto.randomUUID();
      result.autocompleteRequests = 1;
      const autocomplete = await request(
        base + ':autocomplete', 'suggestions.placePrediction.placeId',
        JSON.stringify({ input: 'Iowa State Capitol Des Moines', includedRegionCodes: ['us'], sessionToken }),
      );
      result.autocompleteStatus = autocomplete.status;
      if (!autocomplete.ok) {
        result.reasons = await reasons(autocomplete);
        return report('autocomplete rejected');
      }
      const prediction = await autocomplete.json();
      const placeId = prediction.suggestions?.[0]?.placePrediction?.placeId;
      if (typeof placeId !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(placeId)) {
        return report('no usable public-place prediction');
      }
      result.detailRequests = 1;
      const details = await request(base + '/' + placeId + '?sessionToken=' + sessionToken, 'id,location');
      result.detailStatus = details.status;
      if (!details.ok) {
        result.reasons = await reasons(details);
        return report('place details rejected');
      }
      const place = await details.json();
      result.samePlace = place.id === placeId;
      result.hasLocation = Number.isFinite(place.location?.latitude) && Number.isFinite(place.location?.longitude);
      return report(result.samePlace && result.hasLocation ? 'passed' : 'unexpected place details');
    } catch (error) {
      result.errorType = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error?.name ?? '') ? error.name : 'Error';
      return report('browser request failed');
    }
  });
}

export function renderPlacesDiagnostic(response, nonce, key) {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "'",
    'connect-src https://places.googleapis.com',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  return response.status(200).send(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>CRX staging Places check</title><main><h1>CRX staging Places check</h1>' +
    '<button id="places" type="button">Check Google Places</button><pre id="status" role="status" aria-live="polite">Ready</pre>' +
    '<p><a href="/">Back to CRX</a></p></main>' +
    '<script nonce="' + nonce + '">(' + installPlacesCheck.toString() + ')(' + JSON.stringify(key) + ')</script></html>',
  );
}
