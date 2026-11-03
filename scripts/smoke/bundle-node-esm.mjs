import path from 'node:path';
import { build } from 'rolldown';

// Bundles one TS/JS entry into a single Node ESM file, leaving npm packages
// external (what esbuild's `packages: 'external'` did before vite 8 dropped it).
export async function bundleNodeEsm(entry, outfile, define) {
  await build({
    input: entry,
    platform: 'node',
    external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
    transform: define ? { define } : undefined,
    logLevel: 'warn',
    output: { file: outfile, format: 'esm' },
  });
}
