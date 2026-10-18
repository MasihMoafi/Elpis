import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const evidence = JSON.parse(await fs.readFile(new URL('apps/elpis-desktop/lib/workflow-sources.json', root), 'utf8'));
const lines = ['# Workflow sources', '', `Reviewed ${evidence.reviewed}. ${evidence.scope}`, '',
  'Generated from `apps/elpis-desktop/lib/workflow-sources.json`, also imported by the app. Edit that file, then run `node scripts/workflow-sources.mjs`; `--check` detects drift. Years identify the first paper version; venue notes identify later publication. The source links on Canvas starters describe implementation inspiration, not efficacy.', ''];
for (const pattern of evidence.patterns) {
  lines.push(`## ${pattern.name}`, '', `**${pattern.status}.** What is proven: ${pattern.proven}`, '', `What is not: ${pattern.unproven}`, '');
  for (const id of pattern.origins) {
    const origin = evidence.origins[id];
    lines.push(`Starter inspiration: [${origin.title}](${origin.url}) (implementation guidance, not paper evidence).`, '');
  }
  for (const id of pattern.sources) {
    const source = evidence.sources[id];
    lines.push(`- [${source.title}](${source.url}) — ${source.authors}. ${source.year}; ${source.venue}. ${source.finding} [Results read](${source.read}).`);
  }
  if (!pattern.sources.length) lines.push('No paper or measured efficacy result applies to an empty editor.');
  lines.push('');
}
const result = lines.join('\n'), destination = new URL('docs/workflow-sources.md', root);
if (process.argv.includes('--check')) {
  if (await fs.readFile(destination, 'utf8') !== result) throw Error('workflow-sources.md is stale; run node scripts/workflow-sources.mjs');
  process.stdout.write('Workflow sources match the canonical data.\n');
} else { await fs.writeFile(destination, result); process.stdout.write(`${fileURLToPath(destination)}\n`); }
