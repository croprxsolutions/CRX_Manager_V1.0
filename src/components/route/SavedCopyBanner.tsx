/**
 * The banner over a field screen showing its saved copy after a failed load (src/lib/todaySnapshot.ts):
 * says it is the saved copy and from when, that nothing can be saved until signal returns, and offers a retry.
 */
import { RefreshCw, WifiOff } from 'lucide-react';
import { savedCopyMessage } from '../../lib/todaySnapshot';

interface SavedCopyBannerProps {
  /** What is shown, e.g. "your route". */
  what: string;
  /** When the saved copy was loaded; null (no saved copy on screen) shows nothing. */
  savedAt: string | null;
  /** What cannot be done until signal returns, e.g. "You can't complete stops until signal returns." */
  blocked: string;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}

export default function SavedCopyBanner({ what, savedAt, blocked, onRetry, retrying = false, className = '' }: SavedCopyBannerProps) {
  if (!savedAt) return null;
  return (
    <div role="status" className={`flex items-start gap-2 rounded-lg border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900 ${className}`}>
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{savedCopyMessage(what, savedAt)}</p>
        <p>{blocked}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2 font-semibold text-amber-900 underline disabled:opacity-50"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" /> {retrying ? 'Trying…' : 'Try again'}
      </button>
    </div>
  );
}
