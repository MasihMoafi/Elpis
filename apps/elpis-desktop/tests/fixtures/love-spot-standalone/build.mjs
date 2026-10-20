// Bundles the window's page into dist/ (one script, its CSS, and Excalidraw's fonts, so it works offline).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
await esbuild.build({ entryPoints: ['src/app.jsx'], bundle: true, outdir: 'dist', format: 'iife', jsx: 'automatic', minify: true,
  conditions: ['production'], define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
  loader: { '.woff2': 'file', '.png': 'file', '.svg': 'file' }, logLevel: 'warning' });
fs.cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'dist/fonts', { recursive: true });
fs.copyFileSync('src/index.html', 'dist/index.html');
