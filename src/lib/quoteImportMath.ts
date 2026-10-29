interface Ratio { numerator: bigint; denominator: bigint }

function decimalRatio(value: number): Ratio {
  if (!Number.isFinite(value) || value < 0) throw new Error('Imported quantities and conversion factors must be finite and non-negative.');
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const coefficient = BigInt(whole + fraction);
  return scale >= 0
    ? { numerator: coefficient, denominator: 10n ** BigInt(scale) }
    : { numerator: coefficient * 10n ** BigInt(-scale), denominator: 1n };
}

function multiply(left: Ratio, right: Ratio): Ratio {
  return { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator };
}

function quantityNumber(ratio: Ratio): number {
  const value = Number(ratio.numerator) / Number(ratio.denominator);
  if (!Number.isFinite(value) || (value === 0 && ratio.numerator !== 0n)) {
    throw new Error('Imported quantity exceeds the supported range. Reduce the values and retry.');
  }
  return value;
}

function roundedCents(quantity: Ratio, cents: bigint): bigint {
  const product = quantity.numerator * cents;
  const absolute = product < 0n ? -product : product;
  const rounded = (absolute * 2n + quantity.denominator) / (quantity.denominator * 2n);
  return product < 0n ? -rounded : rounded;
}

/** Keep acreage, rates, and conversions exact until each extended amount is rounded to cents. */
export function quoteImportAmounts(input: {
  acres: number; rate: number; rateFactor: number; inventoryFactor: number;
  priceCents: bigint; costCents: bigint;
}) {
  const ounces = multiply(decimalRatio(input.rate), decimalRatio(input.rateFactor));
  const inventory = decimalRatio(input.inventoryFactor);
  if (inventory.numerator === 0n) throw new Error('Inventory conversion factor must be positive.');
  const applied = multiply(decimalRatio(input.acres), ounces);
  const units = { numerator: applied.numerator * inventory.denominator, denominator: applied.denominator * inventory.numerator };
  return {
    ouncesPerAcre: quantityNumber(ounces), totalUnits: quantityNumber(units),
    priceCents: roundedCents(units, input.priceCents), costCents: roundedCents(units, input.costCents),
  };
}
