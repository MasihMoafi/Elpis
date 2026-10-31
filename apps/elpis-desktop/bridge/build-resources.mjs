import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const bridgeOnly = process.argv.includes('--bridge-only');
if (!bridgeOnly) {
  const { instrument } = createRequire(import.meta.url)('./source-map.cjs');
  const sourceMap = {};
  for (const dir of ['app', 'components']) {
    const root = new URL(`../${dir}/`, import.meta.url);
    for (const name of await fs.readdir(root, { recursive: true })) {
      if (name.endsWith('.tsx')) Object.assign(sourceMap, instrument(await fs.readFile(new URL(name, root), 'utf8'), `${dir}/${name}`).entries);
    }
  }
  await fs.mkdir(new URL('../public/', import.meta.url), { recursive: true });
  await fs.writeFile(new URL('../public/elpis-source-map.json', import.meta.url), JSON.stringify(sourceMap));
}
const resources = new URL('./resources/', import.meta.url);
await fs.mkdir(resources, { recursive: true });
await fs.copyFile(new URL('../../../tools/elpis-claude/permission-policy.mjs', import.meta.url), new URL('./permission-policy.mjs', resources));
await fs.copyFile(new URL('../../../tools/elpis-claude/workflow-concurrency.mjs', import.meta.url), new URL('./workflow-concurrency.mjs', resources));
await fs.copyFile(new URL('../../../codex-rs/core/src/prompts/rag.md', import.meta.url), new URL('./rag.md', resources));
await fs.copyFile(new URL('../../../codex-rs/skills/src/assets/personal/SKILL.md', import.meta.url), new URL('./personal.md', resources));
if (!bridgeOnly) {
  // Excalidraw's bundled fonts stay local, including during whole-drawing PNG export.
  await fs.cp(new URL('../node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url), new URL('../public/love-spot-assets/fonts/', import.meta.url), { recursive: true });
}

