import { describe, it, expect } from 'vitest';
import {
  buildLinesSeen, countTicketPhotosForLoad, hasDeliveredAmount, isLoadProofRefusal, LINES_LOADING_MESSAGE, loadProofProblem, NOTHING_DELIVERED_MESSAGE,
  sameLinesSeen, SIGNATURE_LOAD_CHANGED_MESSAGE, TICKET_PHOTO_LOAD_CHANGED_MESSAGE,
} from './deliveryEvidence';
import { PAPER_TICKET_PHOTO_CAPTION } from './paperTicket';

// Mirrors the server's _delivery_lines_match (migration 20270306190000): a multiset of
// (order line, product, quantity, delivered), delivered kept between 0 and the quantity.
describe('proof bound to the load', () => {
  const items = [
    { id: 'd1', order_item_id: 'OI-1', product_id: 'P-1', quantity: 10 },
    { id: 'd2', order_item_id: 'oi-2', product_id: 'p-2', quantity: 2.5 },
  ];

  it('builds the list with delivered = scheduled unless a figure is given', () => {
    expect(buildLinesSeen(items)).toEqual([
      { order_item_id: 'OI-1', product_id: 'P-1', quantity: 10, delivered: 10 },
      { order_item_id: 'oi-2', product_id: 'p-2', quantity: 2.5, delivered: 2.5 },
    ]);
    expect(buildLinesSeen(items, (it) => (it.id === 'd1' ? 4 : it.quantity))[0].delivered).toBe(4);
  });

  it('matches regardless of order, id case and number spelling', () => {
    const a = buildLinesSeen(items);
    const b = [
      { order_item_id: 'oi-2', product_id: 'P-2', quantity: 2.5, delivered: 2.5 },
      { order_item_id: 'oi-1', product_id: 'p-1', quantity: Number('10.000'), delivered: 10 },
    ];
    expect(sameLinesSeen(a, b)).toBe(true);
  });

  it('refuses a changed amount, product, extra line or duplicate', () => {
    const a = buildLinesSeen(items);
    expect(sameLinesSeen(a, buildLinesSeen(items, (it) => (it.id === 'd1' ? 9.99 : it.quantity)))).toBe(false);
    expect(sameLinesSeen(a, [a[0], { ...a[1], product_id: 'p-3' }])).toBe(false);
    expect(sameLinesSeen(a, [...a, a[0]])).toBe(false);
    expect(sameLinesSeen([a[0], a[0]], [a[0], a[1]])).toBe(false);
    // Sol round 11: 0.005 signed, 0.05 sent.
    expect(sameLinesSeen([{ ...a[0], delivered: 0.005 }], [{ ...a[0], delivered: 0.05 }])).toBe(false);
  });

  it('compares amounts to 6 decimal places, as the server does', () => {
    const a = buildLinesSeen(items);
    expect(sameLinesSeen([{ ...a[0], delivered: 0.1234564 }], [{ ...a[0], delivered: 0.12345649 }])).toBe(true);
    expect(sameLinesSeen([{ ...a[0], delivered: 0.123456 }], [{ ...a[0], delivered: 0.123457 }])).toBe(false);
  });

  it('counts only ticket photos taken for the current load toward the cap', () => {
    const a = buildLinesSeen(items);
    const stale = [{ ...a[0], delivered: 1 }, a[1]];
    const photos = [
      { caption: PAPER_TICKET_PHOTO_CAPTION, lines_seen: stale },
      { caption: PAPER_TICKET_PHOTO_CAPTION, lines_seen: null },
      { caption: PAPER_TICKET_PHOTO_CAPTION, lines_seen: a },
      { caption: 'Delivery photo', lines_seen: a },
    ];
    expect(countTicketPhotosForLoad(photos, a)).toBe(1);
    expect(countTicketPhotosForLoad(photos, null)).toBe(0);
  });

  it('clamps delivered to [0, quantity] on both sides', () => {
    const a = buildLinesSeen(items);
    expect(sameLinesSeen([{ ...a[0], delivered: 12 }], [{ ...a[0], delivered: 10 }])).toBe(true);
    expect(sameLinesSeen([{ ...a[0], delivered: -1 }], [{ ...a[0], delivered: 0 }])).toBe(true);
  });

  it('never matches a missing list (a photo saved without one)', () => {
    expect(sameLinesSeen(null, buildLinesSeen(items))).toBe(false);
    expect(sameLinesSeen(buildLinesSeen(items), undefined)).toBe(false);
    expect(sameLinesSeen([], [])).toBe(true);
  });

  it('counts under 0.01 as nothing delivered', () => {
    expect(hasDeliveredAmount(buildLinesSeen(items, () => 0.005))).toBe(false);
    expect(hasDeliveredAmount(buildLinesSeen(items, (it) => (it.id === 'd2' ? 0.01 : 0)))).toBe(true);
    expect(hasDeliveredAmount([])).toBe(false);
  });

  it('recognises the three refusals that clear the proof', () => {
    expect(isLoadProofRefusal({ message: 'DELIVERY_LOAD_CHANGED: the products changed' })).toBe(true);
    expect(isLoadProofRefusal({ message: 'PAPER_TICKET_LOAD_CHANGED: x' })).toBe(true);
    expect(isLoadProofRefusal({ message: 'DELIVERY_NOTHING_DELIVERED: x' })).toBe(true);
    expect(isLoadProofRefusal({ message: 'SIGNATURE_IMAGE_MISSING: x' })).toBe(false);
    expect(isLoadProofRefusal(new Error('Failed to fetch'))).toBe(false);
  });

  it('names the first proof-binding problem before anything is uploaded', () => {
    const lines = buildLinesSeen(items);
    const other = buildLinesSeen(items, () => 1);
    expect(loadProofProblem('no_proof', null, null, null)).toBeNull();
    expect(loadProofProblem('left_at_site', null, null, null)).toBeNull();
    expect(loadProofProblem('signature', null, lines, null)).toBe(LINES_LOADING_MESSAGE);
    expect(loadProofProblem('signature', buildLinesSeen(items, () => 0.005), null, null)).toBe(NOTHING_DELIVERED_MESSAGE);
    expect(loadProofProblem('signature', lines, other, null)).toBe(SIGNATURE_LOAD_CHANGED_MESSAGE);
    expect(loadProofProblem('signature', lines, lines, null)).toBeNull();
    expect(loadProofProblem('paper_ticket', lines, null, other)).toBe(TICKET_PHOTO_LOAD_CHANGED_MESSAGE);
    expect(loadProofProblem('paper_ticket', lines, null, undefined)).toBe(TICKET_PHOTO_LOAD_CHANGED_MESSAGE);
    expect(loadProofProblem('paper_ticket', lines, null, lines)).toBeNull();
  });
});
