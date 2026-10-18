#!/usr/bin/env node
// Prepared switch only. The coordinator runs --apply after installing the checked desktop bundle.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const execPath = value => `"${value.replace(/[\\"`$%]/g, char => char === '%' ? '%%' : `\\${char}`)}"`;

export function prepareDock(text, home) {
  const exec = `Exec=${execPath(path.join(home, '.local/bin/elpis-app'))} --love-spot-app`;
  const found = new Set(); let section = '';
  const next = text.split('\n').map(line => {
    if (/^\[.*\]$/.test(line)) section = line;
    if ((section === '[Desktop Entry]' || section === '[Desktop Action new-page]') && line.startsWith('Exec=')) {
      if (found.has(section)) throw Error(`Duplicate Exec in ${section}`);
      found.add(section); return exec;
    }
    return line;
  }).join('\n');
  for (const required of ['[Desktop Entry]', '[Desktop Action new-page]']) if (!found.has(required)) throw Error(`Missing Exec in ${required}`);
  return next;
}

/** Carries the exact old contents in the command itself, without a backup file. */
export function rollbackCommand(file, original) {
  const code = `require('node:fs').writeFileSync(${JSON.stringify(file)},Buffer.from(${JSON.stringify(Buffer.from(original).toString('base64'))},'base64'))`;
  return `${quote(process.execPath)} -e ${quote(code)}`;
}

async function main(args) {
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) throw Error('Usage: node scripts/point-love-dock.mjs [--dry-run|--apply]');
  const home = os.homedir(), file = path.join(home, '.local/share/applications/excalidraw.desktop');
  if (!(await fs.lstat(file)).isFile()) throw Error('The dock entry must be a regular file');
  const original = await fs.readFile(file, 'utf8'), next = prepareDock(original, home);
  console.log(`Rollback:\n${rollbackCommand(file, original)}`);
  if (args.includes('--apply')) {
    await fs.access(path.join(home, '.local/bin/elpis-app'), constants.X_OK);
    await fs.writeFile(file, next);
    console.log(`Updated ${file}`);
  } else console.log(`Preview only; use --apply after installation:\n${next}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
