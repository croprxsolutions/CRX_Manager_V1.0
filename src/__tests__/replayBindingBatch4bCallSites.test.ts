/**
 * Replay-binding batch 4b (migration 20261102235000): price_order, update_order_items and
 * mark_inventory_row_verified replay a saved result only for the same person and the exact same
 * request.
 *
 * The pricing button retires a refused key ONLY when the refusal proves nothing ran under it
 * ('intent' or 'actor'); a 'receipt' refusal keeps it. The order-edit save already sends every
 * binding refusal to the reload dialog, which retires its key after the reload. The verify button
 * mints a fresh key per click.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('replay-binding batch 4b call sites', () => {
  const order = read('src/pages/OrderDetail.tsx');

  it('price_order retires its key only on an intent or actor refusal', () => {
    const start = order.indexOf('const handlePriceOrder = async');
    const handler = order.slice(start, order.indexOf('\n  };\n', start));
    expect(handler).toContain(
      "const bindingRejection = getIdempotencyBindingRejection(err);\n      if (bindingRejection === 'intent' || bindingRejection === 'actor') priceOrderIdem.resetKey();",
    );
  });

  it('update_order_items sends a binding refusal to the reload dialog, which retires the key', () => {
    expect(order).toContain('|| getIdempotencyBindingRejection(error)) {\n            setOrderConflict(true);');
    const reload = order.slice(order.indexOf('const reloadConflictingOrder = async'));
    expect(reload.slice(0, 300)).toContain('updateOrderIdem.resetKey();');
  });

  it('mark_inventory_row_verified sends a fresh key per click', () => {
    const panel = read('src/components/integrity/IntegrityCleanupPanel.tsx');
    const start = panel.indexOf('const handleVerifyManufactured = async');
    expect(panel.slice(start, start + 600)).toContain('const idemKey = crypto.randomUUID();');
  });
});
