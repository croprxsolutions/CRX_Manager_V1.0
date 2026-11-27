import type { MapPicture } from './mapPreferences';

// Same credit set as the step 0 proof: mapbox-gl drew the logo itself, MapLibre does not.
const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

const USDA_ATTRIBUTION = link(
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer',
  'USDA, USGS The National Map: Orthoimagery',
);

// MapLibre's credit sanitizer drops data: image sources, so the logo is a CSS background (maplibreSetup.ts).
const MAPBOX_LOGO = `<a class="crx-mapbox-logo" href="https://www.mapbox.com/" target="_blank" rel="noopener noreferrer" title="Mapbox"><span class="crx-mapbox-logo-text">Mapbox</span></a>`;

/** Credit HTML for the picture on screen; Satellite adds the Maxar imagery credit. */
export function mapAttribution(picture: MapPicture): string {
  if (picture === 'usda') return USDA_ATTRIBUTION;
  return [
    MAPBOX_LOGO,
    link('https://www.mapbox.com/about/maps/', '© Mapbox'),
    link('https://www.openstreetmap.org/copyright', '© OpenStreetMap'),
    ...(picture === 'satellite' ? [link('https://www.maxar.com/', '© Maxar')] : []),
    `<strong>${link('https://apps.mapbox.com/feedback/', 'Improve this map')}</strong>`,
  ].join(' ');
}
