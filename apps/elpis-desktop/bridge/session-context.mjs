import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

// Cache only the admitted path manifest; never retain a transcript or file contents in the desktop bridge.
const manifests = new Map();
async function admittedPaths(file) {
  if (typeof file !== 'string' || !/\.jsonl(?:\.zst)?$/.test(file)) return [];
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile()) return [];
  const key = `${stat.size}:${stat.mtimeMs}`, cached = manifests.get(file);
  if (cached?.key === key) return cached.paths;
  const compressed = file.endsWith('.zst');
  const appended = !compressed && cached?.ino === stat.ino && stat.size > cached.size;
  let offset = appended ? cached.offset : 0;
  const input = compressed ? (zlib.createZstdDecompress ? fs.createReadStream(file).pipe(zlib.createZstdDecompress()) : null) : fs.createReadStream(file, { start: offset, end: Math.max(0, stat.size - 1) });
  if (!input) return [];
  const paths = new Set(appended ? cached.paths : []);
  try {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      const bytes = Buffer.byteLength(line) + 1;
      let record; try { record = JSON.parse(line); } catch {
        if (!compressed && offset + bytes > stat.size) break; // Retry a partially appended record next time.
        offset += bytes; continue;
      }
      offset += bytes;
      const event = record.type === 'event_msg' ? record.payload : null;
      if (event?.type === 'exec_command_end' && event.exit_code === 0 && event.aggregated_output) {
        for (const command of event.parsed_cmd ?? []) {
          if (command.type !== 'read' || typeof command.path !== 'string' || !/\/(?:SKILL|AGENTS|CLAUDE|MEMORY|ES)\.md$/.test(`/${command.path}`)) continue;
          if (path.isAbsolute(command.path)) paths.add(command.path);
          else if (typeof event.cwd === 'string' && path.isAbsolute(event.cwd)) paths.add(path.resolve(event.cwd, command.path));
        }
      }
      if (record.type !== 'response_item' || !['developer', 'user'].includes(record.payload?.role)) continue;
      for (const part of record.payload.content ?? []) {
        if (typeof part.text !== 'string') continue;
        // These are runtime admission markers, not the catalog of available skills or quoted assistant output.
        for (const match of part.text.matchAll(/^### Source: (\/[^\n]+?)(?: \(\d+ characters\))?\s*$/gm)) paths.add(match[1]);
        for (const match of part.text.matchAll(/<skill>\s*<name>[^<]+<\/name>\s*<path>(\/[^<]+)<\/path>/g)) paths.add(match[1]);
      }
    }
  } finally { input.destroy(); }
  if (manifests.size >= 20) manifests.delete(manifests.keys().next().value);
  const result = [...paths]; manifests.set(file, { key, paths: result, ino: stat.ino, size: stat.size, offset: Math.min(offset, stat.size) }); return result;
}

/** Keep engine admission authoritative. Add only paths recorded as admitted, plus the requested project intent. */
export async function sessionContextFiles(thread, sources) {
  const files = [...sources], seen = new Set(files.map(file => file.path));
  for (const file of await admittedPaths(thread.path)) {
    if (seen.has(file)) continue;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    seen.add(file);
    files.push({ name: path.basename(file), path: file, group: file.endsWith('/SKILL.md') ? 'skills' : 'instructions', estimatedTokens: Math.ceil(stat.size / 4), included: true, selectable: false, reason: 'Recorded as loaded in this chat' });
  }
  if (typeof thread.cwd === 'string' && path.isAbsolute(thread.cwd)) {
    const file = path.join(thread.cwd, 'ES.md');
    if (!seen.has(file)) {
      const stat = await fs.promises.stat(file).catch(() => null);
      files.unshift({ name: 'ES.md', path: file, group: 'sessionContinuity', estimatedTokens: Math.ceil((stat?.size ?? 0) / 4), included: false, selectable: false, exists: stat?.isFile() ?? false, reason: 'Project session intent', projectIntent: true });
    }
  }
  return { files };
}
