import { describe, expect, it } from 'vitest';
import './maplibreSetup';

describe('MapLibre phone drawing offsets', () => {
  it('scopes attribution and top-right offsets to Field Setup while drawing', () => {
    const css = document.getElementById('crx-maplibre-styles')?.textContent ?? '';

    expect(css).toMatch(/\.crx-field-setup-drawing\s+\.maplibregl-ctrl-bottom-right\s+\.maplibregl-ctrl-attrib\s*\{[^}]*margin-bottom:\s*180px\s*!important/);
    expect(css).toMatch(/\.crx-field-setup-drawing\s+\.maplibregl-ctrl-top-right\s*\{[^}]*top:\s*68px/);
    expect(css).not.toMatch(/(?:^|\})\s*\.maplibregl-ctrl-top-right\s*\{[^}]*top:\s*68px/);
    expect(css).not.toMatch(/(?:^|\})\s*\.maplibregl-ctrl-bottom-right\s+\.maplibregl-ctrl-attrib\s*\{[^}]*margin-bottom:\s*180px/);
  });
});
