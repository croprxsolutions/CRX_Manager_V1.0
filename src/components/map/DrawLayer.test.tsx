import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import DrawLayer, { type DrawnPolygon } from './DrawLayer';

const { mockDrawControl } = vi.hoisted(() => ({ mockDrawControl: vi.fn((_props: Record<string, unknown>) => null) }));

vi.mock('./DrawControl', () => ({ default: mockDrawControl }));

function polygon(id: string, offset: number): Feature<Polygon> {
  return {
    type: 'Feature',
    id,
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[offset, 0], [offset + 0.02, 0], [offset + 0.02, 0.02], [offset, 0]]],
    },
  };
}

describe('DrawLayer', () => {
  afterEach(() => mockDrawControl.mockClear());

  it('updates every selected multipart feature from one draw.update batch', () => {
    const initialPolygons: DrawnPolygon[] = [
      { drawId: 'part-a', polygon: polygon('part-a', 0), acres: 10, label: 'North' },
      { drawId: 'part-b', polygon: polygon('part-b', 1), acres: 20, label: 'South' },
    ];
    const onPolygonsChange = vi.fn();
    render(<DrawLayer initialPolygons={initialPolygons} onPolygonsChange={onPolygonsChange} />);
    const drawProps = mockDrawControl.mock.calls[0][0] as {
      onDrawUpdate: (features: Feature<Polygon>[]) => void;
    };
    const movedParts = [polygon('part-a', 2), polygon('part-b', 3)];

    drawProps.onDrawUpdate(movedParts);

    expect(onPolygonsChange).toHaveBeenCalledTimes(1);
    const updated = onPolygonsChange.mock.calls[0][0] as DrawnPolygon[];
    expect(updated).toHaveLength(2);
    expect(updated.map((part) => part.drawId)).toEqual(['part-a', 'part-b']);
    expect(updated.map((part) => part.polygon.geometry.coordinates)).toEqual(
      movedParts.map((part) => part.geometry.coordinates),
    );
    expect(updated.map((part) => part.label)).toEqual(['North', 'South']);
  });

  it('starts a second update from the first update before the parent re-renders', () => {
    const initialPolygons: DrawnPolygon[] = [
      { drawId: 'part-a', polygon: polygon('part-a', 0), acres: 10, label: 'North' },
      { drawId: 'part-b', polygon: polygon('part-b', 1), acres: 20, label: 'South' },
    ];
    const onPolygonsChange = vi.fn();
    render(<DrawLayer initialPolygons={initialPolygons} onPolygonsChange={onPolygonsChange} />);
    const drawProps = mockDrawControl.mock.calls[0][0] as {
      onDrawUpdate: (features: Feature<Polygon>[]) => void;
    };
    const movedA = polygon('part-a', 2);
    const movedB = polygon('part-b', 3);

    drawProps.onDrawUpdate([movedA]);
    drawProps.onDrawUpdate([movedB]);

    const second = onPolygonsChange.mock.calls[1][0] as DrawnPolygon[];
    expect(second.map((part) => part.polygon.geometry.coordinates)).toEqual([
      movedA.geometry.coordinates,
      movedB.geometry.coordinates,
    ]);
  });
});
