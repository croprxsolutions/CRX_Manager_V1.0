import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../components/ui/Toast';
import { useLatestRef } from './useLatestRef';
import { sameLinesSeen, SIGNATURE_LOAD_CHANGED_MESSAGE, type LineSeen } from '../lib/deliveryEvidence';

/**
 * Binds the on-screen signature to the delivery lines the screen showed when it was drawn
 * (migration 20270307030000). `signedLines` is sent as p_lines_seen. When the lines on screen stop
 * matching (a delivered amount edited, a reload with other lines), the signature is cleared, the
 * drawn canvas too (render SignatureCanvas with `canvasKey` in its key), and the driver is told why.
 */
export function useLoadBoundSignature(
  signature: string | null,
  setSignature: (dataUrl: string | null) => void,
  currentLines: LineSeen[] | null,
) {
  const { toast } = useToast();
  const [signedLines, setSignedLines] = useState<LineSeen[] | null>(null);
  const [canvasKey, setCanvasKey] = useState(0);
  const linesRef = useLatestRef(currentLines);
  // Pass to SignatureCanvas: every stroke records the lines on screen at that moment.
  const onSignatureChange = useCallback((dataUrl: string | null) => {
    setSignature(dataUrl);
    setSignedLines(dataUrl ? linesRef.current : null);
  }, [setSignature, linesRef]);
  const clearSignature = useCallback(() => {
    setSignature(null);
    setSignedLines(null);
    setCanvasKey((key) => key + 1);
  }, [setSignature]);
  // Shows a loadProofProblem message; a signature taken for other lines is cleared too.
  const reportProofProblem = useCallback((problem: string) => {
    if (problem === SIGNATURE_LOAD_CHANGED_MESSAGE) clearSignature();
    toast('error', problem);
  }, [clearSignature, toast]);
  const stale = !!signature && !!currentLines && !sameLinesSeen(signedLines, currentLines);
  useEffect(() => {
    if (!stale) return;
    clearSignature();
    toast('warning', SIGNATURE_LOAD_CHANGED_MESSAGE);
  }, [stale, clearSignature, toast]);
  return { signedLines, canvasKey, onSignatureChange, clearSignature, reportProofProblem };
}
