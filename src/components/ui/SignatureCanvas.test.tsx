/**
 * SignatureCanvas.test.tsx — Tests for signature capture component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── Mock signature_pad ─────────────────────────────────────────────────────
const mockClear = vi.fn();
const mockOff = vi.fn();
const mockIsEmpty = vi.fn(() => false);
const mockToDataURL = vi.fn(() => 'data:image/png;base64,abc');
const mockAddEventListener = vi.fn();

vi.mock('signature_pad', () => {
  // Must be a regular function so `new SignaturePad(...)` works
  function MockSignaturePad() {
    return {
      clear: mockClear,
      off: mockOff,
      isEmpty: mockIsEmpty,
      toDataURL: mockToDataURL,
      addEventListener: mockAddEventListener,
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

  it('sets canvas dimensions from props', () => {
    render(<SignatureCanvas {...defaultProps} width={300} height={100} />);
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.width).toBe('300px');
    // Shrinks to fit a narrow phone while keeping the 300:100 shape
    expect(canvas.style.maxWidth).toBe('100%');
    expect(canvas.style.aspectRatio).toBe('300 / 100');
  });

  it('uses default width/height when not specified', () => {
    render(<SignatureCanvas {...defaultProps} />);
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.width).toBe('400px');
    expect(canvas.style.aspectRatio).toBe('400 / 150');
  });
});
