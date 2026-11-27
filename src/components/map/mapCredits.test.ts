import { describe, expect, it } from 'vitest';
import { mapAttribution } from './mapCredits';

describe('mapAttribution', () => {
  it('gives Mapbox pictures the logo, both credits and the feedback link', () => {
    for (const picture of ['satellite', 'roads', 'terrain'] as const) {
      const html = mapAttribution(picture);
      expect(html).toContain('class="crx-mapbox-logo"');
      // MapLibre strips data: image sources from credits, so the logo must be CSS, not an <img>.
      expect(html).not.toContain('<img');
      expect(html).toContain('© Mapbox');
      expect(html).toContain('© OpenStreetMap');
      expect(html).toContain('Improve this map');
    }
  });

  it('adds the Maxar credit to Satellite only', () => {
    expect(mapAttribution('satellite')).toContain('© Maxar');
    expect(mapAttribution('roads')).not.toContain('© Maxar');
    expect(mapAttribution('terrain')).not.toContain('© Maxar');
  });

  it('names USDA and USGS on the USDA picture, with no Mapbox credit', () => {
    const html = mapAttribution('usda');
    expect(html).toContain('USDA, USGS The National Map: Orthoimagery');
    expect(html).not.toContain('Mapbox');
  });
});
