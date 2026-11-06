import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mts';
import { forgetSubscriptionModels } from './subscription-models.mts';

type SentRequest = { id?: number; method?: string; params?: { refresh?: boolean; modelProvider?: string } };
type MockSocket = EventEmitter & { sent: SentRequest[]; send: (raw: string) => void; close: () => void };

// Every model menu lists the engine's catalog live (1 Nov, Masih: "Refresh it whenever the model picker opens"):
// GET /api/models?refresh=true asks model/list to fetch now. A connection the engine signs in to that is not the
// default (ChatGPT, the Anthropic credits) is asked of the engine again too (subscription-models.mts).
function fixture({ mainProvider = 'openai' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-live-models-'));
  // A ChatGPT sign-in exists in this home; its content is never read.
  fs.writeFileSync(path.join(home, 'auth' + '.json'), '{}');
  const state = { engine: ['gpt-6.1-sol'], chatgpt: ['gpt-6.1-sol', 'gpt-6.1-terra'], fail: false };
  const socket: MockSocket = Object.assign(new EventEmitter(), {
    sent: [] as SentRequest[],
    send: (raw: string): void => {
      const request = JSON.parse(raw) as SentRequest; socket.sent.push(request);
      if (request.id === undefined || !request.method) return;
      let result: Record<string, unknown> = {}, error: { code: number; message: string } | undefined;
      switch (request.method) {
        case 'config/read': result = { config: { model: 'gpt-6.1-sol', model_provider: mainProvider, model_providers: {} }, layers: [{ name: { type: 'user', file: path.join(home, 'config.toml') }, version: 'v1' }] }; break;
        case 'configRequirements/read': result = { requirements: null }; break;
        case 'model/list':
          if (state.fail && request.params?.refresh) { error = { code: -32603, message: 'Could not fetch the model list from `openai`: network down' }; break; }
          result = { data: (request.params?.modelProvider === 'openai' ? state.chatgpt : state.engine).map(model => ({ id: model, model, displayName: model })), nextCursor: null }; break;
        default: break;
      }
      queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, ...(error ? { error } : { result }) })));
    },
    close: (): void => { socket.emit('close'); }
  });
  return { client: new DesktopClient(socket), socket, state, home };
}
const slugs = (list: { data: Array<{ model: string }> }) => list.data.map(item => item.model);
const listRequests = (socket: MockSocket) => socket.sent.filter(row => row.method === 'model/list').map(row => row.params);

test('a menu that opens lists a model added since startup; a plain read keeps the shared copy', async () => {
  const f = fixture(); await f.client.initialize();
  try {
    assert.deepEqual(slugs(await f.client.models()), ['gpt-6.1-sol']);
    f.state.engine.push('gpt-6.1-terra');
    assert.deepEqual(slugs(await f.client.models()), ['gpt-6.1-sol'], 'no refresh: the shared copy');
    assert.deepEqual(slugs(await f.client.models({ refresh: true })), ['gpt-6.1-sol', 'gpt-6.1-terra']);
    assert.equal(listRequests(f.socket).at(-1)?.refresh, true);
    // The refreshed list replaces the shared copy for every other reader.
    assert.deepEqual(slugs(await f.client.models()), ['gpt-6.1-sol', 'gpt-6.1-terra']);
    await assert.rejects(f.client.models({ refresh: 'yes' }), /refresh must be true or false/);
  } finally { f.client.close(); fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('a failed refresh is an error for the menu and the last good list stays', async () => {
  const f = fixture(); await f.client.initialize();
  try {
    assert.deepEqual(slugs(await f.client.models({ refresh: true })), ['gpt-6.1-sol']);
    f.state.fail = true;
    await assert.rejects(f.client.models({ refresh: true }), /network down/);
    assert.deepEqual(slugs(await f.client.models()), ['gpt-6.1-sol']);
  } finally { f.client.close(); fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('ChatGPT and the Anthropic credits, while not the default, are asked of the engine again when a menu opens', async () => {
  const f = fixture({ mainProvider: 'anthropic-credits' }); await f.client.initialize();
  // A stand-in engine: `debug models` prints the catalogue file and records the provider it was asked for.
  const engine = path.join(f.home, 'engine.cjs'), catalogue = path.join(f.home, 'catalogue.json'), calls = path.join(f.home, 'calls.txt');
  fs.writeFileSync(engine, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)}, process.argv[3] + '\\n');\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(catalogue)}, 'utf8'));\n`, { mode: 0o755 });
  const write = (modelSlugs: string[]) => fs.writeFileSync(catalogue, JSON.stringify({ models: modelSlugs.map(slug => ({ slug, display_name: slug, visibility: 'list' })) }));
  const previous = process.env.ELPIS_ENGINE_BIN; process.env.ELPIS_ENGINE_BIN = engine;
  forgetSubscriptionModels();
  try {
    write(['gpt-6.1-sol', 'gpt-6.1-terra']);
    assert.deepEqual(slugs(await f.client.models({ provider: 'openai', refresh: true })), ['gpt-6.1-sol', 'gpt-6.1-terra']);
    write(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.2-new']);
    assert.equal((await f.client.models({ provider: 'openai' })).data.length, 2, 'no refresh: the last answer');
    assert.ok(slugs(await f.client.models({ provider: 'openai', refresh: true })).includes('gpt-6.2-new'));
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['model_provider=openai', 'model_provider=openai']);
  } finally {
    if (previous === undefined) delete process.env.ELPIS_ENGINE_BIN; else process.env.ELPIS_ENGINE_BIN = previous;
    forgetSubscriptionModels(); f.client.close(); fs.rmSync(f.home, { recursive: true, force: true });
  }
});
