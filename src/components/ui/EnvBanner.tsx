import { appEnv, isStagingDatabase, type AppEnv } from '../../lib/appEnv';

// Amber for staging and blue for local: both stay clear of the brand green, so nobody
// mistakes a test build for the live app. Production shows nothing.
// The strip scrolls away with the page (no sticky offsets to shift); the thin fixed line and
// the tab title prefix keep the environment visible after scrolling.
const LOOK: Record<Exclude<AppEnv, 'production'>, { text: string; className: string; line: string }> = {
  staging: { text: 'STAGING · test data only', className: 'bg-amber-300 text-amber-950', line: 'bg-amber-400' },
  local: { text: 'LOCAL', className: 'bg-blue-700 text-white', line: 'bg-blue-600' },
};

export default function EnvBanner({
  env = appEnv(),
  supabaseUrl = import.meta.env.VITE_SUPABASE_URL,
}: { env?: AppEnv; supabaseUrl?: string }) {
  if (env === 'production') return null;
  const { className, line } = LOOK[env];
  // Only staging claims "test data only", and only when its database is positively the staging project.
  const text = env === 'staging' && !isStagingDatabase(supabaseUrl) ? 'STAGING · check which database this uses' : LOOK[env].text;
  const showMapsProofs = env === 'staging' && window.location.hostname === 'staging.croprxsolutions.app';
  // A plain label, not a live region: screen readers shouldn't announce it on every load.
  return (
    <>
      <div className={`${className} text-center text-xs font-semibold tracking-wide py-0.5`}>
        <span>{text}</span>
        {showMapsProofs && (
          <nav aria-label="Staging maps checks" className="flex flex-wrap justify-center">
            <a href="/api/maps-step0-draw/index.html" className="inline-flex min-h-11 touch-manipulation items-center px-3 underline">
              Map drawing proof
            </a>
            <a href="/api/maps-step0?places=1" className="inline-flex min-h-11 touch-manipulation items-center px-3 underline">
              Google Places check
            </a>
          </nav>
        )}
      </div>
      <div aria-hidden="true" className={`${line} pointer-events-none fixed inset-x-0 top-0 z-[60] h-1`} />
    </>
  );
}
