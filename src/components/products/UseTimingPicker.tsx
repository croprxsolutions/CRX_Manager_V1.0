import { groupUseTimingOptionsByCrop, replacementFor, visibleProductUseTimingOptions } from '../../lib/productUseTimings';
import type { CropOption, UseTimingOption } from '../../types';

/**
 * Crop + timing checkboxes grouped by crop (USE-1). Turned-off choices are hidden unless ticked or `held` (the saved
 * list), so unticking a saved turned-off choice before saving can be undone.
 */
export default function UseTimingPicker({ options, crops, category, selected, held, disabled, onChange }: {
  options: readonly UseTimingOption[];
  crops: readonly CropOption[];
  category: string | null | undefined;
  selected: readonly string[];
  held: readonly string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const visible = visibleProductUseTimingOptions(options, category, selected, held);
  const groups = groupUseTimingOptionsByCrop(visible, crops);
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.crop ?? '__any'}>
          <p className="px-2 text-xs font-semibold uppercase tracking-wide text-secondary">{group.label}</p>
          {group.options.map((option) => {
            const checked = selected.includes(option.code);
            const replacement = checked ? replacementFor(options, option) : undefined;
            return (
              <div key={option.code} className="px-2">
                <label className={`flex min-h-9 items-center gap-2 rounded text-sm text-nav-dark ${disabled ? '' : 'hover:bg-gray-50'}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => onChange(event.target.checked ? [...selected, option.code] : selected.filter((code) => code !== option.code))}
                    disabled={disabled}
                    className="h-4 w-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                  />
                  {option.label}{option.is_active ? '' : ' (retired)'}
                </label>
                {!option.is_active && checked && (
                  <div className="mb-1 ml-6 flex flex-wrap items-center gap-2 text-xs text-amber-900">
                    <span>
                      {replacement
                        ? `This choice was turned off. "${replacement.label}" is the same crop and timing.`
                        : 'This choice was turned off. It stays until you untick it.'}
                    </span>
                    {replacement && !disabled && (
                      <button
                        type="button"
                        onClick={() => onChange(selected.map((code) => (code === option.code ? replacement.code : code)))}
                        className="min-h-8 rounded border border-amber-300 bg-white px-2 font-medium text-nav-dark hover:bg-amber-50 focus-visible:ring-2 focus-visible:ring-crx-green"
                      >
                        Switch to {replacement.label}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
