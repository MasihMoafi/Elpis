import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createCharacters } from './custom-characters.mts';
import { handleCharacterRoutes } from './server-characters.mts';

const id = 'custom-12345678-1234-1234-1234-123456789012';
const character = { id, name: 'Lyra', description: 'A patient astronomer', personality: 'Explain through stars.', themeId: null, portrait: { url: `/api/characters/${id}/portrait` } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
async function existing() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-existing-character-'));
  const directory = path.join(home, 'characters');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'characters.json'), JSON.stringify([character]), { mode: 0o600 });
  await fs.writeFile(path.join(directory, `${id}.png`), png, { mode: 0o600 });
  return { home, directory, store: createCharacters(home) };
}

test('previously saved characters and portraits remain usable, editable and deletable', async () => {
  const { home, store } = await existing();
  try {
    assert.deepEqual(await store.list(), [character]);
    assert.deepEqual(await store.portrait(id), png);
    await store.personality(id, 'Ask one clear question.');
    assert.equal((await createCharacters(home).list())[0]?.personality, 'Ask one clear question.');
    await assert.rejects(store.portrait('../../auth'), /character/i);
    await store.delete(id);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.portrait(id), /portrait/i);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('removing creation preserves damaged saved data for recovery', async () => {
  const { home, directory, store } = await existing();
  try {
    const file = path.join(directory, 'characters.json');
    await fs.writeFile(file, 'damaged manifest');
    await assert.rejects(store.list(), /kept/);
    await assert.rejects(store.personality(id, 'New personality'), /kept/);
    assert.equal(await fs.readFile(file, 'utf8'), 'damaged manifest');
    assert.deepEqual(await fs.readFile(path.join(directory, `${id}.png`)), png);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('creation, upload and generation routes are absent while saved characters can still be read', async () => {
  const { home, store } = await existing();
  const server = createServer((request, response) => {
    void handleCharacterRoutes({ characters: store }, request, response, new URL(request.url!, 'http://localhost'), request.method!).then(handled => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch(() => { response.writeHead(500); response.end(); });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const [suffix, method] of [['', 'POST'], ['/portrait', 'POST'], ['/generate', 'POST'], ['/stop', 'POST'], ['/sources', 'GET']]) {
      const response = await fetch(`${origin}/api/characters${suffix}`, { method });
      assert.equal(response.status, 404, `${method} ${suffix} must not start character creation`);
      await response.text();
    }
    const response = await fetch(`${origin}/api/characters`);
    assert.deepEqual(await response.json(), { characters: [character] });
    assert.deepEqual(await store.list(), [character]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  }
});
