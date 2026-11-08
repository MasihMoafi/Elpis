import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(path.join(root, 'apps/elpis-desktop/desktop/main.cts'), 'utf8');
const first = /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:['"]use strict['"];\s*)?const\s+errorGuard\s*:\s*typeof\s+import\(['"]\.\/main-error-guard\.cts['"]\)\s*=\s*require\(['"]\.\/main-error-guard\.cts['"]\);/;
const errors = [];
if (!first.test(main)) errors.push('desktop/main.cts must install the main error guard first');
const allowed = new Set(readFileSync(path.join(root, 'scripts/js-allowlist.txt'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0');
for (const file of new Set(files)) {
  if (/\.(?:js|jsx|mjs|cjs)$/.test(file) && existsSync(path.join(root, file)) && !allowed.has(file)) errors.push(`JavaScript file is not allowlisted: ${file}`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
