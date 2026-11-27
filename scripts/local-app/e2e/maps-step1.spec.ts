import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { localSql } from './local-db';

// This spec only: the keyless lane must prove real USDA tiles load, so that one public host may
// leave this computer. Every other spec keeps the config's dead proxy; Mapbox stays intercepted.
test.use({ proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,basemap.nationalmap.gov' } });

const fakeToken = process.env.CRX_MAP_SWAP_FAKE_MAPBOX_TOKEN ?? '';
const proofName = fakeToken ? 'mapbox-fixture' : 'usda-keyless';
const proofDir = resolve(process.cwd(), 'proofs/maps-step1');
const phoneViewport = { width: 390, height: 844 };
const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAABqElEQVR4nO2aoU7DQBzGv305heIBppbwCjjsULMoTN9gE30KBLzBDAoLBiwORUA2VJDqBQWWkIamW9vRS693/Uh/6rIsd/3t3/7bfrfJy+sd+uTwYJoPPj6zPuYnxCHEIcQxxWg2Pepjgc3mC34EANw8rt3OfnYSoWcMPFIucpolTub0KgDg4vYyH8SLVe0XbMV8C1RNdrAVCybQUSz99RmcQBuxsoz8fYAQhz4XS7Ok6RptT7xYlS/osQKhIcQhxCHEIaSIt1uQnkCVUSA0hDiEOPS8XpfHobjSgsYKDABCHEIc4zmHysmv46b3dysmAeP1cs71p0xtC/oReH97hjKEOIQ4pqedH29bTKb6kauNAlf5837qo8X7p2t04/T4HE6Zbf+sw81GZw31Xz9cFeNovizGZsgHOugdGtsDbcJ3BVwd9/+5DxBqRPNlsHQ6zZJyA3GCXgV2GAVCQ4hDiEPP6zlvRIQ4hDiEOIQ4hPKDEIIIuG1EhDgm1MJFEdbdXnHCCJTP46hyOlkpGT+hiFV8FNkohUyn27Pn/5qDy4VQx56QT74LfQPoro0wnHV52wAAAABJRU5ErkJggg==',
  'base64',
);

function safeConsoleText(value: string) {
  return value.replace(/\b(?:https?|wss?):\/\/[^\s'")]+/gi, '[URL]');
}

async function signIn(page: Page) {
  await page.addLocatorHandler(
    page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /what's new/i }) }),
    async (dialog) => { await dialog.getByRole('button', { name: /close|got it/i }).first().click(); },
  );
  await page.goto('/login');
  await page.locator('#email').fill(process.env.LOCAL_TEST_EMAIL!);
  await page.locator('#password').fill(process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);
}

async function screenshot(page: Page, name: string, fullPage = true) {
  mkdirSync(proofDir, { recursive: true });
  await page.screenshot({ path: resolve(proofDir, `${proofName}-${name}.png`), fullPage });
}

async function mapCanvas(page: Page) {
  const canvas = page.locator('canvas.maplibregl-canvas').first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('MapLibre canvas has no visible bounds');
  return { canvas, box };
}

async function scrollPhoneMapIntoView(page: Page) {
  await page.locator('.maplibregl-map').evaluate((map) => {
    window.scrollBy(0, map.getBoundingClientRect().top - 160);
  });
}

async function expectDesktopFieldSetupControlsToFit(page: Page) {
  const selectors = [
    '.mapbox-gl-draw_ctrl-draw-btn',
    '.crx-map-locate-control button',
    'input[placeholder="Search address or coordinates..."]',
    '.maplibregl-ctrl-zoom-in',
    '.maplibregl-ctrl-zoom-out',
  ];
  const boxes = await page.evaluate((controlSelectors) => {
    const map = document.querySelector('.maplibregl-map')?.getBoundingClientRect();
    const controls = controlSelectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element || !map) return { selector, missing: true };
      const rect = element.getBoundingClientRect();
      return {
        selector,
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        withinMap: rect.left >= map.left && rect.top >= map.top && rect.right <= map.right && rect.bottom <= map.bottom,
      };
    });
    const overlaps: string[] = [];
    for (let left = 0; left < controls.length; left += 1) {
      const a = controls[left];
      if ('missing' in a) continue;
      for (let right = left + 1; right < controls.length; right += 1) {
        const b = controls[right];
        if ('missing' in b) continue;
        if (a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) {
          overlaps.push(`${a.selector} / ${b.selector}`);
        }
      }
    }
    return { controls, overlaps };
  }, selectors);
  expect(boxes.controls.filter((box) => !('missing' in box))).toHaveLength(selectors.length);
  expect(boxes.controls.every((box) => 'missing' in box || box.withinMap), JSON.stringify(boxes)).toBe(true);
  expect(boxes.overlaps, JSON.stringify(boxes)).toEqual([]);
  for (const selector of selectors) await page.locator(selector).click({ trial: true });
}

async function expectPhoneMapControlsInsideMap(page: Page) {
  const layout = await page.evaluate(() => {
    const map = document.querySelector<HTMLElement>('.maplibregl-map');
    const mapRect = map?.getBoundingClientRect();
    const controls = [
      { selector: 'attribution', element: map?.querySelector('.maplibregl-ctrl-attrib') ?? null },
      { selector: 'LayerToggle', element: map?.parentElement?.querySelector('.crx-map-layer-toggle') ?? null },
      { selector: 'LocateMe', element: map?.querySelector('.crx-map-locate-control') ?? null },
      { selector: 'zoom-in', element: map?.querySelector('.maplibregl-ctrl-zoom-in') ?? null },
      { selector: 'zoom-out', element: map?.querySelector('.maplibregl-ctrl-zoom-out') ?? null },
    ];
    const missing = controls.filter(({ element }) => !element).map(({ selector }) => selector);
    const boxes = controls.flatMap(({ selector, element }) => {
      if (!element || !mapRect) return [];
      const rect = element.getBoundingClientRect();
      return [{
        selector,
        x: rect.left,
        y: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        visible: rect.width > 0 && rect.height > 0,
        withinMap: rect.left >= mapRect.left && rect.top >= mapRect.top
          && rect.right <= mapRect.right && rect.bottom <= mapRect.bottom,
      }];
    });
    const overlaps: string[] = [];
    for (let left = 0; left < boxes.length; left += 1) {
      const a = boxes[left];
      for (let right = left + 1; right < boxes.length; right += 1) {
        const b = boxes[right];
        if (a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) {
          overlaps.push(`${a.selector} / ${b.selector}`);
        }
      }
    }
    const mapVisibleOnScreen = !!mapRect && mapRect.left >= 0 && mapRect.top >= 0
      && mapRect.right <= window.innerWidth && mapRect.bottom <= window.innerHeight;
    return { boxes, missing, overlaps, mapVisibleOnScreen };
  });
  expect(layout.mapVisibleOnScreen, JSON.stringify(layout)).toBe(true);
  expect(layout.missing, JSON.stringify(layout)).toEqual([]);
  expect(layout.boxes.every((box) => box.visible && box.withinMap), JSON.stringify(layout)).toBe(true);
  expect(layout.overlaps, JSON.stringify(layout)).toEqual([]);
}

