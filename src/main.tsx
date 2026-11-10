import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initSentry, Sentry } from './lib/sentry';
import { toSentryError } from './lib/sentryError';
import App from './App.tsx';
import './index.css';

// Initialize error tracking (no-op if VITE_SENTRY_DSN not set)
initSentry();

// Global safety net — catches unhandled promise rejections that escape React
// (e.g. fire-and-forget async calls, third-party libs, service worker errors)
window.addEventListener('unhandledrejection', (event) => {
  Sentry.captureException(toSentryError(event.reason), { tags: { mechanism: 'unhandledrejection' } });
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
