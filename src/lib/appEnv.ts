/**
 * Which environment this build runs in, from one build-time variable.
 * VITE_APP_ENV=staging on the Vercel staging environment; the Vite dev server counts as local;
 * unset or "production" is production, which shows no banner. Two safety nets: an unknown value
 * shows the staging banner rather than nothing, and a build pointed at the staging or a local
 * database is staging or local even if the variable is missing (e.g. `npm run preview`).
 */
export type AppEnv = 'production' | 'staging' | 'local';

const STAGING_SUPABASE_HOST = 'fsnjredpmakbmhwowjjt.supabase.co';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function supabaseHost(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return '';
  }
}

// True only when the build's database is positively known to hold test data.
export function isTestDatabase(url: string | undefined): boolean {
  const host = supabaseHost(url);
  return host === STAGING_SUPABASE_HOST || LOCAL_HOSTS.has(host);
}

export function appEnv(
  raw: string | undefined = import.meta.env.VITE_APP_ENV,
  dev: boolean = import.meta.env.DEV,
  supabaseUrl: string | undefined = import.meta.env.VITE_SUPABASE_URL,
): AppEnv {
  const value = raw?.trim().toLowerCase();
  if (value === 'staging' || value === 'local') return value;
  if (value && value !== 'production') return 'staging';
  const host = supabaseHost(supabaseUrl);
  if (dev || LOCAL_HOSTS.has(host)) return 'local';
  return host === STAGING_SUPABASE_HOST ? 'staging' : 'production';
}

export function envTitlePrefix(env: AppEnv): string {
  return env === 'production' ? '' : `${env.toUpperCase()} · `;
}
