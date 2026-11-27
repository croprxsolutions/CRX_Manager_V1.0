import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LayerToggle from './LayerToggle';

function rect(top: number, bottom: number) {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function openOn(mapTop: number, mapBottom: number, toggleTop: number, toggleBottom: number) {
  const { container } = render(
    <div data-testid="map" style={{ position: 'relative' }}>
      <LayerToggle activeLayer="satellite" mapboxAvailable onChange={vi.fn()} />
    </div>,
  );
  const root = container.querySelector('.crx-map-layer-toggle') as HTMLElement;
  const map = screen.getByTestId('map');
  Object.defineProperty(root, 'offsetParent', { value: map });
  map.getBoundingClientRect = () => rect(mapTop, mapBottom);
  root.getBoundingClientRect = () => rect(toggleTop, toggleBottom);
  fireEvent.click(screen.getByRole('button', { name: 'Satellite' }));
  return screen.getByRole('button', { name: 'USDA aerial' }).parentElement as HTMLElement;
}

describe('LayerToggle menu placement', () => {
  it('opens upward from a bottom toggle, as on desktop', () => {
    const menu = openOn(0, 500, 444, 484);
    expect(menu.className).toContain('bottom-full');
    expect(menu.style.maxHeight).toBe('436px');
  });

  it('keeps the menu inside a short phone map by opening to the roomier side and scrolling', () => {
    // Field Dashboard on a phone: 200px map, toggle 100px from the top.
    const menu = openOn(0, 200, 100, 140);
    expect(menu.className).toContain('bottom-full');
    expect(menu.style.maxHeight).toBe('92px');
    expect(menu.className).toContain('overflow-y-auto');
  });

  it('opens downward when there is more room below', () => {
    const menu = openOn(0, 600, 100, 140);
    expect(menu.className).toContain('top-full');
    expect(menu.style.maxHeight).toBe('452px');
  });
});