async function expectPhoneDrawingOffsets(page: Page, drawing: boolean) {
  const offsets = await page.evaluate(() => ({
    drawingClass: document.querySelector('.crx-field-setup-drawing') !== null,
    topRight: getComputedStyle(document.querySelector('.maplibregl-ctrl-top-right')!).top,
    attributionMargin: getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib')!).marginBottom,
  }));
  expect(offsets.drawingClass).toBe(drawing);
  if (drawing) {
    expect(offsets.topRight).toBe('68px');
    expect(offsets.attributionMargin).toBe('180px');
  } else {
    expect(offsets.topRight).not.toBe('68px');
    expect(offsets.attributionMargin).not.toBe('180px');
  }
}

async function zoomToFieldScale(page: Page, usdaTileZooms: number[]) {
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect.poll(() => usdaTileZooms.length, { timeout: 15000 }).toBeGreaterThan(0);
  for (let index = 0; index < 8; index += 1) {
    await page.locator('.maplibregl-ctrl-zoom-in').click();
    await page.waitForTimeout(500);
  }
  await expect.poll(() => Math.max(...usdaTileZooms, 0), { timeout: 15000 }).toBeGreaterThanOrEqual(14);
}

async function panMapAwayFromExistingFields(page: Page, distance = 180) {
  const { box } = await mapCanvas(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - Math.min(distance, box.width * 0.4), y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function drawPolygon(page: Page, offsetX: number) {
  const { box } = await mapCanvas(page);
  const cx = box.x + box.width * 0.38 + offsetX;
  const cy = box.y + box.height * 0.32;
  const points = [
    { x: cx - 70, y: cy - 70 },
    { x: cx + 70, y: cy - 70 },
    { x: cx + 70, y: cy + 70 },
    { x: cx - 70, y: cy + 70 },
  ];
  const replaceOrStart = page.getByRole('button', { name: /^(draw field boundary|redraw boundary)$/i });
  const addAnother = page.getByRole('button', { name: 'Add another section', exact: true });
  const firstPartButton = offsetX === 0 && await replaceOrStart.count() > 0
    ? replaceOrStart.first()
    : await addAnother.count() > 0 ? addAnother.first() : replaceOrStart.first();
  await firstPartButton.click();
  for (const point of points) await page.mouse.click(point.x, point.y);
  await page.getByRole('button', { name: 'Done' }).click();
  if (offsetX !== 0) await expect(page.getByText('Part 2 of 2')).toBeVisible();
}

test('field maps use the local MapLibre style and preserve picture, boundary and marker behavior', async ({ page }) => {
  test.setTimeout(180_000); // one long walkthrough over many screens; 90 s ran out on a cold dev server
  const requestedHosts = new Set<string>();
  const failedResponseHosts: string[] = [];
  const mapboxTilePaths: string[] = [];
  const mapboxStaticPaths: string[] = [];
  const mapboxTileZooms: number[] = [];
  const usdaTileZooms: number[] = [];
  const usdaSuccessfulTileZooms: number[] = [];
  const workerUrls: string[] = [];
  const boundaryRpcResults: Array<{ status: number; code?: string; message?: string }> = [];
  const markerWriteResults: string[] = [];
  const markerReadResults: string[] = [];
  const customerFieldResponseShapes: Array<{ path: string; centroidType: string; geometryType: string | null; coordinates: unknown }> = [];
  let customerMapCaptureFieldId = '';
  let captureCustomerMapResponse = false;
  const consoleErrors: string[] = [];
  let holdUsdaTiles = false;
  let delayedUsdaTileCount = 0;
  let pendingUsdaTiles = 0;
  let holdMapboxTiles = false;
  let pendingMapboxTiles = 0;
  // MapLibre fetches tiles only for a visible picture, so the style named in new tile requests is the one on screen.
  const expectMapboxPictureFrom = async (since: number, style: 'satellite-streets-v12' | 'streets-v12') => {
    await expect.poll(() => mapboxTilePaths.slice(since).some((path) => path.includes(`/mapbox/${style}/tiles/`)), {
      message: `expected ${style} tiles after index ${since}; console: ${consoleErrors.join(' | ')}`,
    }).toBe(true);
  };
  // The supported screen-walk local stack intentionally omits Supabase Realtime; keep its
  // unused live-update socket idle so a local-only 404 does not pollute browser diagnostics.
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, () => {});
  await page.route('https://basemap.nationalmap.gov/**', async (route) => {
    if (holdUsdaTiles && new URL(route.request().url()).pathname.includes('/tile/')) {
      delayedUsdaTileCount += 1;
      pendingUsdaTiles += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.continue();
      } finally {
        pendingUsdaTiles -= 1;
      }
    } else {
      await route.continue();
    }
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    requestedHosts.add(url.hostname);
    if (url.hostname === 'api.mapbox.com') {
      if (url.pathname.includes('/tiles/')) mapboxTilePaths.push(url.pathname);
      if (url.pathname.includes('/static/')) mapboxStaticPaths.push(url.pathname);
      const zoom = Number(url.pathname.match(/\/tiles\/512\/(\d+)\//)?.[1]);
      if (Number.isFinite(zoom)) mapboxTileZooms.push(zoom);
    }
    if (/maplibre.*worker|worker.*maplibre/i.test(url.pathname)) workerUrls.push(`${url.origin}${url.pathname}`);
    if (url.hostname === 'basemap.nationalmap.gov') {
      const zoom = Number(url.pathname.match(/\/tile\/(\d+)\//)?.[1]);
      if (Number.isFinite(zoom)) usdaTileZooms.push(zoom);
    }
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    consoleErrors.push(safeConsoleText(message.text()));
    console.warn(`Browser console error: ${safeConsoleText(message.text())}`);
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(safeConsoleText(error.message));
    console.warn(`Browser page error: ${safeConsoleText(`${error.message}
${error.stack ?? ''}`)}`);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname === 'basemap.nationalmap.gov' && response.ok()) {
      const zoom = Number(url.pathname.match(/\/tile\/(\d+)\//)?.[1]);
      if (Number.isFinite(zoom)) usdaSuccessfulTileZooms.push(zoom);
    }
    if (response.status() >= 400) {
      const location = ['api.mapbox.com', 'basemap.nationalmap.gov'].includes(url.hostname)
        ? url.hostname
        : `${url.hostname}${url.pathname}`;
      const request = response.request();
      const descriptor = `${response.status()} ${request.method()} ${location}`;
      if (url.pathname === '/rest/v1/fields') {
        void response.json().then((body: { code?: string; message?: string }) => {
          failedResponseHosts.push(`${descriptor} ${body.code ?? ''} ${body.message ?? ''}`.trim());
        }).catch(() => failedResponseHosts.push(`${descriptor} (body unavailable)`));
      } else {
        failedResponseHosts.push(descriptor);
      }
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (captureCustomerMapResponse && response.ok() && url.pathname.startsWith('/rest/v1/')) {
      void response.json().then((payload: unknown) => {
        const rows = Array.isArray(payload) ? payload : [payload];
        const row = rows.find((candidate): candidate is Record<string, unknown> =>
          !!candidate && typeof candidate === 'object' && 'id' in candidate
          && candidate.id === customerMapCaptureFieldId,
        );
        if (!row || !('centroid_geojson' in row)) return;
        const raw = row.centroid_geojson;
        let geometry: { type?: string; coordinates?: unknown } | null = null;
        try {
          geometry = typeof raw === 'string' ? JSON.parse(raw) as { type?: string; coordinates?: unknown } : raw as { type?: string; coordinates?: unknown };
        } catch {
          // Keep the raw response type so the test report shows a parse failure.
        }
        customerFieldResponseShapes.push({
          path: url.pathname,
          centroidType: typeof raw,
          geometryType: geometry?.type ?? null,
          coordinates: geometry?.coordinates ?? null,
        });
      }).catch(() => {});
    }
    if (url.pathname.endsWith('/rest/v1/field_obstacles') && response.request().method() === 'POST') {
      markerWriteResults.push(String(response.status()));
    }
    if (url.pathname.endsWith('/rpc/get_field_marker_read')) {
      void response.json().then((payload: { available?: boolean; count?: number; markers?: unknown[] } | Array<{ available?: boolean; count?: number; markers?: unknown[] }>) => {
        const snapshot = Array.isArray(payload) ? payload[0] : payload;
        markerReadResults.push(`${response.status()}:${snapshot?.available}:${snapshot?.count}:${snapshot?.markers?.length}`);
      }).catch(() => markerReadResults.push(`${response.status()}:unreadable`));
    }
    if (url.pathname.endsWith('/rpc/set_field_boundary')) {
      void response.json().then((body: { code?: string; message?: string; error?: string }) => {
        boundaryRpcResults.push({ status: response.status(), code: body.code, message: body.message ?? body.error });
      }).catch(() => boundaryRpcResults.push({ status: response.status() }));
    }
  });

  if (fakeToken) {
    await page.route('https://api.mapbox.com/**', async (route) => {
      const isTile = new URL(route.request().url()).pathname.includes('/tiles/');
      if (holdMapboxTiles && isTile) {
        pendingMapboxTiles += 1;
        try {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          await route.fulfill({ status: 200, contentType: 'image/png', body: fixturePng });
        } finally {
          pendingMapboxTiles -= 1;
        }
      } else {
        await route.fulfill({ status: 200, contentType: 'image/png', body: fixturePng });
      }
    });
  }

  await signIn(page);
  const suffix = Date.now().toString(36);
  const customerName = `Map proof farm ${suffix}`;
  const fieldName = `Map proof field ${suffix}`;
  const customerId = await page.evaluate(async (farmName) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const { data, error } = await supabase.from('customers').insert({ farm_name: farmName }).select('id').single();
    if (error || !data) throw new Error(`Local invented customer insert failed (${error?.code ?? 'no row'})`);
    return data.id as string;
  }, customerName);

  await page.goto('/fields/new');
  await expect(page.getByRole('heading', { name: 'New Field' })).toBeVisible();
  await page.getByLabel('Field Name').fill(fieldName);
  await page.getByRole('combobox', { name: 'Owner (Customer)' }).fill(customerName);
  await page.getByRole('option', { name: customerName }).click();
  await mapCanvas(page);
  await screenshot(page, 'desktop-field-setup-controls');
  await expectDesktopFieldSetupControlsToFit(page);

  if (fakeToken) {
    await expect(page.getByRole('button', { name: 'Satellite' }).first()).toBeVisible();
    await zoomToFieldScale(page, mapboxTileZooms);
    await expect(page.getByText('© Mapbox', { exact: false })).toBeVisible();
    await expectMapboxPictureFrom(0, 'satellite-streets-v12');
    const credits = page.locator('.maplibregl-ctrl-attrib');
    // The logo is a CSS background; require that its picture actually loaded, not just that the link is there.
    const logo = credits.locator('.crx-mapbox-logo');
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate(async (el) => {
      const url = getComputedStyle(el).backgroundImage.match(/^url\("(.*)"\)$/)?.[1];
      if (!url) return 0;
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => undefined);
      return img.naturalWidth;
    }), { message: 'Mapbox logo picture did not load' }).toBeGreaterThan(0);
    await expect(credits).toContainText('© Maxar');
    await expect(credits.getByRole('link', { name: 'Improve this map' })).toBeVisible();
    holdMapboxTiles = true;
    await panMapAwayFromExistingFields(page);
    await page.locator('.maplibregl-ctrl-zoom-in').click();
    await expect.poll(() => pendingMapboxTiles, { timeout: 8000 }).toBeGreaterThan(0);
    await page.locator('.maplibregl-ctrl-zoom-out').click();
    await page.waitForTimeout(250);
    const usdaRequestsBeforeSwitch = usdaTileZooms.length;
    const loadingPictureToggle = page.locator('.crx-map-layer-toggle');
    await loadingPictureToggle.getByRole('button', { name: 'Satellite' }).click();
    await page.getByRole('button', { name: 'USDA aerial' }).click();
    await expect(loadingPictureToggle.getByRole('button', { name: 'USDA aerial' })).toBeVisible();
    await expect.poll(() => usdaTileZooms.length, { timeout: 5000 }).toBeGreaterThan(usdaRequestsBeforeSwitch);
    await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('USDA, USGS The National Map');
    holdMapboxTiles = false;
    await expect.poll(() => pendingMapboxTiles, { timeout: 8000 }).toBe(0);
    await loadingPictureToggle.getByRole('button', { name: 'USDA aerial' }).click();
    await page.getByRole('button', { name: 'Satellite' }).click();
    await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('© Mapbox');
    await panMapAwayFromExistingFields(page);
    await page.getByRole('button', { name: /Draw field boundary|Redraw boundary/ }).click();
    const { box } = await mapCanvas(page);
    const cx = box.x + box.width * 0.38;
    const cy = box.y + box.height * 0.32;
    await page.mouse.click(cx - 70, cy - 70);
    await page.mouse.click(cx + 70, cy - 70);
    await expect(page.getByText(/(?:[2-9]|\d{2,}) corners placed/)).toBeVisible();
    await screenshot(page, 'field-setup-draft-before-switch');

    const toggle = page.locator('.crx-map-layer-toggle');
    await toggle.getByRole('button', { name: 'Satellite' }).click();
    await page.getByRole('button', { name: 'USDA aerial' }).click();
    await expect(toggle.getByRole('button', { name: 'USDA aerial' })).toBeVisible();
    await expect(page.getByText('USDA, USGS The National Map')).toBeVisible();
    await toggle.getByRole('button', { name: 'USDA aerial' }).click();
    await page.getByRole('button', { name: 'Roads' }).click();
    await expect(toggle.getByRole('button', { name: 'Roads' })).toBeVisible();
    await expect(page.getByText('© Mapbox', { exact: false })).toBeVisible();
    await expect(page.getByText(/(?:[2-9]|\d{2,}) corners placed/)).toBeVisible();
    await screenshot(page, 'field-setup-draft-after-switch');

    const remaining = [
      { x: cx + 70, y: cy + 70 },
      { x: cx - 70, y: cy + 70 },
    ];
    for (const point of remaining) await page.mouse.click(point.x, point.y);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('button', { name: 'Add another section' })).toBeVisible();
    await drawPolygon(page, 130);
  } else {
    await expect(page.getByRole('status').filter({ hasText: 'Mapbox picture unavailable — showing USDA' })).toBeVisible();
    const toggle = page.locator('.crx-map-layer-toggle');
    await toggle.getByRole('button').click();
    await expect(toggle.getByRole('button', { name: 'Satellite', exact: true })).toBeDisabled();
    await expect(toggle.getByRole('button', { name: 'Roads', exact: true })).toBeDisabled();
    await expect(toggle.getByRole('button', { name: 'Terrain', exact: true })).toBeDisabled();
    await expect(toggle.getByRole('button', { name: 'USDA aerial', exact: true }).last()).toBeEnabled();
    await toggle.getByRole('button', { name: 'USDA aerial', exact: true }).first().click();
    expect(await page.evaluate(() => localStorage.getItem('crx.map-picture'))).toBeNull();
    await screenshot(page, 'field-setup-usda-fallback');
    await zoomToFieldScale(page, usdaTileZooms);
    await panMapAwayFromExistingFields(page);
    await drawPolygon(page, 0);
    await drawPolygon(page, 130);
  }

  await expect(page.getByText('Part 1 of 2')).toBeVisible();
  await expect(page.getByText('Part 2 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Create Field' }).click();
  await expect(page).toHaveURL(/\/fields\/[0-9a-f-]{36}$/);
  const fieldId = page.url().split('/').at(-1)!;
  await expect(page.getByRole('heading', { name: fieldName }), consoleErrors.join(' | ')).toBeVisible();
  expect(boundaryRpcResults).toHaveLength(1);
  expect(boundaryRpcResults[0].status, JSON.stringify(boundaryRpcResults[0])).toBe(200);
  await screenshot(page, 'field-setup-after-create-before-reload');
  if (!fakeToken) {
    for (let index = 0; index < 4; index += 1) {
      await page.locator('.maplibregl-ctrl-zoom-in').click();
      await page.waitForTimeout(450);
    }
    await expect.poll(() => Math.max(...usdaTileZooms, 0)).toBe(16);
    expect(usdaTileZooms.every((zoom) => zoom <= 16)).toBe(true);
    expect(usdaSuccessfulTileZooms).toContain(16);
  }
  const geometryBeforeReload = await page.evaluate(async (id) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const [fieldResult, partsResult] = await Promise.all([
      supabase.from('fields').select('measured_acres,total_acres').eq('id', id).single(),
      supabase.from('field_polygons').select('polygon_geojson').eq('field_id', id).order('sort_order'),
    ]);
    if (fieldResult.error || partsResult.error) throw new Error('Local field geometry could not be read before reload');
    return { field: fieldResult.data, parts: partsResult.data };
  }, fieldId);
  if (!fakeToken) holdUsdaTiles = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: fieldName })).toBeVisible();
  if (!fakeToken) {
    await mapCanvas(page);
    await expect.poll(() => delayedUsdaTileCount, { timeout: 8000 }).toBeGreaterThan(0);
    await expect.poll(() => pendingUsdaTiles, { timeout: 3000 }).toBeGreaterThan(0);
    await expect(page.getByText('Part 1 of 2')).toBeVisible({ timeout: 1500 });
    await expect(page.getByText('Part 2 of 2')).toBeVisible({ timeout: 1500 });
    expect(delayedUsdaTileCount).toBeGreaterThan(0);
    holdUsdaTiles = false;
    await expect.poll(() => pendingUsdaTiles, { timeout: 8000 }).toBe(0);
  }
  await expect(page.getByText('Part 1 of 2')).toBeVisible();
  await expect(page.getByText('Part 2 of 2')).toBeVisible();
  const savedGeometry = await page.evaluate(async (id) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const [fieldResult, partsResult] = await Promise.all([
      supabase.from('fields').select('measured_acres,total_acres').eq('id', id).single(),
      supabase.from('field_polygons').select('polygon_geojson').eq('field_id', id).order('sort_order'),
    ]);
    if (fieldResult.error || partsResult.error) {
      throw new Error(`Local saved field could not be reread (${fieldResult.error?.code ?? partsResult.error?.code ?? 'unknown'})`);
    }
    return { field: fieldResult.data, parts: partsResult.data };
  }, fieldId);
  expect(savedGeometry.parts).toHaveLength(2);
  expect(savedGeometry.field.measured_acres).toBe(geometryBeforeReload.field.measured_acres);
  expect(savedGeometry.field.total_acres).toBe(geometryBeforeReload.field.total_acres);
  expect(savedGeometry.parts.map((part) => part.polygon_geojson)).toEqual(
    geometryBeforeReload.parts.map((part) => part.polygon_geojson),
  );
  expect(savedGeometry.field.measured_acres).toBeGreaterThan(0.1);
  expect(savedGeometry.field.total_acres).toBeGreaterThan(0);
  await screenshot(page, 'field-setup-saved-reloaded');

  const firstPartAcresBeforeEdit = await page.getByText(/Part 1 of 2/).textContent();
  const editToggle = page.locator('.crx-map-layer-toggle');
  if (fakeToken) {
    await editToggle.getByRole('button', { name: 'Roads', exact: true }).click();
    await editToggle.getByRole('button', { name: 'Satellite', exact: true }).click();
  }
  await page.locator('.maplibregl-canvas').scrollIntoViewIfNeeded();
  const { box: editMap } = await mapCanvas(page);
  await page.mouse.click(editMap.x + editMap.width * 0.35, editMap.y + editMap.height * 0.45);
  await screenshot(page, 'field-setup-corner-edit-selected');
  const cornerStart = { x: editMap.x + editMap.width * 0.25, y: editMap.y + editMap.height * 0.31 };
  await page.mouse.move(cornerStart.x, cornerStart.y);
  await page.mouse.down();
  if (fakeToken) {
    await page.mouse.move(cornerStart.x + 3, cornerStart.y + 2, { steps: 2 });
    await editToggle.locator(':scope > button').evaluate((button) => (button as HTMLButtonElement).click());
    await expect(editToggle.getByRole('button', { name: 'USDA aerial', exact: true })).toBeVisible();
    await editToggle.getByRole('button', { name: 'USDA aerial', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  }
  await page.mouse.move(cornerStart.x + 17, cornerStart.y + 12, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('USDA, USGS The National Map');
  await screenshot(page, 'field-setup-corner-drag-usda');
  if (fakeToken) {
    const tilesBeforeRoads = mapboxTilePaths.length;
    await editToggle.getByRole('button', { name: 'USDA aerial', exact: true }).click();
    await editToggle.getByRole('button', { name: 'Roads', exact: true }).click();
    await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('© Mapbox');
    await expectMapboxPictureFrom(tilesBeforeRoads, 'streets-v12');
    await expect(page.locator('.maplibregl-ctrl-attrib .crx-mapbox-logo')).toBeVisible();
    await expect(page.locator('.maplibregl-ctrl-attrib')).not.toContainText('© Maxar');
  }
  await expect.poll(async () => page.getByText(/Part 1 of 2/).textContent(), { message: consoleErrors.join(' | ') }).not.toBe(firstPartAcresBeforeEdit);
  await screenshot(page, fakeToken ? 'field-setup-corner-edit-roads' : 'field-setup-corner-edit-usda');
  const saveCornerEditResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/rpc/set_field_boundary') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save Changes' }).click();
  expect((await saveCornerEditResponse).ok()).toBe(true);
  const tilesBeforeRememberedReload = mapboxTilePaths.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: fieldName })).toBeVisible();
  if (fakeToken) {
    // The remembered Roads choice must be what loads, never the default Satellite.
    await expectMapboxPictureFrom(tilesBeforeRememberedReload, 'streets-v12');
    expect(mapboxTilePaths.slice(tilesBeforeRememberedReload).some((path) => path.includes('/satellite-streets-v12/'))).toBe(false);
  }
  const geometryAfterCornerEdit = await page.evaluate(async (id) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const { data, error } = await supabase.from('field_polygons').select('polygon_geojson').eq('field_id', id).order('sort_order');
    if (error) throw new Error('Edited field geometry could not be reread after reload');
    return data;
  }, fieldId);
  expect(geometryAfterCornerEdit).toHaveLength(2);
  expect(geometryAfterCornerEdit.map((part) => part.polygon_geojson)).not.toEqual(
    savedGeometry.parts.map((part) => part.polygon_geojson),
  );
  await screenshot(page, 'field-setup-corner-edit-saved-reloaded');
  if (fakeToken) {
    await editToggle.getByRole('button', { name: 'Roads', exact: true }).click();
    await editToggle.getByRole('button', { name: 'Terrain', exact: true }).click();
    await expect.poll(() => mapboxTilePaths.some((path) => path.includes('/outdoors-v12/tiles/512/'))).toBe(true);
    await editToggle.getByRole('button', { name: 'Terrain', exact: true }).click();
    await editToggle.getByRole('button', { name: 'Roads', exact: true }).click();
  }

  await page.getByRole('button', { name: 'Add marker' }).click();
  await expect(page.getByRole('form', { name: 'Field marker editor' })).toBeVisible();
  await page.getByRole('form', { name: 'Field marker editor' }).getByLabel('Marker type').selectOption('field_entrance');
  await expect(page.getByText('Tap the map where the marker belongs.')).toBeVisible();
  const { box: markerMap } = await mapCanvas(page);
  await page.mouse.click(markerMap.x + markerMap.width * 0.9, markerMap.y + markerMap.height * 0.85);
  const markerWriteResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/rest/v1/field_obstacles') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save marker' }).click();
  expect((await markerWriteResponse).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add marker' })).toBeVisible();
  expect(markerWriteResults).toContain('201');
  expect(markerReadResults).toContain('200:true:1:1');
  const markerPanel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Field markers' }) });
  await expect(markerPanel.getByRole('listitem').filter({ hasText: /Entrance \d+/ })).toBeVisible();
  await screenshot(page, 'field-setup-marker');

  await page.goto('/fields');
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await mapCanvas(page);
  await zoomToFieldScale(page, usdaTileZooms);
  await expect(page.locator('.maplibregl-marker span[aria-hidden="true"]').first()).toBeVisible();
  await screenshot(page, 'fields-list-map');

  await page.goto(`/fields/${fieldId}/dashboard`);
  await mapCanvas(page);
  await expect(page.getByRole('heading', { name: fieldName })).toBeVisible();
  await screenshot(page, 'field-dashboard');

  customerMapCaptureFieldId = fieldId;
  captureCustomerMapResponse = true;
  await page.goto(`/customers/${customerId}`);
  await expect(page.getByText(customerName).first()).toBeVisible();
  const fieldsSection = page.locator('#customer-section-fields').getByRole('button', { name: 'Fields', exact: true });
  if (await fieldsSection.getAttribute('aria-expanded') !== 'true') await fieldsSection.click();
  await page.waitForTimeout(1000);
  if (await page.getByText('This page crashed', { exact: true }).count()) {
    throw new Error(`Customer map section crashed: ${consoleErrors.join(' | ') || 'no browser console details'}`);
  }
  await mapCanvas(page);
  const customerMapDiagnosis = await page.evaluate(async ({ fieldId: id, customerId: ownerId }) => {
    const { assertRpcResult, supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const result = await supabase.rpc('get_fields_with_geojson', { p_customer_id: ownerId });
    if (result.error) throw new Error(`Customer map fields could not be read (${result.error.code})`);
    const data = assertRpcResult<Array<{ id: string; centroid_geojson: string | null }>>(
      result.data,
      'get_fields_with_geojson',
    );
    const row = data.find((field) => field.id === id);
    if (!row) throw new Error('The saved test field was missing from the Customer Detail field list');
    const raw: unknown = row.centroid_geojson;
    const geometry = typeof raw === 'string' ? JSON.parse(raw) as { type?: string; coordinates?: number[] } : raw as { type?: string; coordinates?: number[] };
    const mapRect = document.querySelector('.maplibregl-map')?.getBoundingClientRect();
    const markers = [...document.querySelectorAll<HTMLElement>('.maplibregl-marker')].map((marker) => {
      const rect = marker.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        insideMap: !!mapRect && rect.right > mapRect.left && rect.left < mapRect.right
          && rect.bottom > mapRect.top && rect.top < mapRect.bottom,
        fieldPin: !!marker.querySelector('.bg-crx-green'),
      };
    });
    const allMapMarkerCount = document.querySelectorAll('.maplibregl-marker').length;
    return {
      mapCount: document.querySelectorAll('.maplibregl-map').length,
      centroidType: typeof raw,
      geometryType: geometry?.type ?? null,
      coordinates: geometry?.coordinates ?? null,
      allMapMarkerCount,
      markerCount: markers.filter((marker) => marker.fieldPin).length,
      markers,
    };
  }, { fieldId, customerId });
  captureCustomerMapResponse = false;
  await expect.poll(() => customerFieldResponseShapes.length, { timeout: 5000 }).toBeGreaterThan(0);
  await test.info().attach('customer-detail-map-diagnosis.json', {
    body: Buffer.from(JSON.stringify({
      ...customerMapDiagnosis,
      pageResponse: customerFieldResponseShapes,
      consoleErrors,
    }, null, 2)),
    contentType: 'application/json',
  });
  await screenshot(page, 'customer-detail-map');
  expect(customerMapDiagnosis.markerCount, JSON.stringify(customerMapDiagnosis)).toBe(1);

  await page.goto('/fields');
  await page.getByRole('button', { name: 'Import Fields' }).click();
  await page.locator('#field-import-input').setInputFiles({
    name: 'map-preview.geojson',
    mimeType: 'application/geo+json',
    buffer: Buffer.from(JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'Map preview polygon' },
        geometry: { type: 'Polygon', coordinates: [[[-89.42, 40.05], [-89.40, 40.05], [-89.40, 40.07], [-89.42, 40.07], [-89.42, 40.05]]] },
      }],
    })),
  });
  const parseFileButton = page.getByRole('button', { name: 'Parse Files' });
  await expect(parseFileButton).toBeEnabled();
  await parseFileButton.click();
  await expect(page.getByText('1 field boundaries found')).toBeVisible();
  await mapCanvas(page);
  await screenshot(page, 'field-import-preview');

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneTileZooms = fakeToken ? mapboxTileZooms : usdaTileZooms;
  const phoneTileStart = phoneTileZooms.length;
  await page.goto('/fields/new');
  await page.getByLabel('Field Name').fill(`Phone map proof ${suffix}`);
  await page.getByRole('combobox', { name: 'Owner (Customer)' }).fill(customerName);
  await page.getByRole('option', { name: customerName }).click();
  await mapCanvas(page);
  await page.locator('.maplibregl-canvas').scrollIntoViewIfNeeded();
  await expectPhoneMapControlsInsideMap(page);
  await expectPhoneDrawingOffsets(page, false);
  await screenshot(page, 'phone-field-setup', false);
  await expect.poll(() => Math.max(...phoneTileZooms.slice(phoneTileStart), 0), { timeout: 15000 }).toBeGreaterThan(0);
  for (let index = 0; index < 8; index += 1) {
    await page.locator('.maplibregl-ctrl-zoom-in').click();
    await page.waitForTimeout(350);
  }
  await expect.poll(() => Math.max(...phoneTileZooms.slice(phoneTileStart), 0), { timeout: 15000 }).toBeGreaterThanOrEqual(14);
  if (fakeToken) {
    await expect(page.getByText('© Mapbox', { exact: false })).toBeVisible();
  } else {
    await expect(page.getByRole('status').filter({ hasText: 'Mapbox picture unavailable — showing USDA' })).toBeVisible();
  }
  await panMapAwayFromExistingFields(page);
  await page.getByRole('button', { name: /Draw field boundary|Redraw boundary/ }).click();
  const { box: phoneMap } = await mapCanvas(page);
  const phoneCenterX = phoneMap.x + phoneMap.width / 2;
  const phoneCenterY = phoneMap.y + phoneMap.height / 2;
  for (const point of [
    { x: phoneCenterX - 45, y: phoneCenterY - 45 },
    { x: phoneCenterX + 45, y: phoneCenterY - 45 },
    { x: phoneCenterX + 45, y: phoneCenterY + 45 },
  ]) await page.mouse.click(point.x, point.y);
  await expect(page.getByText(/(?:[3-9]|\d{2,}) corners placed/)).toBeVisible();
  await page.locator('.crx-map-locate-control').scrollIntoViewIfNeeded();
  await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText(
    fakeToken ? '© Mapbox' : 'USDA, USGS The National Map',
  );
  const phoneControlOverlap = await page.evaluate(() => {
    const selectors = [
      '.maplibregl-ctrl-attrib',
      '.crx-map-locate-control',
      '.crx-map-layer-toggle',
      '.maplibregl-ctrl-top-left .maplibregl-ctrl-group',
      '.maplibregl-ctrl-top-right',
      'input[placeholder="Search address or coordinates..."]',
    ];
    const boxes = selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const rect = element.getBoundingClientRect();
      return { selector, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
    });
    const doneButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Done');
    if (doneButton) {
      const rect = doneButton.getBoundingClientRect();
      boxes.push({ selector: 'draw-done-button', x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom });
    }
    const overlaps: string[] = [];
    for (let left = 0; left < boxes.length; left += 1) {
      const a = boxes[left];
      if ('missing' in a) continue;
      for (let right = left + 1; right < boxes.length; right += 1) {
        const b = boxes[right];
        if ('missing' in b) continue;
        if (a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) {
          overlaps.push(`${a.selector} / ${b.selector}`);
        }
      }
    }
    return { boxes, overlaps };
  });
  expect(phoneControlOverlap.boxes.filter((box) => !('missing' in box))).toHaveLength(7);
  expect(phoneControlOverlap.overlaps).toEqual([]);
  await expectPhoneDrawingOffsets(page, true);
  await screenshot(page, 'phone-field-setup-drawing', false);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/jobs/new?customer_id=${customerId}`);
  await expect(page.getByRole('heading', { name: /New Job/ })).toBeVisible();
  await page.getByRole('button', { name: 'Select locations on map' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('input[placeholder="Search fields..."]').fill(fieldName);
  await expect(page.getByRole('checkbox', { name: `Select ${fieldName}` })).toBeVisible();
  await mapCanvas(page);
  await screenshot(page, 'job-field-picker-map');
  await page.getByRole('checkbox', { name: `Select ${fieldName}` }).check();
  await page.getByRole('button', { name: 'Add 1 Location' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add Chemical' }).click();
  const productPicker = page.getByPlaceholder('Select product...');
  await productPicker.fill('Test Herbicide (invented)');
  await page.getByRole('option', { name: /Test Herbicide \(invented\)/ }).click();
  await page.getByRole('checkbox', { name: /Customer supplied/ }).check();
  const saveJobButton = page.getByRole('button', { name: /Save Job/ });
  await expect(saveJobButton).toBeEnabled();
  const saveJobResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/rpc/save_job') && response.request().method() === 'POST',
  );
  await saveJobButton.click();
  expect((await saveJobResponse).ok()).toBe(true);
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobId = page.url().split('/').at(-1)!;

  if (fakeToken) {
    await expect(page.getByRole('button', { name: 'Field Sheet' })).toBeVisible();
    await page.getByRole('button', { name: 'Field Sheet' }).click();
    const printDialog = page.getByRole('dialog');
    await expect(printDialog).toBeVisible();
    await printDialog.getByLabel('Map pages').selectOption('both');
    const fieldSheetDownload = page.waitForEvent('download');
    await printDialog.getByRole('button', { name: 'Print', exact: true }).click();
    await (await fieldSheetDownload).saveAs(resolve(proofDir, `${proofName}-job-sheet.pdf`));
    await expect(printDialog).toHaveCount(0);
    await expect.poll(() => mapboxStaticPaths.length).toBeGreaterThan(0);

    const staticPathCountBeforeMapsOnly = mapboxStaticPaths.length;
    const mapPagesButton = page.getByRole('button', { name: 'Maps Only' });
    await expect(mapPagesButton).toBeEnabled();
    const mapPagesDownload = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await mapPagesButton.click();
    const mapPagesFile = await mapPagesDownload;
    if (!mapPagesFile) {
      const visibleText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 1200);
      const messages = await page.locator('[role="alert"], [role="status"]').allInnerTexts();
      throw new Error(`Map-pages-only print produced no download. URL: ${page.url()}; button disabled: ${await mapPagesButton.isDisabled()}; messages: ${messages.join(' | ')}; static requests: ${mapboxStaticPaths.length - staticPathCountBeforeMapsOnly}; console errors: ${consoleErrors.join(' | ')}; visible page text: ${visibleText}`);
    }
    await mapPagesFile.saveAs(resolve(proofDir, `${proofName}-map-pages-only.pdf`));
    await expect.poll(() => mapboxStaticPaths.length).toBeGreaterThan(staticPathCountBeforeMapsOnly);
  }

  await page.goto('/dispatch');
  await page.getByRole('button', { name: 'View Map' }).click();
  await mapCanvas(page);
  await screenshot(page, 'dispatch-board-map');

  await page.goto(`/jobs/${jobId}?tab=map_logs`);
  await expect(page.getByRole('heading', { name: 'Field Map' })).toBeVisible();
  await page.locator('.maplibregl-canvas').scrollIntoViewIfNeeded();
  await mapCanvas(page);
  await screenshot(page, 'job-field-map');

  const actorId = localSql(`SELECT id FROM public.profiles WHERE email = '${(process.env.LOCAL_TEST_EMAIL ?? '').replaceAll("'", "''")}' AND role = 'admin';`);
  expect(actorId).toMatch(/^[0-9a-f-]{36}$/i);
  try {
    localSql(`BEGIN;
      SET LOCAL session_replication_role = replica;
      UPDATE public.profiles SET role = 'applicator' WHERE id = '${actorId}';
      UPDATE public.jobs SET applicator_id = '${actorId}' WHERE id = '${jobId}';
      COMMIT;`);
    await page.evaluate(async () => {
      const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
      await supabase.auth.signOut();
    });
    await signIn(page);
    await page.setViewportSize(phoneViewport);
    expect(page.viewportSize()).toEqual(phoneViewport);
    await page.goto('/field');
    const mapToggle = page.getByRole('button', { name: 'Map', exact: true });
    await mapToggle.click();
    await expect(mapToggle).toHaveAttribute('aria-pressed', 'true');
    await mapCanvas(page);
    await scrollPhoneMapIntoView(page);
    await expectPhoneMapControlsInsideMap(page);
    await expectPhoneDrawingOffsets(page, false);
    await screenshot(page, 'phone-field-view-map', false);

    const checkingMarkerStatuses = page.getByText('Checking field markers…', { exact: true });
    const initialCheckingCount = await checkingMarkerStatuses.count();
    let remainingCheckingCount = initialCheckingCount;
    if (initialCheckingCount > 0) {
      try {
        await expect.poll(() => checkingMarkerStatuses.count(), { timeout: 15000 }).toBe(0);
        remainingCheckingCount = 0;
      } catch {
        remainingCheckingCount = await checkingMarkerStatuses.count();
      }
    }
    console.warn(`My Day field marker status: checking at first observation=${initialCheckingCount}, still checking after wait=${remainingCheckingCount}`);

    const crewFieldPanel = page.getByRole('heading', { name: fieldName }).locator('xpath=ancestor::section[1]');
    const addCrewMarker = crewFieldPanel.getByRole('button', { name: 'Add marker' });
    await expect(addCrewMarker).toBeVisible();
    const entranceMarkers = page.locator('.maplibregl-marker button[aria-label^="Entrance "]');
    const entranceMarkerCountBeforeSave = await entranceMarkers.count();
    await addCrewMarker.click();
    const markerForm = page.getByRole('form', { name: 'Field marker editor' });
    await expect(markerForm).toBeVisible();
    await markerForm.getByLabel('Marker type').selectOption('field_entrance');
    await page.locator('.maplibregl-canvas').scrollIntoViewIfNeeded();
    const { box: crewMap } = await mapCanvas(page);
    await page.mouse.click(crewMap.x + crewMap.width * 0.85, crewMap.y + crewMap.height * 0.8);
    const crewMarkerResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/rest/v1/field_obstacles') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save marker' }).click();
    expect((await crewMarkerResponse).ok()).toBe(true);
    await expect(crewFieldPanel.getByText(/Entrance \d+/)).toBeVisible();
    if (await mapToggle.getAttribute('aria-pressed') !== 'true') await mapToggle.click();
    await expect(mapToggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => entranceMarkers.count(), { timeout: 15000 }).toBeGreaterThan(entranceMarkerCountBeforeSave);
    await scrollPhoneMapIntoView(page);
    await expectPhoneMapControlsInsideMap(page);
    const savedMarkerButtons = await entranceMarkers.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom };
    }));
    const mapBox = await page.locator('.maplibregl-map').boundingBox();
    expect(mapBox).not.toBeNull();
    expect(savedMarkerButtons.some((marker) => {
      const centerX = (marker.x + marker.right) / 2;
      const centerY = (marker.y + marker.bottom) / 2;
      const savedPointX = mapBox!.x + mapBox!.width * 0.85;
      const savedPointY = mapBox!.y + mapBox!.height * 0.8;
      return Math.abs(centerX - savedPointX) < 15 && Math.abs(centerY - savedPointY) < 15
        && marker.x >= mapBox!.x && marker.y >= mapBox!.y
        && marker.right <= mapBox!.x + mapBox!.width && marker.bottom <= mapBox!.y + mapBox!.height
        && marker.x >= 0 && marker.y >= 0 && marker.right <= phoneViewport.width && marker.bottom <= phoneViewport.height;
    }),
    JSON.stringify({ mapBox, savedMarkerButtons })).toBe(true);
    await screenshot(page, 'phone-crew-map-marker', false);
  } finally {
    localSql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.profiles SET role = 'admin' WHERE id = '${actorId}'; COMMIT;`);
  }

  expect([...requestedHosts].every((host) => [
    '127.0.0.1', 'localhost', 'basemap.nationalmap.gov', ...(fakeToken ? ['api.mapbox.com'] : []),
  ].includes(host))).toBe(true);
  if (fakeToken) {
    expect(mapboxTilePaths.some((path) => path.includes('/satellite-streets-v12/tiles/512/'))).toBe(true);
    expect(mapboxTilePaths.some((path) => path.includes('/streets-v12/tiles/512/'))).toBe(true);
    expect(mapboxTilePaths.every((path) => /\/tiles\/512\/\d+\/\d+\/\d+@2x$/.test(path))).toBe(true);
    expect(Math.max(...mapboxTileZooms, 0)).toBeGreaterThanOrEqual(14);
    expect(mapboxStaticPaths.some((path) => path.includes('/styles/v1/mapbox/satellite-streets-v12/static/'))).toBe(true);
    expect(workerUrls.some((workerUrl) => ['127.0.0.1', 'localhost'].includes(new URL(workerUrl).hostname))).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('crx.map-picture'))).toBe('roads');
  } else {
    expect(await page.evaluate(() => localStorage.getItem('crx.map-picture'))).toBeNull();
    expect(Math.max(...usdaTileZooms, 0)).toBe(16);
    expect(usdaTileZooms.every((zoom) => zoom <= 16)).toBe(true);
    expect(usdaSuccessfulTileZooms).toContain(16);
  }
  expect(consoleErrors, failedResponseHosts.join('; ')).toEqual([]);
});
