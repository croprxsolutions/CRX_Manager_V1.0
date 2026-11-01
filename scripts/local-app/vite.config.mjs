import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import appConfig from '../../vite.config.ts';

// The real app's config, minus its Google Fonts links, which every page load would otherwise fetch.
export default mergeConfig(appConfig, {
  root: fileURLToPath(new URL('../..', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./.state/vite', import.meta.url)),
  // Vite serves the whole checkout, so keep the local keys and any private data out of its reach.
  server: { fs: { deny: ['**/.state/**', '**/backups/**', '**/*.dump', '**/docs/claude-memory/**'] } },
  plugins: [{
    name: 'crx-local-app-no-outside-fonts',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace(/^.*https:\/\/fonts\..*$/gm, '') },
  }],
});
