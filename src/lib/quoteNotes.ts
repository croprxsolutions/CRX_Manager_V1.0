import type { Product } from '../types';

/** Prefer customer-facing quote guidance, with the grower description as a legacy fallback. */
export function preferredQuoteNotes(
  product: Pick<Product, 'quoting_notes' | 'notes'>,
): string {
  return product.quoting_notes?.trim() || product.notes?.trim() || '';
}

type QuoteNoteFields = { quoting_notes?: string | null; notes?: string | null };

/** What a new quote line shows before and after an edit; null when a customer would see no difference. */
export function quoteLineChange(
  before: QuoteNoteFields,
  after: QuoteNoteFields,
): { before: string; after: string } | null {
  const was = preferredQuoteNotes({ quoting_notes: before.quoting_notes ?? null, notes: before.notes ?? null });
  const now = preferredQuoteNotes({ quoting_notes: after.quoting_notes ?? null, notes: after.notes ?? null });
  return was === now ? null : { before: was, after: now };
}
