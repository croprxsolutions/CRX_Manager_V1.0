/**
 * UpdatePrompt — Shows a dismissible banner when a new app version is ready.
 *
 * Previously the PWA used registerType: 'autoUpdate' which silently forced
 * a full page reload when the service worker updated — wiping any form data
 * the user had typed (especially on mobile after switching apps).
 *
 * Now we use registerType: 'prompt': the service worker waits patiently until
 * the user taps "Reload", so form data is never lost unexpectedly.
 */
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw } from 'lucide-react';

// "Later" hides the notice for this browser session only; storage can be blocked (private mode).
const LATER_KEY = 'crx-update-later';
function laterChosen(): boolean {
  try { return sessionStorage.getItem(LATER_KEY) !== null; } catch { return false; }
}
function rememberLater() {
  try { sessionStorage.setItem(LATER_KEY, '1'); } catch { /* hidden until the page reloads */ }
}

export default function UpdatePrompt() {
  const [visible, setVisible] = useState(false);

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r: ServiceWorkerRegistration | undefined) {
      // Periodically check for updates (every 60 minutes)
      if (r) {
        setInterval(() => r.update().catch(() => {}), 60 * 60 * 1000);
      }
    },
  });

  useEffect(() => {
    if (needRefresh && !laterChosen()) setVisible(true);
  }, [needRefresh]);

  if (!visible) return null;

  return (
    <div
      role="status"
      data-testid="update-prompt"
      className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom)+0.75rem)] z-40 flex items-center gap-3 rounded-xl bg-nav-dark px-3.5 py-3 text-white shadow-xl md:inset-x-auto md:bottom-4 md:left-1/2 md:w-full md:max-w-md md:-translate-x-1/2"
    >
      <RefreshCw className="h-[18px] w-[18px] shrink-0 text-[#7fd1a8]" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-sm">
        <strong className="block font-semibold">A new version of CRX is ready</strong>
        <span className="text-[13px] text-gray-300">Reload when you are not in the middle of something.</span>
      </span>
      <button
        type="button"
        onClick={() => { rememberLater(); setVisible(false); }}
        className="min-h-11 shrink-0 rounded-lg px-3 text-[13px] font-medium text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/60 md:min-h-9"
      >
        Later
      </button>
      <button
        type="button"
        onClick={() => updateServiceWorker(true)}
        className="min-h-11 shrink-0 rounded-lg bg-crx-green px-3 text-[13px] font-semibold text-white transition-colors hover:bg-crx-green-hover focus:outline-none focus:ring-2 focus:ring-white/60 md:min-h-9"
      >
        Reload
      </button>
    </div>
  );
}
