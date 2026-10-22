import fs from 'node:fs';
import path from 'node:path';

/** The plugin catalogs the Claude and ChatGPT desktop apps already keep on this computer. Elpis reads them where they are:
 * nothing is downloaded until a plugin is installed. The engine reserves the name openai-bundled for a folder inside its own
 * `.tmp/bundled-marketplaces`, so that one is reached through a link there. */
const CATALOGS = [
  { app: 'claude', label: 'Claude', name: 'claude-plugins-official', folder: '.claude/plugins/marketplaces/claude-plugins-official', manifest: '.claude-plugin/marketplace.json' },
  { app: 'chatgpt', label: 'ChatGPT', name: 'openai-bundled', folder: '.codex/.tmp/bundled-marketplaces/openai-bundled', manifest: '.agents/plugins/marketplace.json' },
];

/** The catalogs found under `home`: { app, label, name, source }. */
export function appCatalogs(home) {
  return CATALOGS.flatMap(({ app, label, name, folder, manifest }) => {
    const source = path.join(home, folder);
    return fs.existsSync(path.join(source, manifest)) ? [{ app, label, name, source }] : [];
  });
}

/** Where the engine looks for the bundled marketplace of `elpisHome`, with the ChatGPT app's folder linked there. */
export async function linkBundledCatalog(elpisHome, source) {
  const link = path.join(elpisHome, '.tmp', 'bundled-marketplaces', 'openai-bundled');
  await fs.promises.mkdir(path.dirname(link), { recursive: true });
  const existing = await fs.promises.readlink(link).catch(() => null);
  if (existing !== source) {
    if (existing !== null) await fs.promises.unlink(link);
    await fs.promises.symlink(source, link);
  }
  return link;
}
