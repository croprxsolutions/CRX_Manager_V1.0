import { AlertTriangle } from 'lucide-react';

// Set this to false when the RUP flag review (DATA-7) is done; the notice and the export label both go away.
export const RUP_FLAGS_KNOWN_INCOMPLETE = true;

export default function RupIncompleteNotice() {
  if (!RUP_FLAGS_KNOWN_INCOMPLETE) return null;

  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span><span className="font-medium">Known incomplete.</span> Restricted Use flags on products have not all been reviewed, so this list and its counts may be missing products.</span>
    </div>
  );
}
