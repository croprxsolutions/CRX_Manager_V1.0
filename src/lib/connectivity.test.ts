import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasSignal } from './connectivity';
import { hasPaperTicketPhoto, PAPER_TICKET_PHOTO_CAPTION } from './paperTicket';

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

describe('hasSignal (Goal 5: completing a delivery needs a signal)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setOnline(true);
  });

  it('is false without touching the network when the phone reports offline', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    setOnline(false);
    expect(await hasSignal()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is false when the phone says online but the request cannot reach the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await hasSignal(2000)).toBe(false);
  });

  it('is false when the server never answers before the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    expect(await hasSignal(50)).toBe(false);
  });

  it('is true for any real HTTP answer, including a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    expect(await hasSignal()).toBe(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    expect(await hasSignal()).toBe(true);
  });
});

describe('paper ticket photo', () => {
  it('is found only by its exact caption', () => {
    expect(hasPaperTicketPhoto([{ caption: null }, { caption: 'Drop spot' }])).toBe(false);
    expect(hasPaperTicketPhoto([{ caption: PAPER_TICKET_PHOTO_CAPTION }])).toBe(true);
  });
});

describe('no delivery completion is queued offline', () => {
  it.each(['src/pages/DeliveryDetail.tsx', 'src/pages/FieldStop.tsx', 'src/pages/Deliveries.tsx'])(
    '%s neither queues work offline nor skips the signal check',
    (path) => {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/queueAction/);
      expect(source).toMatch(/hasSignal\(\)/);
    },
  );
});
