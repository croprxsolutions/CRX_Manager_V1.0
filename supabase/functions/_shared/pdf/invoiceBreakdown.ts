// Pure and import-free, so the Deno invoice PDF shares it with the browser app: invoicePdf.ts (the printed and emailed
// invoice) and the invoice page's Amount due card (via src/lib/invoiceChargeLines.ts) both use it. Amounts are integer cents.

export const CHARGE_TYPE_LABELS: Readonly<Record<string, string>> = {
  freight: 'Freight',
  application_fee: 'Application fee',
  service: 'Service',
  other: 'Other',
  standing_discount: 'Standing discount',
  sales_tax: 'Sales tax',
};

interface BreakdownLine {
  extended_cents: number;
  product_id?: string | null;
  charge_type?: string | null;
  description?: string | null;
}

/**
 * A charge line: a typed charge, or, on an invoice that takes charges, an older untyped line with no product.
 * The database agrees: the standing discount's base is product_id set and charge_type null (20261231110000).
 */
export function isChargeLine(line: { product_id?: string | null; charge_type?: string | null }, productlessIsCharge: boolean): boolean {
  return !!line.charge_type || (productlessIsCharge && !line.product_id);
}

export interface InvoiceBreakdown {
  productsCents: number;
  charges: Array<{ label: string; cents: number }>;
  discount: { label: string; cents: number } | null;
  tax: { label: string; cents: number } | null;
  totalCents: number;
}

/**
 * A product line is any line that is not a charge line (isChargeLine). An untyped charge line reads "Charge", as the
 * invoice page labels it. The database writes the discount and tax descriptions (e.g. "Sales tax 6.25%").
 */
export function invoiceBreakdown(lines: ReadonlyArray<BreakdownLine>, productlessIsCharge = false): InvoiceBreakdown {
  const out: InvoiceBreakdown = { productsCents: 0, charges: [], discount: null, tax: null, totalCents: 0 };
  for (const line of lines) {
    const type = line.charge_type;
    out.totalCents += line.extended_cents;
    if (!isChargeLine(line, productlessIsCharge)) {
      out.productsCents += line.extended_cents;
      continue;
    }
    const typeLabel = type ? CHARGE_TYPE_LABELS[type] ?? '' : 'Charge';
    if (type === 'standing_discount' || type === 'sales_tax') {
      const key = type === 'sales_tax' ? 'tax' : 'discount';
      const prior = out[key];
      out[key] = { label: prior?.label ?? (line.description?.trim() || typeLabel), cents: (prior?.cents ?? 0) + line.extended_cents };
      continue;
    }
    const existing = out.charges.find((charge) => charge.label === typeLabel);
    if (existing) existing.cents += line.extended_cents;
    else out.charges.push({ label: typeLabel, cents: line.extended_cents });
  }
  return out;
}
