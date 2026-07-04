import * as esbuild from 'esbuild';

// Keep node_modules (react, ink) external so Node loads them as native ESM —
// bundling Ink's internals into one file breaks (top-level await + CJS deps).
await esbuild.build({
  entryPoints: ['app.js'],
  outfile: 'dist/app.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  loader: { '.js': 'jsx' },
});

console.log('Built dist/app.mjs');
