import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createdFieldAppInvoiceStorageKey,
  forgetCreatedFieldAppInvoice,
  rememberCreatedFieldAppInvoice,
  readCreatedFieldAppInvoice,
} from './fieldAppCreatedInvoice';

const INVOICE_ID = '3f2b8c1e-5d4a-4b6f-9a1c-2e7d8f9a0b1c';
const KEY = createdFieldAppInvoiceStorageKey('user-1');

describe('fieldAppCreatedInvoice', () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.useRealTimers());

  it('keeps returning the remembered invoice until it is forgotten', () => {
    rememberCreatedFieldAppInvoice('user-1', INVOICE_ID);
    expect(readCreatedFieldAppInvoice('user-1')).toBe(INVOICE_ID);
    expect(readCreatedFieldAppInvoice('user-1')).toBe(INVOICE_ID);
    forgetCreatedFieldAppInvoice('user-1');
    expect(readCreatedFieldAppInvoice('user-1')).toBeNull();
  });

  it('keeps each user separate', () => {
    rememberCreatedFieldAppInvoice('user-1', INVOICE_ID);
    expect(readCreatedFieldAppInvoice('user-2')).toBeNull();
    expect(readCreatedFieldAppInvoice('user-1')).toBe(INVOICE_ID);
  });

  it('ignores and clears an expired entry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    rememberCreatedFieldAppInvoice('user-1', INVOICE_ID);
    vi.setSystemTime(new Date('2026-10-12T14:00:01Z'));
    expect(readCreatedFieldAppInvoice('user-1')).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('treats a non-finite expiry as expired (JSON 1e999 parses to Infinity)', () => {
    window.sessionStorage.setItem(KEY,
      `{"version":1,"userId":"user-1","invoiceId":"${INVOICE_ID}","expiresAt":1e999}`);
    expect(readCreatedFieldAppInvoice('user-1')).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('never stores or returns something that is not an invoice id', () => {
    rememberCreatedFieldAppInvoice('user-1', '../../admin');
    expect(window.sessionStorage.getItem(KEY)).toBeNull();

    window.sessionStorage.setItem(KEY, JSON.stringify({
      version: 1, userId: 'user-1', invoiceId: '../../admin', expiresAt: Date.now() + 60_000,
    }));
    expect(readCreatedFieldAppInvoice('user-1')).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('ignores an entry written for a different user under this key, and garbage', () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({
      version: 1, userId: 'user-2', invoiceId: INVOICE_ID, expiresAt: Date.now() + 60_000,
    }));
    expect(readCreatedFieldAppInvoice('user-1')).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();

    window.sessionStorage.setItem(KEY, '{not json');
    expect(readCreatedFieldAppInvoice('user-1')).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });
});
