/**
 * The stop screen's saved copy (src/lib/todaySnapshot.ts), shown when the stop cannot be loaded in a dead
 * spot: where to go, who to call, the notes and what is on the truck for this stop. Read-only: the main
 * button stays off, because a stop is only started or completed with signal (Goal 5, Mason 2026-10-15).
 */
import { ClipboardCheck, MapPin } from 'lucide-react';
import PhoneHeader from '../ui/PhoneHeader';
import SavedCopyBanner from './SavedCopyBanner';
import StopContactActions, { type StopCoords } from './StopContactActions';

/** Only what the stop screen displays; no email, no billing details, nothing to save back. */
export interface SavedStopCopy {
  id: string;
  delivery_number: string | null;
  status: string;
  delivery_notes: string | null;
  farm_name: string | null;
  phone: string | null;
  address_line: string;
  address_coords: StopCoords | null;
  items: { id: string; quantity: number; product_name: string | null }[];
}

interface StopSavedCopyProps {
  stop: SavedStopCopy;
  savedAt: string;
  retrying: boolean;
  onRetry: () => void;
  onBack: () => void;
}

export default function StopSavedCopy({ stop, savedAt, retrying, onRetry, onBack }: StopSavedCopyProps) {
  return (
    <div className="phone-touch max-w-2xl mx-auto">
      <PhoneHeader
        title={stop.farm_name || 'Unknown customer'}
        eyebrow={stop.delivery_number}
        back={{ label: 'My Route', onClick: onBack }}
        className="-mx-4 -mt-4 mb-4 md:mx-0 md:mt-0 md:rounded-xl"
      />
      <SavedCopyBanner
        what="this stop"
        savedAt={savedAt}
        blocked="You can't start or complete this stop until signal returns."
        onRetry={onRetry}
        retrying={retrying}
        className="mb-3"
      />
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
        {stop.address_line && (
          <p className="flex items-start gap-2 px-4 py-3 text-base text-nav-dark">
            <MapPin className="w-5 h-5 mt-0.5 text-crx-green shrink-0" aria-hidden="true" /> {stop.address_line}
          </p>
        )}
        <StopContactActions phone={stop.phone} address={stop.address_line} coords={stop.address_coords} />
        {stop.delivery_notes && (
          <p className="bg-amber-50 border-l-4 border-amber-500 px-4 py-3 text-base text-amber-900 whitespace-pre-wrap break-words">{stop.delivery_notes}</p>
        )}
      </div>
      <h2 className="font-heading text-lg font-semibold text-nav-dark mt-4 mb-2">On this delivery</h2>
      <ul className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
        {stop.items.map((it) => (
          <li key={it.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="font-semibold text-nav-dark break-words">{it.product_name || 'Product'}</span>
            <span className="shrink-0 font-heading text-xl font-bold tabular-nums text-nav-dark">{it.quantity}</span>
          </li>
        ))}
        {stop.items.length === 0 && <li className="px-4 py-6 text-center text-sm text-secondary">No items on this delivery.</li>}
      </ul>
      <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-4 bg-cream/95 px-4 py-2 backdrop-blur md:static md:mx-0 md:bg-transparent md:px-0 md:backdrop-blur-none">
        <button
          type="button"
          disabled
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-crx-green font-heading text-xl font-bold text-white disabled:opacity-50"
        >
          <ClipboardCheck className="w-6 h-6" aria-hidden="true" /> Needs signal to {stop.status === 'scheduled' ? 'start' : 'complete'}
        </button>
      </div>
    </div>
  );
}
