/**
 * A stop's Call and Navigate buttons for the driver: a tel: link to the farm's phone and a Google Maps
 * directions link to the stop (its map pin when the delivery address has one, else the address text).
 * Each button shows only when its information is on file. Links only; nothing is saved.
 */
import { MapPin, Phone } from 'lucide-react';

export interface StopCoords {
  lat: number;
  lng: number;
}

/** The phone number as a tel: link, or null when it has no digits. */
function telHref(phone: string | null | undefined): string | null {
  // An extension ("x12", "ext. 12") is not dialled as part of the number.
  const trimmed = (phone ?? '').split(/x|ext/i)[0].trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

/** Google Maps directions to the stop, or null when there is neither a map pin nor an address. */
function directionsHref(address: string, coords: StopCoords | null): string | null {
  const destination = coords ? `${coords.lat},${coords.lng}` : address.trim();
  if (!destination) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

const ACTION_LINK = 'flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-3 text-base font-semibold text-nav-dark active:scale-[0.99]';

export default function StopContactActions({ phone, address, coords }: { phone: string | null | undefined; address: string; coords: StopCoords | null }) {
  const tel = telHref(phone);
  const maps = directionsHref(address, coords);
  if (!tel && !maps) return null;
  return (
    <div className="flex gap-2 px-4 py-3">
      {tel && (
        <a href={tel} className={ACTION_LINK}>
          <Phone className="w-5 h-5 text-crx-green" aria-hidden="true" /> Call
        </a>
      )}
      {maps && (
        <a href={maps} target="_blank" rel="noopener noreferrer" className={ACTION_LINK}>
          <MapPin className="w-5 h-5 text-crx-green" aria-hidden="true" /> Navigate
        </a>
      )}
    </div>
  );
}
