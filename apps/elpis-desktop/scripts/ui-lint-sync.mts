#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = join(homedir(), 'Desktop/p/skills/web-dev/ui-check/lint.mjs');
const destination = fileURLToPath(new URL('./ui-lint.generated.mjs', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1 || !['--write', '--check'].includes(args[0] ?? '')) {
  console.error('Usage: node scripts/ui-lint-sync.mts --write|--check');
  process.exit(2);
}
let content: string;
try {
  content = await readFile(source, 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT' && args[0] === '--check'
      && !(await stat(dirname(source)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }))) {
    console.log('ui-lint: shared source unavailable; using generated copy.');
    process.exit(0);
  }
  throw error;
}
const digest = createHash('sha256').update(content).digest('hex');
const expected = `// @ts-nocheck\n// Generated from skills/web-dev/ui-check/lint.mjs; node scripts/ui-lint-sync.mts --write; sha256=${digest}\n${content}`;
if (args[0] === '--write') {
  await writeFile(destination, expected);
  console.log('ui-lint: generated copy updated.');
} else if (await readFile(destination, 'utf8').catch(() => '') !== expected) {
  console.error('ui-lint: generated copy is stale; run node scripts/ui-lint-sync.mts --write.');
  process.exit(1);
} else {
  console.log('ui-lint: generated copy is current.');
}
