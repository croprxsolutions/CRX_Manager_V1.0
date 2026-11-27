import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';

const mockToast = vi.fn();
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import { useLoadBoundSignature } from './useLoadBoundSignature';
import { SIGNATURE_LOAD_CHANGED_MESSAGE, type LineSeen } from '../lib/deliveryEvidence';

const line = (delivered: number): LineSeen[] => [{ order_item_id: 'oi-1', product_id: 'p-1', quantity: 10, delivered }];

// Taha's review of #2614 (LOW 1): editing an amount after signing clears the signature and remounts the canvas.
describe('useLoadBoundSignature', () => {
  it('records the lines at the stroke and clears the signature when they change', () => {
    const { result, rerender } = renderHook(({ lines }) => {
      const [signature, setSignature] = useState<string | null>(null);
      return { signature, ...useLoadBoundSignature(signature, setSignature, lines) };
    }, { initialProps: { lines: line(10) } });
    act(() => result.current.onSignatureChange('data:image/png;base64,AAAA'));
    expect(result.current.signature).not.toBeNull();
    expect(result.current.signedLines).toEqual(line(10));
    const keyBefore = result.current.canvasKey;
    rerender({ lines: line(10) });
    expect(result.current.signature).not.toBeNull();
    rerender({ lines: line(4) });
    expect(result.current.signature).toBeNull();
    expect(result.current.signedLines).toBeNull();
    expect(result.current.canvasKey).toBe(keyBefore + 1);
    expect(mockToast).toHaveBeenCalledWith('warning', SIGNATURE_LOAD_CHANGED_MESSAGE);
  });
});
