import { useRef, useEffect, useCallback, useState } from 'react';
import { Eraser } from 'lucide-react';
import SignaturePad from 'signature_pad';

interface SignatureCanvasProps {
  onSignatureChange: (dataUrl: string | null) => void;
  /** Height of the signing box in CSS pixels; it always fills the width it is given. */
  height?: number;
  label?: string;
  disabled?: boolean;
}

/**
 * The on-screen signature box: full width, tall enough to sign with a finger on a phone, a clear border,
 * a "Sign here" line until the first stroke and a large Clear button. The saved PNG takes the box's own
 * shape (it varies with the screen), so the delivery PDF fits the image by its real proportions
 * (src/lib/deliveryPdf.ts) instead of stretching it to a fixed box.
 */
export default function SignatureCanvas({
  onSignatureChange,
  height = 220,
  label = 'Signature',
  disabled = false,
}: SignatureCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const [hasInk, setHasInk] = useState(false);
  // New ink since the strokes were last captured: the next resize re-captures them at their drawn size.
  const inkChangedRef = useRef(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });

    // Match the drawing surface to the box (high-DPI aware). The box resizes when a phone
    // rotates, so redo it then. Strokes already drawn keep their shape: a bigger box leaves them
    // where they are, a smaller one shrinks them evenly so the whole signature stays inside.
    // Each resize scales from the size the strokes were drawn at, so rotating back and forth never
    // shrinks them further.
    let sizedWidth = 0;
    let sizedHeight = 0;
    let drawn: { strokes: ReturnType<SignaturePad['toData']>; width: number; height: number } = { strokes: [], width: 0, height: 0 };
    const fitToBox = () => {
      const boxWidth = canvas.offsetWidth;
      const boxHeight = canvas.offsetHeight;
      if (!boxWidth || (boxWidth === sizedWidth && boxHeight === sizedHeight)) return;
      if (inkChangedRef.current && sizedWidth) {
        drawn = { strokes: pad.toData(), width: sizedWidth, height: sizedHeight };
        inkChangedRef.current = false;
      }
      const { strokes } = drawn;
      const scale = drawn.width && drawn.height
        ? Math.min(1, boxWidth / drawn.width, boxHeight / drawn.height)
        : 1;
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = boxWidth * ratio;
      canvas.height = boxHeight * ratio;
      canvas.getContext('2d')?.scale(ratio, ratio);
      sizedWidth = boxWidth;
      sizedHeight = boxHeight;
      pad.clear();
      if (strokes.length) {
        pad.fromData(strokes.map((g) => ({ ...g, points: g.points.map((p) => ({ ...p, x: p.x * scale, y: p.y * scale })) })));
        onSignatureChange(pad.toDataURL('image/png'));
      }
    };
    fitToBox();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitToBox);
    observer?.observe(canvas);

    pad.addEventListener('beginStroke', () => setHasInk(true));
    pad.addEventListener('endStroke', () => {
      inkChangedRef.current = true;
      if (!pad.isEmpty()) {
        onSignatureChange(pad.toDataURL('image/png'));
      }
    });

    if (disabled) {
      pad.off();
    }

    padRef.current = pad;

    return () => {
      observer?.disconnect();
      pad.off();
    };
  }, [disabled, onSignatureChange]);

  const handleClear = useCallback(() => {
    padRef.current?.clear();
    inkChangedRef.current = true;
    setHasInk(false);
    onSignatureChange(null);
  }, [onSignatureChange]);

  return (
    <div>
      <div className="mb-1 flex min-h-[44px] items-center justify-between gap-2">
        {label ? <span className="text-sm font-semibold text-nav-dark">{label}</span> : <span />}
        {!disabled && (
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-nav-dark hover:bg-gray-50 active:scale-95"
          >
            <Eraser className="h-4 w-4" aria-hidden="true" /> Clear
          </button>
        )}
      </div>
      <div className="relative overflow-hidden rounded-xl border-2 border-gray-400 bg-white">
        {!hasInk && !disabled && (
          // A signature line with its hint, like a paper ticket; gone once the customer starts signing.
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-4 bottom-[28%] flex items-end gap-2 border-b-2 border-gray-300 pb-1 text-gray-500">
            <span className="text-lg font-bold leading-none">×</span>
            <span className="text-base">Sign here</span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          aria-label={label || 'Signature'}
          style={{ height }}
          className="block w-full cursor-crosshair touch-none"
        />
      </div>
    </div>
  );
}
