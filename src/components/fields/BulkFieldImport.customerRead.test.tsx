/**
 * BulkFieldImport.customerRead.test.tsx — the step-4 customer list is read in full
 * (page by page), and a failed read never leaves an earlier or partial list behind:
 * the list is emptied, a toast says so, and step 4 cannot advance.
 *
 * Mocked: the network boundary, auth, toast, child steps and the file parser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const toast = vi.fn();
const assignmentProps = vi.fn();
let customerReply: { data: unknown[] | null; error: { message: string } | null; count?: number | null } = {
  data: [], error: null, count: 0,
};
const rangeCalls: Array<[number, number]> = [];

function customerChain() {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  for (const m of ['select', 'eq', 'order', 'limit', 'is', 'in', 'neq']) builder[m] = vi.fn(self);
  builder.range = vi.fn((from: number, to: number) => {
    rangeCalls.push([from, to]);
    return builder;
  });
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(customerReply).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => customerChain()), rpc: vi.fn() },
  assertRpcResult: (data: unknown) => data,
  rpcAuthErrorMessage: () => null,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1' } }),
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));

vi.mock('./ImportPreviewMap', () => ({ default: () => <div /> }));
vi.mock('./AttributeMappingStep', () => ({ default: () => <div /> }));
vi.mock('./FieldCustomerAssignment', () => ({
  default: (props: { customers: unknown[]; onApplyToAll: (id: string) => void }) => {
    assignmentProps(props);
    return <button onClick={() => props.onApplyToAll('cust-1')}>stub-assign</button>;
  },
}));

vi.mock('../../lib/fieldImportParser', () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [[[-88.0, 40.0], [-88.0, 40.01], [-87.99, 40.01], [-87.99, 40.0], [-88.0, 40.0]]],
  };
  return {
    parseShapefileBundle: vi.fn(),
    parseShapefileZip: vi.fn(),
    parseKMLFile: vi.fn(),
    parseGeoJSONFile: () => ({
      featureCollection: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry, properties: { NAME: 'North 1' } }],
      },
      attributeKeys: ['NAME'],
      crsDetected: 'EPSG:4326',
      warnings: [],
      featureCount: 1,
      fullGeometries: [geometry],
    }),
    calculateFieldMetrics: () => ({ acres: 40, centroid: { type: 'Point', coordinates: [-88, 40] } }),
    validateFullGeometry: () => [],
    geometryAcres: () => 40,
  };
});

import BulkFieldImport from './BulkFieldImport';

async function click(name: RegExp) {
  const el = await screen.findByRole('button', { name });
  await act(async () => { fireEvent.click(el); });
}

async function goToCustomerStep() {
  const file = new File(['{}'], 'fields.geojson', { type: 'application/geo+json' });
  const input = document.getElementById('field-import-input') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
  await click(/parse files/i);
  await click(/^next$/i); // step 2 -> 3
  await click(/^next$/i); // step 3 -> 4
}

describe('BulkFieldImport customer list read', () => {
  beforeEach(() => {
    toast.mockReset();
    assignmentProps.mockReset();
    rangeCalls.length = 0;
  });

  it('reads customers page by page and offers them at step 4', async () => {
    customerReply = { data: [{ id: 'cust-1', farm_name: 'Smith Farm' }], error: null, count: 1 };
    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await goToCustomerStep();

    expect(rangeCalls[0]).toEqual([0, 999]);
    expect(assignmentProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ customers: [{ id: 'cust-1', farm_name: 'Smith Farm' }] }),
    );
  });

  it('a failed read after a successful one leaves no stale list and blocks step 4', async () => {
    customerReply = { data: [{ id: 'cust-1', farm_name: 'Smith Farm' }], error: null, count: 1 };
    const { rerender } = render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });

    customerReply = { data: null, error: { message: 'boom' }, count: null };
    rerender(<BulkFieldImport open={false} onClose={vi.fn()} onSuccess={vi.fn()} />);
    rerender(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    await goToCustomerStep();

    expect(toast).toHaveBeenCalledWith('error', 'Failed to load customers');
    expect(screen.getByRole('alert')).toHaveTextContent('Customers could not be loaded');
    expect(screen.queryByRole('button', { name: /stub-assign/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
  });
});
