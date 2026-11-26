import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import DrawControl from './DrawControl';

const {
  mockChangeMode,
  mockDrawConstructor,
  mockMap,
  mockMode,
  mockDrawInstance,
  mockControlState,
} = vi.hoisted(() => {
  const mockMode = { value: 'simple_select' };
  const mockChangeMode = vi.fn();
  const mockDrawInstance = {
    add: vi.fn(),
    changeMode: mockChangeMode,
    deleteAll: vi.fn(),
    getAll: vi.fn((): { features: Feature[] } => ({ features: [] })),
    getMode: vi.fn(() => mockMode.value),
    trash: vi.fn(),
  };
  const mockDrawConstructor = vi.fn(function MockDraw(_options?: unknown) {
    return mockDrawInstance;
  });
  Object.assign(mockDrawConstructor, {
    constants: {
      classes: {
        CANVAS: 'mapboxgl-canvas',
        CONTROL_BASE: 'mapboxgl-ctrl',
        CONTROL_PREFIX: 'mapboxgl-ctrl-',
        CONTROL_GROUP: 'mapboxgl-ctrl-group',
        ATTRIBUTION: 'mapboxgl-ctrl-attrib',
      },
    },
    modes: {
      draw_line_string: {},
      draw_polygon: {},
      draw_point: {},
      direct_select: {},
      simple_select: {},
    },
  });
  const mockMap = {
    getContainer: () => document.createElement('div'),
    getLayer: vi.fn((): { id: string } | undefined => undefined),
    isStyleLoaded: vi.fn(() => true),
    off: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
  const mockControlState: { instance: object | null } = { instance: null };

  return { mockChangeMode, mockDrawConstructor, mockDrawInstance, mockMap, mockMode, mockControlState };
});

vi.mock('@mapbox/mapbox-gl-draw', () => ({ default: mockDrawConstructor }));

vi.mock('react-map-gl/maplibre', () => ({
  useControl: (create: () => object, onAdd: ({ map }: { map: typeof mockMap }) => void) => {
    if (!mockControlState.instance) {
      mockControlState.instance = create();
      onAdd({ map: mockMap });
    }
    return mockControlState.instance;
  },
}));

describe('DrawControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMode.value = 'simple_select';
    mockMap.isStyleLoaded.mockReturnValue(true);
    mockMap.getLayer.mockReturnValue({ id: 'crx-map-background' });
    mockControlState.instance = null;
  });

  it('requests static mode during obstacle placement and restores simple_select afterward', () => {
    const { rerender } = render(<DrawControl disabled={false} />);
    mockChangeMode.mockClear();

    rerender(<DrawControl disabled />);
    expect(mockChangeMode).toHaveBeenCalledWith('static');

    mockChangeMode.mockClear();
    rerender(<DrawControl disabled={false} />);
    expect(mockChangeMode).toHaveBeenCalledWith('simple_select');
  });

  it('registers the handler-free static mode that keeps boundary features visible', () => {
    render(<DrawControl />);

    const options = mockDrawConstructor.mock.calls[0][0] as {
      keybindings: boolean;
      modes: Record<string, {
        onSetup: () => Record<string, never>;
        toDisplayFeatures: (
          state: unknown,
          geojson: unknown,
          display: (feature: unknown) => void,
        ) => void;
      }>;
    };
    const staticMode = options.modes.static;
    const feature = { type: 'Feature' };
    const display = vi.fn();

    expect(options.keybindings).toBe(false);
    expect(staticMode.onSetup()).toEqual({});
    staticMode.toDisplayFeatures({}, feature, display);
    expect(display).toHaveBeenCalledWith(feature);
    expect(staticMode).not.toHaveProperty('onClick');
    expect(staticMode).not.toHaveProperty('onDrag');
  });

  it('restores static mode when a modechange tries to enter polygon drawing while disabled', () => {
    render(<DrawControl disabled />);
    mockChangeMode.mockClear();

    const modeChangeHandler = mockMap.on.mock.calls.find(
      ([event]) => event === 'draw.modechange',
    )?.[1] as ((event: { mode: string }) => void) | undefined;

    expect(modeChangeHandler).toBeDefined();
    modeChangeHandler?.({ mode: 'draw_polygon' });

    expect(mockChangeMode).toHaveBeenCalledWith('static');
  });

  it('delivers every feature in a multipart draw.update event', () => {
    const onDrawUpdate = vi.fn();
    render(<DrawControl onDrawUpdate={onDrawUpdate} />);

    const updates: Feature<Polygon>[] = [
      {
        type: 'Feature',
        id: 'part-a',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      },
      {
        type: 'Feature',
        id: 'part-b',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] },
      },
    ];
    const updateHandler = mockMap.on.mock.calls.find(([event]) => event === 'draw.update')?.[1] as
      ((event: { features: Feature<Polygon>[] }) => void) | undefined;

    expect(updateHandler).toBeDefined();
    updateHandler?.({ features: updates });

    expect(onDrawUpdate).toHaveBeenCalledWith(updates);
  });

  it('does not commit an in-progress sketch when obstacle mode interrupts polygon drawing', () => {
    const onDrawCreate = vi.fn();
    const sketch: Feature<Polygon> = {
      type: 'Feature',
      id: 'unfinished-part',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };
    const { rerender } = render(<DrawControl disabled={false} onDrawCreate={onDrawCreate} />);
    mockMode.value = 'draw_polygon';
    mockDrawInstance.trash.mockImplementation(() => {
      mockMode.value = 'simple_select';
    });
    mockChangeMode.mockImplementation((nextMode: string) => {
      if (nextMode === 'static' && mockMode.value === 'draw_polygon') {
        const createHandler = mockMap.on.mock.calls.find(([event]) => event === 'draw.create')?.[1] as
          ((event: { features: Feature<Polygon>[] }) => void) | undefined;
        createHandler?.({ features: [sketch] });
      }
      mockMode.value = nextMode;
    });

    rerender(<DrawControl disabled onDrawCreate={onDrawCreate} />);

    expect(onDrawCreate).not.toHaveBeenCalled();
  });

  it('waits for the map style load before adding initial geometry', async () => {
    vi.useFakeTimers();
    mockMap.isStyleLoaded.mockReturnValue(false);
    mockMap.getLayer.mockReturnValue(undefined);
    const initialFeature: Feature<Polygon> = {
      type: 'Feature',
      id: 'saved-part',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };

    try {
      render(<DrawControl initialGeoJSON={initialFeature} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(mockDrawInstance.add).not.toHaveBeenCalled();
      const loadHandler = mockMap.once.mock.calls.find(([event]) => event === 'load')?.[1] as
        (() => void) | undefined;
      expect(loadHandler).toBeDefined();

      mockMap.isStyleLoaded.mockReturnValue(true);
      loadHandler?.();

      expect(mockDrawInstance.add).toHaveBeenCalledWith(initialFeature);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds saved geometry that arrives after load fired while source tiles are still loading', () => {
    mockMap.isStyleLoaded.mockReturnValue(false);
    mockMap.getLayer.mockReturnValue(undefined);
    const initialFeature: Feature<Polygon> = {
      type: 'Feature',
      id: 'saved-after-load',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };

    const { rerender } = render(<DrawControl initialGeoJSON={null} />);
    const loadHandler = mockMap.once.mock.calls.find(([event]) => event === 'load')?.[1] as
      (() => void) | undefined;
    expect(loadHandler).toBeDefined();

    // MapLibre's one-time map load has fired, but pending source tiles keep isStyleLoaded false.
    loadHandler?.();
    rerender(<DrawControl initialGeoJSON={initialFeature} />);

    expect(mockDrawInstance.add).toHaveBeenCalledWith(initialFeature);
  });

  it('does not clear Draw again when its current geometry already matches parent state', async () => {
    vi.useFakeTimers();
    const initialFeature: Feature<Polygon> = {
      type: 'Feature',
      id: 'part-a',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };

    try {
      const { rerender } = render(<DrawControl initialGeoJSON={initialFeature} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      mockDrawInstance.getAll.mockReturnValue({ features: [initialFeature] });

      const unchangedGeometry: Feature<Polygon> = {
        ...initialFeature,
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      };
      rerender(<DrawControl initialGeoJSON={unchangedGeometry} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(mockDrawInstance.deleteAll).toHaveBeenCalledTimes(1);
      expect(mockDrawInstance.add).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
