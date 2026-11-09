import { appEnv, type AppEnv } from '../../lib/appEnv';

// Amber for staging and blue for local: both stay clear of the brand green, so nobody
// mistakes a test build for the live app. Production shows nothing.
// The strip scrolls away with the page (no sticky offsets to shift); the thin fixed line and
// the tab title prefix keep the environment visible after scrolling.
const LOOK: Record<Exclude<AppEnv, 'production'>, { text: string; className: string; line: string }> = {
  staging: { text: 'STAGING · test data only', className: 'bg-amber-300 text-amber-950', line: 'bg-amber-400' },
  local: { text: 'LOCAL', className: 'bg-blue-700 text-white', line: 'bg-blue-600' },
};

// Live project ref: a staging build wrongly pointed at live must never claim "test data only".
const LIVE_SUPABASE_REF = 'rhyzpcqhnizqbxphqdkr';

export default function EnvBanner({
  env = appEnv(),
  supabaseUrl = import.meta.env.VITE_SUPABASE_URL,
}: { env?: AppEnv; supabaseUrl?: string }) {
  if (env === 'production') return null;
  const { className, line } = LOOK[env];
  const text = supabaseUrl?.includes(LIVE_SUPABASE_REF) ? `${env.toUpperCase()} · LIVE DATABASE` : LOOK[env].text;
  // A plain label, not a live region: screen readers shouldn't announce it on every load.
  return (
    <>
      <div className={`${className} text-center text-xs font-semibold tracking-wide py-0.5`}>
        {text}
      </div>
      <div aria-hidden="true" className={`${line} pointer-events-none fixed inset-x-0 top-0 z-[60] h-1`} />
    </>
  );
}
