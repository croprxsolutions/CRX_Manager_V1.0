import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Full-bleed pages cancel <main>'s padding with negative margins. If the two drift apart the
// page scrolls sideways (8px at 640-1023 on the driver views until Nov 2026).
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('full-bleed wrappers', () => {
  it('main pads p-4 then lg:p-6', () => {
    expect(read('components/layout/AppLayout.tsx')).toMatch(/<main id="main-content" className="flex-1 p-4 [^"]*md:p-4 lg:p-6"/);
  });

  it.each(['pages/Deliveries.tsx', 'pages/DeliveryDetail.tsx', 'pages/DispatchBoard.tsx'])('%s cancels exactly that padding', (file) => {
    const src = read(file);
    expect(src).toContain('-m-4 lg:-m-6 ');
    expect(src).not.toMatch(/sm:-m-6|lg:-m-8/);
  });
});
