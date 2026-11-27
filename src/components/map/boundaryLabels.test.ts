import { describe, expect, it } from 'vitest';
import { createBoundaryLabels } from './boundaryLabels';

type LabelInput = Parameters<typeof createBoundaryLabels>[0];

function collection(coordinates: number[][][]): LabelInput {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { id: 'field-1', label: 'North\n10 ac' },
      geometry: { type: 'Polygon', coordinates },
    }],
  } as unknown as LabelInput;
}

describe('createBoundaryLabels', () => {
  it('places a label inside a normal outline', () => {
    const [label] = createBoundaryLabels(collection([[[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]]]));
    expect(label.longitude).toBeCloseTo(0.01, 6);
    expect(label.latitude).toBeCloseTo(0.01, 6);
  });

  it('skips an outline with no usable corners instead of producing a bad map position', () => {
    expect(createBoundaryLabels(collection([]))).toEqual([]);
    expect(createBoundaryLabels(collection([[]]))).toEqual([]);
  });
});
