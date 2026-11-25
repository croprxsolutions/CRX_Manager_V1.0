import { cloneElement, type MouseEventHandler, type ReactElement, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { FieldObstacle } from '../../types';
import FieldObstacleLayer from './FieldObstacleLayer';

vi.mock('react-map-gl/mapbox', () => ({
  Marker: ({ children, onClick }: {
    children: ReactElement<{ onClick?: MouseEventHandler<HTMLButtonElement> }>;
    onClick?: (event: { originalEvent: { stopPropagation: () => void } }) => void;
  }) => cloneElement(children, { onClick: (event) => onClick?.({ originalEvent: event }) }),
  Popup: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
}));

it('shows an entrance number and keeps the pin disabled while placing a new marker', () => {
  const marker: FieldObstacle = {
    id: 'gate', field_id: 'field-a', kind: 'field_entrance', entrance_number: 2,
    label: 'East gate', created_by: 'crew', created_at: '', updated_at: '',
    point_geojson: { type: 'Point', coordinates: [-89, 40] },
  };
  const { rerender } = render(<FieldObstacleLayer obstacles={[marker]} interactive={false} />);
  const pin = screen.getByRole('button', { name: 'Entrance 2: East gate' });
  expect(pin).toHaveTextContent('2');
  expect(pin).toBeDisabled();
  fireEvent.click(pin);
  expect(screen.queryByText('East gate')).not.toBeInTheDocument();

  rerender(<FieldObstacleLayer obstacles={[marker]} />);
  fireEvent.click(pin);
  expect(screen.getByText('East gate')).toBeInTheDocument();
});
