import { useRef, useState } from 'react';
import { Layers, Satellite, Map as MapIcon, Mountain, Globe } from 'lucide-react';
import type { MapPicture } from './mapPreferences';

interface LayerToggleProps {
  activeLayer: MapPicture;
  mapboxAvailable: boolean;
  onChange: (layer: MapPicture) => void;
}

const LAYER_OPTIONS: { key: MapPicture; label: string; Icon: typeof Satellite; needsMapbox: boolean }[] = [
  { key: 'satellite', label: 'Satellite', Icon: Satellite, needsMapbox: true },
  { key: 'roads', label: 'Roads', Icon: MapIcon, needsMapbox: true },
  { key: 'terrain', label: 'Terrain', Icon: Mountain, needsMapbox: true },
  { key: 'usda', label: 'USDA aerial', Icon: Globe, needsMapbox: false },
];

export default function LayerToggle({ activeLayer, mapboxAvailable, onChange }: LayerToggleProps) {
  const [open, setOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState({ up: true, maxHeight: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  // Open toward the side of the map with more room, so a short phone map never clips options.
  const toggleMenu = () => {
    const root = rootRef.current;
    const mapBox = root?.offsetParent?.getBoundingClientRect();
    const box = root?.getBoundingClientRect();
    if (!open && mapBox && box) {
      const above = box.top - mapBox.top - 8;
      const below = mapBox.bottom - box.bottom - 8;
      setMenuPlacement(above > below ? { up: true, maxHeight: above } : { up: false, maxHeight: below });
    }
    setOpen(!open);
  };

  return (
    <div ref={rootRef} className="crx-map-layer-toggle absolute bottom-4 left-4 z-10 max-[480px]:left-2.5 max-[480px]:top-[100px] max-[480px]:bottom-auto">
      <button
        type="button"
        onClick={toggleMenu}
        className="bg-white rounded-lg shadow-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 flex items-center gap-2"
      >
        <Layers className="w-4 h-4" />
        {LAYER_OPTIONS.find((l) => l.key === activeLayer)?.label ?? 'Satellite'}
      </button>

      {open && (
        <div
          className={`absolute left-0 min-w-[140px] overflow-y-auto rounded-lg border bg-white p-1 shadow-lg ${menuPlacement.up ? 'bottom-full mb-2' : 'top-full mt-2'}`}
          style={menuPlacement.maxHeight > 0 ? { maxHeight: menuPlacement.maxHeight } : undefined}
        >
          {LAYER_OPTIONS.map(({ key, label, Icon, needsMapbox }) => {
            const disabled = needsMapbox && !mapboxAvailable;
            return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => {
                onChange(key);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 rounded text-sm flex items-center gap-2 ${
                disabled
                  ? 'cursor-not-allowed text-gray-400'
                  : key === activeLayer
                  ? 'bg-crx-green/10 text-crx-green font-medium'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
