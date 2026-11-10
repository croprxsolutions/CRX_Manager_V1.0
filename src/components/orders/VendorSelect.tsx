interface Props {
  label: string;
  value: string | null | undefined;
  vendors: string[];
  disabled?: boolean;
  onChange: (vendor: string | null) => void;
}

export default function VendorSelect({ label, value, vendors, disabled, onChange }: Props) {
  // A line's vendor may have been renamed or removed since; it still shows, and stays pickable.
  const options = value && !vendors.includes(value) ? [value, ...vendors] : vendors;
  return (
    <select
      aria-label={label}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full min-w-[9rem] px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20"
    >
      {/* A saved vendor can't be cleared: the database keeps the line's or refills the preferred one. */}
      {!value && <option value="">No vendor</option>}
      {options.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
  );
}
