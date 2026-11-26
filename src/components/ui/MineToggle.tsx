const segment = (active: boolean) =>
  `inline-flex min-h-11 items-center justify-center rounded-md px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green md:min-h-9 ${
    active ? 'bg-white font-semibold text-nav-dark shadow-sm' : 'font-medium text-secondary hover:text-nav-dark'
  }`;

/**
 * Mine / All for a sales rep on the Quotes and Orders lists. A view filter, never a permission: All shows
 * every record, as the list always has.
 */
export default function MineToggle({ mine, onChange, label }: { mine: boolean; onChange: (mine: boolean) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-grid shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-cream-dark p-0.5">
      <button type="button" aria-pressed={mine} onClick={() => onChange(true)} className={segment(mine)}>
        Mine
      </button>
      <button type="button" aria-pressed={!mine} onClick={() => onChange(false)} className={segment(!mine)}>
        All
      </button>
    </div>
  );
}
