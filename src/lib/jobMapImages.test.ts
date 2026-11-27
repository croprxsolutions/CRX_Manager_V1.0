import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockFrom, mockIn, mockObstacleIn, mockEq, mockReadSignal } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockIn: vi.fn(),
  mockObstacleIn: vi.fn(),
  mockEq: vi.fn(),
  mockReadSignal: vi.fn(),
}));

function abortable<T>(request: T) {
  return Object.assign(request as T & object, {
    abortSignal(signal: AbortSignal) {
      mockReadSignal(signal);
      return request;
    },
  });
}

vi.mock('./db', () => ({
  supabase: { rpc: (...args: unknown[]) => abortable(mockRpc(...args)), from: mockFrom },
  assertRpcResult: <T,>(data: unknown): T => data as T,
}));

import { fetchJobFieldLocations, fetchJobMapImages, sprayNumbersByFieldId } from './jobMapImages';

const squareBoundary = JSON.stringify({
  type: 'Polygon',
  coordinates: [[[-89.1, 39.1], [-89.0, 39.1], [-89.0, 39.2], [-89.1, 39.2], [-89.1, 39.1]]],
});

function makeRow(boundary = squareBoundary, centroid: [number, number] = [-89.05, 39.15]) {
  return {
    id: 'field-1',
    customer_id: 'customer-1',
    field_name: 'North 40',
    total_acres: 40,
    measured_acres: 41.25,
    override_acres: null,
    centroid_geojson: JSON.stringify({ type: 'Point', coordinates: centroid }),
    boundary_geojson: boundary,
    sort_order: 0,
  };
}

function setupRpc(boundary = squareBoundary, centroid?: [number, number], acresToTreat: number | null = 10): void {
  mockRpc.mockResolvedValue({ data: [makeRow(boundary, centroid)], error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'job_fields') {
      return { select: vi.fn().mockReturnValue({ eq: (...args: unknown[]) => abortable(mockEq(...args)) }) };
    }
    if (table === 'field_obstacles') {
      return { select: vi.fn().mockReturnValue({ in: (...args: unknown[]) => abortable(mockObstacleIn(...args)) }) };
    }
    return { select: vi.fn().mockReturnValue({ in: (...args: unknown[]) => abortable(mockIn(...args)) }) };
  });
  mockEq.mockResolvedValue({ data: [{ field_id: 'field-1', acres_to_treat: acresToTreat }], error: null });
  mockObstacleIn.mockResolvedValue({ data: [], error: null });
  mockIn.mockResolvedValue({ data: [{ id: 'customer-1', farm_name: 'Smith Farm' }], error: null });
}

