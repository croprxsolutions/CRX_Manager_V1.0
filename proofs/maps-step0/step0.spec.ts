import { expect, test, type Page } from '@playwright/test';

type ProofApi = {
  ready: boolean;
  startPolygon: () => void;
  startDirectSelect: () => void;
  switchPicture: (picture: 'A' | 'B') => void;
  getDraft: () => {
    features: Array<{
      geometry: { type: string; coordinates: unknown };
      id?: string | number;
    }>;
  };
  getMode: () => string;
  getLayerOrder: () => string[];
  getPictureTiles: () => string[];
  project: (coordinate: [number, number]) => { x: number; y: number };
  trash: () => void;
  mapInstanceId: string;
};

type ProofAction =
  | 'startPolygon'
  | 'startDirectSelect'
  | 'switchA'
  | 'switchB'
  | 'getDraft'
  | 'getMode'
  | 'getLayerOrder'
  | 'getPictureTiles'
  | 'projectSecondVertex'
  | 'trash'
  | 'mapInstanceId';

async function callProof<T = void>(page: Page, action: ProofAction): Promise<T> {
  const result = await page.evaluate((requestedAction) => {
    const proof = (window as Window & { __proof?: ProofApi }).__proof;
    if (!proof) throw new Error('Proof API was not initialized');

    switch (requestedAction) {
      case 'startPolygon': return proof.startPolygon();
      case 'startDirectSelect': return proof.startDirectSelect();
      case 'switchA': return proof.switchPicture('A');
      case 'switchB': return proof.switchPicture('B');
      case 'getDraft': return proof.getDraft();
      case 'getMode': return proof.getMode();
      case 'getLayerOrder': return proof.getLayerOrder();
      case 'getPictureTiles': return proof.getPictureTiles();
      case 'projectSecondVertex': {
        const geometry = proof.getDraft().features[0].geometry as unknown as { coordinates: number[][][] };
        const coordinates = geometry.coordinates;
        return proof.project([coordinates[0][1][0], coordinates[0][1][1]]);
      }
      case 'trash': return proof.trash();
      case 'mapInstanceId': return proof.mapInstanceId;
    }
  }, action);
  return result as T;
}

async function openProof(page: Page): Promise<{
  tileRequests: string[];
  externalRequests: string[];
  consoleErrors: string[];
}> {
  const tileRequests: string[] = [];
  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/tiles/')) tileRequests.push(url.pathname);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1') {
      externalRequests.push(request.url());
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error(`Proof test base URL was not configured: ${JSON.stringify(baseURL)}`);
  await page.goto(new URL('/', baseURL).toString());
  await page.waitForFunction(
    () => {
      const proof = (window as Window & { __proof?: ProofApi }).__proof;
      return Boolean(proof?.ready && proof.getLayerOrder().some((id) => id.startsWith('gl-draw-')));
    },
  );
  await expect(page.locator('#proof-draw-control')).toBeVisible();
  await expect(page.locator('#proof-draw-control.maplibregl-ctrl-group.maplibregl-ctrl')).toBeVisible();
  await expect(page.locator('#proof-draw-control .mapbox-gl-draw_ctrl-draw-btn')).toHaveCount(2);
  const polygonButton = page.locator('#proof-draw-control .mapbox-gl-draw_polygon');
  await expect(polygonButton).toBeVisible();
  expect(await polygonButton.evaluate((button) => getComputedStyle(button).backgroundImage)).toContain('data:image/svg+xml');
  await expect(page.locator('#proof-map.maplibregl-map canvas.maplibregl-canvas')).toHaveCount(1);
  await expect.poll(() => tileRequests.some((path) => path.startsWith('/tiles/A/'))).toBe(true);
  return { tileRequests, externalRequests, consoleErrors };
}

