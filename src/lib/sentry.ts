// eslint-disable-next-line no-restricted-imports
import * as Sentry from '@sentry/react';

// Supabase reads carry their filter values (customer ids, amounts) in the query string.
function redactQuery(url: string): string {
  return url.replace(/[?#].*$/s, '?[REDACTED]');
}

export function initSentry() {
  // Only init in production (VITE_SENTRY_DSN must be set)
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Only send errors in production
    enabled: import.meta.env.PROD,
    // Sample 100% of errors, 10% of transactions for performance
    sampleRate: 1.0,
    tracesSampleRate: 0.1,
    // Filter out noisy errors
    ignoreErrors: [
      'ResizeObserver loop',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',
      // Network errors that aren't bugs
      'Failed to fetch',
      'NetworkError',
      'Load failed',
    ],
    beforeBreadcrumb(breadcrumb) {
      // 'supabase' is the crumb db.ts adds; 'fetch' and 'xhr' are the SDK's own.
      if (breadcrumb.category === 'supabase' && typeof breadcrumb.message === 'string') {
        return { ...breadcrumb, message: redactQuery(breadcrumb.message) };
      }
      if (
        (breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr')
        && typeof breadcrumb.data?.url === 'string'
      ) {
        return { ...breadcrumb, data: { ...breadcrumb.data, url: redactQuery(breadcrumb.data.url) } };
      }
      return breadcrumb;
    },
    beforeSend(event) {
      // Strip PII from error messages
      if (event.message) {
        event.message = event.message.replace(/eyJ[A-Za-z0-9_-]+/g, '[JWT_REDACTED]');
      }
      return event;
    },
  });
}

// Re-export for use in components
export { Sentry };
