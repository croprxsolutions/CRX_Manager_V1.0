import * as maplibregl from 'maplibre-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import mapLibreCss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import drawCss from '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css?inline';

maplibregl.setWorkerUrl(workerUrl);

type DrawClassNames = Record<
  'CANVAS' | 'CONTROL_BASE' | 'CONTROL_PREFIX' | 'CONTROL_GROUP' | 'ATTRIBUTION',
  string
>;

const drawClassNames = MapboxDraw.constants.classes as unknown as DrawClassNames;
drawClassNames.CANVAS = 'maplibregl-canvas';
drawClassNames.CONTROL_BASE = 'maplibregl-ctrl';
drawClassNames.CONTROL_PREFIX = 'maplibregl-ctrl-';
drawClassNames.CONTROL_GROUP = 'maplibregl-ctrl-group';
drawClassNames.ATTRIBUTION = 'maplibregl-ctrl-attrib';

function scopeDrawCss(css: string): string {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const scopedRules: string[] = [];

  for (const [, selectorText, declarations] of rules) {
    const selectors = selectorText.split(',').map((selector) => selector.trim());
    const scopedSelectors = selectors.map((selector) => {
      const renamed = selector
        .replaceAll('mapboxgl-map', 'maplibregl-map')
        .replaceAll('mapboxgl-canvas-container', 'maplibregl-canvas-container')
        .replaceAll('mapboxgl-interactive', 'maplibregl-interactive');
      return renamed.startsWith('.maplibregl-map')
        ? renamed
        : `.maplibregl-map ${renamed}`;
    });
    scopedRules.push(`${scopedSelectors.join(', ')} {${declarations}}`);
  }

  return scopedRules.join('\n');
}

if (typeof document !== 'undefined' && !document.getElementById('crx-maplibre-styles')) {
  const style = document.createElement('style');
  style.id = 'crx-maplibre-styles';
  style.textContent = `${mapLibreCss}\n${scopeDrawCss(drawCss)}
    @media (max-width: 480px) {
      .crx-map-picture-notice { top: 140px; max-width: calc(100% - 20px); }
      .crx-field-setup-drawing .maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib { margin-bottom: 180px !important; }
      .crx-field-setup-drawing .maplibregl-ctrl-top-right { top: 68px; }
    }`;
  document.head.append(style);
}
