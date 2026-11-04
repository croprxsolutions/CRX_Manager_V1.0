import type { UnitConversion } from '../../types';
import { rateUnitOptionsForProduct } from '../../lib/units';

interface UnitSelectProps {
  unitConversions: UnitConversion[];
  form: string | null;
  inventoryUnit?: string | null;
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}

export default function UnitSelect({
  unitConversions,
  form,
  inventoryUnit,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: UnitSelectProps) {
  return (
    <select
      value={value || ''}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      className="w-full px-3 py-2.5 text-sm text-nav-dark bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50 transition-colors duration-150"
    >
      <option value="" disabled>--</option>
      {value && !rateUnitOptionsForProduct(unitConversions, form, inventoryUnit).some((conversion) => conversion.unit === value) && (
        <option value={value}>{value}</option>
      )}
      {rateUnitOptionsForProduct(unitConversions, form, inventoryUnit).map((conversion) => (
        <option key={conversion.id} value={conversion.unit}>{conversion.unit}</option>
      ))}
    </select>
  );
}
