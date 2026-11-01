import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import appConfig from '../../vite.config.ts';

// The real app's config, minus its Google Fonts links, so the page asks for nothing beyond this computer.
export default mergeConfig(appConfig, {
  root: fileURLToPath(new URL('../..', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./.state/vite', import.meta.url)),
  plugins: [{
    name: 'crx-local-app-no-outside-fonts',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace(/^.*https:\/\/fonts\..*$/gm, '') },
  }],
});
