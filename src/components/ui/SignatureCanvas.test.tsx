/**
 * SignatureCanvas.test.tsx — Tests for signature capture component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

// ── Mock signature_pad ─────────────────────────────────────────────────────
const mockClear = vi.fn();
const mockOff = vi.fn();
const mockIsEmpty = vi.fn(() => false);
const mockToDataURL = vi.fn(() => 'data:image/png;base64,abc');
const mockAddEventListener = vi.fn();
const mockToData = vi.fn((): unknown[] => []);
const mockFromData = vi.fn();

vi.mock('signature_pad', () => {
  // Must be a regular function so `new SignaturePad(...)` works
  function MockSignaturePad() {
    return {
      clear: mockClear,
      off: mockOff,
      isEmpty: mockIsEmpty,
      toDataURL: mockToDataURL,
      addEventListener: mockAddEventListener,
      toData: mockToData,
      fromData: mockFromData,
    };
  }
  return { default: MockSignaturePad };
});

import SignatureCanvas from './SignatureCanvas';

describe('SignatureCanvas', () => {
  const defaultProps = {
    onSignatureChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders canvas and label', () => {
    render(<SignatureCanvas {...defaultProps} />);
    expect(screen.getByText('Signature')).toBeInTheDocument();
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('renders custom label', () => {
    render(<SignatureCanvas {...defaultProps} label="Driver Signature" />);
    expect(screen.getByText('Driver Signature')).toBeInTheDocument();
  });

  it('renders Clear button when not disabled', () => {
    render(<SignatureCanvas {...defaultProps} />);
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('hides Clear button when disabled', () => {
    render(<SignatureCanvas {...defaultProps} disabled />);
    expect(screen.queryByText('Clear')).not.toBeInTheDocument();
  });

  it('calls onSignatureChange(null) when Clear is clicked', () => {
    render(<SignatureCanvas {...defaultProps} />);
    fireEvent.click(screen.getByText('Clear'));
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(defaultProps.onSignatureChange).toHaveBeenCalledWith(null);
  });

  it('fills the width it is given at the height asked for', () => {
    render(<SignatureCanvas {...defaultProps} height={180} />);
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.height).toBe('180px');
    expect(canvas).toHaveClass('w-full');
    expect(canvas.style.width).toBe('');
  });

  it('is a tall box by default, big enough to sign with a finger on a phone', () => {
    render(<SignatureCanvas {...defaultProps} />);
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    expect(parseInt(canvas.style.height, 10)).toBeGreaterThanOrEqual(200);
    expect(parseInt(canvas.style.height, 10)).toBeLessThanOrEqual(240);
    expect(canvas.parentElement).toHaveClass('border-2');
  });

  it('shows a Sign here line until the customer starts signing, and again after Clear', () => {
    render(<SignatureCanvas {...defaultProps} />);
    expect(screen.getByText('Sign here')).toBeInTheDocument();
    const beginStroke = mockAddEventListener.mock.calls.find(([name]) => name === 'beginStroke')?.[1] as () => void;
    act(() => beginStroke());
    expect(screen.queryByText('Sign here')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Sign here')).toBeInTheDocument();
  });

  it('gives Clear a 44px tap target', () => {
    render(<SignatureCanvas {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveClass('min-h-[44px]');
  });

  it('shows no Sign here hint when disabled', () => {
    render(<SignatureCanvas {...defaultProps} disabled />);
    expect(screen.queryByText('Sign here')).not.toBeInTheDocument();
  });

  it('rescales drawn strokes when the box resizes (phone rotation)', () => {
    let boxWidth = 300;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => boxWidth);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => boxWidth / 2.5);
    let onResize = () => {};
    vi.stubGlobal('ResizeObserver', function (cb: () => void) {
      onResize = cb;
      return { observe: vi.fn(), disconnect: vi.fn() };
    });
    try {
      render(<SignatureCanvas {...defaultProps} />);
      expect(mockFromData).not.toHaveBeenCalled();

      mockToData.mockReturnValue([{ penColor: 'rgb(0, 0, 0)', points: [{ x: 100, y: 40 }] }]);
      boxWidth = 600;
      onResize();

      expect(mockFromData).toHaveBeenCalledWith([{ penColor: 'rgb(0, 0, 0)', points: [{ x: 200, y: 80 }] }]);
      expect(defaultProps.onSignatureChange).toHaveBeenCalledWith('data:image/png;base64,abc');
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      mockToData.mockReturnValue([]);
    }
  });
});
