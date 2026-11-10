#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint, readConfig } from './ui-lint.generated.mjs';

const dir = dirname(dirname(fileURLToPath(import.meta.url)));
const config = await readConfig(dir);
if (!config) { console.error(`ui-check: no ui-check.json in ${dir}`); process.exit(2); }
const findings = (await lint(dir, config)).map(f => ({ ...f, where: `${f.file}:${f.line}`, key: `${f.rule}|${f.file}|${f.msg}` }));
const known = new Map<string, number>(Object.entries(JSON.parse(await readFile(join(dir, 'ui-check.known.json'), 'utf8').catch(() => '{}'))));
const budget = new Map(known);
const fresh = findings.filter(f => { const left = budget.get(f.key) ?? 0; budget.set(f.key, left - 1); return left <= 0; });
const debt = findings.length - fresh.length;
if (!fresh.length) {
  console.log(`ui-check: pass (${findings.length ? `${debt} known findings left to fix` : 'no findings'})`);
  process.exit(0);
}
console.log(`ui-check: ${fresh.length} new violation(s) of ~/Desktop/p/skills/web-dev/UI-RULES.md${debt ? ` (+${debt} known)` : ''}`);
for (const f of fresh.sort((a, b) => a.rule.localeCompare(b.rule) || a.where.localeCompare(b.where))) console.log(`  ${f.rule}  ${f.where}  ${f.msg}`);
process.exit(1);
