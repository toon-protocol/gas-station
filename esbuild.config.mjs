/**
 * esbuild configuration for the gas-station Docker entrypoint.
 *
 * Bundles src/entrypoint-gas-station.ts into a single ESM file and leaves
 * every dependency external (`packages: 'external'`). Dependencies resolve
 * from node_modules at runtime, installed by `pnpm install --prod` in
 * Dockerfile.gas-station's deps stage — so a runtime version is written down
 * in exactly one place, package.json, and the lockfile keeps it honest.
 *
 * A hand-maintained `external:` list would have to name every package
 * reachable through a dynamic import, and getting it wrong fails in the
 * container rather than here.
 *
 * Usage: node esbuild.config.mjs
 */

import * as esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: ['src/entrypoint-gas-station.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outdir: 'dist',
  minify: true,
  sourcemap: false,
  metafile: true,

  // Bundle our own source only; every bare import stays a runtime import.
  packages: 'external',
});

console.log(await esbuild.analyzeMetafile(result.metafile));