describe('fetchJobMapImages', () => {
  const originalToken = import.meta.env.VITE_MAPBOX_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    import.meta.env.VITE_MAPBOX_TOKEN = 'test-mapbox-token';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('Image', class {
      src = '';
      async decode() { return undefined; }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    import.meta.env.VITE_MAPBOX_TOKEN = originalToken;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a satellite-streets URL with yellow GeoJSON boundaries and converts its PNG response to a data URL', async () => {
    setupRpc();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchJobMapImages('job-1', { perField: false });

    expect(mockRpc).toHaveBeenCalledWith('get_job_fields_with_geojson', { p_job_id: 'job-1' });
    expect(mockEq).toHaveBeenCalledWith('job_id', 'job-1');
    expect(result?.overview).toBe('data:image/png;base64,cG5n');
    expect(result?.perField).toEqual([]);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('/mapbox/satellite-streets-v12/static/geojson(');
    expect(url).toMatch(/\/auto\/\d+x\d+\?access_token=test-mapbox-token&padding=40/);
    const encodedOverlay = url.match(/geojson\((.+)\)\/auto/);
    expect(encodedOverlay).not.toBeNull();
    const overlay = JSON.parse(decodeURIComponent(encodedOverlay?.[1] ?? '')) as {
      features: Array<{ properties: Record<string, string | number> }>;
    };
    expect(overlay.features[0].properties).toMatchObject({
      stroke: '#FFD700',
      'stroke-width': 3,
      fill: '#FFD700',
      'fill-opacity': 0.15,
    });
  });

  it('uses the job field acres for each printed field map', async () => {
    setupRpc();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    }));

    const result = await fetchJobMapImages('job-1', { overview: false });

    expect(result?.perField).toHaveLength(1);
    expect(result?.perField[0].acres).toBe(10);
  });

  it('adds small red obstacle points to a per-field close-up overlay', async () => {
    setupRpc();
    mockObstacleIn.mockResolvedValue({
      data: [{
        id: 'obstacle-1',
        field_id: 'field-1',
        kind: 'oil_well',
        label: 'West well',
        point_geojson: { type: 'Point', coordinates: [-89.04, 39.16] },
        created_by: 'user-1',
        created_at: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-11T12:00:00Z',
      }],
      error: null,
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchJobMapImages('job-1', { overview: false });

    expect(mockObstacleIn).toHaveBeenCalledWith('field_id', ['field-1']);
    const url = String(mockFetch.mock.calls[0][0]);
    const encodedOverlay = url.match(/geojson\((.+)\)\/auto/);
    const overlay = JSON.parse(decodeURIComponent(encodedOverlay?.[1] ?? '')) as {
      features: Array<{ geometry: { type: string }; properties: Record<string, string> }>;
    };
    const marker = overlay.features.find((feature) => feature.geometry.type === 'Point');
    expect(marker?.properties).toEqual({
      'marker-color': '#dc2626',
      'marker-size': 'small',
    });
  });

  it('keeps an obstacle and the field fill even if private text would exceed the URL limit', async () => {
    setupRpc();
    mockObstacleIn.mockResolvedValue({
      data: [{
        id: 'obstacle-1',
        field_id: 'field-1',
        kind: 'other',
        label: 'x'.repeat(8_000),
        point_geojson: { type: 'Point', coordinates: [-89.04, 39.16] },
        created_by: 'user-1',
        created_at: '2026-07-11T12:00:00Z',
        updated_at: '2026-07-11T12:00:00Z',
      }],
      error: null,
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchJobMapImages('job-1', { overview: false });

    const url = String(mockFetch.mock.calls[0][0]);
    const encodedOverlay = url.match(/geojson\((.+)\)\/auto/);
    const overlay = JSON.parse(decodeURIComponent(encodedOverlay?.[1] ?? '')) as {
      features: Array<{ geometry: { type: string }; properties: Record<string, string | number> }>;
    };
    expect(overlay.features.some((feature) => feature.geometry.type === 'Point')).toBe(true);
    expect(JSON.stringify(overlay)).not.toContain('x'.repeat(100));
    expect(overlay.features[0].properties).toMatchObject({
      fill: '#FFD700',
      'fill-opacity': 0.15,
    });
  });

  it('still builds map images when the obstacle fetch fails', async () => {
    setupRpc();
    mockObstacleIn.mockResolvedValue({ data: null, error: new Error('obstacles unavailable') });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    }));

    const result = await fetchJobMapImages('job-1', { overview: false });

    expect(result?.perField).toHaveLength(1);
  });

  it.each([['north', 0.25], ['center', 0.5], ['south', 0.75]])('places a %s acreage label correctly on a wide overview', async (_side, fractionFromTop) => {
    const minLatitude = 39;
    const maxLatitude = 39.1;
    const mercatorY = (latitude: number) => {
      const radians = latitude * Math.PI / 180;
      return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
    };
    const latitudeForMercatorY = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
    const northY = mercatorY(maxLatitude);
    const southY = mercatorY(minLatitude);
    const centroid: [number, number] = [
      -89.85,
      latitudeForMercatorY(northY + (southY - northY) * fractionFromTop),
    ];
    const nonSquareBoundary = JSON.stringify({
      type: 'Polygon',
      coordinates: [[[-90, minLatitude], [-89.7, minLatitude], [-89.7, maxLatitude], [-90, maxLatitude], [-90, minLatitude]]],
    });
    setupRpc(nonSquareBoundary, centroid);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const context = {
      drawImage: vi.fn(),
      measureText: vi.fn(() => ({ width: 48 })),
      fillRect: vi.fn(),
      fillText: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,bGFiZWxlZA==');
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));

    const result = await fetchJobMapImages('job-1', { perField: false });

    expect(result?.overview).toBe('data:image/png;base64,bGFiZWxlZA==');
    const url = String(mockFetch.mock.calls[0][0]);
    const size = url.match(/\/auto\/(\d+)x(\d+)\?/);
    expect(size).not.toBeNull();
    const width = Number(size?.[1]);
    const height = Number(size?.[2]);
    expect(width / height).toBeGreaterThan(2);
    const [text, x, y] = context.fillText.mock.calls[0] as [string, number, number];
    expect(text).toBe('1 · 10 ac');
    expect(Math.abs(x - width / 2)).toBeLessThanOrEqual(1);
    const padding = new URL(url).searchParams.get('padding');
    expect(padding).not.toBeNull();
    const inset = Number(padding);
    const expectedY = inset + (height - 2 * inset) * fractionFromTop;
    expect(Math.abs(y - expectedY)).toBeLessThanOrEqual(1);
  });

  it('omits acreage when the job-field acreage query fails', async () => {
    setupRpc();
    mockEq.mockResolvedValue({ data: null, error: new Error('job_fields unavailable') });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    }));

    const result = await fetchJobMapImages('job-1', { overview: false });

    expect(result?.perField[0].acres).toBeNull();
  });

  it('ends the whole map preparation when the obstacle lookup misses the cutoff', async () => {
    vi.useFakeTimers();
    setupRpc();
    mockObstacleIn.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ data: [], error: null }), 30_000);
    }));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const result = fetchJobMapImages('job-1');
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toBeNull();
    expect(mockReadSignal).toHaveBeenCalledTimes(4);
    const [jobSignal] = mockReadSignal.mock.calls[0] as [AbortSignal];
    expect(jobSignal.aborted).toBe(true);
    for (const [signal] of mockReadSignal.mock.calls) expect(signal).toBe(jobSignal);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a warning on an otherwise successful response', 'image/png', 'png', true],
    ['a success response carrying an HTML error page', 'text/html', '<p>synthetic provider error</p>', false],
    ['an empty image response', 'image/png', '', false],
    ['a missing content type', '', 'png', false],
  ])('declines %s before passing it to the PDF', async (_description, type, body, warning) => {
    setupRpc();
    const headers = new Headers();
    if (warning) headers.set('X-Staticmap-API-Warning', 'synthetic warning details');
    const blob = vi.fn(async () => new Blob([body], { type }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, headers, blob }));

    await expect(fetchJobMapImages('job-1', { perField: false })).resolves.toBeNull();
    if (warning) expect(blob).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(warning
      ? 'Mapbox overview print image returned a provider warning.'
      : 'Mapbox overview print image returned an unusable image type.');
  });

  it('does not return a picture when the browser rejects image decoding', async () => {
    setupRpc();
    vi.stubGlobal('Image', class {
      src = '';
      async decode() { throw new Error('Synthetic invalid image data'); }
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['invalid'], { type: 'image/png' }),
    }));
    await expect(fetchJobMapImages('job-1', { perField: false })).resolves.toBeNull();
  });

  it('cuts off a twelve-field job before all its stalled images are requested', async () => {
    vi.useFakeTimers();
    setupRpc();
    mockRpc.mockResolvedValue({ data: Array.from({ length: 12 }, (_, sortOrder) => ({
      ...makeRow(),
      id: `field-${sortOrder}`,
      sort_order: sortOrder,
      boundary_geojson: sortOrder === 11 ? null : squareBoundary,
    })), error: null });
    const aborted = vi.fn();
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        aborted();
        reject(new DOMException('Map image request aborted', 'AbortError'));
      }, { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);

    const result = fetchJobMapImages('job-1');
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(aborted).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps a completed overview and reaches the next field when image conversion stalls', async () => {
    vi.useFakeTimers();
    setupRpc();
    mockRpc.mockResolvedValue({ data: [makeRow(), { ...makeRow(), id: 'field-2', sort_order: 1 }], error: null });
    const encoded = 'data:image/png;base64,cG5n';
    let readCount = 0;
    vi.stubGlobal('FileReader', class {
      onloadend: (() => void) | null = null;
      result = encoded;
      readAsDataURL() {
        readCount += 1;
        setTimeout(() => this.onloadend?.(), readCount === 2 ? 30_000 : 1);
      }
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    }));

    const result = fetchJobMapImages('job-1');
    await vi.advanceTimersByTimeAsync(10_005);
    const snapshot = await result;
    expect(snapshot?.overview).toBe(encoded);
    expect(snapshot?.perField.map((image) => image.fieldId)).toEqual(['field-2']);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(snapshot?.perField.map((image) => image.fieldId)).toEqual(['field-2']);
  });

  it('returns null when a hanging Mapbox request reaches the ten-second timeout', async () => {
    vi.useFakeTimers();
    setupRpc();
    let notifyFetchStarted: () => void = () => undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const mockFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      notifyFetchStarted();
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    vi.stubGlobal('fetch', mockFetch);

    const result = fetchJobMapImages('job-1', { perField: false });
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalledWith('Mapbox overview print image timed out.');
  });

  it('keeps the original geometry when its URL already fits within the Mapbox limit', async () => {
    const originalCoordinates = [
      [-89.1, 39.1],
      [-89.075, 39.1],
      [-89.0, 39.1],
      [-89.0, 39.2],
      [-89.1, 39.2],
      [-89.1, 39.1],
    ];
    setupRpc(JSON.stringify({ type: 'Polygon', coordinates: [originalCoordinates] }));
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchJobMapImages('job-1', { perField: false });

    const url = String(mockFetch.mock.calls[0][0]);
    const encodedOverlay = url.match(/geojson\((.+)\)\/auto/);
    const overlay = JSON.parse(decodeURIComponent(encodedOverlay?.[1] ?? '')) as {
      features: Array<{ geometry: { coordinates: number[][][] } }>;
    };
    expect(overlay.features[0].geometry.coordinates[0]).toEqual(originalCoordinates);
  });

  it('does not call Supabase or Mapbox when no token is configured', async () => {
    import.meta.env.VITE_MAPBOX_TOKEN = '';
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(fetchJobMapImages('job-1')).resolves.toBeNull();

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('guards Mapbox against an un-simplifiable oversized polygon instead of requesting an overlong URL', async () => {
    const vertices = Array.from({ length: 1_500 }, (_, index) => [
      -89 + (index % 2 === 0 ? 0 : 0.02),
      39 + index * 0.00001,
    ]);
    vertices.push(vertices[0]);
    setupRpc(JSON.stringify({ type: 'Polygon', coordinates: [vertices] }));
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchJobMapImages('job-1', { perField: false });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('sprayNumbersByFieldId', () => {
  it('numbers fields 1, 2, 3 by sort_order and restarts for each job printed together', () => {
    const jobA = sprayNumbersByFieldId([
      { id: 'a-west', sort_order: 7 },
      { id: 'a-east', sort_order: 2 },
      { id: 'a-north', sort_order: 5 },
    ]);
    const jobB = sprayNumbersByFieldId([{ id: 'b-only', sort_order: 9 }, { id: 'b-unset', sort_order: null }]);
    expect([...jobA.entries()]).toEqual([['a-east', 1], ['a-north', 2], ['a-west', 3]]);
    // An unset order counts as 0, as on the sheet, so it is Stop 1 here too (Codex P2).
    expect([...jobB.entries()]).toEqual([['b-unset', 1], ['b-only', 2]]);
  });

  it('keeps the database order for tied sort_order values', () => {
    expect([...sprayNumbersByFieldId([{ id: 'x', sort_order: 0 }, { id: 'y', sort_order: 0 }]).entries()])
      .toEqual([['x', 1], ['y', 2]]);
  });
});

describe('fetchJobFieldLocations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns each mapped field pin and skips a field without one', async () => {
    mockRpc.mockResolvedValue({ data: [makeRow(), { ...makeRow(), id: 'field-2', centroid_geojson: null }], error: null });
    const locations = await fetchJobFieldLocations('job-1');
    expect([...locations.entries()]).toEqual([['field-1', { lat: 39.15, lng: -89.05 }]]);
  });

  it('returns no pins when the read is refused', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'denied' } });
    expect((await fetchJobFieldLocations('job-1')).size).toBe(0);
  });

  it('gives up on directions at the map cutoff so the sheet can still print', async () => {
    vi.useFakeTimers();
    try {
      mockRpc.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ data: [makeRow()], error: null }), 30_000);
      }));
      const locations = fetchJobFieldLocations('job-1');
      await vi.advanceTimersByTimeAsync(25_000);
      const result = await locations;
      expect(result.size).toBe(0);
      const [signal] = mockReadSignal.mock.calls[0] as [AbortSignal];
      expect(signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(result.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
