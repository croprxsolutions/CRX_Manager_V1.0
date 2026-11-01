import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import appConfig from '../../vite.config.ts';

// The real app's config, minus its Google Fonts links, which every page load would otherwise fetch.
export default mergeConfig(appConfig, {
  root: fileURLToPath(new URL('../..', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./.state/vite', import.meta.url)),
  // An empty folder, so a checkout's .env files are never loaded at all.
  envDir: fileURLToPath(new URL('./.state/no-env', import.meta.url)),
  // Vite serves the whole checkout, so keep keys and private data out of its reach. Setting this
  // list replaces Vite's own, so the first line repeats its defaults (Vite 8.3.5).
  server: {
    fs: {
      deny: [
        '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
        '**/.state/**', '**/.claude/**', '**/backups/**', '**/*.dump', '**/docs/claude-memory/**',
      ],
    },
  },
  plugins: [{
    name: 'crx-local-app-no-outside-fonts',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace(/^.*https:\/\/fonts\..*$/gm, '') },
  }],
});
