/**
 * Which environment this build runs in, from one build-time variable.
 * VITE_APP_ENV=staging on the Vercel staging environment; the Vite dev server counts as local;
 * anything else (unset on production) is production, which shows no banner.
 */
export type AppEnv = 'production' | 'staging' | 'local';

export function appEnv(
  raw: string | undefined = import.meta.env.VITE_APP_ENV,
  dev: boolean = import.meta.env.DEV,
): AppEnv {
  const value = raw?.trim().toLowerCase();
  if (value === 'staging' || value === 'local') return value;
  return dev ? 'local' : 'production';
}

export function envTitlePrefix(env: AppEnv): string {
  return env === 'production' ? '' : `${env.toUpperCase()} · `;
}
