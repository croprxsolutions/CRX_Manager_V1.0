import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initSentry, Sentry } from './lib/sentry';
import { toSentryError } from './lib/sentryError';
import App from './App.tsx';
import { appEnv, envTitlePrefix } from './lib/appEnv';
import './index.css';

// Staging and local tabs say so in the title; production keeps index.html's title.
document.title = envTitlePrefix(appEnv()) + document.title;

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
