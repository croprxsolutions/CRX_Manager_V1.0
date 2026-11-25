import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Field, FieldMarkerState, FieldObstacle } from '../../types';
import CrewFieldMarkerMap from './CrewFieldMarkerMap';
import { deleteFieldMarker } from '../../lib/fieldMarkerData';
import { readPendingMarker } from '../../lib/fieldMarkerPending';

const field = { id: 'field-1', field_name: 'North field' } as Field;
const own: FieldObstacle = {
  id: 'own', field_id: field.id, kind: 'washout', label: 'My washout', entrance_number: null,
  point_geojson: { type: 'Point', coordinates: [-89, 40] },
  created_by: 'crew-1', created_at: '2026-11-25T09:00:00Z', updated_at: '2026-11-25T09:00:00Z',
};
const loaded: FieldMarkerState = {
  status: 'complete', authors: new Map(),
  markers: [own, { ...own, id: 'coworker', label: 'Coworker washout', created_by: 'crew-2' }],
};

let currentRead = loaded;

vi.mock('../../hooks/useFieldMarkers', () => ({
  useFieldMarkers: () => ({
    forField: (id: string) => id === field.id ? currentRead : { ...loaded, markers: [] },
    refresh: vi.fn(),
  }),
}));
vi.mock('./CRXMap', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('./FieldBoundaryLayer', () => ({
  default: ({ onFieldClick }: { onFieldClick?: (id: string) => void }) => (
    <button disabled={!onFieldClick} onClick={() => onFieldClick?.(field.id)}>Open field</button>
  ),
}));
vi.mock('../../lib/fieldMarkerData', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/fieldMarkerData')>(),
  deleteFieldMarker: vi.fn(),
}));
vi.mock('./FieldObstacleLayer', () => ({ default: () => null }));
vi.mock('../../lib/fieldMarkerPending', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/fieldMarkerPending')>(),
  readPendingMarker: vi.fn().mockResolvedValue(null),
}));

it('shows progress while checking the device for a pending marker', async () => {
  let finish = () => {};
  vi.mocked(readPendingMarker).mockImplementationOnce(() => new Promise((resolve) => {
    finish = () => resolve(null);
  }));
  render(<CrewFieldMarkerMap fields={[field]} actorId="crew-1" jobByField={new Map([[field.id, 'job-1']])} office={false}
    onFieldClick={vi.fn()} onMapLoad={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Add marker' }));
  expect(screen.getByRole('status')).toHaveTextContent('Checking this device for a pending marker');
  await act(async () => finish());

  expect(screen.getByRole('heading', { name: 'Add marker to North field' })).toBeInTheDocument();
  expect(screen.queryByText(/Checking this device/)).not.toBeInTheDocument();
});

it('lets crew create a marker and manage only their own pins', () => {
  render(<CrewFieldMarkerMap fields={[field]} actorId="crew-1" jobByField={new Map([[field.id, 'job-1']])} office={false}
    onFieldClick={vi.fn()} onMapLoad={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Add marker' })).toBeEnabled();
  const ownRow = within(screen.getByText('My washout').closest('li')!);
  const coworkerRow = within(screen.getByText('Coworker washout').closest('li')!);
  expect(ownRow.getByRole('button', { name: 'Delete' })).toBeEnabled();
  expect(coworkerRow.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  expect(coworkerRow.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  fireEvent.click(ownRow.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('heading', { name: 'Edit marker on North field' })).toBeInTheDocument();
  expect(screen.getByLabelText('Note (optional)')).toHaveValue('My washout');
});

it('keeps a draft when another job appears and clears it when its own job changes', () => {
  const second = { ...field, id: 'field-2', field_name: 'South field' };
  const props = { actorId: 'crew-1', office: false, onFieldClick: vi.fn(), onMapLoad: vi.fn() };
  const { rerender } = render(<CrewFieldMarkerMap {...props} fields={[field]}
    jobByField={new Map([[field.id, 'job-1']])} />);
  fireEvent.click(within(screen.getByText('My washout').closest('li')!).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Keep this note' } });

  rerender(<CrewFieldMarkerMap {...props} fields={[field, second]}
    jobByField={new Map([[field.id, 'job-1'], [second.id, 'job-2']])} />);
  expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this note');

  rerender(<CrewFieldMarkerMap {...props} fields={[field, second]}
    jobByField={new Map([[field.id, 'job-3'], [second.id, 'job-2']])} />);
  expect(screen.queryByLabelText('Note (optional)')).not.toBeInTheDocument();
});

it('waits to allow field navigation until a confirmed delete returns', async () => {
  let finish: () => void = () => {};
  vi.mocked(deleteFieldMarker).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<CrewFieldMarkerMap fields={[field]} actorId="crew-1" jobByField={new Map([[field.id, 'job-1']])} office={false}
    onFieldClick={vi.fn()} onMapLoad={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Open field' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete marker' }));
  expect(screen.getByRole('button', { name: 'Open field' })).toBeDisabled();
  await act(async () => finish());
  expect(screen.getByText('Marker deleted.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open field' })).toBeEnabled();
});

it('hides the editor on an unavailable read and restores it when the field is checked again', () => {
  const view = () => <CrewFieldMarkerMap fields={[field]} actorId="crew-1" jobByField={new Map([[field.id, 'job-1']])} office={false}
    onFieldClick={vi.fn()} onMapLoad={vi.fn()} />;
  const { rerender } = render(view());
  fireEvent.click(within(screen.getByText('My washout').closest('li')!).getByRole('button', { name: 'Edit' }));
  try {
    currentRead = { ...loaded, status: 'unavailable', markers: [] };
    rerender(view());
    expect(screen.queryByLabelText('Note (optional)')).not.toBeInTheDocument();
    expect(screen.queryByText('My washout')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    currentRead = loaded;
    rerender(view());
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('My washout');
  } finally {
    currentRead = loaded;
  }
});

it.each(['authors', 'stale'] as const)('disables a %s retry until the field check returns', (reason) => {
  const view = () => <CrewFieldMarkerMap fields={[field]} actorId="crew-1" jobByField={new Map([[field.id, 'job-1']])} office={false}
    onFieldClick={vi.fn()} onMapLoad={vi.fn()} />;
  try {
    currentRead = reason === 'authors' ? { ...loaded, authorsUnavailable: true }
      : { ...loaded, status: 'stale', checkedAt: Date.now() };
    const { rerender } = render(view());
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    currentRead = { ...currentRead, status: reason === 'authors' ? 'loading' : 'stale', checking: true };
    rerender(view());
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
  } finally {
    currentRead = loaded;
  }
});

it('keeps the note textbox mounted during a background check and conceals it for a fresh access check', () => {
  const view = () => <CrewFieldMarkerMap fields={[field]} actorId="crew-1" jobByField={new Map([[field.id, 'job-1']])} office={false}
    onFieldClick={vi.fn()} onMapLoad={vi.fn()} />;
  try {
    const { rerender } = render(view());
    fireEvent.click(within(screen.getByText('My washout').closest('li')!).getByRole('button', { name: 'Edit' }));
    const note = screen.getByRole('textbox', { name: 'Note (optional)' });
    fireEvent.change(note, { target: { value: 'Still typing' } });
    currentRead = { ...loaded, status: 'loading', checkedAt: Date.now(), checking: true };
    rerender(view());
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).toBe(note);
    expect(note).toHaveValue('Still typing');
    currentRead = { ...loaded, status: 'loading', markers: [] };
    rerender(view());
    expect(screen.queryByRole('textbox', { name: 'Note (optional)' })).not.toBeInTheDocument();
  } finally {
    currentRead = loaded;
  }
});
