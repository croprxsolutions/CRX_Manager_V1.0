// Pure and import-free so the browser app and the Deno invoice PDF share one breakdown.
// Amounts are integer cents.

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
  charge_type?: string | null;
  description?: string | null;
}

export interface InvoiceBreakdown {
  productsCents: number;
  charges: Array<{ label: string; cents: number }>;
  discount: { label: string; cents: number } | null;
  tax: { label: string; cents: number } | null;
  totalCents: number;
}

/** A product line is any line without a charge_type. The database writes the discount and tax descriptions (e.g. "Sales tax 6.25%"). */
export function invoiceBreakdown(lines: ReadonlyArray<BreakdownLine>): InvoiceBreakdown {
  const out: InvoiceBreakdown = { productsCents: 0, charges: [], discount: null, tax: null, totalCents: 0 };
  for (const line of lines) {
    const type = line.charge_type;
    out.totalCents += line.extended_cents;
    if (!type) {
      out.productsCents += line.extended_cents;
      continue;
    }
    const typeLabel = CHARGE_TYPE_LABELS[type] ?? '';
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
