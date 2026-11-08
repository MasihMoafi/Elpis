import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['scripts/untitled-tui-e2e.mts', 'scripts/untitled-tui-e2e.mjs'],
  ['packaging/obsidian/elpis-workflows/main.cts', 'packaging/obsidian/elpis-workflows/main.js'],
  ['packaging/obsidian/love-spot/main.cts', 'packaging/obsidian/love-spot/main.js'],
  ['codex-rs/responses-api-proxy/npm/bin/codex-responses-api-proxy.mts', 'codex-rs/responses-api-proxy/npm/bin/codex-responses-api-proxy.js'],
  ['codex-rs/skills/assets-src/openai-docs/fetch-codex-manual.mts', 'codex-rs/skills/src/assets/samples/openai-docs/scripts/fetch-codex-manual.mjs'],
  ...['manual-errors', 'manual-transport', 'manual-cache', 'manual-outline', 'manual-fetch'].map(name =>
    [`codex-rs/skills/assets-src/openai-docs/${name}.mts`, `codex-rs/skills/src/assets/samples/openai-docs/scripts/${name}.mjs`] as const),
  ['codex-rs/skills/assets-src/openai-docs/resolve-latest-model-info.cts', 'codex-rs/skills/src/assets/samples/openai-docs/scripts/resolve-latest-model-info.cjs'],
] as const;

for (const [source, output] of targets) {
  const header = `// Generated from ${source} by scripts/emit-compat-js.mts; do not edit.\n`;
  const input = readFileSync(path.join(root, source), 'utf8');
  const originalLines = input.split('\n');
  const stripped = stripTypeScriptTypes(input).split('\n').map((line, index) => {
    const trailing = originalLines[index]?.match(/[ \t]*$/)?.[0] ?? '';
    return line.replace(/[ \t]+$/, '') + trailing;
  }).join('\n');
  const shebang = stripped.match(/^#![^\n]*\n/)?.[0] ?? '';
  const generated = shebang + header + stripped.slice(shebang.length).replace(/(\b(?:from|import)\s*(?:\(\s*)?['"][^'"\n]+)\.mts(['"])/g, '$1.mjs$2');
  const destination = path.join(root, output);
  if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== generated) {
      throw new Error(`Run node scripts/emit-compat-js.mts to update ${output}.`);
    }
  } else {
    writeFileSync(destination, generated);
  }
}
