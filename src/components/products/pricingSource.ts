export const PRICING_SOURCE_CHOICES = [
  'Vendor price list', 'Rebate program', 'Market adjustment', 'PO cost', 'Other',
] as const;

export type PricingSourceChoice = typeof PRICING_SOURCE_CHOICES[number];

export function pricingSourceValue(choice: PricingSourceChoice | '', detail: string): string {
  const trimmed = detail.trim();
  return choice === 'Other' ? trimmed : choice ? `${choice}${trimmed ? `: ${trimmed}` : ''}` : '';
}
