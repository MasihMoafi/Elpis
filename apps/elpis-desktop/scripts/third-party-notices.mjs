#!/usr/bin/env node
// third-party-notices.mjs PACKAGE_ROOT OUT [RUST_LIST]: the licence notices a package of Elpis must carry.
// 1. Every npm package shipped as files inside PACKAGE_ROOT (any node_modules folder in it), with its licence text.
// 2. The libraries bundled into the desktop renderer: the app's production dependencies, without build-only tools.
// 3. The fonts Excalidraw (Love Spot) bundles, under the SIL Open Font License 1.1.
// 4. RUST_LIST when given: the engine's Rust crates (name, version, licence), written by the engine build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [root, out, rustList] = process.argv.slice(2);
if (!root || !out) { console.error('usage: third-party-notices.mjs PACKAGE_ROOT OUT [RUST_LIST]'); process.exit(2); }
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LICENCE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
// Build-time only: they produce the renderer and are not in it (sharp and libvips optimise images during the build).
const BUILD_ONLY = /^(@img\/|sharp$|caniuse-lite$|typescript$|@types\/|eslint|@next\/swc|@tailwindcss\/oxide|lightningcss|@esbuild\/|esbuild$|postcss$|electron$)/;

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const entries = new Map();
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
function add(dir, from) {
  const pkg = JSON.parse(read(path.join(dir, 'package.json')) || 'null');
  if (!pkg?.name || BUILD_ONLY.test(pkg.name)) return;
  const key = `${pkg.name}@${pkg.version}`;
  if (entries.has(key)) return;
  const licence = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? ((pkg.licenses || []).map(l => l.type).join(' OR ') || 'see text'));
  let text = null;
  try { for (const name of fs.readdirSync(dir)) if (LICENCE.test(name)) { text = read(path.join(dir, name)); if (text) break; } } catch {}
  // A package published without its licence file still carries its licence: write the standard MIT text for it.
  const holder = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || `the ${pkg.name} authors`;
  if (!text && licence === 'MIT') text = `MIT License\n\nCopyright (c) ${holder}\n\n${MIT}`;
  entries.set(key, { name: pkg.name, version: pkg.version, licence: licence === 'see text' && /\bMIT License\b|Permission is hereby granted, free of charge/.test(text || '') ? 'MIT' : licence, text, from });
}
// 1. Packages shipped as files.
function walk(dir) {
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const item of list) {
    if (!item.isDirectory()) continue;
    const full = path.join(dir, item.name);
    if (item.name === 'node_modules') {
      for (const pkg of fs.readdirSync(full, { withFileTypes: true })) {
        if (!pkg.isDirectory() || pkg.name.startsWith('.')) continue;
        const p = path.join(full, pkg.name);
        if (pkg.name.startsWith('@')) for (const sub of fs.readdirSync(p)) { add(path.join(p, sub), 'shipped'); walk(path.join(p, sub)); }
        else { add(p, 'shipped'); walk(p); }
      }
    } else walk(full);
  }
}
walk(root);
// 2. The renderer's bundled libraries.
const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8'));
for (const [where, meta] of Object.entries(lock.packages)) if (where && !meta.dev && !meta.optional) add(path.join(app, where), 'bundled in the desktop window');

const ofl = read(path.join(app, 'scripts/OFL-1.1.txt'));
if (!ofl) { console.error('missing scripts/OFL-1.1.txt'); process.exit(1); }
const rust = rustList ? read(rustList) : null;
const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
const parts = [
  'Elpis: third-party notices',
  '',
  'Elpis is Apache-2.0 and builds on OpenAI Codex (Apache-2.0). This file lists the third-party software in this package',
  'and carries its licence texts. Electron and Chromium licences are in runtime/electron/LICENSE and LICENSES.chromium.html.',
  '',
  `== npm packages (${sorted.length}) ==`,
  ...sorted.map(e => `${e.name} ${e.version}: ${e.licence} (${e.from})`),
  '',
  '== Fonts bundled by Excalidraw (Love Spot) ==',
  'Virgil, Excalifont, Cascadia Code, Assistant, Liberation Sans, Lilita One, Nunito, Xiaolai: SIL Open Font License 1.1 (text below).',
  'Comic Shanns: MIT.',
  '',
  ...(rust ? ['== Rust crates in the Elpis engine ==', rust.trim(), ''] : []),
  '== Licence texts ==',
  '',
  '-- SIL Open Font License 1.1 --', ofl.trim(), '',
  ...sorted.filter(e => e.text).flatMap(e => [`-- ${e.name} ${e.version} --`, e.text.trim(), '']),
];
fs.writeFileSync(out, parts.join('\n') + '\n');
console.log(`${out}: ${sorted.length} npm packages${rust ? ', Rust crates' : ''}`);
