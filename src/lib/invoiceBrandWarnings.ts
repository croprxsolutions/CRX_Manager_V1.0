// Brand PR B-3: the brand warnings shown before an invoice posts. They warn and never block: posting records what the
// saved lines carry (Mason, Q5). The rules mirror the database's (20270106110000 _invoice_line_brand_alloc and
// get_epa_sales_to_check), so a line warned "no RUP record" here is the line the register skips and lists.
// shortcut: billed-above is summed over the lines given (this invoice, or its Bill Split group), and a line with no
// brands on an order-wide invoice (no delivery) is not checked for picks added since; another invoice billing the same
// order line is not read here either. The database lists those cases on Sales to check after posting.
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
  /** The invoice's own delivery, when it bills one. */
  delivery_id: string | null;
  brand_lines: unknown;
}

/** A delivery line's current picks (get_delivery_brands). */
export interface DeliveryPickLine {
  delivery_id: string;
  delivery_item_id: string;
  order_item_id: string | null;
  product_id: string | null;
  picks: Array<{ id: string; quantity: number; review_state: string | null }>;
}

export interface BrandWarnings {
  /** Lines that get no RUP record (Q6 problems). */
  noRecord: string[];
  /** Lines listed for follow-up; they are recorded by the usual restricted-use rule. */
  followUp: string[];
}

const tenThousandths = (v: unknown) => Math.round(Number(v) * 10000);

/** The deliveries whose current picks are read before warning: every delivery a line's brands or invoice covers. */
export function brandDeliveryIds(lines: BrandWarningLine[]): string[] {
  const ids = new Set<string>();
  for (const l of lines) {
    if (l.delivery_id && l.order_item_id && l.product_id) ids.add(l.delivery_id);
    for (const e of parseBrandLines(l.brand_lines) ?? []) if (e.delivery_id) ids.add(e.delivery_id);
  }
  return [...ids];
}

type Entries = NonNullable<ReturnType<typeof parseBrandLines>>;

const groupKey = (l: BrandWarningLine) => (l.order_item_id && l.product_id ? `${l.order_item_id}|${l.product_id}` : null);

/** The payer group: lines billing the same order line and product share what was delivered (ten-thousandths). */
function billedByGroup(lines: BrandWarningLine[]): Map<string, number> {
  const billed = new Map<string, number>();
  for (const l of lines) {
    const k = groupKey(l);
    if (k && l.quantity > 0) billed.set(k, (billed.get(k) ?? 0) + tenThousandths(l.quantity));
  }
  return billed;
}

const pickText = (id: string | null | undefined, q: unknown) => `${id}|${tenThousandths(q)}`;

/**
 * The saved brands no longer say what the picks say (a Bill Split draft is never re-copied after a correction):
 * posting records nothing for the line and lists it as brand_lines_stale (20270106110000).
 */
function brandsChanged(l: BrandWarningLine, entries: Entries | null, current: DeliveryPickLine[]): boolean {
  if (entries === null || entries.length === 0) {
    // No brands saved: stale once a pick exists on the invoice's own delivery line.
    return !!l.delivery_id && current.some((c) => c.delivery_id === l.delivery_id && c.order_item_id === l.order_item_id
      && c.product_id === l.product_id && c.picks.length > 0);
  }
  const items = new Set(entries.map((e) => e.delivery_item_id));
  const saved = entries.filter((e) => e.pick_id).map((e) => pickText(e.pick_id, e.quantity)).sort();
  const now = current.filter((c) => items.has(c.delivery_item_id))
    .flatMap((c) => c.picks.map((p) => pickText(p.id, p.quantity))).sort();
  return saved.join(',') !== now.join(',');
}

function pickFollowUps(label: string, entries: Entries, pendingTypedPickIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.brand_key === 'n:') continue;
    if (!e.epa_registration) out.push(`${label}: EPA number not recorded for ${e.brand_name || 'a brand'} (uses the product's EPA number)`);
    if (e.typed && e.pick_id && pendingTypedPickIds.has(e.pick_id)) {
      out.push(`${label}: Brand typed at delivery, not yet checked (${e.brand_name || 'unnamed'})`);
    }
  }
  return out;
}

export function invoiceBrandWarnings(lines: BrandWarningLine[], current: DeliveryPickLine[]): BrandWarnings {
  const noRecord: string[] = [];
  const followUp: string[] = [];
  const billed = billedByGroup(lines);
  const pendingTypedPickIds = new Set(current.flatMap((c) => c.picks.filter((p) => p.review_state === 'pending').map((p) => p.id)));
  for (const l of lines) {
    const entries = parseBrandLines(l.brand_lines);
    if (!(l.quantity > 0)) continue;
    if (l.order_item_id && l.product_id && brandsChanged(l, entries, current)) {
      noRecord.push(`${l.label}: Brands changed since this invoice was made`);
      continue;
    }
    if (entries === null) continue;
    if (entries.length === 0 || entries.some((e) => e.brand_key === 'n:')) {
      followUp.push(`${l.label}: Brand not recorded (uses the product's EPA number)`);
    }
    if (entries.length === 0) continue;
    followUp.push(...pickFollowUps(l.label, entries, pendingTypedPickIds));
    const mismatch = brandSplitMismatch(entries);
    if (mismatch) {
      noRecord.push(`${l.label}: Split does not match delivered (${mismatch} recorded)`);
      continue;
    }
    const delivered = brandLinesDelivered(entries);
    const k = groupKey(l);
    const total = k ? billed.get(k) ?? 0 : tenThousandths(l.quantity);
    const amounts = `(${fmtBrandQty(total / 10000)} billed, ${fmtBrandQty(delivered / 10000)} delivered)`;
    if (total > delivered) noRecord.push(`${l.label}: Billed above delivered ${amounts}`);
    else if (total < delivered) followUp.push(`${l.label}: Quantity changed from delivered ${amounts}`);
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
    parts.push(`Brand follow-ups to check: ${w.followUp.join('; ')}.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
