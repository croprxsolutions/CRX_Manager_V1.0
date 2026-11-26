import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { FieldMarkerState, FieldObstacle } from '../../types';
import JobFieldMap from './JobFieldMap';

const { rpc, forField, refresh } = vi.hoisted(() => ({
  rpc: vi.fn(), forField: vi.fn<(id: string) => FieldMarkerState>(), refresh: vi.fn(),
}));
vi.mock('../../lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/db')>(),
  supabase: { rpc },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'crew' } }) }));
vi.mock('../../hooks/useFieldMarkers', () => ({ useFieldMarkers: () => ({ forField, refresh }) }));
vi.mock('../map/CRXMap', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../map/FieldBoundaryLayer', () => ({ default: () => null }));
vi.mock('../map/FieldMarkerLayer', () => ({ default: () => null }));
vi.mock('../map/FieldObstacleLayer', () => ({
  default: ({ obstacles }: { obstacles: FieldObstacle[] }) => (
    <div role="region" aria-label="Plotted markers">{obstacles.map((marker) => <p key={marker.id}>{marker.label}</p>)}</div>
  ),
}));

const north = {
  id: 'north', field_name: 'North field', customer_id: 'customer', sort_order: 1,
  total_acres: 20, measured_acres: null, override_acres: null,
  centroid_geojson: '{"type":"Point","coordinates":[-89,40]}', boundary_geojson: null,
};

function mapScreen(refreshKey?: number) {
  return <MemoryRouter><JobFieldMap jobId="job-1" refreshKey={refreshKey} /></MemoryRouter>;
}

function renderMap() {
  return render(mapScreen());
}

it('shows a field lookup failure instead of reporting that the job has no locations', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: new Error('Unavailable') });
  let finish = () => {};
  rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ data: [], error: null }); }));
  renderMap();
  expect(await screen.findByText('Could not load this job’s fields.')).toBeInTheDocument();
  expect(screen.queryByText('No field locations are selected on this job.')).not.toBeInTheDocument();
  const retry = screen.getByRole('button', { name: 'Check again' });
  fireEvent.click(retry);
  expect(retry).toBeDisabled();
  expect(screen.getByText('Checking this job’s fields…')).toBeInTheDocument();
  const checked = rpc.mock.calls.length;
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    fireEvent(document, new Event('visibilitychange'));
    expect(rpc).toHaveBeenCalledTimes(checked);
  } finally {
    visibility.mockRestore();
  }
  await act(async () => finish());
  expect(await screen.findByText('No field locations are selected on this job.')).toBeInTheDocument();
});

it('checks job fields again when the tab resumes and clears a removed location', async () => {
  rpc.mockResolvedValueOnce({ data: [north], error: null });
  rpc.mockResolvedValueOnce({ data: [], error: null });
  forField.mockReturnValue({ status: 'complete', markers: [], authors: new Map() });
  renderMap();
  await screen.findByRole('heading', { name: 'North field' });
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText('No field locations are selected on this job.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'North field' })).not.toBeInTheDocument();
  } finally {
    visibility.mockRestore();
  }
});

it('keeps the existing map mounted if the renewed job field check loses signal', async () => {
  rpc.mockResolvedValueOnce({ data: [north], error: null });
  rpc.mockResolvedValueOnce({ data: null, error: new Error('Failed to fetch') });
  forField.mockReturnValue({ status: 'complete', markers: [], authors: new Map() });
  renderMap();
  const map = await screen.findByRole('region', { name: 'Plotted markers' });
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByText('Checking this job’s fields…')).toBeInTheDocument();
    expect(await screen.findByText(/Some locations may be out of date/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Plotted markers' })).toBe(map);
  } finally {
    visibility.mockRestore();
  }
});

it('keeps the same job map if signal drops after the job data refresh key changes', async () => {
  rpc.mockResolvedValueOnce({ data: [north], error: null });
  rpc.mockResolvedValueOnce({ data: null, error: new Error('Failed to fetch') });
  forField.mockReturnValue({ status: 'complete', markers: [], authors: new Map() });
  const { rerender } = render(mapScreen(1));
  const map = await screen.findByRole('region', { name: 'Plotted markers' });
  rerender(mapScreen(2));
  expect(await screen.findByText(/Some locations may be out of date/)).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Plotted markers' })).toBe(map);
});

it('shows when markers could not be checked and lets the reader retry', async () => {
  rpc.mockResolvedValueOnce({ data: [north], error: null });
  forField.mockReturnValue({ status: 'unavailable', markers: [], authors: new Map() });
  renderMap();
  expect(await screen.findByText('Markers could not be checked for this field. Confirm hazards on site.')).toBeInTheDocument();
  expect(screen.queryByText('None recorded.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('filters the plotted symbols and keeps all marker notes in the list', async () => {
  const washout: FieldObstacle = {
    id: 'washout', field_id: north.id, kind: 'washout', label: 'Deep washout',
    point_geojson: { type: 'Point', coordinates: [-89, 40] }, entrance_number: null,
    created_by: 'crew', created_at: '2026-11-25T09:00:00Z', updated_at: '2026-11-25T09:00:00Z',
  };
  const entrance: FieldObstacle = { ...washout, id: 'entrance', kind: 'field_entrance', label: 'Use this gate', entrance_number: 2 };
  rpc.mockResolvedValueOnce({ data: [north], error: null });
  forField.mockReturnValue({ status: 'complete', markers: [washout, entrance], authors: new Map() });
  renderMap();

  const map = within(await screen.findByRole('region', { name: 'Plotted markers' }));
  const notes = within(screen.getByRole('list'));
  expect(map.getByText('Use this gate')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: /Map symbols/ }), { target: { value: 'washout' } });
  expect(map.getByText('Deep washout')).toBeInTheDocument();
  expect(map.queryByText('Use this gate')).not.toBeInTheDocument();
  expect(notes.getByText('Deep washout')).toBeInTheDocument();
  expect(notes.getByText('Use this gate')).toBeInTheDocument();
});

it('explains when matching markers have unusable map coordinates', async () => {
  const gate: FieldObstacle = {
    id: 'gate', field_id: north.id, kind: 'gate', label: 'East gate', entrance_number: null,
    point_geojson: { type: 'Point', coordinates: [-89, 40] },
    created_by: 'crew', created_at: '2026-11-25T09:00:00Z', updated_at: '2026-11-25T09:00:00Z',
  };
  const washout: FieldObstacle = {
    ...gate, id: 'washout', kind: 'washout', label: 'Deep washout', point_geojson: { type: 'Point', coordinates: [-89, 98] },
  };
  rpc.mockResolvedValueOnce({ data: [{ ...north, centroid_geojson: null }], error: null });
  forField.mockReturnValue({ status: 'complete', markers: [gate, washout], authors: new Map() });
  renderMap();
  await screen.findByRole('region', { name: 'Plotted markers' });
  fireEvent.change(screen.getByRole('combobox', { name: /Map symbols/ }), { target: { value: 'washout' } });
  expect(screen.getByText('Markers matching this symbol filter could not be placed on the map.')).toBeInTheDocument();
  expect(screen.getByText('Deep washout')).toBeInTheDocument();
});
