/** A PostgreSQL numeric as an exact integer and its display scale: units × 10^-scale. */
interface PgNumeric {
  units: bigint;
  scale: number;
}

// Both conversion columns are numeric(20,8) (scale 8) and arrive as JSON numbers. Below
// 10^7 a double is within half of 10^-8 of the stored value, so toFixed(8) restores it exactly.
function positiveNumeric8(value: number | string | null): PgNumeric | null {
  if (value === null) return null;
  const text = typeof value === 'number' && Number.isFinite(value) && value < 1e7 ? value.toFixed(8) : String(value);
  const match = text.match(/^(\d{1,7})(?:\.(\d{1,8}))?$/);
  if (!match) return null;
  const units = BigInt(match[1] + (match[2] ?? '').padEnd(8, '0'));
  return units > 0n ? { units, scale: 8 } : null;
}

/** numerator ÷ denominator (denominator > 0), rounded half away from zero like PostgreSQL. */
function divideRoundingHalfAway(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = 2n * (remainder < 0n ? -remainder : remainder);
  if (doubled < denominator) return quotient;
  return numerator < 0n ? quotient - 1n : quotient + 1n;
}

// PostgreSQL keeps numerics as base-10000 digits; select_div_scale (numeric.c) reads the
// weight and first non-zero digit of each operand to choose a division's result scale.
function weightAndFirstDigit({ units, scale }: PgNumeric): [number, bigint] {
  if (units === 0n) return [0, 0n];
  const groups = Math.ceil(scale / 4);
  const aligned = (units < 0n ? -units : units) * 10n ** BigInt(groups * 4 - scale);
  const digitCount = Math.ceil(aligned.toString().length / 4);
  return [digitCount - 1 - groups, aligned / 10000n ** BigInt(digitCount - 1)];
}

/** PostgreSQL numeric ÷ numeric: at least 16 significant digits, rounded half away from zero. */
function pgNumericDivide(dividend: PgNumeric, divisor: PgNumeric): PgNumeric {
  const [dividendWeight, dividendFirst] = weightAndFirstDigit(dividend);
  const [divisorWeight, divisorFirst] = weightAndFirstDigit(divisor);
  const quotientWeight = dividendWeight - divisorWeight - (dividendFirst <= divisorFirst ? 1 : 0);
  const scale = Math.min(Math.max(16 - quotientWeight * 4, dividend.scale, divisor.scale, 0), 1000);
  return {
    units: divideRoundingHalfAway(
      dividend.units * 10n ** BigInt(scale + divisor.scale),
      divisor.units * 10n ** BigInt(dividend.scale),
    ),
    scale,
  };
}

/**
 * The cost per inventory unit the server records for a supplier quote:
 * round(cost_cents::numeric / package_quantity / inventory_units_per_supplier_unit)::bigint
 * (20260720230000 get_supplier_market_evidence). Repeats PostgreSQL's two rounded
 * divisions and its final round() in BigInt, so a preview matches the server to the cent.
 * Null when either quantity is missing, not above 0, or too large to read exactly.
 */
export function supplierUnitCostCents(
  costCents: bigint,
  packageQuantity: number | string | null,
  inventoryUnitsPerSupplierUnit: number | string | null,
): bigint | null {
  const quantity = positiveNumeric8(packageQuantity);
  const factor = positiveNumeric8(inventoryUnitsPerSupplierUnit);
  if (!quantity || !factor) return null;
  const perUnit = pgNumericDivide(pgNumericDivide({ units: costCents, scale: 0 }, quantity), factor);
  return divideRoundingHalfAway(perUnit.units, 10n ** BigInt(perUnit.scale));
}
