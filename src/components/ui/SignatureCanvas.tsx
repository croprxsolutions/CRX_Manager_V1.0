import { useRef, useEffect, useCallback } from 'react';
import SignaturePad from 'signature_pad';

interface SignatureCanvasProps {
  onSignatureChange: (dataUrl: string | null) => void;
  width?: number;
  height?: number;
  label?: string;
  disabled?: boolean;
}

export default function SignatureCanvas({
  onSignatureChange,
  width = 400,
  height = 150,
  label = 'Signature',
  disabled = false,
}: SignatureCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });

    // Match the drawing surface to the box (high-DPI aware). The box resizes when a phone
    // rotates, so redo it then and rescale any strokes already drawn to keep the pen under the finger.
    let sizedWidth = 0;
    const fitToBox = () => {
      const boxWidth = canvas.offsetWidth;
      if (!boxWidth || boxWidth === sizedWidth) return;
      const scale = sizedWidth ? boxWidth / sizedWidth : 1;
      const strokes = pad.toData();
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = boxWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext('2d')?.scale(ratio, ratio);
      sizedWidth = boxWidth;
      pad.clear();
      if (strokes.length) {
        pad.fromData(strokes.map((g) => ({ ...g, points: g.points.map((p) => ({ ...p, x: p.x * scale, y: p.y * scale })) })));
        onSignatureChange(pad.toDataURL('image/png'));
      }
    };
    fitToBox();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitToBox);
    observer?.observe(canvas);

    pad.addEventListener('endStroke', () => {
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
    onSignatureChange(null);
  }, [onSignatureChange]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-secondary">{label}</label>
        {!disabled && (
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-red-500 hover:text-red-700 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      <canvas
        ref={canvasRef}
        // Shrinks on narrow phones but keeps the desktop shape, so the saved PNG is never squashed.
        style={{ width, maxWidth: '100%', height: 'auto', aspectRatio: `${width} / ${height}` }}
        className="border border-gray-200 rounded-lg cursor-crosshair touch-none w-full"
      />
    </div>
  );
}
