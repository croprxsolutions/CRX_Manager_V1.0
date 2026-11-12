// Brand PR B-3: the brand warnings shown before an invoice posts. They warn and never block: posting records what the
// saved lines carry (Mason, Q5). The rules mirror the database's (20270106110000 _invoice_line_brand_alloc and
// get_epa_sales_to_check), so a line warned "no RUP record" here is the line the register skips and lists.
// shortcut: billed-above is summed over the lines given (this invoice, or its Bill Split group); another invoice
// billing the same order line is not read here, and the database lists that case on Sales to check after posting.
import {
  brandLinesDelivered,
  brandSplitMismatch,
  fmtBrandQty,
  parseBrandLines,
} from '../../supabase/functions/_shared/brandNotes.ts';

export interface BrandWarningLine {
  label: string;
  quantity: number;
  order_item_id: string | null;
  product_id: string | null;
  brand_lines: unknown;
}

export interface BrandWarnings {
  /** Lines that get no RUP record (Q6 problems). */
  noRecord: string[];
  /** Lines listed for follow-up; they are recorded by the usual restricted-use rule. */
  followUp: string[];
}

const tenThousandths = (v: unknown) => Math.round(Number(v) * 10000);

/** Delivery ids with a typed brand on the given lines: their picks' review state is read before warning. */
export function typedBrandDeliveryIds(lines: BrandWarningLine[]): string[] {
  const ids = new Set<string>();
  for (const l of lines) {
    for (const e of parseBrandLines(l.brand_lines) ?? []) if (e.typed && e.delivery_id) ids.add(e.delivery_id);
  }
  return [...ids];
}

export function invoiceBrandWarnings(lines: BrandWarningLine[], pendingTypedPickIds: ReadonlySet<string>): BrandWarnings {
  const noRecord: string[] = [];
  const followUp: string[] = [];
  // The payer group: lines billing the same order line and product share what was delivered.
  const billed = new Map<string, number>();
  for (const l of lines) {
    if (!l.order_item_id || !l.product_id || !(l.quantity > 0)) continue;
    const k = `${l.order_item_id}|${l.product_id}`;
    billed.set(k, (billed.get(k) ?? 0) + tenThousandths(l.quantity));
  }
  for (const l of lines) {
    const entries = parseBrandLines(l.brand_lines);
    if (entries === null || !(l.quantity > 0)) continue;
    if (entries.length === 0 || entries.some((e) => e.brand_key === 'n:')) {
      followUp.push(`${l.label}: Brand not recorded (uses the product's EPA number)`);
    }
    if (entries.length === 0) continue;
    const picks = entries.filter((e) => e.brand_key !== 'n:');
    for (const e of picks) {
      if (!e.epa_registration) followUp.push(`${l.label}: EPA number not recorded for ${e.brand_name || 'a brand'} (uses the product's EPA number)`);
      if (e.typed && e.pick_id && pendingTypedPickIds.has(e.pick_id)) {
        followUp.push(`${l.label}: Brand typed at delivery, not yet checked (${e.brand_name || 'unnamed'})`);
      }
    }
    const mismatch = brandSplitMismatch(entries);
    if (mismatch) {
      noRecord.push(`${l.label}: Split does not match delivered (${fmtBrandQty(mismatch.picked)} of ${fmtBrandQty(mismatch.delivered)} recorded)`);
      continue;
    }
    const delivered = brandLinesDelivered(entries);
    const total = l.order_item_id && l.product_id ? billed.get(`${l.order_item_id}|${l.product_id}`) ?? 0 : tenThousandths(l.quantity);
    if (total > delivered) {
      noRecord.push(`${l.label}: Billed above delivered (${fmtBrandQty(total / 10000)} billed, ${fmtBrandQty(delivered / 10000)} delivered)`);
    } else if (total < delivered) {
      followUp.push(`${l.label}: Quantity changed from delivered (${fmtBrandQty(total / 10000)} billed, ${fmtBrandQty(delivered / 10000)} delivered)`);
    }
  }
  return { noRecord, followUp };
}

/** The text added to the Post confirm, or null when nothing needs saying. */
export function brandPostWarningText(w: BrandWarnings): string | null {
  const parts: string[] = [];
  if (w.noRecord.length > 0) {
    parts.push(`These lines get NO RUP sales record and are listed on Sales to check: ${w.noRecord.join('; ')}.`);
  }
  if (w.followUp.length > 0) {
    parts.push(`Brand follow-ups, listed on Sales to check: ${w.followUp.join('; ')}.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