async function getCanvasBox(page: Page) {
  const box = await page.locator('#proof-map canvas.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('MapLibre canvas is not visible');
  return box;
}

function polygonClicks(box: { x: number; y: number; width: number; height: number }) {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return [
    { x: centerX - 120, y: centerY - 80 },
    { x: centerX + 120, y: centerY - 80 },
    { x: centerX + 120, y: centerY + 80 },
    { x: centerX - 120, y: centerY + 80 },
  ];
}

async function clickPolygon(page: Page, points: Array<{ x: number; y: number }>): Promise<void> {
  for (const point of points) await page.mouse.click(point.x, point.y);
  await page.mouse.click(points[0].x, points[0].y);
}

async function expectOneFourCornerPolygon(page: Page): Promise<void> {
  await expect
    .poll(async () => (await callProof<ReturnType<ProofApi['getDraft']>>(page, 'getDraft')).features.length)
    .toBe(1);
  const draft = await callProof<ReturnType<ProofApi['getDraft']>>(page, 'getDraft');
  const geometry = draft.features[0].geometry;
  expect(geometry.type).toBe('Polygon');
  const ring = (geometry.coordinates as number[][][])[0];
  const distinctCorners = new Set(ring.slice(0, -1).map(([longitude, latitude]) => `${longitude},${latitude}`));
  expect(distinctCorners.size).toBeGreaterThanOrEqual(3);
  expect(distinctCorners.size).toBe(4);
}

async function expectRasterBelowDraw(page: Page): Promise<void> {
  const layerOrder = await callProof<string[]>(page, 'getLayerOrder');
  const rasterIndex = layerOrder.indexOf('proof-picture-layer');
  const drawIndexes = layerOrder
    .map((id, index) => (id.startsWith('gl-draw-') ? index : -1))
    .filter((index) => index >= 0);
  expect(rasterIndex).toBeGreaterThanOrEqual(0);
  expect(drawIndexes.length).toBeGreaterThan(0);
  expect(Math.min(...drawIndexes)).toBeGreaterThan(rasterIndex);
}

async function expectNoExternalRequestsOrErrors(
  page: Page,
  externalRequests: string[],
  consoleErrors: string[],
): Promise<void> {
  expect(externalRequests).toEqual([]);
  expect(consoleErrors, `Browser errors: ${consoleErrors.join(' | ')}`).toEqual([]);
}

test('draws a polygon using Mapbox Draw on one MapLibre map', async ({ page }) => {
  const { externalRequests, consoleErrors } = await openProof(page);
  const mapInstanceId = await callProof<string>(page, 'mapInstanceId');
  await callProof(page, 'startPolygon');
  await clickPolygon(page, polygonClicks(await getCanvasBox(page)));

  await expectOneFourCornerPolygon(page);
  await expectRasterBelowDraw(page);
  expect(await callProof<string>(page, 'mapInstanceId')).toBe(mapInstanceId);
  await expectNoExternalRequestsOrErrors(page, externalRequests, consoleErrors);
});

test('switching picture mid-draw preserves all corners and draw mode', async ({ page }) => {
  const { tileRequests, externalRequests, consoleErrors } = await openProof(page);
  const mapInstanceId = await callProof<string>(page, 'mapInstanceId');
  const points = polygonClicks(await getCanvasBox(page));
  await callProof(page, 'startPolygon');
  await page.mouse.click(points[0].x, points[0].y);
  await page.mouse.click(points[1].x, points[1].y);
  expect(await callProof<string>(page, 'getMode')).toBe('draw_polygon');

  await callProof(page, 'switchB');
  expect(await callProof<string>(page, 'getMode')).toBe('draw_polygon');
  expect(await callProof<string[]>(page, 'getPictureTiles')).toEqual(
    expect.arrayContaining([expect.stringContaining('/tiles/B/')]),
  );
  await expect.poll(() => tileRequests.some((path) => path.startsWith('/tiles/B/'))).toBe(true);
  await expectRasterBelowDraw(page);

  await page.mouse.click(points[2].x, points[2].y);
  await page.mouse.click(points[3].x, points[3].y);
  expect(await callProof<string>(page, 'getMode')).toBe('draw_polygon');
  await page.mouse.click(points[0].x, points[0].y);

  await expectOneFourCornerPolygon(page);
  expect(await callProof<string>(page, 'getMode')).toBe('simple_select');
  expect(await callProof<string>(page, 'mapInstanceId')).toBe(mapInstanceId);
  await expectRasterBelowDraw(page);
  await expectNoExternalRequestsOrErrors(page, externalRequests, consoleErrors);
});

test('switching picture during a vertex drag keeps the edit in the same map', async ({ page }) => {
  const { tileRequests, externalRequests, consoleErrors } = await openProof(page);
  const mapInstanceId = await callProof<string>(page, 'mapInstanceId');
  const bRequestCountBeforeSwitch = tileRequests.filter((path) => path.startsWith('/tiles/B/')).length;
  await callProof(page, 'switchB');
  await expect
    .poll(() => tileRequests.filter((path) => path.startsWith('/tiles/B/')).length)
    .toBeGreaterThan(bRequestCountBeforeSwitch);
  expect(await callProof<string[]>(page, 'getPictureTiles')).toEqual(
    expect.arrayContaining([expect.stringContaining('/tiles/B/')]),
  );
  await expectRasterBelowDraw(page);
  const points = polygonClicks(await getCanvasBox(page));
  await callProof(page, 'startPolygon');
  await clickPolygon(page, points);
  await expectOneFourCornerPolygon(page);

  const secondVertex = await callProof<{ x: number; y: number }>(page, 'projectSecondVertex');
  await callProof(page, 'startDirectSelect');
  expect(await callProof<string>(page, 'getMode')).toBe('direct_select');

  const releasePoint = { x: secondVertex.x + 55, y: secondVertex.y + 32 };
  await page.mouse.move(secondVertex.x, secondVertex.y);
  await page.mouse.down();
  await page.mouse.move(secondVertex.x + 20, secondVertex.y + 12, { steps: 3 });
  const aToARequestCount = tileRequests.filter((path) => path.startsWith('/tiles/A/')).length;
  await callProof(page, 'switchA');
  await expect
    .poll(() => tileRequests.filter((path) => path.startsWith('/tiles/A/')).length)
    .toBeGreaterThan(aToARequestCount);
  expect(await callProof<string[]>(page, 'getPictureTiles')).toEqual(
    expect.arrayContaining([expect.stringContaining('/tiles/A/')]),
  );
  await expectRasterBelowDraw(page);
  await page.mouse.move(releasePoint.x, releasePoint.y, { steps: 5 });
  await page.mouse.up();

  const movedVertex = await callProof<{ x: number; y: number }>(page, 'projectSecondVertex');
  expect(Math.hypot(movedVertex.x - releasePoint.x, movedVertex.y - releasePoint.y)).toBeLessThan(12);
  await expectOneFourCornerPolygon(page);
  expect(await callProof<string>(page, 'getMode')).toBe('direct_select');
  expect(await callProof<string>(page, 'mapInstanceId')).toBe(mapInstanceId);
  await expectNoExternalRequestsOrErrors(page, externalRequests, consoleErrors);
});

test('trashing a three-corner draft matches the app restart expectation', async ({ page }) => {
  const { externalRequests, consoleErrors } = await openProof(page);
  await callProof(page, 'startPolygon');
  const points = polygonClicks(await getCanvasBox(page));
  for (const point of points.slice(0, 3)) await page.mouse.click(point.x, point.y);
  expect(await callProof<string>(page, 'getMode')).toBe('draw_polygon');

  await callProof(page, 'trash');
  expect((await callProof<ReturnType<ProofApi['getDraft']>>(page, 'getDraft')).features.length).toBe(0);
  expect(await callProof<string>(page, 'getMode')).toBe('simple_select');
  await callProof(page, 'startPolygon');
  expect(await callProof<string>(page, 'getMode')).toBe('draw_polygon');
  await expectNoExternalRequestsOrErrors(page, externalRequests, consoleErrors);
});
